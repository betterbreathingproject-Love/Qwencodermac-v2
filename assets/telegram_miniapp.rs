/// Telegram Mini App — interactive HTTP server for storyboard creation,
/// chat with LLM, character management, music generation, and project gallery.
/// Exposes the same workflow as the Telegram bot commands but through
/// a visual web interface optimized for Telegram Web App.
///
/// Routes:
///   GET  /                    → Mini app HTML (SPA)
///   GET  /api/projects        → List storyboard projects
///   GET  /api/projects/:id    → Full project detail
///   GET  /api/staged          → Staged videos
///   GET  /api/session         → Current session state
///   GET  /api/styles          → Available style presets
///   POST /api/chat            → Chat with LLM (storyboard flow)
///   POST /api/style           → Set visual style
///   POST /api/workflow        → Set workflow mode
///   POST /api/character       → Add/update character
///   POST /api/generate        → Trigger video generation
///   POST /api/reset           → Reset current session
///   GET  /api/music/status    → ACE Step availability
///   GET  /api/music/library   → List generated music assets
///   POST /api/music/generate  → Generate music with ACE Step
///   POST /api/music/promptlab → Chat with music prompt lab LLM
///   GET  /media/*             → Serve local media files
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use warp::Filter;

static MINIAPP_PORT: Lazy<Mutex<u16>> = Lazy::new(|| Mutex::new(8377));
static MINIAPP_HANDLE: Lazy<Mutex<Option<tokio::task::JoinHandle<()>>>> =
    Lazy::new(|| Mutex::new(None));
static MINIAPP_BASE_URL: Lazy<Mutex<String>> =
    Lazy::new(|| Mutex::new(String::new()));
static MINIAPP_PUBLIC_URL: Lazy<Mutex<String>> =
    Lazy::new(|| Mutex::new(String::new()));
static TUNNEL_PROCESS: Lazy<Mutex<Option<std::process::Child>>> =
    Lazy::new(|| Mutex::new(None));
/// Stored Tauri window handle so the generate route can emit progress events
static MINIAPP_WINDOW: Lazy<Mutex<Option<tauri::Window>>> =
    Lazy::new(|| Mutex::new(None));

/// Expose the window store so commands.rs can set it before starting the tunnel
pub fn get_window_store() -> &'static Mutex<Option<tauri::Window>> {
    &MINIAPP_WINDOW
}

/// Sentinel chat ID for mini app sessions (not a real Telegram chat)
const MINIAPP_CHAT_ID: i64 = -999;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiniAppStatus {
    pub running: bool,
    pub port: u16,
    pub local_url: String,
    pub public_url: String,
}

// ── Request/Response types for the API ───────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(default)]
    video_length_secs: Option<u32>,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    response: String,
    scenes: Vec<crate::storyboard::StoryboardScene>,
    project_id: String,
    #[serde(default)]
    generate_requested: bool,
}

#[derive(Debug, Deserialize)]
struct StyleRequest {
    style: String,
}

#[derive(Debug, Deserialize)]
struct WorkflowRequest {
    mode: String,
}

#[derive(Debug, Deserialize)]
struct CharacterRequest {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    role: String,
}

#[derive(Debug, Serialize)]
struct SessionResponse {
    active: bool,
    project_id: String,
    style: String,
    workflow: String,
    video_length_secs: u32,
    history: Vec<HistoryMessage>,
    characters: Vec<crate::storyboard::CharacterProfile>,
    scenes: Vec<crate::storyboard::StoryboardScene>,
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoryMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct StylePreset {
    key: String,
    label: String,
    description: String,
}

// ── Music generation types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct MusicGenerateRequest {
    prompt: String,
    #[serde(default = "default_music_duration")]
    duration_secs: u32,
    #[serde(default)]
    tags: String,
    #[serde(default)]
    lyrics: String,
    #[serde(default = "default_true")]
    instrumental: bool,
    #[serde(default)]
    advanced: Option<serde_json::Value>,
}

fn default_music_duration() -> u32 { 60 }
fn default_true() -> bool { true }

#[derive(Debug, Deserialize)]
struct PromptLabRequest {
    message: String,
    #[serde(default)]
    history: Vec<HistoryMessage>,
}

// ── Video generation types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct VideoGenerateRequest {
    prompt: String,
    #[serde(default)]
    negative_prompt: Option<String>,
    #[serde(default = "default_video_width")]
    width: u32,
    #[serde(default = "default_video_height")]
    height: u32,
    #[serde(default = "default_num_frames")]
    num_frames: u32,
    #[serde(default = "default_num_steps")]
    num_steps: u32,
    #[serde(default = "default_guidance")]
    guidance_scale: f64,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default = "default_seed")]
    seed: i64,
    /// Optional image reference path (from image library)
    #[serde(default)]
    image_path: Option<String>,
}

fn default_video_width() -> u32 { 768 }
fn default_video_height() -> u32 { 512 }
fn default_num_frames() -> u32 { 65 }
fn default_num_steps() -> u32 { 30 }
fn default_guidance() -> f64 { 3.5 }
fn default_fps() -> u32 { 24 }
fn default_seed() -> i64 { -1 }

// ── Public helpers ───────────────────────────────────────────────────────────

/// Get current mini app server status
pub fn get_status() -> MiniAppStatus {
    let port = MINIAPP_PORT.lock().map(|p| *p).unwrap_or(8377);
    let running = MINIAPP_HANDLE.lock().map(|h| h.is_some()).unwrap_or(false);
    let local_url = MINIAPP_BASE_URL.lock().map(|u| u.clone()).unwrap_or_default();
    let public_url = MINIAPP_PUBLIC_URL.lock().map(|u| u.clone()).unwrap_or_default();
    MiniAppStatus { running, port, local_url, public_url }
}

/// Set the public URL (from tunnel) so the bot can send Web App buttons
pub fn set_public_url(url: &str) {
    if let Ok(mut u) = MINIAPP_PUBLIC_URL.lock() {
        *u = url.trim_end_matches('/').to_string();
    }
}

