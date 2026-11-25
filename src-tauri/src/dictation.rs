//! Local voice dictation: whisper.cpp through `whisper-rs`, nothing leaves the machine.
//!
//! The multilingual ggml base model is downloaded on first use into the app data
//! directory and checked against a pinned SHA-256.
use crate::*;
use futures_util::StreamExt;
use ring::digest;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MODEL_FILE: &str = "ggml-base-q5_1.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
const MODEL_SHA256: &str = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898";
const MODEL_SIZE: u64 = 59_707_625;
const PROMPT_HEADER: &str = "x-whisper-prompt";
const MAX_VOCABULARY_CHARS: usize = 400;
const DEV_VOCABULARY: &str = "commit, merge, push, pull request, branche, build, tests, composer, Tauri, React, TypeScript, Rust, npm, cargo, refactor, bug, fix";
const PROGRESS_EVENT: &str = "dictation-model-progress";
const SAMPLE_RATE: usize = 16_000;
const MAX_SAMPLES: usize = 2 * 60 * SAMPLE_RATE;

static CONTEXT: OnceLock<Arc<WhisperContext>> = OnceLock::new();
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelStatus {
    installed: bool,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

#[derive(Debug, Serialize)]
pub(super) struct Transcript {
    text: String,
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join(MODEL_FILE))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_matches(digest_bytes: &[u8], expected: &str) -> bool {
    hex(digest_bytes) == expected
}

fn check_length(samples: &[f32]) -> Result<(), String> {
    if samples.is_empty() {
        return Err("No audio recorded.".into());
    }
    if samples.len() > MAX_SAMPLES {
        return Err("Recording is longer than 2 minutes.".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn dictation_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    let installed = model_path(&app)?.is_file();
    Ok(ModelStatus {
        installed,
        size_bytes: MODEL_SIZE,
    })
}

async fn download(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let part = dest.with_extension("part");
    tokio::fs::create_dir_all(dest.parent().ok_or("invalid model path")?)
        .await
        .map_err(|e| e.to_string())?;
    let response = reqwest::get(MODEL_URL)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Model download failed: {e}"))?;
    let total = response.content_length().unwrap_or(MODEL_SIZE);
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = digest::Context::new(&digest::SHA256);
    let mut received = 0u64;
    let mut last_emit = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Model download failed: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received - last_emit >= 512 * 1024 {
            last_emit = received;
            let _ = app.emit(PROGRESS_EVENT, Progress { received, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if !sha256_matches(hasher.finish().as_ref(), MODEL_SHA256) {
        return Err("Downloaded model is corrupted (SHA-256 mismatch).".into());
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(PROGRESS_EVENT, Progress { received, total });
    Ok(())
}

#[tauri::command]
pub(super) async fn dictation_download_model(app: AppHandle) -> Result<(), String> {
    let dest = model_path(&app)?;
    if dest.is_file() {
        return Ok(());
    }
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("Model download already in progress.".into());
    }
    let result = download(&app, &dest).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest.with_extension("part")).await;
    }
    result
}

fn context(path: &Path) -> Result<Arc<WhisperContext>, String> {
    if let Some(ctx) = CONTEXT.get() {
        return Ok(ctx.clone());
    }
    let path = path.to_str().ok_or("invalid model path")?;
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("Could not load the speech model: {e}"))?;
    Ok(CONTEXT.get_or_init(|| Arc::new(ctx)).clone())
}

/// Decodes `encodeURIComponent` output; invalid escapes are kept as typed.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| {
                input
                    .get(i + 1..i + 3)
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
            })
            .flatten();
        match escaped {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn initial_prompt(vocabulary: &str) -> String {
    let extra: String = vocabulary
        .trim()
        .chars()
        .take(MAX_VOCABULARY_CHARS)
        .collect();
    if extra.is_empty() {
        DEV_VOCABULARY.to_string()
    } else {
        format!("{DEV_VOCABULARY}, {extra}")
    }
}

/// Whisper invents subtitles credits and thanks on silence; those are never real speech.
fn is_hallucination(text: &str) -> bool {
    let plain: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let plain = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    plain.is_empty()
        || plain == "you"
        || plain.starts_with("sous titres")
        || plain.starts_with("merci d avoir regardé")
        || plain.starts_with("thank you for watching")
        || plain.starts_with("thanks for watching")
}

fn transcribe(path: &Path, samples: &[f32], vocabulary: &str) -> Result<String, String> {
    let ctx = context(path)?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    params.set_n_threads(threads as i32);
    params.set_translate(false);
    let prompt = initial_prompt(vocabulary);
    params.set_initial_prompt(&prompt);
    params.set_no_speech_thold(0.6);
    params.set_suppress_blank(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    state.full(params, samples).map_err(|e| e.to_string())?;
    let text: String = state
        .as_iter()
        .filter_map(|segment| segment.to_str().ok().map(str::to_owned))
        .collect();
    let text = text.trim();
    Ok(if is_hallucination(text) {
        String::new()
    } else {
        text.to_string()
    })
}

/// Raw little-endian f32 PCM (mono, 16 kHz): JSON would turn 2 min of audio into tens of MB.
fn samples_from_bytes(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err("Invalid audio payload.".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

#[tauri::command]
pub(super) async fn transcribe_audio(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Transcript, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw audio bytes.".into());
    };
    let vocabulary = request
        .headers()
        .get(PROMPT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let samples = samples_from_bytes(bytes)?;
    check_length(&samples)?;
    let path = model_path(&app)?;
    if !path.is_file() {
        return Err("Speech model is not installed.".into());
    }
    let text = tokio::task::spawn_blocking(move || transcribe(&path, &samples, &vocabulary))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Transcript { text })
}

/// WebKitGTK ships with media streams off and denies permission requests without a handler.
#[cfg(target_os = "linux")]
pub(super) fn allow_microphone(window: &tauri::WebviewWindow) {
    use webkit2gtk::{
        glib::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt,
    };
    let _ = window.with_webview(|webview| {
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, request| {
            if request
                .downcast_ref::<UserMediaPermissionRequest>()
                .is_none()
            {
                return false;
            }
            request.allow();
            true
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_check_accepts_only_the_matching_digest() {
        let sum = digest::digest(&digest::SHA256, b"abc");
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(sha256_matches(sum.as_ref(), abc));
        assert!(!sha256_matches(sum.as_ref(), MODEL_SHA256));
    }

    #[test]
    fn audio_longer_than_two_minutes_is_rejected() {
        assert!(check_length(&vec![0.0; MAX_SAMPLES]).is_ok());
        assert!(check_length(&vec![0.0; MAX_SAMPLES + 1]).is_err());
        assert!(check_length(&[]).is_err());
    }

    #[test]
    fn percent_decoding_handles_utf8_and_stray_percent() {
        assert_eq!(percent_decode("caf%C3%A9%20%26%20Cl%C3%A9"), "café & Clé");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb%2"), "a%zzb%2");
    }

    #[test]
    fn prompt_appends_vocabulary_after_dev_words() {
        assert_eq!(initial_prompt("  "), DEV_VOCABULARY);
        assert_eq!(
            initial_prompt("composer, App.tsx"),
            format!("{DEV_VOCABULARY}, composer, App.tsx")
        );
        assert!(initial_prompt(&"é".repeat(1000)).chars().count() < DEV_VOCABULARY.len() + 410);
    }

    #[test]
    fn known_silence_hallucinations_are_dropped() {
        for text in [
            "Merci d'avoir regardé cette vidéo !",
            "Sous-titres réalisés par la communauté d'Amara.org",
            "Thank you for watching.",
            "You",
            "...",
            " ",
            "you.",
        ] {
            assert!(is_hallucination(text), "{text}");
        }
        for text in [
            "Lance les tests",
            "merci, fais le commit",
            "you should push",
        ] {
            assert!(!is_hallucination(text), "{text}");
        }
    }

    #[test]
    fn raw_bytes_decode_as_little_endian_f32() {
        let bytes: Vec<u8> = [0.5f32, -1.0]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert_eq!(samples_from_bytes(&bytes).unwrap(), vec![0.5, -1.0]);
        assert!(samples_from_bytes(&bytes[..3]).is_err());
    }
}
