use std::{collections::HashMap, env, path::PathBuf, process::Command, sync::Arc};

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
};
use serde::Serialize;
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

use native_whisperx::{
    CancellationHandle, FiniteTranscriptionOutcome, InputSource, NativeOpusMtTranslationProvider,
    NativeOpusMtTranslationProviderConfig, NativeWhisperxConfig, OutputConfig,
    TranscriptionContract, TranscriptionPipelineResponse, TranscriptionProgressEvent,
    TranscriptionProgressObserver, TranslatedTranscriptionOutcome, TranslationPlan,
    TranslationPlanProvenance, run_with_control, translate_transcription_with_control,
};

use crate::{AppError, AppState, RegisteredFileKind};

mod contracts;

use contracts::{JobPhase, JobState, phase_for_event};

const DEFAULT_MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024 * 1024;
// The selected native-whisperx features do not include a diarization provider.
// Keep capability reporting and command validation together, not in the UI.
const DIARIZATION_AVAILABLE: bool = false;

fn env_flag(name: &str) -> bool {
    env::var(name).is_ok_and(|value| {
        matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
    })
}

fn recoverable_alignment_error(message: &str) -> bool {
    message.contains("model_output_mismatch") && message.contains("CTC path is impossible")
}

fn completion_message(base: &str, alignment_warning: Option<&str>) -> String {
    alignment_warning.map_or_else(
        || base.to_string(),
        |warning| format!("{base}; word alignment was skipped after a recoverable native alignment failure: {warning}"),
    )
}

#[derive(Clone)]
pub struct GenerationState {
    inner: Arc<Mutex<Inner>>,
    cache_dir: PathBuf,
    max_upload_bytes: u64,
    model_cache_only: bool,
    events: Arc<Mutex<HashMap<String, broadcast::Sender<Job>>>>,
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
    state: JobState,
    phase: JobPhase,
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
    model_downloads_automatic: bool,
    diarization_available: bool,
}

enum NativeJobResult {
    Completed { source_track: Track, translation_track: Option<Track>, message: String },
    Cancelled { source_track: Option<Track> },
    Failed { source_track: Option<Track>, message: String },
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
        let model_cache_only = env_flag("SUBTITLE_MODEL_CACHE_ONLY");
        Self {
            inner: Arc::new(Mutex::new(Inner {
                sessions: HashMap::new(), jobs: HashMap::new(), active_job: None,
            })),
            cache_dir,
            max_upload_bytes,
            model_cache_only,
            events: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn publish_phase(&self, id: &str, sender: &broadcast::Sender<Job>, phase: JobPhase) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.get_mut(id) {
            if job.state.is_terminal() { return; }
            job.state = JobState::Running;
            job.phase = phase;
            // No invented download percentage: Native WhisperX reports lifecycle events.
            job.message = format!("{phase:?}");
            let _ = sender.send(job.clone());
        }
    }
}

pub async fn create_session(State(app): State<AppState>) -> Result<Json<SessionResponse>, AppError> {
    let state = app.generation;
    let id = Uuid::new_v4().to_string();
    let workspace = env::temp_dir().join("subtitle-merger").join(&id);
    tokio::fs::create_dir_all(&workspace).await
        .map_err(|_| AppError::internal("could not create session workspace"))?;
    state.inner.lock().await.sessions.insert(id.clone(), workspace);
    Ok(Json(SessionResponse { session_id: id }))
}

pub async fn delete_session(State(app): State<AppState>, Path(id): Path<String>) -> Result<StatusCode, AppError> {
    let state = app.generation;
    let mut inner = state.inner.lock().await;
    if inner.jobs.values().any(|job| job.session_id == id && !job.state.is_terminal()) {
        return Err(AppError::bad_request("wait for the active job to finish cancelling before deleting its session"));
    }
    let workspace = inner.sessions.remove(&id)
        .ok_or_else(|| AppError::not_found("subtitle session not found"))?;
    drop(inner);
    let _ = tokio::fs::remove_dir_all(workspace).await;
    Ok(StatusCode::NO_CONTENT)
}

fn command_available(name: &str) -> bool {
    Command::new(name).arg("-version").output()
        .is_ok_and(|output| output.status.success())
}