/// Get the public URL for Web App buttons
pub fn get_public_url() -> String {
    MINIAPP_PUBLIC_URL.lock().map(|u| u.clone()).unwrap_or_default()
}

/// Helper: convert a local file path to a media URL served by the mini app
pub fn media_url(file_path: &str) -> String {
    let base = {
        let public = MINIAPP_PUBLIC_URL.lock().map(|u| u.clone()).unwrap_or_default();
        if public.is_empty() {
            let port = MINIAPP_PORT.lock().map(|p| *p).unwrap_or(8377);
            format!("http://localhost:{}", port)
        } else {
            public
        }
    };
    let encoded = percent_encoding::utf8_percent_encode(
        file_path,
        percent_encoding::NON_ALPHANUMERIC,
    );
    format!("{}/media/{}", base, encoded)
}

// ── Server ───────────────────────────────────────────────────────────────────

/// Start the mini app HTTP server with full interactive API
pub async fn start_server(port: Option<u16>) -> Result<MiniAppStatus, String> {
    start_server_with_window(port, None).await
}

/// Start the mini app HTTP server, optionally storing a window handle for generation events
pub async fn start_server_with_window(port: Option<u16>, window: Option<tauri::Window>) -> Result<MiniAppStatus, String> {
    stop_server()?;

    if let Some(w) = window {
        if let Ok(mut wh) = MINIAPP_WINDOW.lock() { *wh = Some(w); }
    }

    let port = port.unwrap_or(8377);
    if let Ok(mut p) = MINIAPP_PORT.lock() { *p = port; }

    let base_url = format!("http://localhost:{}", port);
    if let Ok(mut u) = MINIAPP_BASE_URL.lock() { *u = base_url.clone(); }

    // ── Routes ───────────────────────────────────────────────────────

    // GET / → serve the mini app HTML
    let index = warp::path::end().and(warp::get()).map(|| {
        warp::reply::html(MINIAPP_HTML)
    });

    // GET /api/projects → list all storyboard projects
    let api_projects = warp::path!("api" / "projects")
        .and(warp::get())
        .map(|| {
            match crate::storyboard::list_storyboards() {
                Ok(projects) => {
                    let summaries: Vec<serde_json::Value> = projects
                        .iter()
                        .map(|p| {
                            serde_json::json!({
                                "id": p.id,
                                "prompt": p.prompt,
                                "scene_count": p.scene_count,
                                "video_length_ms": p.video_length_ms,
                                "created_at": p.created_at,
                                "character_count": p.characters.len(),
                                "thumbnail": p.scenes.first()
                                    .and_then(|s| s.shots.first())
                                    .and_then(|sh| sh.image_path.as_ref())
                                    .or_else(|| p.scenes.first().and_then(|s| s.image_path.as_ref())),
                            })
                        })
                        .collect();
                    warp::reply::with_status(
                        warp::reply::json(&summaries),
                        warp::http::StatusCode::OK,
                    )
                }
                Err(e) => warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": e})),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ),
            }
        });

    // GET /api/projects/:id → full project detail
    let api_project_detail = warp::path!("api" / "projects" / String)
        .and(warp::get())
        .map(|id: String| {
            match crate::storyboard::list_storyboards() {
                Ok(projects) => {
                    if let Some(project) = projects.into_iter().find(|p| p.id == id) {
                        warp::reply::with_status(
                            warp::reply::json(&project),
                            warp::http::StatusCode::OK,
                        )
                    } else {
                        warp::reply::with_status(
                            warp::reply::json(&serde_json::json!({"error": "Not found"})),
                            warp::http::StatusCode::NOT_FOUND,
                        )
                    }
                }
                Err(e) => warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": e})),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ),
            }
        });

    // GET /api/staged → staged videos from Telegram uploads
    let api_staged = warp::path!("api" / "staged")
        .and(warp::get())
        .map(|| {
            let videos = crate::telegram_bot::get_staged_videos();
            warp::reply::json(&videos)
        });

    // GET /api/session → current session state
    let api_session = warp::path!("api" / "session")
        .and(warp::get())
        .map(|| {
            let session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "");
            let scenes = get_session_scenes(&session.project_id);
            let resp = SessionResponse {
                active: !session.history.is_empty(),
                project_id: session.project_id.clone(),
                style: session.style.clone(),
                workflow: session.workflow.clone(),
                video_length_secs: session.video_length_secs,
                history: session.history.iter().map(|(r, c)| HistoryMessage {
                    role: r.clone(),
                    content: c.clone(),
                }).collect(),
                characters: session.characters.clone(),
                scenes,
            };
            warp::reply::json(&resp)
        });

    // GET /api/styles → available style presets
    let api_styles = warp::path!("api" / "styles")
        .and(warp::get())
        .map(|| {
            let presets: Vec<StylePreset> = crate::telegram_bot::STYLE_PRESETS
                .iter()
                .map(|(key, label, desc)| StylePreset {
                    key: key.to_string(),
                    label: label.to_string(),
                    description: desc.to_string(),
                })
                .collect();
            warp::reply::json(&presets)
        });

    // POST /api/chat → chat with LLM (storyboard flow)
    let api_chat = warp::path!("api" / "chat")
        .and(warp::post())
        .and(warp::body::json())
        .and_then(handle_chat);

    // POST /api/style → set visual style
    let api_set_style = warp::path!("api" / "style")
        .and(warp::post())
        .and(warp::body::json())
        .map(|req: StyleRequest| {
            let mut session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "");
            let style_key = req.style.trim().to_lowercase();
            if style_key == "off" || style_key == "none" || style_key.is_empty() {
                session.style = String::new();
            } else if let Some((_key, _label, desc)) = crate::telegram_bot::find_style_preset(&style_key) {
                session.style = desc.to_string();
            } else {
                session.style = req.style.clone();
            }
            crate::telegram_bot::update_session(&session);
            warp::reply::json(&serde_json::json!({
                "ok": true,
                "style": session.style,
            }))
        });

    // POST /api/workflow → set workflow mode
    let api_set_workflow = warp::path!("api" / "workflow")
        .and(warp::post())
        .and(warp::body::json())
        .map(|req: WorkflowRequest| {
            let mut session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "");
            let mode = req.mode.trim().to_lowercase();
            if ["fast-start", "full-auto", "production"].contains(&mode.as_str()) {
                session.workflow = mode.clone();
                crate::telegram_bot::update_session(&session);
                warp::reply::json(&serde_json::json!({ "ok": true, "workflow": mode }))
            } else {
                warp::reply::json(&serde_json::json!({
                    "ok": false,
                    "error": "Invalid mode. Use: fast-start, full-auto, or production"
                }))
            }
        });

    // POST /api/character → add/update character
    let api_character = warp::path!("api" / "character")
        .and(warp::post())
        .and(warp::body::json())
        .map(|req: CharacterRequest| {
            let mut session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "");
            let profile = crate::storyboard::CharacterProfile {
                id: format!("miniapp_char_{}", chrono::Utc::now().timestamp_millis()),
                name: req.name.clone(),
                description: req.description.clone(),
                role: req.role.clone(),
                reference_images: Vec::new(),
                active_image: None,
                backstory: String::new(),
                personality: String::new(),
                appearance: String::new(),
                motivations: String::new(),
                relationships: String::new(),
                arc: String::new(),
                enriched: false,
            };
            let _ = crate::storyboard::save_character_profile(&session.project_id, profile.clone());
            // Update session characters
            if let Some(existing) = session.characters.iter_mut().find(|c| c.name.eq_ignore_ascii_case(&req.name)) {
                *existing = profile.clone();
            } else {
                session.characters.push(profile.clone());
            }
            crate::telegram_bot::update_session(&session);
            warp::reply::json(&serde_json::json!({ "ok": true, "character": profile }))
        });

    // POST /api/generate → trigger storyboard image+video generation
    let api_generate = warp::path!("api" / "generate")
        .and(warp::post())
        .and_then(handle_generate);

    // POST /api/reset → reset current session
    let api_reset = warp::path!("api" / "reset")
        .and(warp::post())
        .map(|| {
            // Persist current chat before clearing
            let session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "");
            crate::telegram_bot::persist_chat(&session);
            // Clear the session so get_or_create_session will make a new one
            crate::telegram_bot::update_session(&crate::telegram_bot::StoryboardSession {
                project_id: String::new(),
                chat_id: String::new(),
                telegram_chat_id: -1, // different from MINIAPP_CHAT_ID so next call creates fresh
                history: Vec::new(),
                ref_images: Vec::new(),
                style: String::new(),
                video_length_secs: 60,
                characters: Vec::new(),
                workflow: "fast-start".to_string(),
            });
            let fresh = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "New session");
            warp::reply::json(&serde_json::json!({
                "ok": true,
                "project_id": fresh.project_id,
            }))
        });

    // ── LLM API routes ───────────────────────────────────────────────────

    // GET /api/llm/status → check if a local LLM is running
    let api_llm_status = warp::path!("api" / "llm" / "status")
        .and(warp::get())
        .map(|| {
            let mlx_port = crate::mlx::get_mlx_llm_server_port();
            let vlm_port = crate::vision_analyzer::get_vlm_server_port();
            let omlx = crate::omlx::get_omlx_status();
            let running = mlx_port.is_some() || vlm_port.is_some() || omlx.running;
            let endpoint = if let Some(p) = mlx_port {
                format!("http://127.0.0.1:{}/v1/chat/completions", p)
            } else if let Some(p) = vlm_port {
                format!("http://127.0.0.1:{}/v1/chat/completions", p)
            } else if omlx.running && !omlx.endpoint.is_empty() {
                format!("{}/v1/chat/completions", omlx.endpoint.trim_end_matches('/'))
            } else {
                String::new()
            };
            warp::reply::json(&serde_json::json!({
                "running": running,
                "endpoint": endpoint,
                "omlx_installed": omlx.installed,
                "omlx_running": omlx.running,
            }))
        });

    // POST /api/llm/start → lazy-start oMLX so the Prompt Lab can work
    let api_llm_start = warp::path!("api" / "llm" / "start")
        .and(warp::post())
        .and_then(handle_llm_start);

    // ── Video API routes ─────────────────────────────────────────────────

    // GET /api/video/status → LTX availability
    let api_video_status = warp::path!("api" / "video" / "status")
        .and(warp::get())
        .map(|| {
            let status = crate::ltx::check_ltx_available();
            warp::reply::json(&serde_json::json!({
                "available": status.available,
                "message": status.message,
            }))
        });

    // GET /api/video/library → list LTX generated videos
    let api_video_library = warp::path!("api" / "video" / "library")
        .and(warp::get())
        .map(|| {
            let items = crate::ltx::list_ltx_library();
            warp::reply::json(&items)
        });

    // GET /api/images → list image library for reference picking
    let api_images = warp::path!("api" / "images")
        .and(warp::get())
        .map(|| {
            match crate::image_gen::list_image_library() {
                Ok(assets) => warp::reply::with_status(
                    warp::reply::json(&assets),
                    warp::http::StatusCode::OK,
                ),
                Err(e) => warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": e})),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ),
            }
        });

    // POST /api/video/generate → generate video with LTX
    let api_video_generate = warp::path!("api" / "video" / "generate")
        .and(warp::post())
        .and(warp::body::json())
        .and_then(handle_video_generate);

    // ── Music API routes ─────────────────────────────────────────────────

    // GET /api/music/status → ACE Step availability and server status
    let api_music_status = warp::path!("api" / "music" / "status")
        .and(warp::get())
        .map(|| {
            let installed = crate::ace_step::check_ace_step_installed();
            let server_running = crate::ace_step::is_server_running();
            let mlx_port = crate::mlx::get_mlx_llm_server_port();
            let vlm_port = crate::vision_analyzer::get_vlm_server_port();
            let omlx = crate::omlx::get_omlx_status();
            let llm_available = mlx_port.is_some() || vlm_port.is_some() || omlx.running;
            let omlx_installed = omlx.installed;
            warp::reply::json(&serde_json::json!({
                "installed": installed,
                "server_running": server_running,
                "llm_available": llm_available,
                "omlx_installed": omlx_installed,
            }))
        });

    // GET /api/music/library → list generated music assets
    let api_music_library = warp::path!("api" / "music" / "library")
        .and(warp::get())
        .map(|| {
            match crate::ace_step::list_assets() {
                Ok(assets) => warp::reply::with_status(
                    warp::reply::json(&assets),
                    warp::http::StatusCode::OK,
                ),
                Err(e) => warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": e})),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ),
            }
        });

    // POST /api/music/generate → generate music with ACE Step
    let api_music_generate = warp::path!("api" / "music" / "generate")
        .and(warp::post())
        .and(warp::body::json())
        .and_then(handle_music_generate);

    // POST /api/music/promptlab → chat with the music prompt lab LLM
    let api_music_promptlab = warp::path!("api" / "music" / "promptlab")
        .and(warp::post())
        .and(warp::body::json())
        .and_then(handle_music_promptlab);

    // GET /media/* → serve local image/video files with security checks
    let media = warp::path("media")
        .and(warp::get())
        .and(warp::path::tail())
        .map(|tail: warp::path::Tail| {
            use warp::Reply;
            let file_path = percent_encoding::percent_decode_str(tail.as_str())
                .decode_utf8_lossy()
                .to_string();

            let allowed_prefixes = vec![
                dirs::home_dir()
                    .map(|h| h.join(".zoom-video-editor").to_string_lossy().to_string())
                    .unwrap_or_default(),
                std::env::temp_dir().to_string_lossy().to_string(),
            ];

            let is_allowed = allowed_prefixes
                .iter()
                .any(|prefix| !prefix.is_empty() && file_path.starts_with(prefix));

            if !is_allowed {
                return warp::reply::with_status(Vec::new(), warp::http::StatusCode::FORBIDDEN)
                    .into_response();
            }

            let path = std::path::Path::new(&file_path);
            if !path.exists() {
                return warp::reply::with_status(Vec::new(), warp::http::StatusCode::NOT_FOUND)
                    .into_response();
            }

            let mime = match path.extension().and_then(|e| e.to_str()) {
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("png") => "image/png",
                Some("webp") => "image/webp",
                Some("gif") => "image/gif",
                Some("mp4") | Some("m4v") => "video/mp4",
                Some("mov") => "video/quicktime",
                Some("webm") => "video/webm",
                Some("mp3") => "audio/mpeg",
                Some("wav") => "audio/wav",
                Some("ogg") => "audio/ogg",
                Some("m4a") | Some("aac") => "audio/mp4",
                _ => "application/octet-stream",
            };

            match std::fs::read(path) {
                Ok(data) => warp::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Cache-Control", "public, max-age=3600")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(data)
                    .unwrap()
                    .into_response(),
                Err(_) => warp::reply::with_status(
                    Vec::new(),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )
                .into_response(),
            }
        });

    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST", "OPTIONS"])
        .allow_headers(vec!["Content-Type"]);

    let routes = index
        .or(api_projects)
        .or(api_project_detail)
        .or(api_staged)
        .or(api_session)
        .or(api_styles)
        .or(api_chat)
        .or(api_set_style)
        .or(api_set_workflow)
        .or(api_character)
        .or(api_generate)
        .or(api_reset)
        .or(api_llm_status)
        .or(api_llm_start)
        .or(api_video_status)
        .or(api_video_library)
        .or(api_images)
        .or(api_video_generate)
        .or(api_music_status)
        .or(api_music_library)
        .or(api_music_generate)
        .or(api_music_promptlab)
        .or(media)
        .with(cors);

    let (addr, server) = warp::serve(routes).bind_ephemeral(([127, 0, 0, 1], port));
    eprintln!("[telegram-miniapp] Server started on http://{}", addr);

    let handle = tokio::spawn(server);
    if let Ok(mut h) = MINIAPP_HANDLE.lock() { *h = Some(handle); }

    let public_url = MINIAPP_PUBLIC_URL.lock().map(|u| u.clone()).unwrap_or_default();

    Ok(MiniAppStatus {
        running: true,
        port: addr.port(),
        local_url: format!("http://localhost:{}", addr.port()),
        public_url,
    })
}

