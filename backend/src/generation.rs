use std::{collections::HashMap, env, path::PathBuf, process::Command, sync::Arc};

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use native_whisperx::{
    run_with_control, translate_transcription_with_control, CancellationHandle,
    FiniteTranscriptionOutcome, InputSource, NativeOpusMtTranslationProvider,
    NativeOpusMtTranslationProviderConfig, NativeWhisperxConfig, OutputConfig,
    TranscriptionContract, TranscriptionPipelineResponse, TranscriptionProgressEvent,
    TranscriptionProgressObserver, TranslatedTranscriptionOutcome, TranslationPlan,
    TranslationPlanProvenance,
};

use crate::{AppError, AppState};

const DEFAULT_MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Clone)]
pub struct GenerationState {
    inner: Arc<Mutex<Inner>>,
    cache_dir: PathBuf,
    max_upload_bytes: u64,
    events: Arc<Mutex<HashMap<String, broadcast::Sender<String>>>>,
}

struct Inner {
    sessions: HashMap<String, PathBuf>,
    jobs: HashMap<String, Job>,
    active_job: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    job_id: String,
    session_id: String,
    state: String,
    phase: String,
    progress: u8,
    message: String,
    source_track: Option<Track>,
    translation_track: Option<Track>,
    #[serde(skip)]
    cancellation: CancellationHandle,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    language: String,
    pivoted: bool,
    cues: Vec<Cue>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cue {
    start_ms: u64,
    end_ms: u64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResponse {
    ready: bool,
    ffmpeg_available: bool,
    ffprobe_available: bool,
    cache_dir: String,
    max_upload_bytes: u64,
    native_whisperx_version: &'static str,
}

enum NativeJobResult {
    Completed {
        source_track: Track,
        translation_track: Option<Track>,
        message: String,
    },
    Cancelled {
        source_track: Option<Track>,
    },
    Failed {
        source_track: Option<Track>,
        message: String,
    },
}

enum TranslationAttempt {
    Completed(Track),
    SkippedSameLanguage,
    Cancelled,
    Failed(String),
}

impl GenerationState {
    pub fn new() -> Self {
        let cache_dir = env::var_os("SUBTITLE_MODEL_CACHE_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::cache_dir().map(|path| path.join("subtitle-merger/models")))
            .unwrap_or_else(|| PathBuf::from(".subtitle-merger/models"));
        let max_upload_bytes = env::var("SUBTITLE_MAX_UPLOAD_BYTES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_MAX_UPLOAD_BYTES);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                sessions: HashMap::new(),
                jobs: HashMap::new(),
                active_job: None,
            })),
            cache_dir,
            max_upload_bytes,
            events: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub async fn create_session(
    State(app): State<AppState>,
) -> Result<Json<SessionResponse>, AppError> {
    let state = app.generation;
    let id = Uuid::new_v4().to_string();
    let workspace = env::temp_dir().join("subtitle-merger").join(&id);
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|_| AppError::internal("could not create session workspace"))?;
    state
        .inner
        .lock()
        .await
        .sessions
        .insert(id.clone(), workspace);
    Ok(Json(SessionResponse { session_id: id }))
}

pub async fn delete_session(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let state = app.generation;
    let workspace = state
        .inner
        .lock()
        .await
        .sessions
        .remove(&id)
        .ok_or_else(|| AppError::not_found("subtitle session not found"))?;
    let _ = tokio::fs::remove_dir_all(workspace).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn preflight(State(app): State<AppState>) -> Json<PreflightResponse> {
    let state = app.generation;
    let ffmpeg_available = Command::new("ffmpeg").arg("-version").output().is_ok();
    let ffprobe_available = Command::new("ffprobe").arg("-version").output().is_ok();
    Json(PreflightResponse {
        ready: ffmpeg_available && ffprobe_available,
        ffmpeg_available,
        ffprobe_available,
        cache_dir: state.cache_dir.display().to_string(),
        max_upload_bytes: state.max_upload_bytes,
        native_whisperx_version: "0.1.14",
    })
}

pub async fn create_job(
    State(app): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    let mut session_id = None;
    let mut filename = None;
    let mut video = None;
    let mut source_language = None;
    let mut target_language = None;
    let mut diarize = false;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad_request("invalid multipart upload"))?
    {
        match field.name() {
            Some("sessionId") => {
                session_id = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::bad_request("invalid session id"))?,
                )
            }
            Some("sourceLanguage") => {
                source_language = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::bad_request("invalid source language"))?,
                )
            }
            Some("targetLanguage") => {
                target_language = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::bad_request("invalid target language"))?,
                )
            }
            Some("diarize") => diarize = field.text().await.unwrap_or_default() == "true",
            Some("video") => {
                filename = field.file_name().map(ToOwned::to_owned);
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|_| AppError::bad_request("video upload failed"))?;
                if bytes.len() as u64 > state.max_upload_bytes {
                    return Err(AppError::bad_request("video exceeds configured upload limit"));
                }
                video = Some(bytes);
            }
            _ => {}
        }
    }
    let session_id = session_id.ok_or_else(|| AppError::bad_request("sessionId is required"))?;
    let video = video.ok_or_else(|| AppError::bad_request("video is required"))?;
    let mut inner = state.inner.lock().await;
    if inner.active_job.is_some() {
        return Err(AppError::bad_request(
            "a subtitle generation job is already active",
        ));
    }
    let workspace = inner
        .sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("subtitle session not found"))?;
    let safe_name = filename
        .unwrap_or_else(|| "video.mp4".to_string())
        .replace(['/', '\\'], "_");
    tokio::fs::write(workspace.join(&safe_name), video)
        .await
        .map_err(|_| AppError::internal("could not store uploaded video"))?;
    let id = Uuid::new_v4().to_string();
    let (sender, _) = broadcast::channel(64);
    state.events.lock().await.insert(id.clone(), sender.clone());
    let cancellation = CancellationHandle::new();
    let job = Job {
        job_id: id.clone(),
        session_id,
        state: "queued".to_string(),
        phase: "queued".to_string(),
        progress: 0,
        message: "subtitle generation queued".to_string(),
        source_track: None,
        translation_track: None,
        cancellation: cancellation.clone(),
    };
    inner.jobs.insert(id.clone(), job.clone());
    inner.active_job = Some(id.clone());
    drop(inner);
    let video_path = workspace.join(safe_name);
    let cache_dir = state.cache_dir.clone();
    let state_for_run = state.clone();
    tokio::task::spawn_blocking(move || {
        run_native_job(
            state_for_run,
            id,
            video_path,
            source_language,
            target_language,
            diarize,
            cancellation,
            sender,
            cache_dir,
        )
    });
    Ok(Json(job))
}