pub async fn preflight(State(app): State<AppState>) -> Json<PreflightResponse> {
    let state = app.generation;
    let (ffmpeg_available, ffprobe_available) = tokio::task::spawn_blocking(|| {
        (command_available("ffmpeg"), command_available("ffprobe"))
    }).await.unwrap_or((false, false));
    Json(PreflightResponse {
        ready: ffmpeg_available && ffprobe_available,
        ffmpeg_available,
        ffprobe_available,
        cache_dir: state.cache_dir.display().to_string(),
        max_upload_bytes: state.max_upload_bytes,
        native_whisperx_version: "0.1.14",
        model_downloads_automatic: !state.model_cache_only,
        diarization_available: DIARIZATION_AVAILABLE,
    })
}

fn registered_video_path(app: &AppState, id: &str) -> Result<PathBuf, AppError> {
    let file = app.get_file(id)?;
    if file.kind != RegisteredFileKind::Video {
        return Err(AppError::bad_request("mediaId must identify an opened reference video"));
    }
    Ok(file.path)
}

pub async fn create_job(State(app): State<AppState>, mut multipart: Multipart) -> Result<Json<Job>, AppError> {
    let state = app.generation.clone();
    let mut session_id = None;
    let mut media_id = None;
    let mut filename = None;
    let mut video = None;
    let mut source_language = None;
    let mut target_language = None;
    let mut diarize = false;
    while let Some(field) = multipart.next_field().await
        .map_err(|_| AppError::bad_request("invalid multipart upload"))?
    {
        match field.name() {
            Some("sessionId") => session_id = Some(field.text().await.map_err(|_| AppError::bad_request("invalid session id"))?),
            Some("mediaId") => media_id = Some(field.text().await.map_err(|_| AppError::bad_request("invalid media id"))?),
            Some("sourceLanguage") => source_language = Some(field.text().await.map_err(|_| AppError::bad_request("invalid source language"))?),
            Some("targetLanguage") => target_language = Some(field.text().await.map_err(|_| AppError::bad_request("invalid target language"))?),
            Some("diarize") => diarize = field.text().await.unwrap_or_default() == "true",
            Some("video") => {
                filename = field.file_name().map(ToOwned::to_owned);
                let bytes = field.bytes().await.map_err(|_| AppError::bad_request("video upload failed"))?;
                if bytes.len() as u64 > state.max_upload_bytes {
                    return Err(AppError::bad_request("video exceeds configured upload limit"));
                }
                video = Some(bytes);
            }
            _ => {}
        }
    }
    if diarize && !DIARIZATION_AVAILABLE {
        return Err(AppError::bad_request("Speaker identification is not available in this build. Turn off Identify speakers and retry."));
    }
    let session_id = session_id.ok_or_else(|| AppError::bad_request("sessionId is required"))?;
    let registered_path = media_id.as_deref().map(|id| registered_video_path(&app, id)).transpose()?;
    if registered_path.is_none() && video.is_none() {
        return Err(AppError::bad_request("mediaId or video is required"));
    }
    if registered_path.is_some() && video.is_some() {
        return Err(AppError::bad_request("provide mediaId or video, not both"));
    }
    let mut inner = state.inner.lock().await;
    if inner.active_job.is_some() {
        return Err(AppError::bad_request("a subtitle generation job is already active"));
    }
    let workspace = inner.sessions.get(&session_id).cloned()
        .ok_or_else(|| AppError::not_found("subtitle session not found"))?;
    // The local editor sends an opaque registered media ID. No complete browser-side
    // copy or re-upload is necessary, and ordinary videos do not hit Multipart's limit.
    let video_path = if let Some(path) = registered_path {
        path
    } else {
        let safe_name = filename.unwrap_or_else(|| "video.mp4".to_string()).replace(['/', '\\'], "_");
        let path = workspace.join(safe_name);
        tokio::fs::write(&path, video.expect("uploaded media was validated")).await
            .map_err(|_| AppError::internal("could not store uploaded video"))?;
        path
    };
    let id = Uuid::new_v4().to_string();
    let (sender, _) = broadcast::channel(64);
    state.events.lock().await.insert(id.clone(), sender.clone());
    let cancellation = CancellationHandle::new();
    let job = Job {
        job_id: id.clone(), session_id, state: JobState::Queued, phase: JobPhase::Queued,
        progress: 0, message: "subtitle generation queued".to_string(),
        source_track: None, translation_track: None, cancellation: cancellation.clone(),
    };
    inner.jobs.insert(id.clone(), job.clone());
    inner.active_job = Some(id.clone());
    drop(inner);
    let cache_dir = state.cache_dir.clone();
    tokio::task::spawn_blocking(move || {
        run_native_job(state, id, video_path, source_language, target_language, cancellation, sender, cache_dir)
    });
    Ok(Json(job))
}