// ── Async handler for POST /api/chat ─────────────────────────────────────────

/// Check if a chat message is a generate/render command (mirrors telegram_bot logic)
fn is_miniapp_generate_command(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower == "/generate"
        || lower == "/render"
        || lower == "generate"
        || lower == "render"
        || lower == "generate movie"
        || lower == "generate video"
        || lower == "create movie"
        || lower == "create video"
        || lower == "make movie"
        || lower == "make video"
        || lower == "make it"
        || lower == "build it"
        || lower.starts_with("/generate ")
        || lower.starts_with("/render ")
}

async fn handle_chat(req: ChatRequest) -> Result<impl warp::Reply, warp::Rejection> {
    let message = req.message.trim().to_string();
    if message.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({
            "error": "Message cannot be empty"
        })));
    }

    let mut session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, &message);

    // Apply video length if provided
    if let Some(len) = req.video_length_secs {
        if len > 0 {
            session.video_length_secs = len;
        }
    }

    // ── Intercept generate commands ──────────────────────────────────
    // Don't send these to the LLM — they should trigger video generation
    if is_miniapp_generate_command(&message) {
        let scenes = get_session_scenes(&session.project_id);
        if scenes.is_empty() {
            return Ok(warp::reply::json(&ChatResponse {
                response: "No scenes to generate yet. Keep chatting to develop your storyboard first, then try again.".to_string(),
                scenes: Vec::new(),
                project_id: session.project_id.clone(),
                generate_requested: false,
            }));
        }
        // Add the command to history so it shows in chat
        session.history.push(("user".to_string(), message.clone()));
        let gen_msg = format!(
            "🎬 Generation queued for {} scene{}! Open the main app's Storyboard tab to monitor progress, or use the Telegram bot's /generate command for fully remote generation.",
            scenes.len(),
            if scenes.len() != 1 { "s" } else { "" }
        );
        session.history.push(("assistant".to_string(), gen_msg.clone()));
        crate::telegram_bot::update_session(&session);
        crate::telegram_bot::persist_chat(&session);

        return Ok(warp::reply::json(&ChatResponse {
            response: gen_msg,
            scenes,
            project_id: session.project_id.clone(),
            generate_requested: true,
        }));
    }

    // Add user message to history
    session.history.push(("user".to_string(), message.clone()));
    crate::telegram_bot::update_session(&session);

    // Call the LLM
    match crate::telegram_bot::storyboard_llm_chat(&session, &message).await {
        Ok(response) => {
            // Add assistant response to history
            session.history.push(("assistant".to_string(), response.clone()));
            crate::telegram_bot::update_session(&session);
            crate::telegram_bot::persist_chat(&session);

            // Parse any scenes from the response
            let scenes = crate::telegram_bot::parse_scenes_from_response(&response);

            // If scenes were generated, save them to the project
            if !scenes.is_empty() {
                let _ = crate::storyboard::save_storyboard_scenes(
                    &session.project_id,
                    scenes.clone(),
                );
                eprintln!(
                    "[miniapp-chat] Saved {} scenes to project {}",
                    scenes.len(),
                    session.project_id
                );
            }

            Ok(warp::reply::json(&ChatResponse {
                response,
                scenes,
                project_id: session.project_id.clone(),
                generate_requested: false,
            }))
        }
        Err(e) => {
            // Remove the user message we just added since the call failed
            session.history.pop();
            crate::telegram_bot::update_session(&session);
            Ok(warp::reply::json(&serde_json::json!({
                "error": e,
                "project_id": session.project_id,
            })))
        }
    }
}