pub async fn get_job(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    state
        .inner
        .lock()
        .await
        .jobs
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or_else(|| AppError::not_found("subtitle job not found"))
}

pub async fn cancel_job(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    let mut inner = state.inner.lock().await;
    let job = inner
        .jobs
        .get_mut(&id)
        .ok_or_else(|| AppError::not_found("subtitle job not found"))?;
    job.cancellation.cancel();
    job.message = "cancellation requested".to_string();
    Ok(Json(job.clone()))
}

pub async fn events(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let sender = app
        .generation
        .events
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| AppError::not_found("subtitle job not found"))?;
    let mut receiver = sender.subscribe();
    Ok(Sse::new(async_stream::stream! {
        while let Ok(data) = receiver.recv().await {
            yield Ok(Event::default().event("progress").data(data));
        }
    })
    .keep_alive(KeepAlive::default()))
}

#[allow(clippy::too_many_arguments)]
fn run_native_job(
    state: GenerationState,
    job_id: String,
    video_path: PathBuf,
    source_language: Option<String>,
    target_language: Option<String>,
    diarize: bool,
    cancellation: CancellationHandle,
    sender: broadcast::Sender<String>,
    cache_dir: PathBuf,
) {
    let mut config = NativeWhisperxConfig {
        input: InputSource::Path {
            path: video_path.clone(),
        },
        asr: Default::default(),
        translation: Default::default(),
        vad: Default::default(),
        alignment: Default::default(),
        diarization: Default::default(),
        output: OutputConfig::default(),
    };
    config.asr.model_dir = Some(cache_dir.clone());
    config.asr.language = source_language.clone();
    config.diarization.enabled = diarize;
    config.output.formats.clear();
    let mut observer = SseObserver {
        sender: sender.clone(),
    };
    let _ = sender.send("{\"state\":\"running\",\"phase\":\"transcribing\"}".to_string());

    let result = match run_with_control(config, &mut observer, &cancellation) {
        Ok(FiniteTranscriptionOutcome::Completed(report)) => {
            let source_track = track_from_transcript(&report.response.transcript, false);
            match target_language.as_deref() {
                None => NativeJobResult::Completed {
                    source_track,
                    translation_track: None,
                    message: "source subtitles generated".to_string(),
                },
                Some(target_language) => match translate_track(
                    &report.response,
                    source_language.as_deref(),
                    target_language,
                    &cache_dir,
                    &video_path,
                    &mut observer,
                    &cancellation,
                ) {
                    TranslationAttempt::Completed(translation_track) => NativeJobResult::Completed {
                        source_track,
                        translation_track: Some(translation_track),
                        message: "source and translated subtitles generated".to_string(),
                    },
                    TranslationAttempt::SkippedSameLanguage => NativeJobResult::Completed {
                        source_track,
                        translation_track: None,
                        message: "source subtitles generated; target language matches source"
                            .to_string(),
                    },
                    TranslationAttempt::Cancelled => NativeJobResult::Cancelled {
                        source_track: Some(source_track),
                    },
                    TranslationAttempt::Failed(message) => NativeJobResult::Completed {
                        source_track,
                        translation_track: None,
                        message: format!("source subtitles generated; translation failed: {message}"),
                    },
                },
            }
        }
        Ok(FiniteTranscriptionOutcome::Cancelled(_)) => NativeJobResult::Cancelled {
            source_track: None,
        },
        Err(error) => NativeJobResult::Failed {
            source_track: None,
            message: error.to_string(),
        },
    };

    let runtime = tokio::runtime::Handle::current();
    runtime.block_on(async move {
        let mut inner = state.inner.lock().await;
        let Some(job) = inner.jobs.get_mut(&job_id) else {
            return;
        };
        match result {
            NativeJobResult::Completed {
                source_track,
                translation_track,
                message,
            } => {
                job.state = "completed".to_string();
                job.phase = "completed".to_string();
                job.progress = 100;
                job.message = message;
                job.source_track = Some(source_track);
                job.translation_track = translation_track;
            }
            NativeJobResult::Cancelled { source_track } => {
                job.state = "cancelled".to_string();
                job.phase = "cancelled".to_string();
                job.message = "generation cancelled".to_string();
                job.source_track = source_track;
            }
            NativeJobResult::Failed {
                source_track,
                message,
            } => {
                job.state = "failed".to_string();
                job.phase = "failed".to_string();
                job.message = message;
                job.source_track = source_track;
            }
        }
        let payload = serde_json::to_string(&*job)
            .unwrap_or_else(|_| "{\"state\":\"failed\"}".to_string());
        inner.active_job = None;
        let _ = sender.send(payload);
    });
}