pub async fn get_job(State(app): State<AppState>, Path(id): Path<String>) -> Result<Json<Job>, AppError> {
    app.generation.inner.lock().await.jobs.get(&id).cloned().map(Json)
        .ok_or_else(|| AppError::not_found("subtitle job not found"))
}

pub async fn cancel_job(State(app): State<AppState>, Path(id): Path<String>) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    let mut inner = state.inner.lock().await;
    let job = inner.jobs.get_mut(&id).ok_or_else(|| AppError::not_found("subtitle job not found"))?;
    if !job.state.is_terminal() {
        job.cancellation.cancel();
        job.message = "cancellation requested".to_string();
        if let Some(sender) = state.events.lock().await.get(&id) {
            let _ = sender.send(job.clone());
        }
    }
    Ok(Json(job.clone()))
}

pub async fn events(State(app): State<AppState>, Path(id): Path<String>)
    -> Result<Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>>, AppError>
{
    let state = app.generation;
    // Subscribe and snapshot under the same lock used by publishers: no initial
    // event gap and no older queued event can follow the initial snapshot.
    let inner = state.inner.lock().await;
    let mut snapshot = inner.jobs.get(&id).cloned()
        .ok_or_else(|| AppError::not_found("subtitle job not found"))?;
    let mut receiver = state.events.lock().await.get(&id)
        .ok_or_else(|| AppError::not_found("subtitle job not found"))?.subscribe();
    drop(inner);
    Ok(Sse::new(async_stream::stream! {
        loop {
            if let Ok(data) = serde_json::to_string(&snapshot) {
                yield Ok(Event::default().event("progress").data(data));
            }
            if snapshot.state.is_terminal() { break; }
            snapshot = match receiver.recv().await {
                Ok(job) => job,
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let inner = state.inner.lock().await;
                    loop {
                        match receiver.try_recv() {
                            Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                            Err(_) => break,
                        }
                    }
                    let Some(job) = inner.jobs.get(&id).cloned() else { break; };
                    job
                }
            };
        }
    }).keep_alive(KeepAlive::default()))
}

fn native_config(
    video_path: PathBuf,
    cache_dir: PathBuf,
    language: Option<String>,
    model_cache_only: bool,
) -> NativeWhisperxConfig {
    let mut config = NativeWhisperxConfig {
        input: InputSource::Path { path: video_path },
        asr: Default::default(), translation: Default::default(), vad: Default::default(),
        alignment: Default::default(), diarization: Default::default(), output: OutputConfig::default(),
    };
    // Native WhisperX owns model resolution, downloads and cache reuse. These are
    // application policy, not a second model installer or a prerequisite setup step.
    config.asr.model_dir = Some(cache_dir.clone());
    config.asr.model_cache_only = model_cache_only;
    config.asr.language = language;
    config.alignment.model_dir = Some(cache_dir);
    config.alignment.model_cache_only = model_cache_only;
    config.diarization.enabled = false;
    // Keep the native format contract valid. output_dir=None already disables
    // file writes; clearing formats instead rejects every job before model setup.
    config.output.output_dir = None;
    config
}

