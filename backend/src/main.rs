use std::{
    collections::HashMap,
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{
        HeaderMap, StatusCode,
        header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    },
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, SeekFrom},
};
use tokio_util::io::ReaderStream;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::{EnvFilter, fmt};
use uuid::Uuid;

mod generation;

const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "vtt", "webvtt", "ass", "ssa"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv", "avi"];
const INFIX_TRIM_CHARS: &[char] = &[' ', '.', '-', '_'];

#[derive(Clone)]
pub(crate) struct AppState {
    registry: Arc<RwLock<HashMap<String, RegisteredFile>>>,
    pub(crate) generation: generation::GenerationState,
}

impl AppState {
    fn new() -> Self {
        Self {
            registry: Arc::new(RwLock::new(HashMap::new())),
            generation: generation::GenerationState::new(),
        }
    }

    fn register_file(&self, file: RegisteredFile) -> Result<String, AppError> {
        let id = Uuid::new_v4().to_string();
        let mut registry = self
            .registry
            .write()
            .map_err(|_| AppError::internal("media registry lock is poisoned"))?;

        registry.insert(id.clone(), file);

        Ok(id)
    }

    fn get_file(&self, id: &str) -> Result<RegisteredFile, AppError> {
        let registry = self
            .registry
            .read()
            .map_err(|_| AppError::internal("media registry lock is poisoned"))?;

        registry
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::not_found("registered file not found"))
    }
}