/// Get scenes for a project from disk
fn get_session_scenes(project_id: &str) -> Vec<crate::storyboard::StoryboardScene> {
    crate::storyboard::list_storyboards()
        .ok()
        .and_then(|projects| {
            projects.into_iter().find(|p| p.id == project_id)
        })
        .map(|p| p.scenes)
        .unwrap_or_default()
}

// ── Generate handler ─────────────────────────────────────────────────────────

/// Handle POST /api/generate — kick off storyboard image generation for the current session
async fn handle_generate() -> Result<impl warp::Reply, warp::Rejection> {
    let session = crate::telegram_bot::get_or_create_session(MINIAPP_CHAT_ID, "");
    let scenes = get_session_scenes(&session.project_id);
    if scenes.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({
            "ok": false,
            "error": "No scenes to generate. Chat with the AI first to create a storyboard."
        })));
    }

    let project_id = session.project_id.clone();
    let prompt = session.history.iter()
        .find(|(r, _)| r == "user")
        .map(|(_, c)| c.clone())
        .unwrap_or_else(|| "Storyboard".to_string());
    let video_length_secs = session.video_length_secs as u64;
    let scene_count = scenes.len();

    // Get the stored window handle for progress events
    let window_opt = MINIAPP_WINDOW.lock().ok().and_then(|g| g.clone());

    let result = tokio::task::spawn_blocking(move || {
        // Create a dummy window-less progress emitter if no window is available
        if let Some(window) = window_opt {
            let job_id = format!("miniapp_{}", chrono::Utc::now().timestamp_millis());
            crate::storyboard::generate_storyboard(
                &window,
                &job_id,
                &prompt,
                video_length_secs,
                scene_count,
                true,  // generate_images
                "1280x720",
                None,
                None, // music_metadata
            ).map(|r| serde_json::json!({
                "ok": true,
                "project_id": project_id,
                "scene_count": scene_count,
                "message": format!("Generated {} scene{}!", r.project.scenes.len(), if r.project.scenes.len() != 1 { "s" } else { "" }),
            }))
        } else {
            // No window — still queue the generation via the storyboard module
            // The user can monitor progress in the main app
            Ok(serde_json::json!({
                "ok": true,
                "project_id": project_id,
                "scene_count": scene_count,
                "message": format!(
                    "Generation queued for {} scene{}. Open the main app's Storyboard tab to monitor progress.",
                    scene_count,
                    if scene_count != 1 { "s" } else { "" }
                ),
            }))
        }
    }).await;

    match result {
        Ok(Ok(val)) => Ok(warp::reply::json(&val)),
        Ok(Err(e)) => Ok(warp::reply::json(&serde_json::json!({ "ok": false, "error": e }))),
        Err(e) => Ok(warp::reply::json(&serde_json::json!({ "ok": false, "error": format!("Task error: {}", e) }))),
    }
}

