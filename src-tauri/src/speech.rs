//! Live speech recognition for voice mode on macOS (Apple Speech framework):
//! partial transcripts stream to the UI while the user talks. Other platforms use
//! the Whisper path in `dictation.rs`.
use crate::*;

/// Stable codes the UI maps to messages and choices.
const SPEECH_UNAVAILABLE: &str = "speech_unavailable";

#[tauri::command]
pub(super) fn speech_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Opens a recognition session; `allow_server` lets Apple use its servers when
/// on-device recognition is off (Dictation disabled).
#[tauri::command]
pub(super) async fn speech_start(
    app: AppHandle,
    vocabulary: Option<String>,
    allow_server: bool,
) -> Result<u64, String> {
    #[cfg(target_os = "macos")]
    {
        apple::authorize().await?;
        apple::start(app, vocabulary.as_deref().unwrap_or(""), allow_server)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, vocabulary, allow_server);
        Err(SPEECH_UNAVAILABLE.into())
    }
}

/// Mono 16 kHz PCM as raw bytes, appended to the open session.
#[tauri::command]
pub(super) async fn speech_push(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw audio bytes.".into());
    };
    let samples = crate::dictation::samples_from_bytes(bytes)?;
    #[cfg(target_os = "macos")]
    apple::push(&samples);
    #[cfg(not(target_os = "macos"))]
    drop(samples);
    Ok(())
}

/// Ends the audio and returns the final transcript.
#[tauri::command]
pub(super) async fn speech_finish() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        apple::finish().await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(SPEECH_UNAVAILABLE.into())
    }
}

/// Opens System Settings at Keyboard › Dictation.
#[tauri::command]
pub(super) fn speech_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.keyboard?Dictation")
        .spawn()
        .map_err(|e| e.to_string())
        .map(drop)?;
    Ok(())
}

#[tauri::command]
pub(super) async fn speech_cancel() {
    #[cfg(target_os = "macos")]
    apple::cancel();
}

