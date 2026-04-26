use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Mutex;
use tauri::Window;
use tokio::task::JoinHandle;
use std::path::Path;

// ── Data Structures ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VideoClassification {
    Primary,
    BRoll,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedVideo {
    pub id: String,
    pub file_path: String,
    pub classification: VideoClassification,
    pub filename: String,
    pub size_bytes: u64,
    pub staged_at: String, // ISO 8601 timestamp
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramBotStatus {
    pub connected: bool,
    pub bot_username: Option<String>,
    pub polling: bool,
    pub last_error: Option<String>,
    pub messages_processed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramBotInfo {
    pub id: i64,
    pub username: String,
    pub first_name: String,
}

// ── Static State ─────────────────────────────────────────────────────────────

static BOT_STATUS: Mutex<Option<TelegramBotStatus>> = Mutex::new(None);
static BOT_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static BOT_TOKEN: Mutex<Option<String>> = Mutex::new(None);
static STAGED_VIDEOS: Mutex<Vec<StagedVideo>> = Mutex::new(Vec::new());
static ACTIVE_CHAT_ID: Mutex<Option<i64>> = Mutex::new(None);
/// Active storyboard session for the Telegram bot (real chat IDs)
static STORYBOARD_SESSION: Mutex<Option<StoryboardSession>> = Mutex::new(None);
/// Separate session for the Mini App (chat_id = -999) so it never collides with bot sessions
static MINIAPP_SESSION: Mutex<Option<StoryboardSession>> = Mutex::new(None);

/// Tracks an active storyboard creative session started from Telegram.
/// The project_id links to a real StoryboardProject on disk so the user
/// can continue editing in the app UI.
#[derive(Debug, Clone)]
pub struct StoryboardSession {
    /// Real storyboard project ID (persisted to disk)
    pub project_id: String,
    /// Chat ID for the prompt lab conversation (persisted to disk)
    pub chat_id: String,
    /// Telegram chat to send replies to
    pub telegram_chat_id: i64,
    /// Conversation history for multi-turn LLM calls
    pub history: Vec<(String, String)>,
    /// Reference images sent by the user
    pub ref_images: Vec<String>,
    /// Visual style preference extracted from conversation
    pub style: String,
    /// Video length in seconds
    pub video_length_secs: u32,
    /// Character profiles for this session
    pub characters: Vec<crate::storyboard::CharacterProfile>,
    /// Workflow mode: "full-auto", "fast-start", "production"
    pub workflow: String,
}

const TELEGRAM_API_BASE: &str = "https://api.telegram.org/bot";
const BACKOFF_BASE_DELAY_SECS: u64 = 2;
const BACKOFF_MAX_DELAY_SECS: u64 = 60;
const BACKOFF_MAX_RETRIES: u32 = 10;

// ── Telegram API Response Types ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TelegramResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUser {
    id: i64,
    first_name: String,
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    message: Option<TelegramMessage>,
}

#[derive(Debug, Deserialize)]
struct TelegramMessage {
    #[allow(dead_code)]
    message_id: i64,
    chat: TelegramChat,
    text: Option<String>,
    caption: Option<String>,
    photo: Option<Vec<TelegramPhotoSize>>,
    video: Option<TelegramVideo>,
    document: Option<TelegramDocument>,
}

#[derive(Debug, Deserialize)]
struct TelegramChat {
    id: i64,
}

#[derive(Debug, Deserialize)]
struct TelegramPhotoSize {
    file_id: String,
    #[allow(dead_code)]
    file_unique_id: String,
    #[allow(dead_code)]
    width: i32,
    #[allow(dead_code)]
    height: i32,
    #[allow(dead_code)]
    file_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TelegramVideo {
    file_id: String,
    #[allow(dead_code)]
    file_name: Option<String>,
    #[allow(dead_code)]
    file_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TelegramDocument {
    file_id: String,
    file_name: Option<String>,
    #[allow(dead_code)]
    file_size: Option<u64>,
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramFile {
    #[allow(dead_code)]
    file_id: String,
    file_path: Option<String>,
}

// ── Backoff Calculation ──────────────────────────────────────────────────────

/// Calculate exponential backoff delay in seconds.
/// Formula: min(base_delay * 2^retry_count, max_delay)
pub fn calculate_backoff_delay(retry_count: u32) -> u64 {
    let delay = BACKOFF_BASE_DELAY_SECS.saturating_mul(2u64.saturating_pow(retry_count));
    delay.min(BACKOFF_MAX_DELAY_SECS)
}

// ── Video Classification ─────────────────────────────────────────────────────

/// Classify a video based on caption keywords.
/// Captions containing "primary", "speaker", or "main" (case-insensitive) → Primary.
/// Everything else → BRoll.
pub fn classify_video(caption: &str) -> VideoClassification {
    let lower = caption.to_lowercase();
    if lower.contains("primary") || lower.contains("speaker") || lower.contains("main") {
        VideoClassification::Primary
    } else {
        VideoClassification::BRoll
    }
}

// ── Staged Video Management ──────────────────────────────────────────────────

/// Stage a video file with the given classification.
pub fn stage_video(path: &str, classification: VideoClassification) -> Result<StagedVideo, String> {
    let file_path = std::path::Path::new(path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    let metadata = std::fs::metadata(file_path)
        .map_err(|e| format!("Cannot read file metadata: {}", e))?;

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let video = StagedVideo {
        id: format!("vid_{}", chrono::Utc::now().timestamp_millis()),
        file_path: path.to_string(),
        classification,
        filename,
        size_bytes: metadata.len(),
        staged_at: chrono::Utc::now().to_rfc3339(),
    };

    if let Ok(mut staged) = STAGED_VIDEOS.lock() {
        staged.push(video.clone());
    }

    Ok(video)
}

/// Get all staged videos.
pub fn get_staged_videos() -> Vec<StagedVideo> {
    STAGED_VIDEOS
        .lock()
        .map(|v| v.clone())
        .unwrap_or_default()
}

/// Clear all staged videos.
pub fn clear_staged_videos() {
    if let Ok(mut staged) = STAGED_VIDEOS.lock() {
        staged.clear();
    }
}

// ── Bot Status ───────────────────────────────────────────────────────────────

/// Get the current bot status.
pub fn get_bot_status() -> TelegramBotStatus {
    BOT_STATUS
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or(TelegramBotStatus {
            connected: false,
            bot_username: None,
            polling: false,
            last_error: None,
            messages_processed: 0,
        })
}

fn update_status<F: FnOnce(&mut TelegramBotStatus)>(updater: F) {
    if let Ok(mut status) = BOT_STATUS.lock() {
        let s = status.get_or_insert(TelegramBotStatus {
            connected: false,
            bot_username: None,
            polling: false,
            last_error: None,
            messages_processed: 0,
        });
        updater(s);
    }
}

// ── Token Validation ─────────────────────────────────────────────────────────

/// Validate a Telegram bot token by calling the getMe API.
pub async fn validate_token(token: &str) -> Result<TelegramBotInfo, String> {
    let url = format!("{}{}/getMe", TELEGRAM_API_BASE, token);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Telegram API: {}", e))?;

    let body: TelegramResponse<TelegramUser> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Telegram response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "Telegram API error: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }

    let user = body.result.ok_or("No user data in response")?;
    Ok(TelegramBotInfo {
        id: user.id,
        username: user.username.unwrap_or_else(|| "unknown".to_string()),
        first_name: user.first_name,
    })
}

// ── Telegram API Helpers ─────────────────────────────────────────────────────

/// Send a text message to a Telegram chat.
async fn send_message(token: &str, chat_id: i64, text: &str) -> Result<(), String> {
    let url = format!("{}{}/sendMessage", TELEGRAM_API_BASE, token);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&json!({
            "chat_id": chat_id,
            "text": text,
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let body: TelegramResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sendMessage response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "sendMessage failed: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }
    Ok(())
}

/// Send a message with a Web App inline keyboard button (for Mini App).
async fn send_message_with_webapp(
    token: &str,
    chat_id: i64,
    text: &str,
    button_text: &str,
    webapp_url: &str,
) -> Result<(), String> {
    let url = format!("{}{}/sendMessage", TELEGRAM_API_BASE, token);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&json!({
            "chat_id": chat_id,
            "text": text,
            "reply_markup": {
                "inline_keyboard": [[{
                    "text": button_text,
                    "web_app": { "url": webapp_url }
                }]]
            }
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let body: TelegramResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sendMessage response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "sendMessage with webapp failed: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }
    Ok(())
}

/// Send a photo file to a Telegram chat.
async fn send_photo(token: &str, chat_id: i64, photo_path: &str, caption: Option<&str>) -> Result<(), String> {
    let url = format!("{}{}/sendPhoto", TELEGRAM_API_BASE, token);
    let file_bytes = std::fs::read(photo_path)
        .map_err(|e| format!("Failed to read photo {}: {}", photo_path, e))?;
    let filename = Path::new(photo_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("photo.jpg")
        .to_string();

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str("image/jpeg")
        .map_err(|e| format!("MIME error: {}", e))?;

    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("photo", part);

    if let Some(cap) = caption {
        form = form.text("caption", cap.to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("sendPhoto failed: {}", e))?;

    let body: TelegramResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sendPhoto response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "sendPhoto failed: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }
    Ok(())
}

/// Send a video file to a Telegram chat.
async fn send_video(token: &str, chat_id: i64, video_path: &str, caption: Option<&str>) -> Result<(), String> {
    let url = format!("{}{}/sendVideo", TELEGRAM_API_BASE, token);
    let file_bytes = std::fs::read(video_path)
        .map_err(|e| format!("Failed to read video {}: {}", video_path, e))?;
    let filename = Path::new(video_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video.mp4")
        .to_string();

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str("video/mp4")
        .map_err(|e| format!("MIME error: {}", e))?;

    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("video", part);

    if let Some(cap) = caption {
        form = form.text("caption", cap.to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("sendVideo failed: {}", e))?;

    let body: TelegramResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sendVideo response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "sendVideo failed: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }
    Ok(())
}

/// Send an animated GIF to a Telegram chat.
async fn send_animation(token: &str, chat_id: i64, gif_path: &str, caption: Option<&str>) -> Result<(), String> {
    let url = format!("{}{}/sendAnimation", TELEGRAM_API_BASE, token);
    let file_bytes = std::fs::read(gif_path)
        .map_err(|e| format!("Failed to read animation {}: {}", gif_path, e))?;
    let filename = Path::new(gif_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("animation.gif")
        .to_string();

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str("image/gif")
        .map_err(|e| format!("MIME error: {}", e))?;

    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("animation", part);

    if let Some(cap) = caption {
        form = form.text("caption", cap.to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("sendAnimation failed: {}", e))?;

    let body: TelegramResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sendAnimation response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "sendAnimation failed: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }
    Ok(())
}
async fn download_telegram_file(
    token: &str,
    file_id: &str,
    dest_dir: &str,
) -> Result<String, String> {
    // Step 1: Get file path from Telegram
    let url = format!("{}{}/getFile?file_id={}", TELEGRAM_API_BASE, token, file_id);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("getFile failed: {}", e))?;

    let body: TelegramResponse<TelegramFile> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse getFile response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "getFile error: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }

    let tg_file = body.result.ok_or("No file data in response")?;
    let remote_path = tg_file
        .file_path
        .ok_or("Telegram did not return a file_path")?;

    // Step 2: Download the file
    let download_url = format!(
        "https://api.telegram.org/file/bot{}/{}",
        token, remote_path
    );
    let file_bytes = client
        .get(&download_url)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("File download failed: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read file bytes: {}", e))?;

    // Step 3: Save to local staging directory
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Cannot create staging dir: {}", e))?;

    let filename = remote_path
        .split('/')
        .last()
        .unwrap_or("telegram_file");
    let local_path = format!("{}/{}", dest_dir, filename);

    std::fs::write(&local_path, &file_bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(local_path)
}

/// Fetch updates from Telegram using long-polling.
async fn get_updates(
    token: &str,
    offset: i64,
) -> Result<Vec<TelegramUpdate>, String> {
    let url = format!(
        "{}{}/getUpdates?offset={}&timeout=30",
        TELEGRAM_API_BASE, token, offset
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(35))
        .send()
        .await
        .map_err(|e| format!("getUpdates failed: {}", e))?;

    let body: TelegramResponse<Vec<TelegramUpdate>> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse getUpdates response: {}", e))?;

    if !body.ok {
        return Err(format!(
            "getUpdates error: {}",
            body.description.unwrap_or_else(|| "Unknown error".to_string())
        ));
    }

    Ok(body.result.unwrap_or_default())
}

// ── Message Handling ─────────────────────────────────────────────────────────

/// Get the staging directory for downloaded Telegram files.
fn get_staging_dir() -> String {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    let staging = base.join("zoom-video-editor").join("telegram-staging");
    staging.to_string_lossy().to_string()
}

// ── LLM Endpoint Discovery ──────────────────────────────────────────────────

/// Try to find a running local LLM endpoint (MLX-LM or VLM server).
pub fn find_llm_endpoint() -> Result<String, String> {
    // Try MLX LLM server first
    if let Some(port) = crate::mlx::get_mlx_llm_server_port() {
        return Ok(format!("http://127.0.0.1:{}/v1/chat/completions", port));
    }
    // Try VLM server
    if let Some(port) = crate::vision_analyzer::get_vlm_server_port() {
        return Ok(format!("http://127.0.0.1:{}/v1/chat/completions", port));
    }
    // Probe common ports using non-blocking TCP connect to avoid blocking the
    // Tokio async runtime when this function is called from an async context.
    for port in &[8012u16, 8011, 8010, 1234, 11434] {
        let addr = format!("127.0.0.1:{}", port);
        if std::net::TcpStream::connect_timeout(
            &addr.parse().unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap()),
            std::time::Duration::from_millis(300),
        ).is_ok() {
            return Ok(format!("http://127.0.0.1:{}/v1/chat/completions", port));
        }
    }
    Err("No local AI server running. Start your LLM from the app first.".to_string())
}

// ── Storyboard Session Helpers ───────────────────────────────────────────────

/// The same system prompt used by the frontend Prompt Lab.
const STORYBOARD_SYSTEM_PROMPT: &str = r#"You are a video scene prompt engineer for LTX-2.3, a state-of-the-art AI video generation model. You help users craft perfect scene prompts through conversation — from a single scene to a full multi-scene storyboard.

Your job:
1. Understand the user's creative vision through natural conversation
2. Help them develop scenes with rich visual prompts optimized for AI video generation
3. When they're ready, output scenes in a structured format with shots

When outputting scenes, use this exact format:
```scene
TITLE: <scene title>
PROMPT: <overall scene description — what happens in this scene>
MOOD: <emotional tone>
DURATION: <total scene seconds, typically 5-10>
SHOT 1: <shot_type> | <camera_movement> | <duration_secs> | <detailed visual prompt for what the camera sees> | <transition>
SHOT 2: <shot_type> | <camera_movement> | <duration_secs> | <visual prompt> | <transition>
```

Shot types: wide, medium, close-up, extreme-close-up, over-the-shoulder, aerial, low-angle, high-angle, dutch-angle, pov
Camera movements: static, pan-left, pan-right, tilt-up, tilt-down, dolly-in, dolly-out, tracking, crane-up, crane-down, handheld, orbit
Transitions: cut, dissolve, fade-in, fade-out, wipe, match-cut

Rules:
- Each scene should have 2-4 shots
- Shot visual prompts should describe ONLY what is visible: composition, subjects, lighting, action, environment
- Follow: shot type + subject + action + environment + camera movement + lighting + style
- Include lighting details, color palette, and atmosphere
- Keep each shot prompt under 200 words for best results
- Each shot can be up to 10 seconds; use 8-10s for establishing shots, 3-5s for action
- Ask clarifying questions to refine the vision
- Suggest improvements and alternatives proactively"#;

/// Get or create a storyboard session for the given Telegram chat.
pub fn get_or_create_session(telegram_chat_id: i64, initial_prompt: &str) -> StoryboardSession {
    // Mini App uses a dedicated session store to avoid colliding with bot sessions
    let store: &Mutex<Option<StoryboardSession>> = if telegram_chat_id == -999 {
        &MINIAPP_SESSION
    } else {
        &STORYBOARD_SESSION
    };

    if let Ok(guard) = store.lock() {
        if let Some(ref session) = *guard {
            if session.telegram_chat_id == telegram_chat_id {
                return session.clone();
            }
        }
    }
    // Create a new session with a real storyboard project
    let project_id = format!("tg_{}", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let chat_id = format!("tg_chat_{}", chrono::Utc::now().timestamp_millis());
    let session = StoryboardSession {
        project_id: project_id.clone(),
        chat_id,
        telegram_chat_id,
        history: Vec::new(),
        ref_images: Vec::new(),
        style: String::new(),
        video_length_secs: 60,
        characters: Vec::new(),
        workflow: "fast-start".to_string(),
    };
    // Create the storyboard project on disk so it shows up in the library
    let _ = crate::storyboard::create_storyboard_project(
        &session.project_id,
        &initial_prompt[..initial_prompt.len().min(100)],
        (session.video_length_secs as u64) * 1000,
        Vec::new(),
        "",
    );
    eprintln!(
        "[telegram-storyboard] Created project {} for chat {}",
        project_id, telegram_chat_id
    );
    if let Ok(mut guard) = store.lock() {
        *guard = Some(session.clone());
    }
    session
}

/// Update the session in global state.
pub fn update_session(session: &StoryboardSession) {
    let store: &Mutex<Option<StoryboardSession>> = if session.telegram_chat_id == -999 {
        &MINIAPP_SESSION
    } else {
        &STORYBOARD_SESSION
    };
    if let Ok(mut guard) = store.lock() {
        *guard = Some(session.clone());
    }
}
pub fn persist_chat(session: &StoryboardSession) {
    let messages: Vec<crate::storyboard::PromptLabMessage> = session
        .history
        .iter()
        .map(|(role, content)| crate::storyboard::PromptLabMessage {
            role: role.clone(),
            content: content.clone(),
            images: Vec::new(),
        })
        .collect();
    let title = session
        .history
        .iter()
        .find(|(r, _)| r == "user")
        .map(|(_, c)| c[..c.len().min(50)].to_string())
        .unwrap_or_else(|| "Telegram session".to_string());
    let _ = crate::storyboard::save_storyboard_chat(
        &session.project_id,
        &session.chat_id,
        &title,
        messages,
    );
}

/// Chat with the LLM using the storyboard system prompt and conversation history.
pub async fn storyboard_llm_chat(
    session: &StoryboardSession,
    user_message: &str,
) -> Result<String, String> {
    let endpoint = find_llm_endpoint()?;

    let style_note = if session.style.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nVISUAL STYLE CONSTRAINT: All scene prompts MUST use \"{}\" style.",
            session.style
        )
    };

    // Include character profiles so the LLM knows about characters when generating scenes
    let character_note = if session.characters.is_empty() {
        // Fall back to project-level character_prompt
        let project_char = crate::storyboard::load_storyboard_project(&session.project_id)
            .ok()
            .map(|p| p.character_prompt)
            .unwrap_or_default();
        if project_char.is_empty() {
            String::new()
        } else {
            format!("\n\nCHARACTER DESCRIPTION:\n{}", project_char)
        }
    } else {
        let mut char_lines = Vec::new();
        for ch in &session.characters {
            let visual = if !ch.appearance.is_empty() {
                ch.appearance.trim()
            } else {
                ch.description.trim()
            };
            let role_tag = if ch.role.is_empty() {
                String::new()
            } else {
                format!(" ({})", ch.role)
            };
            char_lines.push(format!("- {}{}: {}", ch.name, role_tag, visual));
        }
        format!(
            "\n\nCHARACTER PROFILES — include these exact appearances in every scene/shot prompt where the character appears:\n{}",
            char_lines.join("\n")
        )
    };

    let system = format!(
        "{}{}{}\n\nRespond directly without internal reasoning. Keep responses concise.",
        STORYBOARD_SYSTEM_PROMPT, style_note, character_note
    );

    let history: Option<Vec<(String, String)>> = if session.history.is_empty() {
        None
    } else {
        Some(session.history.clone())
    };

    crate::mlx::generate_with_mlx_llm(
        &endpoint,
        &system,
        user_message,
        history,
        None,
        Some(0.8),
        None,
    )
    .await
}

/// Parse ```scene blocks from LLM response into StoryboardScene structs.
pub fn parse_scenes_from_response(response: &str) -> Vec<crate::storyboard::StoryboardScene> {
    let mut scenes = Vec::new();
    let re = regex::Regex::new(r"(?s)```scene\s*\n(.*?)```").unwrap_or_else(|_| return regex::Regex::new("$^").unwrap());
    let shot_re = regex::Regex::new(r"(?i)SHOT\s+(\d+):\s*(.+)").unwrap_or_else(|_| return regex::Regex::new("$^").unwrap());

    for (i, cap) in re.captures_iter(response).enumerate() {
        let block = &cap[1];
        let title = extract_field(block, "TITLE").unwrap_or_else(|| format!("Scene {}", i + 1));
        let scene_prompt = extract_field(block, "PROMPT").unwrap_or_default();
        let mood = extract_field(block, "MOOD").unwrap_or_else(|| "cinematic".to_string());
        let duration_str = extract_field(block, "DURATION").unwrap_or_else(|| "8".to_string());
        let duration_secs: f64 = duration_str
            .trim_end_matches('s')
            .trim()
            .parse()
            .unwrap_or(8.0);
        let scene_duration_ms = (duration_secs * 1000.0) as u64;

        // Parse shots within the scene block
        let mut shots = Vec::new();
        for shot_cap in shot_re.captures_iter(block) {
            let shot_num: usize = shot_cap[1].parse().unwrap_or(shots.len() + 1);
            let parts: Vec<&str> = shot_cap[2].split('|').map(|p| p.trim()).collect();

            let shot_type = parts.first().unwrap_or(&"medium").to_string();
            let camera_movement = parts.get(1).unwrap_or(&"static").to_string();
            let shot_dur_secs: f64 = parts.get(2)
                .and_then(|s| s.trim_end_matches('s').trim().parse().ok())
                .unwrap_or(duration_secs / 3.0);
            let shot_prompt = parts.get(3).unwrap_or(&scene_prompt.as_str()).to_string();
            let transition = parts.get(4).unwrap_or(&"cut").to_string();

            shots.push(crate::storyboard::StoryboardShot {
                id: format!("tg_shot_{}_{}_{}", chrono::Utc::now().timestamp_millis(), i, shot_num),
                shot_number: shot_num,
                duration_ms: (shot_dur_secs * 1000.0) as u64,
                shot_type,
                camera_movement,
                visual_prompt: shot_prompt,
                video_prompt: None,
                dialogue: None,
                transition,
                image_path: None,
                keyframe_middle_path: None,
                keyframe_last_path: None,
                keyframe_first_prompt: None,
                keyframe_middle_prompt: None,
                keyframe_last_prompt: None,
                video_path: None,
                video_settings: None,
                characters_in_shot: vec![],
                image_history: vec![],
                keyframe_middle_history: vec![],
                keyframe_last_history: vec![],
                video_history: vec![],
            });
        }

        // If no shots were parsed, create a default shot from the scene prompt
        if shots.is_empty() {
            shots.push(crate::storyboard::StoryboardShot {
                id: format!("tg_shot_{}_{}_1", chrono::Utc::now().timestamp_millis(), i),
                shot_number: 1,
                duration_ms: scene_duration_ms,
                shot_type: "wide".to_string(),
                camera_movement: "static".to_string(),
                visual_prompt: scene_prompt.clone(),
                video_prompt: None,
                dialogue: None,
                transition: "cut".to_string(),
                image_path: None,
                keyframe_middle_path: None,
                keyframe_last_path: None,
                keyframe_first_prompt: None,
                keyframe_middle_prompt: None,
                keyframe_last_prompt: None,
                video_path: None,
                video_settings: None,
                characters_in_shot: vec![],
                image_history: vec![],
                keyframe_middle_history: vec![],
                keyframe_last_history: vec![],
                video_history: vec![],
            });
        }

        scenes.push(crate::storyboard::StoryboardScene {
            id: format!("tg_scene_{}_{}", chrono::Utc::now().timestamp_millis(), i),
            scene_number: i + 1,
            duration_ms: scene_duration_ms,
            title,
            description: String::new(),
            visual_prompt: scene_prompt,
            mood,
            suggested_music: String::new(),
            suggested_broll: Vec::new(),
            image_path: None,
            shots,
            reference_images: vec![],
            characters_in_scene: vec![],
        });
    }
    scenes
}

/// Extract a field value from a scene block (e.g. "TITLE: My Scene" → "My Scene").
fn extract_field(block: &str, field: &str) -> Option<String> {
    for line in block.lines() {
        let trimmed = line.trim();
        let prefix = format!("{}:", field);
        if trimmed.to_uppercase().starts_with(&prefix.to_uppercase()) {
            let value = trimmed[prefix.len()..].trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// Generate video for each scene's shots using LTX, sending each clip back via Telegram.
/// Returns the list of generated video file paths.
/// LTX 2.3 max: 257 frames = 8*32+1 (~10.7s at 24fps).
const MAX_FRAMES_PER_CLIP: u32 = 257;
/// 1080p 16:9 resolution matching BRollPanel's "1080p" tier.
const TG_VIDEO_WIDTH: u32 = 1280;
const TG_VIDEO_HEIGHT: u32 = 736;

/// Visual style presets matching the frontend StoryboardPanel.
pub const STYLE_PRESETS: &[(&str, &str, &str)] = &[
    ("pixar", "🧸 Pixar / 3D Animated", "Pixar-style 3D animation, vibrant colors, soft lighting, expressive characters, detailed textures, cinematic rendering"),
    ("anime", "🌸 Anime", "Anime style, cel-shaded, vibrant saturated colors, dramatic lighting, detailed backgrounds, Studio Ghibli inspired"),
    ("realistic", "📷 Photorealistic", "Photorealistic, ultra-detailed, natural lighting, shot on RED camera, shallow depth of field, 8K resolution"),
    ("hollywood", "🎬 Hollywood Cinematic", "Hollywood cinematic style, dramatic lighting, anamorphic lens flare, color graded, film grain, epic composition"),
    ("scifi", "🌌 Surreal Sci-Fi", "Surreal science fiction, otherworldly atmosphere, bioluminescent elements, cosmic scale, dreamlike quality, futuristic"),
    ("watercolor", "🎨 Watercolor", "Watercolor painting style, soft washes of color, visible brush strokes, dreamy atmosphere, artistic illustration"),
    ("noir", "🕵️ Film Noir", "Film noir style, high contrast black and white, dramatic shadows, venetian blind lighting, moody atmosphere"),
    ("retro", "🕹️ Retro Synthwave", "Retro 80s synthwave aesthetic, neon colors, chrome reflections, grid landscapes, VHS texture, retrowave"),
    ("comic", "💥 Comic Book", "Comic book style, bold outlines, halftone dots, dynamic action poses, vivid flat colors, graphic novel aesthetic"),
];

/// Look up a style preset by key (case-insensitive, partial match).
pub fn find_style_preset(key: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let lower = key.trim().to_lowercase();
    STYLE_PRESETS.iter().find(|(k, label, _)| {
        k.eq_ignore_ascii_case(&lower)
            || label.to_lowercase().contains(&lower)
    }).copied()
}

/// Format the style menu for Telegram.
pub fn style_menu() -> String {
    let mut msg = "🎨 Visual Styles:\n".to_string();
    for (key, label, _) in STYLE_PRESETS {
        msg.push_str(&format!("  /style {} — {}\n", key, label));
    }
    msg.push_str("\nOr /style <custom description> for your own style.\n/style off — remove style constraint");
    msg
}

/// Snap frame count to valid LTX 8n+1 value.
fn snap_frames(n: u32) -> u32 {
    let n = n.max(17);
    if n % 8 == 1 { n } else { ((n - 1) / 8) * 8 + 1 }
}

/// Extract a character description from storyboard scenes for auto-generating a reference image.
/// Looks for recurring character mentions across scene prompts and descriptions.
fn extract_character_description(scenes: &[crate::storyboard::StoryboardScene]) -> String {
    // Collect all text from scenes
    let all_text: Vec<String> = scenes
        .iter()
        .flat_map(|s| {
            let mut texts = vec![s.description.clone(), s.visual_prompt.clone()];
            for shot in &s.shots {
                texts.push(shot.visual_prompt.clone());
            }
            texts
        })
        .collect();
    let combined = all_text.join(" ");

    // Look for character-like descriptions: "a young woman with...", "an old man wearing..."
    let patterns = [
        r"(?i)(a\s+(?:young|old|elderly|tall|short|mysterious|wise)\s+(?:woman|man|girl|boy|child|person|figure|lady|gentleman)\b[^.]{0,120})",
        r"(?i)((?:she|he)\s+(?:has|wears|is wearing|is dressed in)\b[^.]{0,100})",
        r"(?i)(character[^.]{0,80}(?:with|wearing|has)[^.]{0,80})",
    ];

    for pat in &patterns {
        if let Ok(re) = regex::Regex::new(pat) {
            if let Some(m) = re.find(&combined) {
                let desc = m.as_str().trim().to_string();
                if desc.len() > 15 {
                    return desc;
                }
            }
        }
    }

    // Fallback: use the first scene's visual prompt (first 150 chars) as a rough character hint
    if let Some(first) = scenes.first() {
        let vp = &first.visual_prompt;
        if vp.len() > 20 {
            return vp.chars().take(150).collect::<String>();
        }
    }

    String::new()
}

/// Build an enriched prompt mirroring the frontend's `buildFullPrompt` logic.
/// Prepends session style, scene context (for shot-level prompts), global character
/// description, and scoped character appearances (only characters whose names appear
/// in the scene/shot text).
fn build_enriched_prompt(
    base_prompt: &str,
    scene: &crate::storyboard::StoryboardScene,
    session: &StoryboardSession,
    is_shot_level: bool,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    // 1. Session style (equivalent to frontend's getStylePrompt())
    if !session.style.is_empty() {
        parts.push(session.style.clone());
    }

    // 2. Scene context — ground the shot in its parent scene (shot-level only)
    if is_shot_level {
        let mood_part = if scene.mood.is_empty() {
            String::new()
        } else {
            format!(", mood: {}", scene.mood)
        };
        parts.push(format!("Scene: \"{}\"{}",  scene.title, mood_part));
    }

    // 3. Global character description extracted from all scenes
    //    (equivalent to frontend's charPrompt — we derive it from extract_character_description
    //     or from the project's character_prompt if available)
    let global_char_desc = {
        // Try loading the project's character_prompt from disk
        let project_char_prompt = crate::storyboard::load_storyboard_project(&session.project_id)
            .ok()
            .map(|p| p.character_prompt)
            .unwrap_or_default();
        if !project_char_prompt.is_empty() {
            project_char_prompt
        } else {
            String::new()
        }
    };
    if !global_char_desc.is_empty() {
        parts.push(global_char_desc.clone());
    }

    // 4. Scoped character appearances — only include characters whose name appears
    //    in the scene or shot text (mirrors frontend's buildFullPrompt logic)
    let combined_text = format!(
        "{} {} {} {}",
        scene.visual_prompt, scene.title, scene.description, base_prompt
    ).to_lowercase();

    for ch in &session.characters {
        let visual = if !ch.appearance.is_empty() {
            ch.appearance.trim().to_string()
        } else {
            ch.description.trim().to_string()
        };
        if visual.is_empty() {
            continue;
        }
        // Skip if already mentioned in global char description
        if !global_char_desc.is_empty() && global_char_desc.contains(&ch.name) {
            continue;
        }
        // Only include characters relevant to this scene/shot
        if combined_text.contains(&ch.name.to_lowercase()) {
            parts.push(format!("{}: {}", ch.name, visual));
        }
    }

    // 5. If no character profiles exist, fall back to regex-extracted character description
    if session.characters.is_empty() && global_char_desc.is_empty() {
        // Build a temporary scenes vec to extract character description
        let fallback_desc = extract_character_description(std::slice::from_ref(scene));
        if !fallback_desc.is_empty() {
            parts.push(fallback_desc);
        }
    }

    // 6. The base prompt itself
    parts.push(base_prompt.to_string());

    parts.join(". ")
}

/// Generate a single LTX clip and return the file path.
fn generate_single_clip(
    window: &Window,
    prompt: &str,
    num_frames: u32,
) -> Result<crate::ltx::LtxGenerationResult, String> {
    crate::ltx::generate_ltx_video(
        window,
        prompt,
        None,            // negative_prompt
        TG_VIDEO_WIDTH,
        TG_VIDEO_HEIGHT,
        num_frames,
        30,              // steps
        3.5,             // guidance_scale
        24,              // fps
        -1,              // seed (random)
        None,            // image_path
        None,            // model_id
        true,            // no_audio (faster for batch)
        None,            // hf_token
        true,            // distilled
        false,           // upscale
        None,            // character_refs
    )
}

/// For scenes longer than MAX_FRAMES_PER_CLIP, generate multiple clips and concat.
fn concat_scene_clips(clip_paths: &[String]) -> Result<String, String> {
    if clip_paths.len() == 1 {
        return Ok(clip_paths[0].clone());
    }
    let ffmpeg = crate::ffmpeg_path::ffmpeg_path();
    let tmp_dir = std::env::temp_dir().join("tg_scene_concat");
    std::fs::create_dir_all(&tmp_dir).ok();
    let list_file = tmp_dir.join(format!("scene_{}.txt", chrono::Utc::now().timestamp_millis()));
    let mut list = String::new();
    for p in clip_paths {
        list.push_str(&format!("file '{}'\n", p));
    }
    std::fs::write(&list_file, &list)
        .map_err(|e| format!("Failed to write concat list: {}", e))?;

    let output_dir = shellexpand::tilde("~/.zoom-video-editor/ltx-library").to_string();
    let output = format!("{}/scene_concat_{}.mp4", output_dir, chrono::Utc::now().timestamp_millis());

    let result = std::process::Command::new(&ffmpeg)
        .args(["-y", "-f", "concat", "-safe", "0", "-i", &list_file.to_string_lossy(), "-c", "copy", &output])
        .output()
        .map_err(|e| format!("FFmpeg concat failed: {}", e))?;

    if !result.status.success() {
        // Fallback: re-encode
        let result2 = std::process::Command::new(&ffmpeg)
            .args(["-y", "-f", "concat", "-safe", "0", "-i", &list_file.to_string_lossy(),
                   "-c:v", "libx264", "-preset", "fast", "-crf", "23", &output])
            .output()
            .map_err(|e| format!("FFmpeg re-encode failed: {}", e))?;
        if !result2.status.success() {
            return Err(format!("FFmpeg concat failed: {}", String::from_utf8_lossy(&result2.stderr)));
        }
    }
    Ok(output)
}

/// Result from scene video generation — includes per-shot paths for proper project persistence.
struct SceneVideoResult {
    /// The concatenated scene video (or single clip if only one shot)
    scene_path: String,
    /// Individual shot video paths, in order. Empty if scene had no shots.
    shot_paths: Vec<String>,
}

async fn generate_scene_videos(
    window: &Window,
    token: &str,
    session: &StoryboardSession,
    scenes: &[crate::storyboard::StoryboardScene],
) -> Vec<SceneVideoResult> {
    let mut results = Vec::new();

    for (i, scene) in scenes.iter().enumerate() {
        let shots = &scene.shots;

        // If no shots, fall back to scene-level generation
        if shots.is_empty() {
            let total_frames = ((scene.duration_ms as f64 / 1000.0) * 24.0) as u32;
            let total_frames = total_frames.max(25);
            let num_frames = snap_frames(total_frames.min(MAX_FRAMES_PER_CLIP));
            let total_secs = total_frames as f64 / 24.0;

            let _ = send_message(
                token,
                session.telegram_chat_id,
                &format!(
                    "🎬 Scene {}/{}: {} ({:.0}s, {}×{})...",
                    i + 1, scenes.len(), scene.title, total_secs,
                    TG_VIDEO_WIDTH, TG_VIDEO_HEIGHT,
                ),
            )
            .await;

            let w = window.clone();
            let prompt = build_enriched_prompt(&scene.visual_prompt, scene, session, false);
            let result = tokio::task::spawn_blocking(move || {
                generate_single_clip(&w, &prompt, num_frames)
            })
            .await;

            match result {
                Ok(Ok(gen_result)) => {
                    let caption = format!(
                        "🎬 Scene {}: {}\n⏱ {:.1}s gen | {:.0}s video",
                        i + 1, scene.title, gen_result.generation_time_secs, total_secs,
                    );
                    let _ = send_video(token, session.telegram_chat_id, &gen_result.file_path, Some(&caption)).await;
                    results.push(SceneVideoResult {
                        scene_path: gen_result.file_path.clone(),
                        shot_paths: vec![gen_result.file_path],
                    });
                }
                Ok(Err(e)) => {
                    eprintln!("[telegram-storyboard] Scene {} failed: {}", i + 1, e);
                    let _ = send_message(token, session.telegram_chat_id, &format!("⚠️ Scene {} failed: {}", i + 1, e)).await;
                }
                Err(e) => {
                    eprintln!("[telegram-storyboard] Scene {} task error: {}", i + 1, e);
                }
            }
            continue;
        }

        // Generate each shot as its own video clip
        let total_shots = shots.len();
        let _ = send_message(
            token,
            session.telegram_chat_id,
            &format!(
                "🎬 Scene {}/{}: {} — {} shot{} at {}×{}",
                i + 1, scenes.len(), scene.title,
                total_shots, if total_shots > 1 { "s" } else { "" },
                TG_VIDEO_WIDTH, TG_VIDEO_HEIGHT,
            ),
        )
        .await;

        let mut shot_clip_paths: Vec<String> = Vec::new();
        let mut total_gen_time = 0.0_f64;
        let mut failed = false;

        for (si, shot) in shots.iter().enumerate() {
            let shot_frames = ((shot.duration_ms as f64 / 1000.0) * 24.0) as u32;
            let shot_frames = snap_frames(shot_frames.max(25).min(MAX_FRAMES_PER_CLIP));
            let shot_secs = shot_frames as f64 / 24.0;

            eprintln!(
                "[telegram-storyboard] Scene {} shot {}/{}: {} {} ({} frames, {:.1}s)",
                i + 1, si + 1, total_shots, shot.shot_type, shot.camera_movement,
                shot_frames, shot_secs
            );

            let w = window.clone();
            let prompt = build_enriched_prompt(&shot.visual_prompt, scene, session, true);
            let result = tokio::task::spawn_blocking(move || {
                generate_single_clip(&w, &prompt, shot_frames)
            })
            .await;

            match result {
                Ok(Ok(gen_result)) => {
                    total_gen_time += gen_result.generation_time_secs;
                    shot_clip_paths.push(gen_result.file_path);
                }
                Ok(Err(e)) => {
                    eprintln!("[telegram-storyboard] Scene {} shot {} failed: {}", i + 1, si + 1, e);
                    let _ = send_message(
                        token, session.telegram_chat_id,
                        &format!("⚠️ Scene {} shot {} ({}) failed: {}", i + 1, si + 1, shot.shot_type, e),
                    ).await;
                    failed = true;
                    break;
                }
                Err(e) => {
                    eprintln!("[telegram-storyboard] Scene {} shot {} task error: {}", i + 1, si + 1, e);
                    failed = true;
                    break;
                }
            }
        }

        if failed || shot_clip_paths.is_empty() {
            continue;
        }

        // Concat all shot clips into one scene video
        let scene_path = if shot_clip_paths.len() > 1 {
            match concat_scene_clips(&shot_clip_paths) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[telegram-storyboard] Scene {} concat failed: {}", i + 1, e);
                    let _ = send_message(token, session.telegram_chat_id, &format!("⚠️ Scene {} concat failed: {}", i + 1, e)).await;
                    continue;
                }
            }
        } else {
            shot_clip_paths[0].clone()
        };

        let scene_secs: f64 = shots.iter().map(|s| s.duration_ms as f64 / 1000.0).sum();
        let caption = format!(
            "🎬 Scene {}: {}\n🎥 {} shots | ⏱ {:.1}s gen | {:.0}s video",
            i + 1, scene.title, total_shots, total_gen_time, scene_secs,
        );
        let _ = send_video(token, session.telegram_chat_id, &scene_path, Some(&caption)).await;
        results.push(SceneVideoResult {
            scene_path,
            shot_paths: shot_clip_paths,
        });
    }

    results
}

/// Create an animated GIF preview from a list of video files using FFmpeg.
fn create_preview_gif(video_paths: &[String]) -> Result<String, String> {
    if video_paths.is_empty() {
        return Err("No videos to create GIF from".to_string());
    }

    let ffmpeg = crate::ffmpeg_path::ffmpeg_path();
    let output_dir = shellexpand::tilde("~/.zoom-video-editor/storyboard-movies").to_string();
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    let gif_path = format!(
        "{}/preview_{}.gif",
        output_dir,
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );

    // Build a concat filter that takes 2s from each video, scales to 320px wide
    let tmp_dir = std::env::temp_dir().join("tg_gif_concat");
    std::fs::create_dir_all(&tmp_dir).ok();
    let list_file = tmp_dir.join("gif_list.txt");
    let mut list_content = String::new();
    for vp in video_paths {
        list_content.push_str(&format!("file '{}'\n", vp));
    }
    std::fs::write(&list_file, &list_content)
        .map_err(|e| format!("Failed to write concat list: {}", e))?;

    // Concat → scale → GIF with palette for quality
    let palette_path = tmp_dir.join("palette.png");

    // Step 1: Generate palette
    let output = std::process::Command::new(ffmpeg)
        .args([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", &list_file.to_string_lossy(),
            "-t", &format!("{}", video_paths.len() * 2), // ~2s per clip
            "-vf", "fps=10,scale=320:-1:flags=lanczos,palettegen",
            "-y", &palette_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("FFmpeg palette failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg palette error: {}", stderr));
    }

    // Step 2: Create GIF using palette
    let output = std::process::Command::new(ffmpeg)
        .args([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", &list_file.to_string_lossy(),
            "-i", &palette_path.to_string_lossy(),
            "-t", &format!("{}", video_paths.len() * 2),
            "-lavfi", "fps=10,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse",
            "-y", &gif_path,
        ])
        .output()
        .map_err(|e| format!("FFmpeg GIF failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg GIF error: {}", stderr));
    }

    Ok(gif_path)
}

/// Concatenate video clips into a final movie using FFmpeg.
fn concat_final_movie(video_paths: &[String]) -> Result<String, String> {
    if video_paths.is_empty() {
        return Err("No videos to concatenate".to_string());
    }

    let ffmpeg = crate::ffmpeg_path::ffmpeg_path();
    let output_dir = shellexpand::tilde("~/.zoom-video-editor/storyboard-movies").to_string();
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    let movie_path = format!(
        "{}/movie_{}.mp4",
        output_dir,
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );

    let tmp_dir = std::env::temp_dir().join("tg_movie_concat");
    std::fs::create_dir_all(&tmp_dir).ok();
    let list_file = tmp_dir.join("movie_list.txt");
    let mut list_content = String::new();
    for vp in video_paths {
        list_content.push_str(&format!("file '{}'\n", vp));
    }
    std::fs::write(&list_file, &list_content)
        .map_err(|e| format!("Failed to write concat list: {}", e))?;

    // Try stream copy first (fast)
    let output = std::process::Command::new(ffmpeg)
        .args([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", &list_file.to_string_lossy(),
            "-c", "copy",
            &movie_path,
        ])
        .output()
        .map_err(|e| format!("FFmpeg concat failed: {}", e))?;

    if !output.status.success() {
        // Fallback: re-encode
        let output2 = std::process::Command::new(ffmpeg)
            .args([
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", &list_file.to_string_lossy(),
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "23",
                "-c:a", "aac",
                &movie_path,
            ])
            .output()
            .map_err(|e| format!("FFmpeg re-encode failed: {}", e))?;

        if !output2.status.success() {
            let stderr = String::from_utf8_lossy(&output2.stderr);
            return Err(format!("FFmpeg concat failed: {}", stderr));
        }
    }

    Ok(movie_path)
}

/// Check if a text message is a storyboard command.
fn is_storyboard_command(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower.starts_with("/storyboard")
        || lower.starts_with("/sb")
        || lower.starts_with("storyboard:")
        || lower.starts_with("sb:")
}

/// Check if the user wants to generate/render the storyboard.
fn is_generate_command(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower == "/generate"
        || lower == "/render"
        || lower == "generate"
        || lower == "render"
        || lower == "make it"
        || lower == "build it"
        || lower.starts_with("/generate ")
        || lower.starts_with("/render ")
}

/// Check if the user wants to end/reset the storyboard session.
fn is_reset_command(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower == "/reset" || lower == "/new" || lower == "/done" || lower == "reset" || lower == "new session"
}

/// Check if there's an active storyboard session for this chat.
fn has_active_session(telegram_chat_id: i64) -> bool {
    STORYBOARD_SESSION
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| s.telegram_chat_id == telegram_chat_id))
        .unwrap_or(false)
}

/// Process an incoming Telegram message.
/// Routes: storyboard commands → Prompt Lab pipeline,
///         photos → reference collection or vision analysis,
///         videos → stage_video,
///         text → Intent_Parser.
/// Returns an optional reply string.
async fn handle_message(
    window: &Window,
    message: &TelegramMessage,
    token: &str,
    allowed_chat_ids: &[i64],
) -> Result<Option<String>, String> {
    let chat_id = message.chat.id;

    // Silently ignore messages from unauthorized chats
    if !allowed_chat_ids.is_empty() && !allowed_chat_ids.contains(&chat_id) {
        eprintln!(
            "[telegram-bot] Ignoring message from unauthorized chat {}",
            chat_id
        );
        return Ok(None);
    }

    // Track active chat for notifications
    if let Ok(mut id) = ACTIVE_CHAT_ID.lock() {
        *id = Some(chat_id);
    }

    // ── Photo handling ───────────────────────────────────────────────────
    // If there's an active storyboard session, photos become reference images.
    // Otherwise, route to vision analyzer.
    if let Some(photos) = &message.photo {
        if let Some(largest) = photos.last() {
            let staging_dir = get_staging_dir();
            match download_telegram_file(token, &largest.file_id, &staging_dir).await {
                Ok(local_path) => {
                    // If storyboard session is active, save as reference
                    if has_active_session(chat_id) {
                        let mut session = get_or_create_session(chat_id, "");
                        session.ref_images.push(local_path.clone());
                        update_session(&session);

                        let caption = message.caption.clone().unwrap_or_default();
                        if !caption.is_empty() {
                            // Also chat about the reference
                            let user_msg = format!(
                                "I'm sending a reference image. Caption: {}. Use this as visual inspiration for the storyboard.",
                                caption
                            );
                            session.history.push(("user".to_string(), user_msg.clone()));
                            match storyboard_llm_chat(&session, &user_msg).await {
                                Ok(response) => {
                                    session.history.push(("assistant".to_string(), response.clone()));
                                    update_session(&session);
                                    persist_chat(&session);
                                    return Ok(Some(format!(
                                        "📸 Reference saved ({} total)\n\n{}",
                                        session.ref_images.len(),
                                        response
                                    )));
                                }
                                Err(e) => {
                                    update_session(&session);
                                    return Ok(Some(format!(
                                        "📸 Reference saved ({} total)\n⚠️ LLM unavailable: {}",
                                        session.ref_images.len(),
                                        e
                                    )));
                                }
                            }
                        }

                        return Ok(Some(format!(
                            "📸 Reference image saved ({} total). Send more or describe your vision.",
                            session.ref_images.len()
                        )));
                    }

                    // No active session — use vision analyzer
                    let prompt = message
                        .caption
                        .clone()
                        .unwrap_or_else(|| "Describe this image in detail.".to_string());

                    match crate::vision_analyzer::analyze_image(window, &local_path, &prompt).await
                    {
                        Ok(description) => return Ok(Some(description)),
                        Err(e) => {
                            return Ok(Some(format!("Vision analysis failed: {}", e)));
                        }
                    }
                }
                Err(e) => {
                    return Ok(Some(format!("Failed to download image: {}", e)));
                }
            }
        }
    }

    // ── Video handling → stage_video ─────────────────────────────────────
    if let Some(video) = &message.video {
        let staging_dir = get_staging_dir();
        match download_telegram_file(token, &video.file_id, &staging_dir).await {
            Ok(local_path) => {
                let caption = message.caption.clone().unwrap_or_default();
                let classification = classify_video(&caption);
                match stage_video(&local_path, classification) {
                    Ok(staged) => {
                        let class_label = match &staged.classification {
                            VideoClassification::Primary => "Primary",
                            VideoClassification::BRoll => "B-Roll",
                        };
                        return Ok(Some(format!(
                            "✅ Video staged as {}: {} ({} bytes)",
                            class_label, staged.filename, staged.size_bytes
                        )));
                    }
                    Err(e) => {
                        return Ok(Some(format!("Failed to stage video: {}", e)));
                    }
                }
            }
            Err(e) => {
                return Ok(Some(format!("Failed to download video: {}", e)));
            }
        }
    }

    // ── Document handling (video files sent as documents) ────────────────
    if let Some(doc) = &message.document {
        let is_video = doc
            .mime_type
            .as_ref()
            .map(|m| m.starts_with("video/"))
            .unwrap_or(false);

        if is_video {
            let staging_dir = get_staging_dir();
            match download_telegram_file(token, &doc.file_id, &staging_dir).await {
                Ok(local_path) => {
                    let caption = message.caption.clone().unwrap_or_default();
                    let classification = classify_video(&caption);
                    match stage_video(&local_path, classification) {
                        Ok(staged) => {
                            let class_label = match &staged.classification {
                                VideoClassification::Primary => "Primary",
                                VideoClassification::BRoll => "B-Roll",
                            };
                            return Ok(Some(format!(
                                "✅ Video staged as {}: {} ({} bytes)",
                                class_label, staged.filename, staged.size_bytes
                            )));
                        }
                        Err(e) => {
                            return Ok(Some(format!("Failed to stage video: {}", e)));
                        }
                    }
                }
                Err(e) => {
                    return Ok(Some(format!("Failed to download document: {}", e)));
                }
            }
        }
    }

    // ── Text message handling ────────────────────────────────────────────
    if let Some(text) = &message.text {
        // Special "status" command
        if text.trim().eq_ignore_ascii_case("status") {
            let staged = get_staged_videos();
            let primary_count = staged
                .iter()
                .filter(|v| matches!(v.classification, VideoClassification::Primary))
                .count();
            let broll_count = staged
                .iter()
                .filter(|v| matches!(v.classification, VideoClassification::BRoll))
                .count();

            let session_info = if has_active_session(chat_id) {
                let session = get_or_create_session(chat_id, "");
                let style_info = if session.style.is_empty() {
                    "auto (from chat)".to_string()
                } else if session.style.len() > 40 {
                    format!("{}...", &session.style[..40])
                } else {
                    session.style.clone()
                };
                format!(
                    "\n🎬 Active storyboard: {}\n• {} messages, {} refs\n• 🎨 Style: {}\n• 🔄 Workflow: {}\n• Open in app to continue editing",
                    session.project_id,
                    session.history.len(),
                    session.ref_images.len(),
                    style_info,
                    match session.workflow.as_str() {
                        "full-auto" => "🚀 Full Auto",
                        "production" => "🎬 Full Production",
                        _ => "⚡ Fast Start",
                    }
                )
            } else {
                "\n🎬 No active storyboard session\n• Send /storyboard <idea> to start".to_string()
            };

            return Ok(Some(format!(
                "📊 Status:\n• Staged videos: {} ({} primary, {} B-roll)\n• Bot polling: active{}",
                staged.len(),
                primary_count,
                broll_count,
                session_info
            )));
        }

        // Help command
        if text.trim().eq_ignore_ascii_case("/help") || text.trim().eq_ignore_ascii_case("help") {
            return Ok(Some(
                "🎬 Storyboard Commands:\n\
                 /storyboard <idea> — Start a new creative session\n\
                 /sb <idea> — Short alias for /storyboard\n\
                 /app — Open the Mini App\n\
                 /workflow — Set workflow mode (auto, fast, production)\n\
                 /style <name> — Set visual style (pixar, anime, realistic, etc.)\n\
                 /style — Show all available styles\n\
                 /character <name>: <desc> — Add/update character profile\n\
                 /character enrich <name> — AI backstory & personality pass\n\
                 /character enrich all — Enrich entire cast\n\
                 /character generate <name> — Generate character reference image\n\
                 /character list — Show all characters\n\
                 📸 Send photos — Add reference images\n\
                 💬 Chat naturally — Refine your scenes\n\
                 /generate — Generate all scene videos\n\
                 /reset — End session and start fresh\n\
                 /status — Check current state\n\n\
                 Your project is saved automatically and shows up in the app's Storyboard Library."
                    .to_string(),
            ));
        }

        // Mini App command (/app is primary, /gallery and /miniapp are aliases)
        if text.trim().eq_ignore_ascii_case("/app") || text.trim().eq_ignore_ascii_case("/gallery") || text.trim().eq_ignore_ascii_case("/miniapp") {
            let public_url = crate::telegram_miniapp::get_public_url();
            if public_url.is_empty() {
                return Ok(Some(
                    "🌐 Mini App not running yet.\n\n\
                     Launch it from the app's Telegram settings — one button starts everything.\n\n\
                     The Mini App lets you create storyboards, chat with AI, manage your cast, generate music, and more."
                        .to_string(),
                ));
            }
            // Send a Web App button instead of a plain text reply
            let _ = send_message_with_webapp(
                token,
                chat_id,
                "🌐 Open the Mini App to create storyboards, chat with AI, manage your cast, and more.",
                "🎬 Open App",
                &public_url,
            )
            .await;
            return Ok(None); // We already sent the message with the button
        }

        // ── Style command ────────────────────────────────────────────────
        if text.trim().to_lowercase().starts_with("/style") {
            let arg = text.trim().strip_prefix("/style").unwrap_or("").trim();
            if arg.is_empty() {
                return Ok(Some(style_menu()));
            }
            if arg.eq_ignore_ascii_case("off") || arg.eq_ignore_ascii_case("none") || arg.eq_ignore_ascii_case("auto") {
                if has_active_session(chat_id) {
                    let mut session = get_or_create_session(chat_id, "");
                    session.style.clear();
                    update_session(&session);
                }
                return Ok(Some("🎨 Style cleared — prompts will use auto style from chat.".to_string()));
            }
            // Try preset lookup first
            if let Some((key, label, prompt)) = find_style_preset(arg) {
                if has_active_session(chat_id) {
                    let mut session = get_or_create_session(chat_id, "");
                    session.style = prompt.to_string();
                    update_session(&session);
                    return Ok(Some(format!(
                        "🎨 Style set: {} ({})\nAll scene prompts will now include this style.\n\n/style off to remove.",
                        label, key
                    )));
                }
                return Ok(Some(format!(
                    "🎨 Style: {} — start a session first with /storyboard <idea>",
                    label
                )));
            }
            // Custom style description
            if has_active_session(chat_id) {
                let mut session = get_or_create_session(chat_id, "");
                session.style = arg.to_string();
                update_session(&session);
                return Ok(Some(format!(
                    "🎨 Custom style set: \"{}\"\nAll scene prompts will include this.\n\n/style off to remove.",
                    arg
                )));
            }
            return Ok(Some("Start a session first with /storyboard <idea>, then set a style.".to_string()));
        }

        // ── Workflow command ─────────────────────────────────────────────
        if text.trim().to_lowercase().starts_with("/workflow") {
            let arg = text.trim().strip_prefix("/workflow").unwrap_or("").trim().to_lowercase();
            if arg.is_empty() {
                let current = if has_active_session(chat_id) {
                    let s = get_or_create_session(chat_id, "");
                    s.workflow.clone()
                } else { "fast-start".to_string() };
                return Ok(Some(format!(
                    "🔄 Workflow Modes:\n\
                     /workflow auto — 🚀 Full Auto (AI does everything end-to-end)\n\
                     /workflow fast — ⚡ AI Fast Start (AI creates all, you review before video)\n\
                     /workflow production — 🎬 Full Production (step-by-step with AI)\n\n\
                     Current: {}",
                    match current.as_str() {
                        "full-auto" => "🚀 Full Auto",
                        "production" => "🎬 Full Production",
                        _ => "⚡ AI Fast Start",
                    }
                )));
            }
            let mode = match arg.as_str() {
                "auto" | "full-auto" | "fullauto" => "full-auto",
                "fast" | "fast-start" | "faststart" | "quick" => "fast-start",
                "production" | "prod" | "full" | "step" => "production",
                _ => {
                    return Ok(Some("Unknown workflow. Use: auto, fast, or production".to_string()));
                }
            };
            if has_active_session(chat_id) {
                let mut session = get_or_create_session(chat_id, "");
                session.workflow = mode.to_string();
                update_session(&session);
                let label = match mode {
                    "full-auto" => "🚀 Full Auto — AI does everything from prompt to final movie",
                    "production" => "🎬 Full Production — step-by-step: idea → characters → scenes → shots → video",
                    _ => "⚡ AI Fast Start — AI creates everything, you review before video gen",
                };
                return Ok(Some(format!("Workflow set: {}", label)));
            }
            return Ok(Some("Start a session first with /storyboard <idea>, then set workflow.".to_string()));
        }

        // ── Character command ────────────────────────────────────────────
        if text.trim().to_lowercase().starts_with("/character") || text.trim().to_lowercase().starts_with("/char ") {
            let arg = text.trim().strip_prefix("/character").or_else(|| text.trim().strip_prefix("/char")).unwrap_or("").trim();
            if !has_active_session(chat_id) {
                return Ok(Some("Start a session first with /storyboard <idea>, then manage characters.".to_string()));
            }
            let session = get_or_create_session(chat_id, "");

            if arg.is_empty() || arg.eq_ignore_ascii_case("list") {
                // List current character profiles
                if session.characters.is_empty() {
                    return Ok(Some("👤 No character profiles yet.\n\nUsage:\n/character <name>: <description> — Add a character\n/character enrich <name> — AI backstory pass\n/character enrich all — Enrich entire cast\n/character generate <name> — Generate a reference image\n/character list — Show all characters".to_string()));
                }
                let mut msg = "👤 Character Profiles:\n\n".to_string();
                for ch in &session.characters {
                    let enriched_tag = if ch.enriched { " ✨" } else { "" };
                    let role_tag = if ch.role.is_empty() { String::new() } else { format!(" ({})", ch.role) };
                    msg.push_str(&format!("• {}{}{} — {}\n  📸 {} image{}\n",
                        ch.name, role_tag, enriched_tag,
                        if ch.description.len() > 60 { format!("{}...", &ch.description[..60]) } else { ch.description.clone() },
                        ch.reference_images.len(),
                        if ch.reference_images.len() != 1 { "s" } else { "" },
                    ));
                    if !ch.personality.is_empty() {
                        let preview: String = ch.personality.chars().take(60).collect();
                        msg.push_str(&format!("  🎭 {}...\n", preview));
                    }
                }
                msg.push_str("\n/character <name>: <description> — Add/update\n/character enrich <name> — AI backstory pass\n/character enrich all — Enrich entire cast\n/character generate <name> — Generate image\n/character delete <name> — Remove");
                return Ok(Some(msg));
            }

            // /character delete <name>
            if arg.to_lowercase().starts_with("delete ") || arg.to_lowercase().starts_with("remove ") {
                let name = arg.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
                if let Some(ch) = session.characters.iter().find(|c| c.name.eq_ignore_ascii_case(&name)) {
                    let ch_id = ch.id.clone();
                    let _ = crate::storyboard::delete_character_profile(&session.project_id, &ch_id);
                    if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                        if let Some(ref mut s) = *guard {
                            s.characters.retain(|c| c.id != ch_id);
                        }
                    }
                    return Ok(Some(format!("🗑 Deleted character: {}", name)));
                }
                return Ok(Some(format!("Character '{}' not found.", name)));
            }

            // /character enrich <name> or /character enrich all
            if arg.to_lowercase().starts_with("enrich") {
                let target = arg.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
                let proj_id = session.project_id.clone();

                if target.is_empty() || target.eq_ignore_ascii_case("all") {
                    // Enrich all characters
                    if session.characters.is_empty() {
                        return Ok(Some("No characters to enrich. Add some first with /character <name>: <description>".to_string()));
                    }
                    let count = session.characters.len();
                    let _ = send_message(token, chat_id, &format!("🧠 Enriching {} character{} with AI backstory, personality, relationships...", count, if count != 1 { "s" } else { "" })).await;

                    match crate::storyboard::enrich_all_characters(&proj_id).await {
                        Ok(enriched) => {
                            // Update session
                            if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                                if let Some(ref mut s) = *guard {
                                    s.characters = enriched.clone();
                                }
                            }
                            let mut msg = format!("✅ Enriched {} character profiles:\n\n", enriched.len());
                            for ch in &enriched {
                                msg.push_str(&format!("👤 {} ({})\n", ch.name, if ch.role.is_empty() { "no role" } else { &ch.role }));
                                if !ch.personality.is_empty() {
                                    let preview: String = ch.personality.chars().take(80).collect();
                                    msg.push_str(&format!("   🎭 {}\n", preview));
                                }
                            }
                            msg.push_str("\nUse /character list to see full details.");
                            return Ok(Some(msg));
                        }
                        Err(e) => return Ok(Some(format!("⚠️ Enrichment failed: {}", e))),
                    }
                } else {
                    // Enrich a specific character
                    if let Some(ch) = session.characters.iter().find(|c| c.name.eq_ignore_ascii_case(&target)) {
                        let ch_id = ch.id.clone();
                        let ch_name = ch.name.clone();
                        let _ = send_message(token, chat_id, &format!("🧠 Enriching {}...", ch_name)).await;

                        match crate::storyboard::enrich_character_profile(&proj_id, &ch_id).await {
                            Ok(enriched) => {
                                if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                                    if let Some(ref mut s) = *guard {
                                        if let Some(c) = s.characters.iter_mut().find(|c| c.id == ch_id) {
                                            *c = enriched.clone();
                                        }
                                    }
                                }
                                let mut msg = format!("✅ {} — enriched profile:\n\n", enriched.name);
                                if !enriched.role.is_empty() { msg.push_str(&format!("🎬 Role: {}\n", enriched.role)); }
                                if !enriched.appearance.is_empty() { msg.push_str(&format!("👁 Appearance: {}\n", enriched.appearance.chars().take(120).collect::<String>())); }
                                if !enriched.personality.is_empty() { msg.push_str(&format!("🎭 Personality: {}\n", enriched.personality.chars().take(120).collect::<String>())); }
                                if !enriched.backstory.is_empty() { msg.push_str(&format!("📖 Backstory: {}\n", enriched.backstory.chars().take(120).collect::<String>())); }
                                if !enriched.motivations.is_empty() { msg.push_str(&format!("🔥 Motivations: {}\n", enriched.motivations.chars().take(120).collect::<String>())); }
                                if !enriched.relationships.is_empty() { msg.push_str(&format!("🤝 Relationships: {}\n", enriched.relationships.chars().take(120).collect::<String>())); }
                                if !enriched.arc.is_empty() { msg.push_str(&format!("📈 Arc: {}\n", enriched.arc.chars().take(120).collect::<String>())); }
                                return Ok(Some(msg));
                            }
                            Err(e) => return Ok(Some(format!("⚠️ Failed to enrich {}: {}", ch_name, e))),
                        }
                    }
                    return Ok(Some(format!("Character '{}' not found.", target)));
                }
            }

            // /character generate <name>
            if arg.to_lowercase().starts_with("generate ") || arg.to_lowercase().starts_with("gen ") {
                let name = arg.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
                if let Some(ch) = session.characters.iter().find(|c| c.name.eq_ignore_ascii_case(&name)) {
                    let desc = ch.description.clone();
                    let ch_id = ch.id.clone();
                    let proj_id = session.project_id.clone();
                    let _ = send_message(token, chat_id, &format!("🎨 Generating image for {}...", ch.name)).await;

                    let w = window.clone();
                    let gen_result = tokio::task::spawn_blocking(move || {
                        let prompt = format!("Character reference sheet, full body portrait. {}. Clean background, consistent lighting.", desc);
                        crate::image_gen::generate_image(&w, &format!("tg_char_{}", chrono::Utc::now().timestamp_millis()),
                            &prompt, Some("blurry, deformed, multiple characters, text"),
                            512, 512, 9, 0.0, -1, "zimage-turbo", None, None, 1.0, None)
                    }).await;

                    match gen_result {
                        Ok(Ok(img_result)) => {
                            let _ = crate::storyboard::add_character_image(&proj_id, &ch_id, &img_result.file_path);
                            if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                                if let Some(ref mut s) = *guard {
                                    if let Some(c) = s.characters.iter_mut().find(|c| c.id == ch_id) {
                                        c.reference_images.push(img_result.file_path.clone());
                                        if c.active_image.is_none() {
                                            c.active_image = Some(img_result.file_path.clone());
                                        }
                                    }
                                }
                            }
                            let _ = send_photo(token, chat_id, &img_result.file_path, Some(&format!("🎭 New reference for {}", name))).await;
                            return Ok(Some(format!("✅ Image added to {}'s profile. Send /character generate {} again for more variations.", name, name)));
                        }
                        _ => return Ok(Some(format!("⚠️ Failed to generate image for {}.", name))),
                    }
                }
                return Ok(Some(format!("Character '{}' not found. Add with /character {}: <description>", name, name)));
            }

            // /character <name>: <description> — add or update
            if let Some(colon_pos) = arg.find(':') {
                let name = arg[..colon_pos].trim().to_string();
                let description = arg[colon_pos + 1..].trim().to_string();
                if name.is_empty() || description.is_empty() {
                    return Ok(Some("Usage: /character <name>: <description>".to_string()));
                }
                // Check if character already exists
                let existing = session.characters.iter().find(|c| c.name.eq_ignore_ascii_case(&name));
                let profile = if let Some(ex) = existing {
                    crate::storyboard::CharacterProfile {
                        id: ex.id.clone(),
                        name: name.clone(),
                        description: description.clone(),
                        reference_images: ex.reference_images.clone(),
                        active_image: ex.active_image.clone(),
                        ..Default::default()
                    }
                } else {
                    crate::storyboard::CharacterProfile {
                        id: format!("tg_char_{}", chrono::Utc::now().timestamp_millis()),
                        name: name.clone(),
                        description: description.clone(),
                        ..Default::default()
                    }
                };
                let _ = crate::storyboard::save_character_profile(&session.project_id, profile.clone());
                if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                    if let Some(ref mut s) = *guard {
                        if let Some(existing) = s.characters.iter_mut().find(|c| c.name.eq_ignore_ascii_case(&name)) {
                            existing.description = description.clone();
                        } else {
                            s.characters.push(profile);
                        }
                    }
                }
                return Ok(Some(format!("👤 Character '{}' saved!\nDescription: {}\n\nUse /character generate {} to create a reference image.", name, description, name)));
            }

            return Ok(Some("Usage:\n/character <name>: <description>\n/character enrich <name> — AI backstory pass\n/character enrich all — Enrich entire cast\n/character generate <name>\n/character delete <name>\n/character list".to_string()));
        }

        // ── Reset command ────────────────────────────────────────────────
        if is_reset_command(text) {
            if has_active_session(chat_id) {
                let session = get_or_create_session(chat_id, "");
                persist_chat(&session);
                if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                    *guard = None;
                }
                return Ok(Some(format!(
                    "✅ Session saved as project: {}\nOpen the app's Storyboard tab to continue editing.\n\nSend /storyboard <idea> to start a new one.",
                    session.project_id
                )));
            }
            return Ok(Some("No active session. Send /storyboard <idea> to start.".to_string()));
        }

        // ── Generate/render command ──────────────────────────────────────
        if is_generate_command(text) {
            if !has_active_session(chat_id) {
                return Ok(Some(
                    "No active storyboard session. Send /storyboard <idea> to start one first."
                        .to_string(),
                ));
            }

            let session = get_or_create_session(chat_id, "");

            // Load the project's scenes
            let scenes = match crate::storyboard::list_storyboards() {
                Ok(projects) => {
                    projects
                        .into_iter()
                        .find(|p| p.id == session.project_id)
                        .map(|p| p.scenes)
                        .unwrap_or_default()
                }
                Err(_) => Vec::new(),
            };

            if scenes.is_empty() {
                return Ok(Some(
                    "No scenes in this storyboard yet. Keep chatting to develop scenes, then try /generate again."
                        .to_string(),
                ));
            }

            let _ = send_message(
                token,
                chat_id,
                &format!(
                    "{} Starting generation of {} scenes ({} workflow)...\nThis will take a while. I'll send each clip as it's ready.",
                    match session.workflow.as_str() { "full-auto" => "🚀", "production" => "🎬", _ => "⚡" },
                    scenes.len(),
                    match session.workflow.as_str() { "full-auto" => "Full Auto", "production" => "Full Production", _ => "Fast Start" },
                ),
            )
            .await;

            // Workflow: enrich characters before generation (full-auto and fast-start)
            if session.workflow != "production" && !session.characters.is_empty() {
                let has_unenriched = session.characters.iter().any(|c| !c.enriched);
                if has_unenriched {
                    let _ = send_message(token, chat_id, "🧠 Enriching character profiles for consistency...").await;
                    match crate::storyboard::enrich_all_characters(&session.project_id).await {
                        Ok(enriched) => {
                            if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                                if let Some(ref mut s) = *guard {
                                    s.characters = enriched;
                                }
                            }
                            let _ = send_message(token, chat_id, "✨ Characters enriched with backstory & personality").await;
                        }
                        Err(e) => {
                            eprintln!("[telegram-storyboard] Character enrichment failed: {}", e);
                        }
                    }
                }
            }

            // Auto-generate character reference image if none provided
            // This ensures character consistency across all scene videos
            if session.ref_images.is_empty() {
                // Extract character description from scenes
                let char_desc = extract_character_description(&scenes);
                if !char_desc.is_empty() {
                    let _ = send_message(
                        token,
                        chat_id,
                        "🎭 Generating character reference for consistency...",
                    )
                    .await;

                    let w = window.clone();
                    let desc = char_desc.clone();
                    let ref_result = tokio::task::spawn_blocking(move || {
                        let prompt = format!(
                            "Character reference sheet, full body portrait. {}. Clean background, consistent lighting, detailed features.",
                            desc
                        );
                        crate::image_gen::generate_image(
                            &w,
                            &format!("tg_char_ref_{}", chrono::Utc::now().timestamp_millis()),
                            &prompt,
                            Some("blurry, deformed, multiple characters, text"),
                            512, 512, 9, 0.0, -1,
                            "zimage-turbo",
                            None, None, 1.0, None,
                        )
                    })
                    .await;

                    match ref_result {
                        Ok(Ok(img_result)) => {
                            eprintln!("[telegram-storyboard] Auto char ref generated: {}", img_result.file_path);
                            // Update session ref_images (for future use)
                            if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                                if let Some(ref mut s) = *guard {
                                    s.ref_images.push(img_result.file_path.clone());
                                    // Save as a character profile
                                    let profile = crate::storyboard::CharacterProfile {
                                        id: format!("tg_char_{}", chrono::Utc::now().timestamp_millis()),
                                        name: "Main Character".to_string(),
                                        description: char_desc.clone(),
                                        reference_images: vec![img_result.file_path.clone()],
                                        active_image: Some(img_result.file_path.clone()),
                                        ..Default::default()
                                    };
                                    s.characters.push(profile.clone());
                                    let _ = crate::storyboard::save_character_profile(&s.project_id, profile);
                                }
                            }
                            let _ = send_photo(
                                token,
                                chat_id,
                                &img_result.file_path,
                                Some("🎭 Character reference generated — using for consistency"),
                            )
                            .await;
                        }
                        _ => {
                            eprintln!("[telegram-storyboard] Auto char ref failed, proceeding without");
                        }
                    }
                }
            }

            // Generate videos for each scene
            let scene_results =
                generate_scene_videos(window, token, &session, &scenes).await;

            if scene_results.is_empty() {
                return Ok(Some(
                    "⚠️ No videos were generated. Make sure the LTX server is running in the app."
                        .to_string(),
                ));
            }

            let video_paths: Vec<String> = scene_results.iter().map(|r| r.scene_path.clone()).collect();

            // Create animated GIF preview
            let _ = send_message(token, chat_id, "🎞 Creating preview GIF...").await;
            match create_preview_gif(&video_paths) {
                Ok(gif_path) => {
                    let _ = send_animation(
                        token,
                        chat_id,
                        &gif_path,
                        Some(&format!("🎞 Preview: {} scenes", video_paths.len())),
                    )
                    .await;
                }
                Err(e) => {
                    eprintln!("[telegram-storyboard] GIF creation failed: {}", e);
                    let _ = send_message(
                        token,
                        chat_id,
                        &format!("⚠️ GIF preview failed: {}", e),
                    )
                    .await;
                }
            }

            // Concatenate final movie
            let _ = send_message(token, chat_id, "🎬 Assembling final movie...").await;
            match concat_final_movie(&video_paths) {
                Ok(movie_path) => {
                    // Update the project scenes with individual shot video paths
                    let mut updated_scenes = scenes;
                    for (i, scene) in updated_scenes.iter_mut().enumerate() {
                        if let Some(result) = scene_results.get(i) {
                            if scene.shots.is_empty() {
                                // No shots — create a default shot with the scene video
                                scene.shots.push(crate::storyboard::StoryboardShot {
                                    id: format!("tg_shot_{}_{}", chrono::Utc::now().timestamp_millis(), i),
                                    shot_number: 1,
                                    duration_ms: scene.duration_ms,
                                    shot_type: "wide".to_string(),
                                    camera_movement: "static".to_string(),
                                    visual_prompt: scene.visual_prompt.clone(),
                                    video_prompt: None,
                                    dialogue: None,
                                    transition: "cut".to_string(),
                                    image_path: None,
                                    keyframe_middle_path: None,
                                    keyframe_last_path: None,
                                    keyframe_first_prompt: None,
                                    keyframe_middle_prompt: None,
                                    keyframe_last_prompt: None,
                                    video_path: Some(result.scene_path.clone()),
                                    video_settings: Some(crate::storyboard::ShotVideoSettings {
                                        prompt: scene.visual_prompt.clone(),
                                        negative_prompt: None,
                                        width: TG_VIDEO_WIDTH,
                                        height: TG_VIDEO_HEIGHT,
                                        num_frames: 49,
                                        fps: 24,
                                        guidance_scale: 3.5,
                                        steps: 30,
                                    }),
                                    characters_in_shot: vec![],
                                    image_history: vec![],
                                    keyframe_middle_history: vec![],
                                    keyframe_last_history: vec![],
                                    video_history: vec![],
                                });
                            } else {
                                // Assign each shot its own video path
                                for (si, shot) in scene.shots.iter_mut().enumerate() {
                                    if let Some(shot_path) = result.shot_paths.get(si) {
                                        shot.video_path = Some(shot_path.clone());
                                    }
                                }
                            }
                        }
                    }
                    // Persist updated scenes back to the project
                    let _ = crate::storyboard::save_storyboard_scenes(
                        &session.project_id,
                        updated_scenes,
                    );

                    let _ = send_video(
                        token,
                        chat_id,
                        &movie_path,
                        Some(&format!(
                            "🎬 Final movie ({} scenes)\n\nProject: {}\nOpen the app to refine further.",
                            video_paths.len(),
                            session.project_id
                        )),
                    )
                    .await;

                    return Ok(Some(format!(
                        "✅ Done! {} scenes generated and assembled.\nProject saved as: {}\n\nSend /reset to start a new project, or keep chatting to refine.",
                        video_paths.len(),
                        session.project_id
                    )));
                }
                Err(e) => {
                    return Ok(Some(format!(
                        "⚠️ Movie assembly failed: {}\nIndividual clips were sent above. You can assemble them in the app.",
                        e
                    )));
                }
            }
        }

        // ── Storyboard command (start new session) ───────────────────────
        if is_storyboard_command(text) {
            // Extract the idea from the command
            let idea = text
                .trim()
                .strip_prefix("/storyboard")
                .or_else(|| text.trim().strip_prefix("/sb"))
                .or_else(|| text.trim().strip_prefix("storyboard:"))
                .or_else(|| text.trim().strip_prefix("sb:"))
                .unwrap_or(text)
                .trim();

            if idea.is_empty() {
                return Ok(Some(
                    "🎬 Send your video idea after the command.\nExample: /storyboard A cinematic tour of a futuristic city at sunset"
                        .to_string(),
                ));
            }

            // End any existing session
            if has_active_session(chat_id) {
                let old_session = get_or_create_session(chat_id, "");
                persist_chat(&old_session);
                if let Ok(mut guard) = STORYBOARD_SESSION.lock() {
                    *guard = None;
                }
            }

            // Create new session
            let mut session = get_or_create_session(chat_id, idea);

            // Chat with LLM to develop the concept
            session.history.push(("user".to_string(), idea.to_string()));
            match storyboard_llm_chat(&session, idea).await {
                Ok(response) => {
                    session.history.push(("assistant".to_string(), response.clone()));

                    // Check if the LLM produced scene blocks
                    let scenes = parse_scenes_from_response(&response);
                    if !scenes.is_empty() {
                        // Save scenes to the project
                        let _ = crate::storyboard::save_storyboard_scenes(
                            &session.project_id,
                            scenes.clone(),
                        );
                        let scene_summary: Vec<String> = scenes
                            .iter()
                            .map(|s| {
                                let shot_info = if s.shots.is_empty() {
                                    String::new()
                                } else {
                                    let shot_lines: Vec<String> = s.shots.iter().map(|sh| {
                                        let vp_short = if sh.visual_prompt.len() > 80 {
                                            format!("{}…", &sh.visual_prompt[..77])
                                        } else {
                                            sh.visual_prompt.clone()
                                        };
                                        format!("  🖼 Shot {}: {}", sh.shot_number, vp_short)
                                    }).collect();
                                    format!("\n{}", shot_lines.join("\n"))
                                };
                                let vp_short = if s.visual_prompt.len() > 100 {
                                    format!("{}…", &s.visual_prompt[..97])
                                } else {
                                    s.visual_prompt.clone()
                                };
                                format!(
                                    "Scene {}: {} ({}s)\n  🎬 Video: {}{}",
                                    s.scene_number, s.title, s.duration_ms / 1000, vp_short, shot_info
                                )
                            })
                            .collect();
                        update_session(&session);
                        persist_chat(&session);

                        return Ok(Some(format!(
                            "🎬 Storyboard session started!\nProject: {}\n\n{}\n\n📋 {} scenes created:\n{}\n\n🔄 Workflow: /workflow (auto, fast, production)\n🎨 Set a style: /style (pixar, anime, realistic, etc.)\n💬 Keep chatting to refine, send 📸 photos for references, or /generate to create videos.",
                            session.project_id,
                            response,
                            scenes.len(),
                            scene_summary.join("\n\n"),
                        )));
                    }

                    update_session(&session);
                    persist_chat(&session);

                    return Ok(Some(format!(
                        "🎬 Storyboard session started!\nProject: {}\n\n{}\n\n🎨 Set a style: /style (pixar, anime, realistic, etc.)\n💬 Keep chatting to develop scenes. Send 📸 photos for references.",
                        session.project_id, response
                    )));
                }
                Err(e) => {
                    update_session(&session);
                    return Ok(Some(format!(
                        "🎬 Storyboard session started!\nProject: {}\n\n⚠️ LLM unavailable: {}\n\nMake sure a local AI server is running in the app. You can still send reference images.",
                        session.project_id, e
                    )));
                }
            }
        }

        // ── Continue active storyboard session ───────────────────────────
        if has_active_session(chat_id) {
            let mut session = get_or_create_session(chat_id, "");
            session.history.push(("user".to_string(), text.to_string()));

            // Extract style hints from the message
            let lower = text.to_lowercase();
            for keyword in &["style:", "aesthetic:", "look:"] {
                if let Some(pos) = lower.find(keyword) {
                    let style_val = text[pos + keyword.len()..].trim();
                    let style_end = style_val.find('.').unwrap_or(style_val.len());
                    let extracted = style_val[..style_end].trim().to_string();
                    if !extracted.is_empty() && extracted.len() < 80 {
                        session.style = extracted;
                    }
                }
            }

            match storyboard_llm_chat(&session, text).await {
                Ok(response) => {
                    session.history.push(("assistant".to_string(), response.clone()));

                    // Check for new scene blocks
                    let scenes = parse_scenes_from_response(&response);
                    if !scenes.is_empty() {
                        // Merge with existing scenes or replace
                        let _ = crate::storyboard::save_storyboard_scenes(
                            &session.project_id,
                            scenes.clone(),
                        );
                    }

                    update_session(&session);
                    persist_chat(&session);

                    if !scenes.is_empty() {
                        let scene_summary: Vec<String> = scenes
                            .iter()
                            .map(|s| {
                                let shot_info = if s.shots.is_empty() {
                                    String::new()
                                } else {
                                    let shot_lines: Vec<String> = s.shots.iter().map(|sh| {
                                        let vp_short = if sh.visual_prompt.len() > 80 {
                                            format!("{}…", &sh.visual_prompt[..77])
                                        } else {
                                            sh.visual_prompt.clone()
                                        };
                                        format!("  🖼 Shot {}: {}", sh.shot_number, vp_short)
                                    }).collect();
                                    format!("\n{}", shot_lines.join("\n"))
                                };
                                let vp_short = if s.visual_prompt.len() > 100 {
                                    format!("{}…", &s.visual_prompt[..97])
                                } else {
                                    s.visual_prompt.clone()
                                };
                                format!(
                                    "Scene {}: {} ({}s)\n  🎬 Video: {}{}",
                                    s.scene_number, s.title, s.duration_ms / 1000, vp_short, shot_info
                                )
                            })
                            .collect();
                        return Ok(Some(format!(
                            "{}\n\n📋 {} scenes updated:\n{}\n\nSend /generate when ready.",
                            response,
                            scenes.len(),
                            scene_summary.join("\n\n"),
                        )));
                    }

                    return Ok(Some(response));
                }
                Err(e) => {
                    update_session(&session);
                    return Ok(Some(format!("⚠️ LLM error: {}", e)));
                }
            }
        }

        // ── Default: route to Intent_Parser ──────────────────────────────
        match crate::intent_parser::parse_intent_with_fallback(window, text, false, None, None, None).await {
            Ok((intent, backend)) => {
                // Emit the parsed intent to the frontend
                let _ = window.emit(
                    "telegram-command",
                    json!({
                        "action": intent.action,
                        "parameters": intent.parameters,
                        "instruction": intent.raw_instruction,
                        "backend_used": format!("{}", backend),
                        "source": "telegram",
                    }),
                );

                return Ok(Some(format!(
                    "✅ Action: {} (via {})\n{}\n\n💡 Tip: Send /storyboard <idea> to start a creative session.",
                    intent.action, backend, intent.raw_instruction
                )));
            }
            Err(e) => {
                return Ok(Some(format!("Failed to parse command: {}", e)));
            }
        }
    }

    Ok(None)
}

// ── Bot Lifecycle ────────────────────────────────────────────────────────────

/// Start the Telegram bot polling loop.
/// Spawns a Tokio task that long-polls for updates and dispatches messages.
pub async fn start_bot(
    window: Window,
    token: String,
    allowed_chat_ids: Vec<i64>,
) -> Result<(), String> {
    // Validate token first
    let bot_info = validate_token(&token).await?;
    eprintln!(
        "[telegram-bot] Validated bot: @{} ({})",
        bot_info.username, bot_info.first_name
    );

    // Store token
    if let Ok(mut t) = BOT_TOKEN.lock() {
        *t = Some(token.clone());
    }

    // Update status
    update_status(|s| {
        s.connected = true;
        s.bot_username = Some(bot_info.username.clone());
        s.polling = true;
        s.last_error = None;
    });

    let _ = window.emit(
        "telegram-status",
        json!({
            "connected": true,
            "bot_username": bot_info.username,
            "polling": true,
        }),
    );

    // Stop any existing polling task
    if let Ok(mut handle) = BOT_HANDLE.lock() {
        if let Some(h) = handle.take() {
            h.abort();
        }
    }

    // Spawn the polling loop
    let poll_token = token.clone();
    let poll_window = window.clone();
    let poll_chat_ids = allowed_chat_ids.clone();

    let handle = tokio::spawn(async move {
        let mut offset: i64 = 0;
        let mut consecutive_errors: u32 = 0;

        loop {
            match get_updates(&poll_token, offset).await {
                Ok(updates) => {
                    consecutive_errors = 0;

                    for update in &updates {
                        // Advance offset past this update
                        offset = update.update_id + 1;

                        if let Some(message) = &update.message {
                            match handle_message(
                                &poll_window,
                                message,
                                &poll_token,
                                &poll_chat_ids,
                            )
                            .await
                            {
                                Ok(Some(reply)) => {
                                    let _ = send_message(
                                        &poll_token,
                                        message.chat.id,
                                        &reply,
                                    )
                                    .await;
                                }
                                Ok(None) => {
                                    // No reply needed (e.g., unauthorized chat)
                                }
                                Err(e) => {
                                    eprintln!(
                                        "[telegram-bot] Error handling message: {}",
                                        e
                                    );
                                    let _ = send_message(
                                        &poll_token,
                                        message.chat.id,
                                        &format!("Error: {}", e),
                                    )
                                    .await;
                                }
                            }

                            // Increment messages processed
                            update_status(|s| {
                                s.messages_processed += 1;
                            });
                        }
                    }
                }
                Err(e) => {
                    consecutive_errors += 1;
                    eprintln!(
                        "[telegram-bot] Polling error (attempt {}): {}",
                        consecutive_errors, e
                    );

                    update_status(|s| {
                        s.last_error = Some(e.clone());
                    });

                    let _ = poll_window.emit(
                        "telegram-status",
                        json!({
                            "error": e,
                            "retry_count": consecutive_errors,
                        }),
                    );

                    if consecutive_errors >= BACKOFF_MAX_RETRIES {
                        eprintln!(
                            "[telegram-bot] Max retries ({}) reached, stopping bot",
                            BACKOFF_MAX_RETRIES
                        );
                        update_status(|s| {
                            s.connected = false;
                            s.polling = false;
                            s.last_error =
                                Some("Max retries reached. Bot stopped.".to_string());
                        });
                        break;
                    }

                    let delay = calculate_backoff_delay(consecutive_errors);
                    eprintln!(
                        "[telegram-bot] Retrying in {} seconds...",
                        delay
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                }
            }
        }
    });

    // Store the handle so stop_bot can abort it
    if let Ok(mut h) = BOT_HANDLE.lock() {
        *h = Some(handle);
    }

    Ok(())
}

/// Stop the running Telegram bot polling task and clean up.
pub fn stop_bot() -> Result<(), String> {
    eprintln!("[telegram-bot] Stopping bot...");

    // Abort the polling task
    if let Ok(mut handle) = BOT_HANDLE.lock() {
        if let Some(h) = handle.take() {
            h.abort();
            eprintln!("[telegram-bot] Polling task aborted");
        }
    }

    // Clear token
    if let Ok(mut t) = BOT_TOKEN.lock() {
        *t = None;
    }

    // Update status
    update_status(|s| {
        s.connected = false;
        s.polling = false;
        s.last_error = None;
    });

    eprintln!("[telegram-bot] Bot stopped");
    Ok(())
}

/// Send a notification message to the bot's last active chat.
/// Used for export completion and other significant events.
pub async fn send_notification(text: &str) -> Result<(), String> {
    let token = BOT_TOKEN
        .lock()
        .ok()
        .and_then(|t| t.clone())
        .ok_or("Bot not running")?;

    let chat_id = ACTIVE_CHAT_ID
        .lock()
        .ok()
        .and_then(|id| *id)
        .ok_or("No active chat to send notification to")?;

    send_message(&token, chat_id, text).await
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── classify_video tests ─────────────────────────────────────────────

    #[test]
    fn test_classify_primary_keywords() {
        assert!(matches!(
            classify_video("This is the primary recording"),
            VideoClassification::Primary
        ));
        assert!(matches!(
            classify_video("speaker view from zoom"),
            VideoClassification::Primary
        ));
        assert!(matches!(
            classify_video("main camera angle"),
            VideoClassification::Primary
        ));
    }

    #[test]
    fn test_classify_primary_case_insensitive() {
        assert!(matches!(
            classify_video("PRIMARY VIDEO"),
            VideoClassification::Primary
        ));
        assert!(matches!(
            classify_video("Speaker Recording"),
            VideoClassification::Primary
        ));
        assert!(matches!(
            classify_video("MAIN angle"),
            VideoClassification::Primary
        ));
    }

    #[test]
    fn test_classify_broll_default() {
        assert!(matches!(
            classify_video("cutaway shot of office"),
            VideoClassification::BRoll
        ));
        assert!(matches!(
            classify_video("b-roll footage"),
            VideoClassification::BRoll
        ));
        assert!(matches!(
            classify_video(""),
            VideoClassification::BRoll
        ));
        assert!(matches!(
            classify_video("some random video"),
            VideoClassification::BRoll
        ));
    }

    // ── calculate_backoff_delay tests ────────────────────────────────────

    #[test]
    fn test_backoff_base_case() {
        // retry 0: 2 * 2^0 = 2
        assert_eq!(calculate_backoff_delay(0), 2);
    }

    #[test]
    fn test_backoff_increasing() {
        // retry 1: 2 * 2^1 = 4
        assert_eq!(calculate_backoff_delay(1), 4);
        // retry 2: 2 * 2^2 = 8
        assert_eq!(calculate_backoff_delay(2), 8);
        // retry 3: 2 * 2^3 = 16
        assert_eq!(calculate_backoff_delay(3), 16);
        // retry 4: 2 * 2^4 = 32
        assert_eq!(calculate_backoff_delay(4), 32);
    }

    #[test]
    fn test_backoff_capped_at_max() {
        // retry 5: 2 * 2^5 = 64, capped at 60
        assert_eq!(calculate_backoff_delay(5), 60);
        // retry 10: capped at 60
        assert_eq!(calculate_backoff_delay(10), 60);
    }

    #[test]
    fn test_backoff_overflow_protection() {
        // Very large retry count should not panic, just cap at max
        assert_eq!(calculate_backoff_delay(100), 60);
    }

    // ── get_bot_status tests ─────────────────────────────────────────────

    #[test]
    fn test_default_bot_status() {
        let status = get_bot_status();
        assert!(!status.connected);
        assert!(!status.polling);
        assert_eq!(status.messages_processed, 0);
    }

    // ── staged videos tests ──────────────────────────────────────────────

    #[test]
    fn test_stage_video_nonexistent_file() {
        let result = stage_video("/nonexistent/path/video.mp4", VideoClassification::Primary);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[test]
    fn test_get_staged_videos_empty() {
        // Clear first to ensure clean state
        clear_staged_videos();
        let videos = get_staged_videos();
        assert!(videos.is_empty());
    }

    // ── TelegramBotInfo serde roundtrip ──────────────────────────────────

    #[test]
    fn test_bot_info_serde_roundtrip() {
        let info = TelegramBotInfo {
            id: 12345,
            username: "test_bot".to_string(),
            first_name: "Test".to_string(),
        };
        let json = serde_json::to_string(&info).unwrap();
        let parsed: TelegramBotInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, 12345);
        assert_eq!(parsed.username, "test_bot");
        assert_eq!(parsed.first_name, "Test");
    }

    #[test]
    fn test_staged_video_serde_roundtrip() {
        let video = StagedVideo {
            id: "vid_123".to_string(),
            file_path: "/tmp/test.mp4".to_string(),
            classification: VideoClassification::Primary,
            filename: "test.mp4".to_string(),
            size_bytes: 1024,
            staged_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&video).unwrap();
        let parsed: StagedVideo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "vid_123");
        assert!(matches!(parsed.classification, VideoClassification::Primary));
    }

    #[test]
    fn test_video_classification_serde() {
        let primary = serde_json::to_string(&VideoClassification::Primary).unwrap();
        assert_eq!(primary, "\"Primary\"");
        let broll = serde_json::to_string(&VideoClassification::BRoll).unwrap();
        assert_eq!(broll, "\"BRoll\"");
    }

    // ── Monotonicity of backoff ──────────────────────────────────────────

    #[test]
    fn test_backoff_monotonically_increasing_until_cap() {
        let mut prev = 0;
        for i in 0..=5 {
            let delay = calculate_backoff_delay(i);
            assert!(
                delay >= prev,
                "Backoff should be monotonically non-decreasing: {} < {} at retry {}",
                delay,
                prev,
                i
            );
            prev = delay;
        }
    }

    // ── Property-Based Tests ─────────────────────────────────────────────

    use proptest::prelude::*;

    // Feature: agent-editor, Property 5: Video classification from caption text
    // **Validates: Requirements 5.4**
    proptest! {
        #[test]
        fn prop_classify_video_with_keyword_is_primary(
            prefix in "[a-z ]{0,20}",
            keyword in prop_oneof![Just("primary"), Just("speaker"), Just("main")],
            suffix in "[a-z ]{0,20}"
        ) {
            let caption = format!("{}{}{}", prefix, keyword, suffix);
            let result = classify_video(&caption);
            prop_assert!(
                matches!(result, VideoClassification::Primary),
                "Caption '{}' with keyword '{}' should be Primary", caption, keyword
            );
        }

        #[test]
        fn prop_classify_video_with_uppercase_keyword_is_primary(
            prefix in "[a-zA-Z ]{0,20}",
            keyword in prop_oneof![Just("PRIMARY"), Just("SPEAKER"), Just("MAIN"), Just("Primary"), Just("Speaker"), Just("Main")],
            suffix in "[a-zA-Z ]{0,20}"
        ) {
            let caption = format!("{}{}{}", prefix, keyword, suffix);
            let result = classify_video(&caption);
            prop_assert!(
                matches!(result, VideoClassification::Primary),
                "Caption '{}' with keyword '{}' should be Primary (case-insensitive)", caption, keyword
            );
        }

        #[test]
        fn prop_classify_video_without_keywords_is_broll(
            caption in "[b-ln-oq-rt-z0-9 ]{0,50}"
        ) {
            // Character class excludes 'a','m','p','s' to avoid accidentally forming
            // "primary", "speaker", or "main"
            let result = classify_video(&caption);
            prop_assert!(
                matches!(result, VideoClassification::BRoll),
                "Caption '{}' without keywords should be BRoll", caption
            );
        }

        #[test]
        fn prop_classify_video_always_returns_valid_variant(caption in ".*") {
            let result = classify_video(&caption);
            let is_valid = matches!(result, VideoClassification::Primary | VideoClassification::BRoll);
            prop_assert!(is_valid, "classify_video must return Primary or BRoll, never error");
        }
    }

    // Feature: agent-editor, Property 6: Exponential backoff delay calculation
    // **Validates: Requirements 5.7**
    proptest! {
        #[test]
        fn prop_backoff_delay_formula(retry_count in 0u32..=20) {
            let delay = calculate_backoff_delay(retry_count);
            let expected = BACKOFF_BASE_DELAY_SECS.saturating_mul(2u64.saturating_pow(retry_count));
            let expected_capped = expected.min(BACKOFF_MAX_DELAY_SECS);
            prop_assert_eq!(delay, expected_capped,
                "Delay for retry {} should be min({} * 2^{}, {}) = {}",
                retry_count, BACKOFF_BASE_DELAY_SECS, retry_count, BACKOFF_MAX_DELAY_SECS, expected_capped
            );
        }

        #[test]
        fn prop_backoff_delay_capped_at_max(retry_count in 0u32..=100) {
            let delay = calculate_backoff_delay(retry_count);
            prop_assert!(delay <= BACKOFF_MAX_DELAY_SECS,
                "Delay {} exceeds max {} at retry {}", delay, BACKOFF_MAX_DELAY_SECS, retry_count
            );
        }

        #[test]
        fn prop_backoff_monotonically_increasing(n in 0u32..=19) {
            let delay_n = calculate_backoff_delay(n);
            let delay_n1 = calculate_backoff_delay(n + 1);
            prop_assert!(delay_n1 >= delay_n,
                "Backoff must be monotonically non-decreasing: delay({})={} > delay({})={}",
                n + 1, delay_n1, n, delay_n
            );
        }

        #[test]
        fn prop_backoff_strictly_increasing_before_cap(n in 0u32..=3) {
            // For retry counts 0..4, delay should be strictly increasing (all below cap)
            let delay_n = calculate_backoff_delay(n);
            let delay_n1 = calculate_backoff_delay(n + 1);
            prop_assert!(delay_n1 > delay_n,
                "Backoff should be strictly increasing before cap: delay({})={} should be > delay({})={}",
                n + 1, delay_n1, n, delay_n
            );
        }
    }

}