// ── LLM start handler ────────────────────────────────────────────────────────

/// Handle POST /api/llm/start — lazy-start oMLX so the Prompt Lab can work
async fn handle_llm_start() -> Result<impl warp::Reply, warp::Rejection> {
    // If any LLM is already running, just return its endpoint
    if let Some(port) = crate::mlx::get_mlx_llm_server_port() {
        return Ok(warp::reply::json(&serde_json::json!({
            "ok": true,
            "already_running": true,
            "endpoint": format!("http://127.0.0.1:{}/v1/chat/completions", port),
        })));
    }
    if let Some(port) = crate::vision_analyzer::get_vlm_server_port() {
        return Ok(warp::reply::json(&serde_json::json!({
            "ok": true,
            "already_running": true,
            "endpoint": format!("http://127.0.0.1:{}/v1/chat/completions", port),
        })));
    }
    let omlx = crate::omlx::get_omlx_status();
    if omlx.running && !omlx.endpoint.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({
            "ok": true,
            "already_running": true,
            "endpoint": format!("{}/v1/chat/completions", omlx.endpoint.trim_end_matches('/')),
        })));
    }

    // Try to lazy-start oMLX
    if !omlx.installed {
        return Ok(warp::reply::json(&serde_json::json!({
            "ok": false,
            "error": "No local AI installed. Install oMLX or MLX-LM from the main app's Chat tab first.",
        })));
    }

    let result = tokio::task::spawn_blocking(|| {
        crate::omlx::ensure_omlx_running()
    }).await;

    match result {
        Ok(Ok(())) => {
            // Give it a moment to be ready, then get the endpoint
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let status = crate::omlx::get_omlx_status();
            let endpoint = if !status.endpoint.is_empty() {
                format!("{}/v1/chat/completions", status.endpoint.trim_end_matches('/'))
            } else {
                "http://127.0.0.1:10240/v1/chat/completions".to_string()
            };
            Ok(warp::reply::json(&serde_json::json!({
                "ok": true,
                "already_running": false,
                "endpoint": endpoint,
            })))
        }
        Ok(Err(e)) => Ok(warp::reply::json(&serde_json::json!({
            "ok": false,
            "error": format!("Failed to start AI: {}", e),
        }))),
        Err(e) => Ok(warp::reply::json(&serde_json::json!({
            "ok": false,
            "error": format!("Task error: {}", e),
        }))),
    }
}

