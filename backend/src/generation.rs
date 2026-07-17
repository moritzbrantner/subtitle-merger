use std::{collections::HashMap, env, path::PathBuf, process::Command, sync::Arc};

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use serde::Serialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{AppError, AppState};

const DEFAULT_MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Clone)]
pub struct GenerationState {
    inner: Arc<Mutex<Inner>>,
    cache_dir: PathBuf,
    max_upload_bytes: u64,
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
struct Cue { start_ms: u64, end_ms: u64, text: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse { session_id: String }

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

impl GenerationState {
    pub fn new() -> Self {
        let cache_dir = env::var_os("SUBTITLE_MODEL_CACHE_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::cache_dir().map(|path| path.join("subtitle-merger/models")))
            .unwrap_or_else(|| PathBuf::from(".subtitle-merger/models"));
        let max_upload_bytes = env::var("SUBTITLE_MAX_UPLOAD_BYTES").ok()
            .and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_MAX_UPLOAD_BYTES);
        Self { inner: Arc::new(Mutex::new(Inner { sessions: HashMap::new(), jobs: HashMap::new(), active_job: None })), cache_dir, max_upload_bytes }
    }
}

pub async fn create_session(State(app): State<AppState>) -> Result<Json<SessionResponse>, AppError> {
    let state = app.generation;
    let id = Uuid::new_v4().to_string();
    let workspace = env::temp_dir().join("subtitle-merger").join(&id);
    tokio::fs::create_dir_all(&workspace).await.map_err(|_| AppError::internal("could not create session workspace"))?;
    state.inner.lock().await.sessions.insert(id.clone(), workspace);
    Ok(Json(SessionResponse { session_id: id }))
}

pub async fn delete_session(State(app): State<AppState>, Path(id): Path<String>) -> Result<StatusCode, AppError> {
    let state = app.generation;
    let workspace = state.inner.lock().await.sessions.remove(&id).ok_or_else(|| AppError::not_found("subtitle session not found"))?;
    let _ = tokio::fs::remove_dir_all(workspace).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn preflight(State(app): State<AppState>) -> Json<PreflightResponse> {
    let state = app.generation;
    let ffmpeg_available = Command::new("ffmpeg").arg("-version").output().is_ok();
    let ffprobe_available = Command::new("ffprobe").arg("-version").output().is_ok();
    Json(PreflightResponse { ready: ffmpeg_available && ffprobe_available, ffmpeg_available, ffprobe_available, cache_dir: state.cache_dir.display().to_string(), max_upload_bytes: state.max_upload_bytes, native_whisperx_version: "0.1.13" })
}

pub async fn create_job(State(app): State<AppState>, mut multipart: Multipart) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    let mut session_id = None;
    let mut filename = None;
    let mut video = None;
    while let Some(field) = multipart.next_field().await.map_err(|_| AppError::bad_request("invalid multipart upload"))? {
        match field.name() {
            Some("sessionId") => session_id = Some(field.text().await.map_err(|_| AppError::bad_request("invalid session id"))?),
            Some("video") => { filename = field.file_name().map(ToOwned::to_owned); let bytes = field.bytes().await.map_err(|_| AppError::bad_request("video upload failed"))?; if bytes.len() as u64 > state.max_upload_bytes { return Err(AppError::bad_request("video exceeds configured upload limit")); } video = Some(bytes); }
            _ => {}
        }
    }
    let session_id = session_id.ok_or_else(|| AppError::bad_request("sessionId is required"))?;
    let video = video.ok_or_else(|| AppError::bad_request("video is required"))?;
    let mut inner = state.inner.lock().await;
    if inner.active_job.is_some() { return Err(AppError::bad_request("a subtitle generation job is already active")); }
    let workspace = inner.sessions.get(&session_id).cloned().ok_or_else(|| AppError::not_found("subtitle session not found"))?;
    let safe_name = filename.unwrap_or_else(|| "video.mp4".to_string()).replace(['/', '\\'], "_");
    tokio::fs::write(workspace.join(safe_name), video).await.map_err(|_| AppError::internal("could not store uploaded video"))?;
    let id = Uuid::new_v4().to_string();
    let job = Job { job_id: id.clone(), session_id, state: "failed".to_string(), phase: "preflighting".to_string(), progress: 0, message: "native-whisperx 0.1.14 has not been published yet; generation is unavailable until the required released multi-language runtime is installed.".to_string(), source_track: None, translation_track: None };
    inner.jobs.insert(id.clone(), job.clone());
    Ok(Json(job))
}

pub async fn get_job(State(app): State<AppState>, Path(id): Path<String>) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    state.inner.lock().await.jobs.get(&id).cloned().map(Json).ok_or_else(|| AppError::not_found("subtitle job not found"))
}

pub async fn cancel_job(State(app): State<AppState>, Path(id): Path<String>) -> Result<Json<Job>, AppError> {
    let state = app.generation;
    let mut inner = state.inner.lock().await;
    let job = inner.jobs.get_mut(&id).ok_or_else(|| AppError::not_found("subtitle job not found"))?;
    job.state = "cancelled".to_string(); job.phase = "cancelled".to_string(); job.message = "generation cancelled".to_string();
    Ok(Json(job.clone()))
}

pub async fn events(Path(_id): Path<String>) -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(async_stream::stream! { yield Ok(Event::default().event("status").data("status polling is available at /api/subtitle-jobs/{id}")); }).keep_alive(KeepAlive::default())
}