#[allow(clippy::too_many_arguments)]
fn run_native_job(
    state: GenerationState, job_id: String, video_path: PathBuf,
    source_language: Option<String>, target_language: Option<String>,
    cancellation: CancellationHandle, sender: broadcast::Sender<Job>, cache_dir: PathBuf,
) {
    let model_cache_only = state.model_cache_only;
    let config = native_config(
        video_path.clone(), cache_dir.clone(), source_language.clone(), model_cache_only,
    );
    let mut observer = SseObserver {
        state: state.clone(), job_id: job_id.clone(), sender: sender.clone(), alignment_attempted: false,
    };
    observer.publish(JobPhase::CheckingModels);

    let result = if let Err(error) = std::fs::create_dir_all(&cache_dir) {
        NativeJobResult::Failed {
            source_track: None,
            message: format!("Could not create model cache {}: {error}. Set SUBTITLE_MODEL_CACHE_DIR to a writable directory and retry.", cache_dir.display()),
        }
    } else {
        let initial = run_with_control(config, &mut observer, &cancellation);
        let mut alignment_warning = None;
        let transcription = match initial {
            Err(error) if observer.alignment_attempted && recoverable_alignment_error(&error.to_string()) => {
                let warning = error.to_string();
                tracing::warn!(%warning, "native word alignment failed; retrying transcription without alignment");
                alignment_warning = Some(warning);
                let mut fallback = native_config(
                    video_path.clone(), cache_dir.clone(), source_language.clone(), model_cache_only,
                );
                fallback.alignment.enabled = false;
                observer.publish(JobPhase::Transcribing);
                run_with_control(fallback, &mut observer, &cancellation)
            }
            other => other,
        };
        match transcription {
            Ok(FiniteTranscriptionOutcome::Completed(report)) => {
                let source_track = track_from_transcript(&report.response.transcript, false);
                let warning = alignment_warning.as_deref();
                match target_language.as_deref() {
                    None => NativeJobResult::Completed {
                        source_track,
                        translation_track: None,
                        message: completion_message("source subtitles generated", warning),
                    },
                    Some(target_language) => match translate_track(
                        &report.response, source_language.as_deref(), target_language,
                        &cache_dir, model_cache_only, &video_path, &mut observer, &cancellation,
                    ) {
                        TranslationAttempt::Completed(track) => NativeJobResult::Completed {
                            source_track,
                            translation_track: Some(track),
                            message: completion_message("source and translated subtitles generated", warning),
                        },
                        TranslationAttempt::SkippedSameLanguage => NativeJobResult::Completed {
                            source_track,
                            translation_track: None,
                            message: completion_message("source subtitles generated; target language matches source", warning),
                        },
                        TranslationAttempt::Cancelled => NativeJobResult::Cancelled { source_track: Some(source_track) },
                        TranslationAttempt::Failed(message) => NativeJobResult::Completed {
                            source_track,
                            translation_track: None,
                            message: format!("{}; translation failed: {message}. Check network access and cache permissions, then retry.", completion_message("source subtitles generated", warning)),
                        },
                    },
                }
            }
            Ok(FiniteTranscriptionOutcome::Cancelled(_)) => NativeJobResult::Cancelled { source_track: None },
            Err(error) => NativeJobResult::Failed {
                source_track: None,
                message: format!("{error}. On first use, check network access and free space in {}. Retry generation after correcting the problem.", cache_dir.display()),
            },
        }
    };

    tokio::runtime::Handle::current().block_on(async move {
        let mut inner = state.inner.lock().await;
        let Some(job) = inner.jobs.get_mut(&job_id) else { return; };
        match result {
            NativeJobResult::Completed { source_track, translation_track, message } => {
                job.state = JobState::Completed; job.phase = JobPhase::Completed; job.progress = 100;
                job.message = message; job.source_track = Some(source_track); job.translation_track = translation_track;
            }
            NativeJobResult::Cancelled { source_track } => {
                job.state = JobState::Cancelled; job.phase = JobPhase::Cancelled;
                job.message = "generation cancelled".to_string(); job.source_track = source_track;
            }
            NativeJobResult::Failed { source_track, message } => {
                job.state = JobState::Failed; job.phase = JobPhase::Failed;
                job.message = message; job.source_track = source_track;
            }
        }
        let _ = sender.send(job.clone());
        inner.active_job = None;
    });
}

fn translation_config(cache_dir: PathBuf, model_cache_only: bool) -> NativeOpusMtTranslationProviderConfig {
    NativeOpusMtTranslationProviderConfig {
        model_dir: Some(cache_dir),
        model_cache_only,
        ..Default::default()
    }
}

fn translate_track(
    response: &TranscriptionPipelineResponse, explicit_source_language: Option<&str>, target_language: &str,
    cache_dir: &PathBuf, model_cache_only: bool, video_path: &PathBuf,
    observer: &mut dyn TranscriptionProgressObserver, cancellation: &CancellationHandle,
) -> TranslationAttempt {
    let Some(source_language) = explicit_source_language.or(response.transcript.language.as_deref()) else {
        return TranslationAttempt::Failed("Native WhisperX did not report a source language".to_string());
    };
    if source_language.eq_ignore_ascii_case(target_language) { return TranslationAttempt::SkippedSameLanguage; }
    let plan = match TranslationPlan::from_language_codes(source_language, target_language) {
        Ok(plan) => plan,
        Err(error) => return TranslationAttempt::Failed(error.to_string()),
    };
    let mut provider = NativeOpusMtTranslationProvider::new(translation_config(cache_dir.clone(), model_cache_only));
    match translate_transcription_with_control(response, &plan, &mut provider, 0, video_path.clone(), observer, cancellation) {
        Ok(TranslatedTranscriptionOutcome::Completed(translated)) => {
            let pivoted = matches!(translated.provenance(), TranslationPlanProvenance::PivotTranslation { .. });
            TranslationAttempt::Completed(track_from_transcript(translated.transcript(), pivoted))
        }
        Ok(TranslatedTranscriptionOutcome::Cancelled(_)) => TranslationAttempt::Cancelled,
        Err(error) => TranslationAttempt::Failed(error.to_string()),
    }
}