fn translate_track(
    response: &TranscriptionPipelineResponse,
    explicit_source_language: Option<&str>,
    target_language: &str,
    cache_dir: &PathBuf,
    video_path: &PathBuf,
    observer: &mut dyn TranscriptionProgressObserver,
    cancellation: &CancellationHandle,
) -> TranslationAttempt {
    let source_language = explicit_source_language.or(response.transcript.language.as_deref());
    let Some(source_language) = source_language else {
        return TranslationAttempt::Failed(
            "Native WhisperX did not report a source language".to_string(),
        );
    };
    if source_language.eq_ignore_ascii_case(target_language) {
        return TranslationAttempt::SkippedSameLanguage;
    }

    let plan = match TranslationPlan::from_language_codes(source_language, target_language) {
        Ok(plan) => plan,
        Err(error) => return TranslationAttempt::Failed(error.to_string()),
    };
    let mut provider = NativeOpusMtTranslationProvider::new(NativeOpusMtTranslationProviderConfig {
        model_dir: Some(cache_dir.clone()),
        ..Default::default()
    });
    match translate_transcription_with_control(
        response,
        &plan,
        &mut provider,
        0,
        video_path.clone(),
        observer,
        cancellation,
    ) {
        Ok(TranslatedTranscriptionOutcome::Completed(translated)) => {
            let pivoted = matches!(
                translated.provenance(),
                TranslationPlanProvenance::PivotTranslation { .. }
            );
            TranslationAttempt::Completed(track_from_transcript(translated.transcript(), pivoted))
        }
        Ok(TranslatedTranscriptionOutcome::Cancelled(_)) => TranslationAttempt::Cancelled,
        Err(error) => TranslationAttempt::Failed(error.to_string()),
    }
}

fn track_from_transcript(transcript: &TranscriptionContract, pivoted: bool) -> Track {
    Track {
        language: transcript
            .language
            .clone()
            .unwrap_or_else(|| "und".to_string()),
        pivoted,
        cues: transcript
            .segments
            .iter()
            .map(|segment| Cue {
                start_ms: (segment.start_seconds.unwrap_or(0.0).max(0.0) * 1000.0).round() as u64,
                end_ms: (segment
                    .end_seconds
                    .unwrap_or(segment.start_seconds.unwrap_or(0.0))
                    .max(0.0)
                    * 1000.0)
                    .round() as u64,
                text: segment.text.clone(),
                actor: segment.speaker.clone(),
            })
            .collect(),
    }
}

struct SseObserver {
    sender: broadcast::Sender<String>,
}

impl TranscriptionProgressObserver for SseObserver {
    fn observe(&mut self, event: TranscriptionProgressEvent) {
        let _ = self.sender.send(
            serde_json::json!({ "state": "running", "phase": format!("{event:?}") }).to_string(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::track_from_transcript;
    use native_whisperx::{TranscriptSegmentContract, TranscriptionContract};

    #[test]
    fn transcript_track_preserves_speaker_as_cue_actor() {
        let mut spoken = TranscriptSegmentContract::new(0, "Hello there");
        spoken.start_seconds = Some(1.25);
        spoken.end_seconds = Some(2.5);
        spoken.speaker = Some("Speaker 1".to_string());

        let mut silent_actor = TranscriptSegmentContract::new(1, "No speaker label");
        silent_actor.start_seconds = Some(2.5);
        silent_actor.end_seconds = Some(3.0);

        let mut transcript = TranscriptionContract::new(vec![spoken, silent_actor]);
        transcript.language = Some("en".to_string());

        let track = track_from_transcript(&transcript, false);
        assert_eq!(track.cues[0].actor.as_deref(), Some("Speaker 1"));
        assert_eq!(track.cues[0].text, "Hello there");
        assert_eq!(track.cues[1].actor, None);

        let json = serde_json::to_value(&track).expect("track serialization");
        assert_eq!(json["cues"][0]["actor"], "Speaker 1");
        assert!(json["cues"][1].get("actor").is_none());
    }
}