#[derive(Clone)]
struct RegisteredFile {
    path: PathBuf,
    mime_type: String,
    kind: RegisteredFileKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RegisteredFileKind {
    Video,
    Subtitle,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

#[derive(Deserialize)]
struct VideoLoadRequest {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoLoadResponse {
    load_id: String,
    video: LoadedVideo,
    subtitles: Vec<LoadedSubtitle>,
    warnings: Vec<LoadWarning>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedVideo {
    id: String,
    filename: String,
    stem: String,
    media_url: String,
    mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedSubtitle {
    id: String,
    filename: String,
    infix_title: String,
    media_url: String,
    text_url: String,
    format: String,
    mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadWarning {
    filename: String,
    message: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn unsupported_media_type(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            message: message.into(),
        }
    }

    fn range_not_satisfiable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[tokio::main]
async fn main() {
    init_tracing();

    let addr = env::var("SERVER_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
        .parse::<SocketAddr>()
        .expect("SERVER_ADDR must be a valid socket address");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind backend listener");

    tracing::info!("backend listening on http://{addr}");

    axum::serve(listener, app())
        .await
        .expect("backend server failed");
}

fn app() -> Router {
    app_with_state(AppState::new())
}

fn app_with_state(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/video-loads", post(create_video_load))
        .route("/api/media/{id}", get(get_media))
        .route("/api/subtitles/{id}", get(get_subtitle_text))
        .route("/api/generation-preflight", get(generation::preflight))
        .route("/api/subtitle-sessions", post(generation::create_session))
        .route("/api/subtitle-sessions/{id}", delete(generation::delete_session))
        .route("/api/subtitle-jobs", post(generation::create_job))
        .route("/api/subtitle-jobs/{id}", get(generation::get_job).delete(generation::cancel_job))
        .route("/api/subtitle-jobs/{id}/events", get(generation::events))
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    fmt().with_env_filter(filter).init();
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "subtitle-merger-backend",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn create_video_load(
    State(state): State<AppState>,
    Json(request): Json<VideoLoadRequest>,
) -> Result<Json<VideoLoadResponse>, AppError> {
    let raw_path = request.path.trim();

    if raw_path.is_empty() {
        return Err(AppError::bad_request("path is required"));
    }

    let input_path = PathBuf::from(raw_path);

    if !input_path.is_absolute() {
        return Err(AppError::bad_request("path must be absolute"));
    }

    if !input_path.exists() {
        return Err(AppError::not_found("video file does not exist"));
    }

    let canonical_video_path = input_path
        .canonicalize()
        .map_err(|_| AppError::not_found("video file does not exist"))?;
    let metadata = fs::metadata(&canonical_video_path)
        .map_err(|_| AppError::bad_request("video path cannot be read"))?;

    if !metadata.is_file() {
        return Err(AppError::bad_request("path must point to a file"));
    }

    let video_extension = file_extension(&canonical_video_path).ok_or_else(|| {
        AppError::unsupported_media_type("selected file is not a supported video")
    })?;

    if !VIDEO_EXTENSIONS.contains(&video_extension.as_str()) {
        return Err(AppError::unsupported_media_type(
            "selected file is not a supported video",
        ));
    }

    let video_filename = file_name(&canonical_video_path)?;
    let video_stem = file_stem(&canonical_video_path)?;
    let video_mime_type = video_mime_type(&video_extension);
    let parent_dir = canonical_video_path
        .parent()
        .ok_or_else(|| AppError::bad_request("video file must have a parent directory"))?;

    let (subtitle_candidates, warnings) = find_subtitle_siblings(parent_dir, &video_stem)?;

    let video_id = state.register_file(RegisteredFile {
        path: canonical_video_path,
        mime_type: video_mime_type.clone(),
        kind: RegisteredFileKind::Video,
    })?;

    let mut subtitles = Vec::with_capacity(subtitle_candidates.len());

    for candidate in subtitle_candidates {
        let id = state.register_file(RegisteredFile {
            path: candidate.path,
            mime_type: candidate.mime_type.clone(),
            kind: RegisteredFileKind::Subtitle,
        })?;

        subtitles.push(LoadedSubtitle {
            media_url: media_url(&id),
            text_url: subtitle_text_url(&id),
            id,
            filename: candidate.filename,
            infix_title: candidate.infix_title,
            format: candidate.format,
            mime_type: candidate.mime_type,
        });
    }

    Ok(Json(VideoLoadResponse {
        load_id: Uuid::new_v4().to_string(),
        video: LoadedVideo {
            media_url: media_url(&video_id),
            id: video_id,
            filename: video_filename,
            stem: video_stem,
            mime_type: video_mime_type,
        },
        subtitles,
        warnings,
    }))
}

async fn get_media(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let registered_file = state.get_file(&id)?;
    let metadata = tokio::fs::metadata(&registered_file.path)
        .await
        .map_err(|_| AppError::not_found("registered file cannot be read"))?;
    let file_len = metadata.len();

    if let Some(range_header) = headers.get(RANGE) {
        return serve_file_range(
            registered_file,
            range_header.to_str().unwrap_or(""),
            file_len,
        )
        .await;
    }

    let file = File::open(&registered_file.path)
        .await
        .map_err(|_| AppError::not_found("registered file cannot be opened"))?;
    let stream = ReaderStream::new(file);

    response_builder(StatusCode::OK, &registered_file.mime_type)
        .header(CONTENT_LENGTH, file_len.to_string())
        .body(Body::from_stream(stream))
        .map_err(|_| AppError::internal("failed to build media response"))
}

async fn get_subtitle_text(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, AppError> {
    let registered_file = state.get_file(&id)?;

    if registered_file.kind != RegisteredFileKind::Subtitle {
        return Err(AppError::not_found("subtitle file not found"));
    }

    let bytes = tokio::fs::read(&registered_file.path)
        .await
        .map_err(|_| AppError::not_found("subtitle file cannot be read"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::bad_request("subtitle file is not valid UTF-8"))?;

    response_builder(StatusCode::OK, "text/plain; charset=utf-8")
        .body(Body::from(text))
        .map_err(|_| AppError::internal("failed to build subtitle response"))
}

async fn serve_file_range(
    registered_file: RegisteredFile,
    range_header: &str,
    file_len: u64,
) -> Result<Response, AppError> {
    let (start, end) = parse_single_byte_range(range_header, file_len)?;
    let chunk_len = end - start + 1;
    let mut file = File::open(&registered_file.path)
        .await
        .map_err(|_| AppError::not_found("registered file cannot be opened"))?;

    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|_| AppError::range_not_satisfiable("requested range cannot be read"))?;

    let stream = ReaderStream::new(file.take(chunk_len));

    response_builder(StatusCode::PARTIAL_CONTENT, &registered_file.mime_type)
        .header(CONTENT_LENGTH, chunk_len.to_string())
        .header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_len}"))
        .body(Body::from_stream(stream))
        .map_err(|_| AppError::internal("failed to build range response"))
}

fn response_builder(status: StatusCode, content_type: &str) -> axum::http::response::Builder {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header(ACCEPT_RANGES, "bytes")
}

fn parse_single_byte_range(range_header: &str, file_len: u64) -> Result<(u64, u64), AppError> {
    let Some(range) = range_header.strip_prefix("bytes=") else {
        return Err(AppError::range_not_satisfiable(
            "only byte ranges are supported",
        ));
    };

    if range.contains(',') {
        return Err(AppError::range_not_satisfiable(
            "multiple ranges are not supported",
        ));
    }

    let Some((raw_start, raw_end)) = range.split_once('-') else {
        return Err(AppError::range_not_satisfiable("invalid byte range"));
    };

    if file_len == 0 {
        return Err(AppError::range_not_satisfiable("file is empty"));
    }

    if raw_start.is_empty() {
        let suffix_len = raw_end
            .parse::<u64>()
            .map_err(|_| AppError::range_not_satisfiable("invalid suffix byte range"))?;

        if suffix_len == 0 {
            return Err(AppError::range_not_satisfiable("invalid suffix byte range"));
        }

        let start = file_len.saturating_sub(suffix_len);

        return Ok((start, file_len - 1));
    }

    let start = raw_start
        .parse::<u64>()
        .map_err(|_| AppError::range_not_satisfiable("invalid range start"))?;
    let end = if raw_end.is_empty() {
        file_len - 1
    } else {
        raw_end
            .parse::<u64>()
            .map_err(|_| AppError::range_not_satisfiable("invalid range end"))?
    };

    if start >= file_len || end < start {
        return Err(AppError::range_not_satisfiable("range is outside the file"));
    }

    Ok((start, end.min(file_len - 1)))
}

struct SubtitleCandidate {
    path: PathBuf,
    filename: String,
    infix_title: String,
    format: String,
    mime_type: String,
}

fn find_subtitle_siblings(
    parent_dir: &Path,
    video_stem: &str,
) -> Result<(Vec<SubtitleCandidate>, Vec<LoadWarning>), AppError> {
    let entries = fs::read_dir(parent_dir)
        .map_err(|_| AppError::internal("video directory cannot be scanned"))?;
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();

    for entry in entries {
        let entry =
            entry.map_err(|_| AppError::internal("video directory cannot be fully scanned"))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let Some(extension) = file_extension(&path) else {
            continue;
        };

        if !SUBTITLE_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        let filename = file_name(&path)?;
        let stem = file_stem(&path)?;
        let Some(infix_title) = subtitle_infix_title(video_stem, &stem) else {
            continue;
        };

        if fs::File::open(&path).is_err() {
            warnings.push(LoadWarning {
                filename,
                message: "subtitle file cannot be read".to_string(),
            });
            continue;
        }

        candidates.push(SubtitleCandidate {
            path: path
                .canonicalize()
                .map_err(|_| AppError::bad_request("subtitle path cannot be canonicalized"))?,
            filename,
            infix_title,
            format: subtitle_format(&extension).to_string(),
            mime_type: subtitle_mime_type(&extension).to_string(),
        });
    }

    candidates.sort_by(|left, right| {
        left.filename
            .to_lowercase()
            .cmp(&right.filename.to_lowercase())
            .then_with(|| left.filename.cmp(&right.filename))
    });

    Ok((candidates, warnings))
}

fn subtitle_infix_title(video_stem: &str, subtitle_stem: &str) -> Option<String> {
    if subtitle_stem == video_stem {
        return Some(subtitle_stem.to_string());
    }

    let suffix = subtitle_stem.strip_prefix(video_stem)?;
    let first_char = suffix.chars().next()?;

    if !INFIX_TRIM_CHARS.contains(&first_char) {
        return None;
    }

    let trimmed = suffix.trim_matches(INFIX_TRIM_CHARS);

    Some(if trimmed.is_empty() {
        subtitle_stem.to_string()
    } else {
        trimmed.to_string()
    })
}

fn file_extension(path: &Path) -> Option<String> {
    path.extension()?
        .to_str()
        .map(|extension| extension.to_lowercase())
}

fn file_name(path: &Path) -> Result<String, AppError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::bad_request("path has no valid filename"))
}

fn file_stem(path: &Path) -> Result<String, AppError> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::bad_request("path has no valid file stem"))
}

fn video_mime_type(extension: &str) -> String {
    match extension {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn subtitle_mime_type(extension: &str) -> &'static str {
    match extension {
        "srt" => "application/x-subrip",
        "vtt" | "webvtt" => "text/vtt",
        "ass" | "ssa" => "text/plain; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
}

fn subtitle_format(extension: &str) -> &'static str {
    match extension {
        "vtt" | "webvtt" => "webvtt",
        "srt" => "srt",
        "ass" => "ass",
        "ssa" => "ssa",
        _ => "plain",
    }
}

fn media_url(id: &str) -> String {
    format!("/api/media/{id}")
}

fn subtitle_text_url(id: &str) -> String {
    format!("/api/subtitles/{id}")
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tempfile::tempdir;
    use tower::ServiceExt;

    use super::*;

    async fn response_json(response: Response) -> Value {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();

        serde_json::from_slice(&body).expect("body should be JSON")
    }

    async fn create_load(path: &Path) -> Response {
        app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/video-loads")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "path": path.to_string_lossy()
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete")
    }

    #[tokio::test]
    async fn health_endpoint_reports_service_status() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert!(response.status().is_success());

        let json = response_json(response).await;

        assert_eq!(json["status"], "ok");
        assert_eq!(json["service"], "subtitle-merger-backend");
    }

    #[tokio::test]
    async fn video_load_rejects_relative_paths() {
        let response = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/video-loads")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": "movie.mp4" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn video_load_rejects_missing_files() {
        let dir = tempdir().expect("temp dir should be created");
        let response = create_load(&dir.path().join("missing.mp4")).await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn video_load_rejects_unsupported_selected_files() {
        let dir = tempdir().expect("temp dir should be created");
        let path = dir.path().join("movie.txt");
        fs::write(&path, "not video").expect("file should be written");

        let response = create_load(&path).await;

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn video_load_finds_matching_subtitle_siblings() {
        let dir = tempdir().expect("temp dir should be created");
        let video_path = dir.path().join("movie.mp4");
        fs::write(&video_path, "video").expect("video should be written");
        fs::write(
            dir.path().join("movie.srt"),
            "1\n00:00:00,000 --> 00:00:01,000\nHi",
        )
        .expect("subtitle should be written");
        fs::write(dir.path().join("movie.en.srt"), "subtitle").expect("subtitle should be written");
        fs::write(dir.path().join("movie - Director.ass"), "subtitle")
            .expect("subtitle should be written");
        fs::write(dir.path().join("movie_subs.ssa"), "subtitle")
            .expect("subtitle should be written");
        fs::write(dir.path().join("movie2.srt"), "subtitle").expect("subtitle should be written");

        let response = create_load(&video_path).await;

        assert_eq!(response.status(), StatusCode::OK);

        let json = response_json(response).await;
        let subtitles = json["subtitles"]
            .as_array()
            .expect("subtitles should be an array");
        let titles = subtitles
            .iter()
            .map(|subtitle| subtitle["infixTitle"].as_str().expect("title should exist"))
            .collect::<Vec<_>>();
        let filenames = subtitles
            .iter()
            .map(|subtitle| {
                subtitle["filename"]
                    .as_str()
                    .expect("filename should exist")
            })
            .collect::<Vec<_>>();

        assert_eq!(titles, vec!["Director", "en", "movie", "subs"]);
        assert_eq!(
            filenames,
            vec![
                "movie - Director.ass",
                "movie.en.srt",
                "movie.srt",
                "movie_subs.ssa"
            ]
        );
    }

    #[tokio::test]
    async fn media_endpoint_rejects_unknown_ids() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/media/not-registered")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn media_endpoint_serves_registered_files() {
        let dir = tempdir().expect("temp dir should be created");
        let video_path = dir.path().join("movie.mp4");
        fs::write(&video_path, "video bytes").expect("video should be written");
        let state = AppState::new();

        let response = app_with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/video-loads")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "path": video_path.to_string_lossy()
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");
        let json = response_json(response).await;
        let media_url = json["video"]["mediaUrl"]
            .as_str()
            .expect("media URL should exist");

        let response = app_with_state(state)
            .oneshot(
                Request::builder()
                    .uri(media_url)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "video/mp4");

        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();

        assert_eq!(&bytes[..], b"video bytes");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn video_load_warns_and_skips_unreadable_subtitle_siblings() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("temp dir should be created");
        let video_path = dir.path().join("movie.mp4");
        let unreadable_path = dir.path().join("movie.en.srt");
        fs::write(&video_path, "video").expect("video should be written");
        fs::write(dir.path().join("movie.fr.srt"), "subtitle").expect("subtitle should be written");
        fs::write(&unreadable_path, "subtitle").expect("subtitle should be written");

        let original_permissions = fs::metadata(&unreadable_path)
            .expect("metadata should be readable")
            .permissions();
        let mut unreadable_permissions = original_permissions.clone();
        unreadable_permissions.set_mode(0o000);
        fs::set_permissions(&unreadable_path, unreadable_permissions)
            .expect("permissions should be updated");

        let response = create_load(&video_path).await;

        fs::set_permissions(&unreadable_path, original_permissions)
            .expect("permissions should be restored");

        assert_eq!(response.status(), StatusCode::OK);

        let json = response_json(response).await;
        assert_eq!(json["subtitles"].as_array().expect("subtitles").len(), 1);
        assert_eq!(json["warnings"].as_array().expect("warnings").len(), 1);
        assert_eq!(json["warnings"][0]["filename"], "movie.en.srt");
    }

    #[tokio::test]
    async fn media_endpoint_supports_byte_ranges() {
        let dir = tempdir().expect("temp dir should be created");
        let video_path = dir.path().join("movie.mp4");
        fs::write(&video_path, "0123456789").expect("video should be written");
        let state = AppState::new();
        let response = app_with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/video-loads")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "path": video_path.to_string_lossy()
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");
        let json = response_json(response).await;
        let media_url = json["video"]["mediaUrl"]
            .as_str()
            .expect("media URL should exist");

        let response = app_with_state(state)
            .oneshot(
                Request::builder()
                    .uri(media_url)
                    .header(RANGE, "bytes=2-5")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()[CONTENT_RANGE],
            "bytes 2-5/10",
            "content range should describe the returned bytes"
        );

        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();

        assert_eq!(&bytes[..], b"2345");
    }
}