#[cfg(target_os = "macos")]
mod apple {
    use super::*;
    use block2::RcBlock;
    use objc2::{
        rc::{autoreleasepool, Retained},
        runtime::NSObjectProtocol,
        sel, AllocAnyThread,
    };
    use objc2_avf_audio::{AVAudioCommonFormat, AVAudioFormat, AVAudioPCMBuffer};
    use objc2_foundation::{NSArray, NSError, NSOperationQueue, NSString};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
        SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
    };
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };
    use tokio::sync::oneshot;

    const PARTIAL_EVENT: &str = "speech-partial";
    const ERROR_EVENT: &str = "speech-error";
    const DICTATION_DISABLED: &str = "dictation_disabled";
    const SPEECH_DENIED: &str = "speech_denied";

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Partial {
        id: u64,
        text: String,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SpeechError {
        id: u64,
        code: String,
    }

    /// Error raised by `requiresOnDeviceRecognition` when Siri and Dictation are off.
    const LSR_DOMAIN: &str = "kLSRErrorDomain";
    const LSR_DICTATION_DISABLED: isize = 201;
    /// "No speech detected" (on device; 203 and 209 from Apple's servers): not an error here.
    const AFA_NO_SPEECH: [isize; 3] = [1110, 203, 209];
    const MAX_CONTEXT_WORDS: usize = 100;

    type Done = Arc<Mutex<Option<oneshot::Sender<Result<String, String>>>>>;

    struct Recognition {
        _recognizer: Retained<SFSpeechRecognizer>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        _task: Retained<SFSpeechRecognitionTask>,
        format: Retained<AVAudioFormat>,
    }
    // SAFETY: Apple documents the buffer request and task as usable from any thread;
    // `push` only appends under the SESSION lock.
    unsafe impl Send for Recognition {}

    struct Session {
        recognition: Recognition,
        done: oneshot::Receiver<Result<String, String>>,
    }

    static SESSION: Mutex<Option<Session>> = Mutex::new(None);

    /// One recognizer for the app's lifetime: each new one opens another assistantd connection.
    struct Recognizer(Retained<SFSpeechRecognizer>);
    // SAFETY: only used under the RECOGNIZER lock to start tasks, which Apple allows off the main thread.
    unsafe impl Send for Recognizer {}
    static RECOGNIZER: Mutex<Option<Recognizer>> = Mutex::new(None);

    fn recognizer() -> Result<Retained<SFSpeechRecognizer>, String> {
        let mut shared = RECOGNIZER.lock().unwrap();
        if let Some(Recognizer(recognizer)) = shared.as_ref() {
            return Ok(recognizer.clone());
        }
        let recognizer = unsafe { SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()) }
            .ok_or(SPEECH_UNAVAILABLE)?;
        // Results arrive off the main thread, so they never wait on the UI.
        unsafe { recognizer.setQueue(&NSOperationQueue::new()) };
        *shared = Some(Recognizer(recognizer.clone()));
        Ok(recognizer)
    }
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    pub(super) async fn authorize() -> Result<(), String> {
        let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
        let status = if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            request_authorization().await.map_err(|e| e.to_string())?
        } else {
            status
        };
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            Ok(())
        } else {
            Err(SPEECH_DENIED.into())
        }
    }

    fn request_authorization() -> oneshot::Receiver<SFSpeechRecognizerAuthorizationStatus> {
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |s: SFSpeechRecognizerAuthorizationStatus| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(s);
            }
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        rx
    }

    fn finish_with(done: &Done, result: Result<String, String>) {
        if let Some(tx) = done.lock().unwrap().take() {
            let _ = tx.send(result);
        }
    }

    // Speech objects are driven from Tokio threads, which have no autorelease pool of their own.
    pub(super) fn start(
        app: AppHandle,
        vocabulary: &str,
        allow_server: bool,
    ) -> Result<u64, String> {
        autoreleasepool(|_| start_in_pool(app, vocabulary, allow_server))
    }

    fn start_in_pool(app: AppHandle, vocabulary: &str, allow_server: bool) -> Result<u64, String> {
        cancel();
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let recognizer = recognizer()?;
        if !unsafe { recognizer.isAvailable() } {
            return Err(SPEECH_UNAVAILABLE.into());
        }
        let on_device = !allow_server;
        if on_device && !unsafe { recognizer.supportsOnDeviceRecognition() } {
            return Err(DICTATION_DISABLED.into());
        }
        let format = unsafe {
            AVAudioFormat::initWithCommonFormat_sampleRate_channels_interleaved(
                AVAudioFormat::alloc(),
                AVAudioCommonFormat::PCMFormatFloat32,
                16_000.0,
                1,
                false,
            )
        }
        .ok_or("Could not create the audio format.")?;

        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(on_device);
            // macOS 13+.
            if request.respondsToSelector(sel!(setAddsPunctuation:)) {
                request.setAddsPunctuation(true);
            }
            let words: Vec<Retained<NSString>> = vocabulary
                .split(',')
                .chain(crate::dictation::DEV_VOCABULARY.split(','))
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .take(MAX_CONTEXT_WORDS)
                .map(NSString::from_str)
                .collect();
            request.setContextualStrings(&NSArray::from_retained_slice(&words));
        }

        let (tx, done) = oneshot::channel();
        let sender: Done = Arc::new(Mutex::new(Some(tx)));
        let last = Arc::new(Mutex::new(String::new()));
        let handler = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| unsafe {
                if let Some(result) = result.as_ref() {
                    let text = result.bestTranscription().formattedString().to_string();
                    *last.lock().unwrap() = text.clone();
                    if result.isFinal() {
                        finish_with(&sender, Ok(text));
                    } else {
                        let _ = app.emit(PARTIAL_EVENT, Partial { id, text });
                    }
                } else if let Some(error) = error.as_ref() {
                    let heard = last.lock().unwrap().clone();
                    let code = error.code();
                    let outcome = if !heard.is_empty() || AFA_NO_SPEECH.contains(&code) {
                        Ok(heard)
                    } else if error.domain().to_string() == LSR_DOMAIN
                        && code == LSR_DICTATION_DISABLED
                    {
                        let _ = app.emit(
                            ERROR_EVENT,
                            SpeechError {
                                id,
                                code: DICTATION_DISABLED.into(),
                            },
                        );
                        Err(DICTATION_DISABLED.into())
                    } else {
                        Err(error.localizedDescription().to_string())
                    };
                    finish_with(&sender, outcome);
                }
            },
        );
        let task =
            unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
        *SESSION.lock().unwrap() = Some(Session {
            recognition: Recognition {
                _recognizer: recognizer,
                request,
                _task: task,
                format,
            },
            done,
        });
        Ok(id)
    }

    pub(super) fn push(samples: &[f32]) {
        autoreleasepool(|_| push_in_pool(samples));
    }

    fn push_in_pool(samples: &[f32]) {
        let guard = SESSION.lock().unwrap();
        let Some(session) = guard.as_ref() else {
            return;
        };
        let Ok(frames) = u32::try_from(samples.len()) else {
            return;
        };
        if frames == 0 {
            return;
        }
        unsafe {
            let Some(buffer) = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &session.recognition.format,
                frames,
            ) else {
                return;
            };
            buffer.setFrameLength(frames);
            let channel = (*buffer.floatChannelData()).as_ptr();
            std::ptr::copy_nonoverlapping(samples.as_ptr(), channel, samples.len());
            session.recognition.request.appendAudioPCMBuffer(&buffer);
        }
    }

    pub(super) async fn finish() -> Result<String, String> {
        let Some(session) = SESSION.lock().unwrap().take() else {
            return Ok(String::new());
        };
        let Session { recognition, done } = session;
        autoreleasepool(|_| unsafe { recognition.request.endAudio() });
        // Apple answers ~0.3 s after the audio ends; never leave the UI waiting forever.
        let result = tokio::time::timeout(std::time::Duration::from_secs(8), done).await;
        autoreleasepool(|_| drop(recognition));
        match result {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Ok(String::new()),
            Err(_) => Err("La reconnaissance vocale ne répond pas.".into()),
        }
    }

    pub(super) fn cancel() {
        // Ends the audio rather than `task.cancel()`: cancelled tasks never release their
        // assistantd connection, which refuses new ones after ~20 (kAFAssistantErrorDomain
        // error 7). The late result goes to a dropped receiver.
        if let Some(session) = SESSION.lock().unwrap().take() {
            autoreleasepool(|_| {
                unsafe { session.recognition.request.endAudio() };
                drop(session);
            });
        }
    }
}