// ── Video generate handler ───────────────────────────────────────────────────

/// Handle POST /api/video/generate — generate a video with LTX using optional image reference
async fn handle_video_generate(req: VideoGenerateRequest) -> Result<impl warp::Reply, warp::Rejection> {
    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({"error": "Prompt is required"})));
    }

    let status = crate::ltx::check_ltx_available();
    if !status.available {
        return Ok(warp::reply::json(&serde_json::json!({
            "error": format!("LTX not available: {}", status.message)
        })));
    }

    // Validate image_path if provided — must be within allowed dirs
    let image_path = req.image_path.clone().and_then(|p| {
        let home = dirs::home_dir()
            .map(|h| h.join(".zoom-video-editor").to_string_lossy().to_string())
            .unwrap_or_default();
        if !home.is_empty() && p.starts_with(&home) && std::path::Path::new(&p).exists() {
            Some(p)
        } else {
            None
        }
    });

    let window_opt = MINIAPP_WINDOW.lock().ok().and_then(|g| g.clone());

    let result = tokio::task::spawn_blocking(move || {
        let job_id = format!("miniapp_vid_{}", chrono::Utc::now().timestamp_millis());
        let seed = if req.seed < 0 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| (d.subsec_nanos() as i64).abs())
                .unwrap_or(42)
        } else {
            req.seed
        };

        if let Some(window) = window_opt {
            crate::ltx::generate_ltx_video(
                &window,
                &prompt,
                req.negative_prompt.as_deref(),
                req.width,
                req.height,
                req.num_frames,
                req.num_steps,
                req.guidance_scale,
                req.fps,
                seed,
                image_path.as_deref(),
                None,   // model_id — use default
                false,  // no_audio
                None,   // hf_token
                false,  // distilled
                false,  // upscale
                None,   // character_refs
            )
        } else {
            Err("No window handle available — start the mini app from the main app first.".to_string())
        }
    }).await;

    match result {
        Ok(Ok(r)) => Ok(warp::reply::json(&serde_json::json!({
            "ok": true,
            "id": r.id,
            "file_path": r.file_path,
            "duration_ms": r.duration_ms,
            "width": r.width,
            "height": r.height,
            "generation_time_secs": r.generation_time_secs,
            "prompt": r.prompt,
        }))),
        Ok(Err(e)) => Ok(warp::reply::json(&serde_json::json!({"error": e}))),
        Err(e) => Ok(warp::reply::json(&serde_json::json!({"error": format!("Task error: {}", e)}))),
    }
}

// ── Music handler functions ──────────────────────────────────────────────────

/// ACE-Step music prompt lab system prompt (same as main app MusicGPTPanel)
const MUSIC_PROMPTLAB_SYSTEM: &str = r#"You are an expert ACE-Step 1.5 music prompt engineer. You help users craft excellent prompts for AI music generation.

Your job is to have a conversation — the user describes a musical idea (spoken or typed, possibly vague), and you help them iterate it into a great ACE-Step prompt.

## How ACE-Step Works
ACE-Step uses two inputs:
1. **Caption** — describes overall style, instruments, emotion, atmosphere, timbre, vocal characteristics, production style
2. **Lyrics** — the temporal script with structure tags like [Verse], [Chorus], [Bridge], vocal/energy tags, and lyric text. Use [Instrumental] for instrumental music.

## Caption Writing Rules
- Be specific: "sad piano ballad with female breathy vocal" beats "a sad song"
- Combine dimensions: style + emotion + instruments + timbre + era + production
- Useful dimensions: genre, emotion/atmosphere, instruments, timbre texture, era reference, production style, vocal characteristics, speed/rhythm, structure hints
- Texture words matter: warm, bright, crisp, airy, punchy, lush, raw, polished
- Don't put BPM/key/tempo in caption — those go in metadata params
- Avoid conflicting styles unless describing temporal evolution

## Lyrics/Structure Rules
- Structure tags: [Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro], [Drop], [Breakdown], [Instrumental], [Guitar Solo], [Fade Out]
- Tags can combine: [Chorus - anthemic], [Bridge - whispered]
- Keep 6-10 syllables per line for best rhythm
- UPPERCASE = stronger vocal intensity
- (parentheses) = background vocals
- Separate sections with blank lines
- For instrumental: just use [Instrumental] or structure tags like [Intro - ambient], [Main Theme - piano]

## Your Conversation Style
- Ask clarifying questions about mood, genre, instruments, vocal style
- Suggest improvements and alternatives
- When the user seems happy, output a final structured result in this exact format:

```prompt
CAPTION: <the caption text>
TAGS: <comma-separated genre/style tags>
LYRICS:
<the full lyrics with structure tags>
BPM: <number or "auto">
KEY: <key or "auto">
TIME_SIGNATURE: <time sig or "auto">
INSTRUMENTAL: <true or false>
DURATION: <seconds or "auto">
```