fn track_from_transcript(transcript: &TranscriptionContract, pivoted: bool) -> Track {
    Track {
        language: transcript.language.clone().unwrap_or_else(|| "und".to_string()),
        pivoted,
        cues: transcript.segments.iter().map(|segment| Cue {
            start_ms: (segment.start_seconds.unwrap_or(0.0).max(0.0) * 1000.0).round() as u64,
            end_ms: (segment.end_seconds.unwrap_or(segment.start_seconds.unwrap_or(0.0)).max(0.0) * 1000.0).round() as u64,
            text: segment.text.clone(), actor: segment.speaker.clone(),
        }).collect(),
    }
}

struct SseObserver {
    state: GenerationState,
    job_id: String,
    sender: broadcast::Sender<Job>,
    alignment_attempted: bool,
}

impl SseObserver {
    fn publish(&self, phase: JobPhase) {
        tokio::runtime::Handle::current().block_on(self.state.publish_phase(&self.job_id, &self.sender, phase));
    }
}

impl TranscriptionProgressObserver for SseObserver {
    fn observe(&mut self, event: TranscriptionProgressEvent) {
        if let Some(phase) = phase_for_event(&event) {
            if phase == JobPhase::Aligning {
                self.alignment_attempted = true;
            }
            self.publish(phase);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use native_whisperx::{TranscriptSegmentContract, TranscriptionContract};

    fn job() -> Job {
        Job {
            job_id: "job".into(), session_id: "session".into(), state: JobState::Queued,
            phase: JobPhase::Queued, progress: 0, message: "queued".into(),
            source_track: None, translation_track: None, cancellation: CancellationHandle::new(),
        }
    }

    #[test]
    fn first_use_config_allows_downloads_and_shares_the_application_cache() {
        let root = PathBuf::from("unused-test-cache");
        let config = native_config("video.mp4".into(), root.clone(), None, false);
        assert_eq!(config.asr.model_dir.as_ref(), Some(&root));
        assert_eq!(config.alignment.model_dir.as_ref(), Some(&root));
        assert!(!config.asr.model_cache_only);
        assert!(!config.alignment.model_cache_only);
        let translation = translation_config(root.clone(), false);
        assert_eq!(translation.model_dir.as_ref(), Some(&root));
        assert!(!translation.model_cache_only);
        assert!(!config.diarization.enabled);
        assert!(config.output.output_dir.is_none());
        let request = native_whisperx::build_transcription_request(&config)
            .expect("application config must pass the real native validator without loading models");
        assert_eq!(request.output.formats, vec!["json"]);
    }

    #[test]
    fn cache_only_policy_applies_to_asr_alignment_and_translation() {
        let root = PathBuf::from("existing-model-cache");
        let config = native_config("video.mp4".into(), root.clone(), None, true);
        let translation = translation_config(root, true);
        assert!(config.asr.model_cache_only);
        assert!(config.alignment.model_cache_only);
        assert!(translation.model_cache_only);
    }

    #[test]
    fn only_the_observed_ctc_impossible_alignment_failure_is_recoverable() {
        assert!(recoverable_alignment_error(
            "transcription failed: invalid argument: model_output_mismatch: CTC path is impossible"
        ));
        assert!(!recoverable_alignment_error(
            "failed to resolve alignment model: cache-only=true"
        ));
        assert!(!recoverable_alignment_error("transcription model failed to load"));
    }

    #[test]
    fn completion_message_keeps_the_alignment_degradation_visible() {
        let message = completion_message("source subtitles generated", Some("CTC path is impossible"));
        assert!(message.contains("source subtitles generated"));
        assert!(message.contains("word alignment was skipped"));
        assert!(message.contains("CTC path is impossible"));
    }

    #[test]
    fn native_output_config_does_not_write_files_and_empty_formats_reproduce_the_old_failure() {
        let mut config = native_config("video.mp4".into(), "unused-test-cache".into(), None, false);
        let response = TranscriptionPipelineResponse {
            accepted: true,
            operation: "transcribe".into(),
            provider: "native".into(),
            model_id: "small".into(),
            transcript: TranscriptionContract::new(Vec::new()),
            vad_segments: Vec::new(),
            alignment: None,
            diarization: None,
            artifacts: Vec::new(),
            diagnostics: Vec::new(),
        };
        assert!(native_whisperx::write_outputs(&response, &config.output)
            .expect("no output directory means no file writes").is_empty());
        config.output.formats.clear();
        assert!(native_whisperx::build_transcription_request(&config)
            .expect_err("the previous application config rejected every job")
            .to_string().contains("at least one output format is required"));
    }

    #[tokio::test]
    async fn model_progress_is_retained_and_cannot_overwrite_a_terminal_job() {
        let state = GenerationState::new();
        state.inner.lock().await.jobs.insert("job".into(), job());
        let (sender, mut receiver) = broadcast::channel(4);
        state.publish_phase("job", &sender, JobPhase::DownloadingModels).await;
        let event = receiver.recv().await.ok().unwrap();
        assert_eq!(event.state, JobState::Running);
        assert_eq!(event.phase, JobPhase::DownloadingModels);
        assert_eq!(state.inner.lock().await.jobs["job"].phase, event.phase);
        state.inner.lock().await.jobs.get_mut("job").unwrap().state = JobState::Failed;
        state.publish_phase("job", &sender, JobPhase::LoadingModels).await;
        assert_eq!(state.inner.lock().await.jobs["job"].state, JobState::Failed);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn completed_job_is_replayed_to_a_late_event_subscriber() {
        use axum::response::IntoResponse;
        use http_body_util::BodyExt;
        let app = AppState::new();
        let mut completed = job();
        completed.state = JobState::Completed;
        completed.phase = JobPhase::Completed;
        app.generation.inner.lock().await.jobs.insert("job".into(), completed);
        let (sender, _) = broadcast::channel(4);
        app.generation.events.lock().await.insert("job".into(), sender);
        let response = events(State(app), Path("job".into())).await.ok().unwrap().into_response();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("event: progress"));
        assert!(text.contains("\"state\":\"completed\""));
    }

    #[test]
    fn registered_video_lookup_does_not_accept_subtitles_or_paths_as_ids() {
        let app = AppState::new();
        let id = app.register_file(crate::RegisteredFile {
            path: "movie.mp4".into(), mime_type: "video/mp4".into(), kind: RegisteredFileKind::Video,
        }).ok().unwrap();
        assert_eq!(registered_video_path(&app, &id).ok().unwrap(), PathBuf::from("movie.mp4"));
        assert!(registered_video_path(&app, "/etc/passwd").is_err());
        let subtitle = app.register_file(crate::RegisteredFile {
            path: "captions.srt".into(), mime_type: "text/plain".into(), kind: RegisteredFileKind::Subtitle,
        }).ok().unwrap();
        assert!(registered_video_path(&app, &subtitle).is_err());
    }

    #[test]
    fn missing_transcript_language_stays_unknown_instead_of_being_guessed() {
        let mut segment = TranscriptSegmentContract::new(0, "Hello");
        segment.start_seconds = Some(0.0);
        segment.end_seconds = Some(1.0);
        let transcript = TranscriptionContract::new(vec![segment]);

        let track = track_from_transcript(&transcript, false);

        assert_eq!(track.language, "und");
    }

    #[test]
    fn transcript_track_preserves_speaker_as_cue_actor() {
        let mut spoken = TranscriptSegmentContract::new(0, "Hello there");
        spoken.start_seconds = Some(1.25); spoken.end_seconds = Some(2.5);
        spoken.speaker = Some("Speaker 1".to_string());
        let mut silent_actor = TranscriptSegmentContract::new(1, "No speaker label");
        silent_actor.start_seconds = Some(2.5); silent_actor.end_seconds = Some(3.0);
        let mut transcript = TranscriptionContract::new(vec![spoken, silent_actor]);
        transcript.language = Some("en".to_string());
        let track = track_from_transcript(&transcript, false);
        assert_eq!(track.cues[0].actor.as_deref(), Some("Speaker 1"));
        assert_eq!(track.cues[0].text, "Hello there");
        assert_eq!(track.cues[1].actor, None);
        let json = serde_json::to_value(&track).unwrap();
        assert_eq!(json["cues"][0]["actor"], "Speaker 1");
        assert!(json["cues"][1].get("actor").is_none());
    }
}