Only output the ```prompt block when the user asks you to finalize, or says something like "that's good", "let's go", "generate it", "apply it", etc. Otherwise just chat naturally and help them refine their idea.

IMPORTANT: Respond directly without internal reasoning. Keep responses concise and practical."#;

/// Handle POST /api/music/generate — generate music via ACE Step
async fn handle_music_generate(req: MusicGenerateRequest) -> Result<impl warp::Reply, warp::Rejection> {
    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({"error": "Prompt is required"})));
    }

    if !crate::ace_step::check_ace_step_installed() {
        return Ok(warp::reply::json(&serde_json::json!({
            "error": "ACE-Step is not installed. Install it from the main app's Music panel first."
        })));
    }

    let duration = req.duration_secs.min(900).max(10);
    let tags = if req.tags.is_empty() { prompt.clone() } else { req.tags.clone() };
    let instrumental = req.instrumental;
    let lyrics = if instrumental { "[inst]".to_string() } else if req.lyrics.is_empty() { String::new() } else { req.lyrics.clone() };

    // Build advanced params with sensible defaults
    let mut advanced = serde_json::json!({
        "thinking": true,
        "use_cot_caption": true,
        "use_cot_language": !instrumental,
        "vocal_language": "en",
    });
    if let Some(ref adv) = req.advanced {
        if let Some(obj) = adv.as_object() {
            for (k, v) in obj {
                if !v.is_null() {
                    advanced[k] = v.clone();
                }
            }
        }
    }

    // Spawn the generation in a blocking task since it uses blocking HTTP calls internally
    let result = tokio::task::spawn_blocking(move || {
        // Ensure the ACE Step server is running by checking the port
        let port: u16 = 8001;
        let is_healthy = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(2),
        ).is_ok();

        if !is_healthy {
            return Err("ACE-Step server is not running. Start it from the main app's Music panel first.".to_string());
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        // If vocal track with no lyrics, try to generate lyrics via LLM
        let effective_lyrics = if instrumental {
            "[inst]".to_string()
        } else if lyrics.trim().is_empty() {
            // Try calling the LLM synchronously for lyrics
            let rt = tokio::runtime::Handle::try_current();
            match rt {
                Ok(handle) => {
                    match handle.block_on(crate::intent_parser::call_llm_text(
                        "You are a professional songwriter. Write original song lyrics with section markers like [verse], [chorus], [bridge]. Keep it singable and match the mood.",
                        &format!("Write lyrics for a {}s track about: {} (style: {})", duration, prompt, tags),
                        1024,
                    )) {
                        Ok(l) => l,
                        Err(_) => "[inst]".to_string(), // Fall back to instrumental
                    }
                }
                Err(_) => "[inst]".to_string(),
            }
        } else {
            lyrics
        };

        // Build the request body
        let mut body = serde_json::json!({
            "tags": tags,
            "lyrics": effective_lyrics,
            "prompt": prompt,
            "duration": duration,
        });
        if let Some(obj) = advanced.as_object() {
            for (k, v) in obj {
                if !v.is_null() {
                    body[k] = v.clone();
                }
            }
        }

        // Submit job
        let resp = client
            .post(format!("http://127.0.0.1:{}/release_task", port))
            .json(&body)
            .send()
            .map_err(|e| format!("ACE-Step API error: {}", e))?;
        if !resp.status().is_success() {
            let txt = resp.text().unwrap_or_default();
            return Err(format!("ACE-Step API error: {}", txt));
        }
        let submit: serde_json::Value = resp.json().map_err(|e| format!("Parse error: {}", e))?;
        let task_id = submit["data"]["task_id"]
            .as_str()
            .ok_or_else(|| "No task_id in response".to_string())?
            .to_string();

        // Poll for completion
        let poll_body = serde_json::json!({"task_id_list": [task_id]});
        let mut attempts: u32 = 0;
        let max_attempts: u32 = 360; // 30 min
        let result_json: serde_json::Value = loop {
            attempts += 1;
            if attempts > max_attempts {
                return Err("Generation timed out".to_string());
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
            let poll_resp = match client
                .post(format!("http://127.0.0.1:{}/query_result", port))
                .json(&poll_body)
                .send()
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            if !poll_resp.status().is_success() { continue; }
            let poll_data: serde_json::Value = match poll_resp.json() {
                Ok(d) => d,
                Err(_) => continue,
            };
            if let Some(tasks) = poll_data["data"].as_array() {
                if let Some(task) = tasks.first() {
                    let status = task["status"].as_i64().unwrap_or(0);
                    if status == 2 {
                        return Err("ACE-Step generation failed".to_string());
                    }
                    if status == 1 {
                        if let Some(result_str) = task["result"].as_str() {
                            let parsed: serde_json::Value = serde_json::from_str(result_str)
                                .map_err(|e| format!("Result parse: {}", e))?;
                            break parsed;
                        }
                        return Err("No result in completed task".to_string());
                    }
                }
            }
        };

        // Download the audio file
        let files = result_json.as_array().ok_or("Expected array result")?;
        let file_url = files.first()
            .and_then(|f| f["file"].as_str())
            .ok_or("No file URL in result")?;

        let audio_url = format!("http://127.0.0.1:{}{}", port, file_url);
        let audio_resp = client.get(&audio_url).send()
            .map_err(|e| format!("Download error: {}", e))?;
        let bytes = audio_resp.bytes().map_err(|e| format!("Download error: {}", e))?;

        // Save the asset
        let id = format!("ace_{}", chrono::Utc::now().timestamp_millis());
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let asset_dir = std::path::PathBuf::from(&home)
            .join(".zoom-video-editor")
            .join("ace-step-music");
        std::fs::create_dir_all(&asset_dir).map_err(|e| format!("mkdir: {}", e))?;

        let audio_path = asset_dir.join(format!("{}.mp3", id));
        std::fs::write(&audio_path, &bytes).map_err(|e| format!("Write: {}", e))?;

        // Probe duration
        let audio_duration = {
            let output = std::process::Command::new(crate::ffmpeg_path::ffprobe_path())
                .args(["-v", "quiet", "-show_entries", "format=duration",
                       "-of", "default=noprint_wrappers=1:nokey=1",
                       &audio_path.to_string_lossy()])
                .output();
            match output {
                Ok(o) => String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().unwrap_or(duration as f64),
                Err(_) => duration as f64,
            }
        };

        let asset = crate::ace_step::AceStepAsset {
            id: id.clone(),
            file_path: audio_path.to_string_lossy().to_string(),
            prompt: prompt.clone(),
            duration_secs: audio_duration,
            tags: tags.clone(),
            instrumental,
            created_at: chrono::Utc::now().to_rfc3339(),
            lyrics: effective_lyrics,
            key: None,
            bpm: None,
            time_signature: None,
            model_variant: None,
            task_type: None,
            source_audio_ref: None,
            generation_time_secs: None,
            repaint_metadata: None,
            display_name: None,
            favourite: false,
            playlists: vec![],
        };

        // Save metadata
        let meta_path = asset_dir.join(format!("{}.json", id));
        let json_str = serde_json::to_string_pretty(&asset).map_err(|e| format!("Serialize: {}", e))?;
        std::fs::write(&meta_path, json_str).map_err(|e| format!("Write meta: {}", e))?;

        Ok(asset)
    }).await.map_err(|_| warp::reject::reject())?;

    match result {
        Ok(asset) => Ok(warp::reply::json(&serde_json::json!({
            "ok": true,
            "asset": asset,
        }))),
        Err(e) => Ok(warp::reply::json(&serde_json::json!({
            "error": e,
        }))),
    }
}

/// Handle POST /api/music/promptlab — chat with the music prompt engineer LLM
async fn handle_music_promptlab(req: PromptLabRequest) -> Result<impl warp::Reply, warp::Rejection> {
    let message = req.message.trim().to_string();
    if message.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({"error": "Message is required"})));
    }

    // Find the best available LLM endpoint
    let endpoint = if let Some(port) = crate::mlx::get_mlx_llm_server_port() {
        format!("http://127.0.0.1:{}/v1/chat/completions", port)
    } else if let Some(port) = crate::vision_analyzer::get_vlm_server_port() {
        format!("http://127.0.0.1:{}/v1/chat/completions", port)
    } else {
        return Ok(warp::reply::json(&serde_json::json!({
            "error": "No local AI server running. Start the LLM from the main app first."
        })));
    };

    // Build conversation history
    let history: Option<Vec<(String, String)>> = if req.history.is_empty() {
        None
    } else {
        Some(req.history.iter().map(|m| (m.role.clone(), m.content.clone())).collect())
    };

    match crate::mlx::generate_with_mlx_llm(
        &endpoint,
        MUSIC_PROMPTLAB_SYSTEM,
        &message,
        history,
        None,
        Some(0.8),
        None,
    ).await {
        Ok(response) => {
            let cleaned = response.trim().to_string();
            if cleaned.is_empty() {
                Ok(warp::reply::json(&serde_json::json!({
                    "response": "Hmm, got a blank response. Try rephrasing — shorter prompts sometimes work better with local models."
                })))
            } else {
                Ok(warp::reply::json(&serde_json::json!({
                    "response": cleaned,
                })))
            }
        }
        Err(e) => Ok(warp::reply::json(&serde_json::json!({
            "error": format!("LLM error: {}. Make sure your local AI server is running.", e),
        }))),
    }
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

/// Stop the mini app server and tunnel
pub fn stop_server() -> Result<(), String> {
    stop_tunnel();
    if let Ok(mut handle) = MINIAPP_HANDLE.lock() {
        if let Some(h) = handle.take() {
            h.abort();
            eprintln!("[telegram-miniapp] Server stopped");
        }
    }
    if let Ok(mut u) = MINIAPP_PUBLIC_URL.lock() { u.clear(); }
    Ok(())
}

/// Stop just the tunnel process
fn stop_tunnel() {
    if let Ok(mut proc) = TUNNEL_PROCESS.lock() {
        if let Some(mut child) = proc.take() {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[telegram-miniapp] Tunnel stopped");
        }
    }
}

/// Check if cloudflared is installed
pub fn check_cloudflared() -> bool {
    std::process::Command::new("cloudflared")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Start the warp server + cloudflared tunnel in one shot.
pub async fn start_with_tunnel(port: Option<u16>) -> Result<MiniAppStatus, String> {
    let status = start_server(port).await?;
    let local_port = status.port;

    if !check_cloudflared() {
        return Err(
            "cloudflared not found. Install it with: brew install cloudflared".to_string(),
        );
    }

    stop_tunnel();

    eprintln!(
        "[telegram-miniapp] Starting cloudflared tunnel for port {}...",
        local_port
    );

    let mut child = std::process::Command::new("cloudflared")
        .arg("tunnel")
        .arg("--url")
        .arg(format!("http://localhost:{}", local_port))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture cloudflared stderr")?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();

    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stderr);
        let url_sent = std::sync::atomic::AtomicBool::new(false);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            eprintln!("[cloudflared] {}", line);
            if !url_sent.load(std::sync::atomic::Ordering::Relaxed) {
                if let Some(url) = extract_tunnel_url(&line) {
                    let _ = tx.send(url);
                    url_sent.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }
    });

    if let Ok(mut proc) = TUNNEL_PROCESS.lock() {
        *proc = Some(child);
    }

    let tunnel_url = rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .map_err(|_| {
            "Timed out waiting for cloudflared tunnel URL. Check that cloudflared is working."
                .to_string()
        })?;

    eprintln!("[telegram-miniapp] Tunnel URL: {}", tunnel_url);
    set_public_url(&tunnel_url);

    Ok(MiniAppStatus {
        running: true,
        port: local_port,
        local_url: format!("http://localhost:{}", local_port),
        public_url: tunnel_url,
    })
}

/// Extract a trycloudflare.com or similar tunnel URL from a log line
fn extract_tunnel_url(line: &str) -> Option<String> {
    for word in line.split_whitespace() {
        if word.starts_with("https://") && word.contains(".trycloudflare.com") {
            return Some(word.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '/' && c != ':' && c != '-').to_string());
        }
    }
    for word in line.split_whitespace() {
        if word.starts_with("https://") && (word.contains(".ngrok") || word.contains(".ngrok-free.app")) {
            return Some(word.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '/' && c != ':' && c != '-').to_string());
        }
    }
    None
}

// ── Inline HTML ──────────────────────────────────────────────────────────────

const MINIAPP_HTML: &str = include_str!("telegram_miniapp.html");
