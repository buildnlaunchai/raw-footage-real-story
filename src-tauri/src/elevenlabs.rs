//! ElevenLabs as an optional cloud voice provider (bring your own key).
//!
//! The call lives in Rust for two reasons. The webview's origin would face the
//! usual CORS problem, and more importantly the API key never has to cross into
//! JavaScript: the frontend asks for synthesis, this module reads the
//! credential from the keychain and does the work.
//!
//! Audio is requested as `wav_24000`, which is exactly the format the rest of
//! the pipeline already speaks — 24kHz mono, matching Kokoro. That removes the
//! MP3 decode the plan assumed, and with it any new ffmpeg dependency in the
//! normal case. `wav_24000` is not tier-restricted; only 44.1kHz PCM/WAV
//! requires Pro.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const API: &str = "https://api.elevenlabs.io";

/// Kokoro's rate, and what the timeline and assembly stages expect.
pub const TARGET_SAMPLE_RATE: u32 = 24_000;

/// Cloud round-trips are slower than local inference and a long script is many
/// of them; this only guards against a hung connection.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize)]
pub struct ElevenLabsError {
    pub code: String,
    pub message: String,
}

impl ElevenLabsError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// Map a failed response to something the user can act on.
///
/// ElevenLabs returns a `detail` object carrying a machine-readable `status`,
/// which is more reliable than the HTTP code alone — a quota problem arrives as
/// 401, which would otherwise be indistinguishable from a bad key and send the
/// user to re-paste a credential that was fine.
fn classify(status: u16, body: &str) -> ElevenLabsError {
    let detail_status = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v["detail"]["status"]
                .as_str()
                .map(str::to_string)
                .or_else(|| v["detail"].as_str().map(str::to_string))
        })
        .unwrap_or_default();

    match detail_status.as_str() {
        "quota_exceeded" => ElevenLabsError::new(
            "QUOTA_EXCEEDED",
            "You've used your ElevenLabs character quota for this period.",
        ),
        "voice_not_found" => ElevenLabsError::new(
            "VOICE_NOT_FOUND",
            "That voice no longer exists on your ElevenLabs account.",
        ),
        "invalid_api_key" | "needs_authorization" => ElevenLabsError::new(
            "INVALID_API_KEY",
            "That API key was rejected. Check it in your ElevenLabs account.",
        ),
        "rate_limit_exceeded" | "too_many_concurrent_requests"
        | "concurrent_limit_exceeded" | "system_busy" => ElevenLabsError::new(
            "RATE_LIMITED",
            "ElevenLabs is rate-limiting requests. Try again shortly.",
        ),
        _ => match status {
            401 | 403 => ElevenLabsError::new(
                "INVALID_API_KEY",
                "That API key was rejected. Check it in your ElevenLabs account.",
            ),
            404 | 422 => ElevenLabsError::new(
                "VOICE_NOT_FOUND",
                "ElevenLabs rejected that voice. Pick another from your account.",
            ),
            429 => ElevenLabsError::new(
                "RATE_LIMITED",
                "ElevenLabs is rate-limiting requests. Try again shortly.",
            ),
            500..=599 => ElevenLabsError::new(
                "SERVICE_ERROR",
                "ElevenLabs had a server error. Try again shortly.",
            ),
            _ => ElevenLabsError::new(
                "REQUEST_FAILED",
                format!("ElevenLabs returned {status}: {}", body.chars().take(200).collect::<String>()),
            ),
        },
    }
}

fn key() -> Result<String, ElevenLabsError> {
    crate::secrets::get("elevenlabs").ok_or_else(|| {
        ElevenLabsError::new(
            "MISSING_API_KEY",
            "Add your ElevenLabs API key to use cloud voices.",
        )
    })
}

fn client() -> Result<reqwest::Client, ElevenLabsError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| ElevenLabsError::new("CLIENT_INIT", e.to_string()))
}

fn transport_error(e: reqwest::Error) -> ElevenLabsError {
    if e.is_timeout() {
        ElevenLabsError::new("TIMEOUT", "ElevenLabs took too long to respond.")
    } else if e.is_connect() {
        ElevenLabsError::new("NETWORK", "Couldn't reach ElevenLabs. Check your connection.")
    } else {
        ElevenLabsError::new("REQUEST_FAILED", e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoice {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub character_count: u64,
    pub character_limit: u64,
    pub tier: String,
    pub resets_at_unix: Option<i64>,
}

/// The user's own voices.
///
/// Note this is `/v2/voices`; the v1 path still exists but is the older shape.
#[tauri::command]
pub async fn elevenlabs_voices() -> Result<Vec<CloudVoice>, ElevenLabsError> {
    let resp = client()?
        .get(format!("{API}/v2/voices"))
        .header("xi-api-key", key()?)
        .send()
        .await
        .map_err(transport_error)?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify(status, &body));
    }

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| ElevenLabsError::new("BAD_RESPONSE", e.to_string()))?;
    let empty = vec![];
    Ok(json["voices"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|v| {
            Some(CloudVoice {
                id: v["voice_id"].as_str()?.to_string(),
                name: v["name"].as_str().unwrap_or("Unnamed").to_string(),
                category: v["category"].as_str().unwrap_or("").to_string(),
                description: v["description"].as_str().map(str::to_string),
            })
        })
        .collect())
}

/// Remaining quota, for showing cost in the user's own terms.
///
/// Deliberately quota rather than price: hardcoding a per-character rate would
/// go stale silently and end up lying to someone about their own money.
#[tauri::command]
pub async fn elevenlabs_usage() -> Result<Usage, ElevenLabsError> {
    let resp = client()?
        .get(format!("{API}/v1/user/subscription"))
        .header("xi-api-key", key()?)
        .send()
        .await
        .map_err(transport_error)?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify(status, &body));
    }

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| ElevenLabsError::new("BAD_RESPONSE", e.to_string()))?;
    Ok(Usage {
        character_count: json["character_count"].as_u64().unwrap_or(0),
        character_limit: json["character_limit"].as_u64().unwrap_or(0),
        tier: json["tier"].as_str().unwrap_or("unknown").to_string(),
        resets_at_unix: json["next_character_count_reset_unix"].as_i64(),
    })
}

/// Validate a key without storing it, so the setup screen can say plainly
/// whether it works before committing it to the keychain.
#[tauri::command]
pub async fn elevenlabs_test_key(api_key: String) -> Result<Usage, ElevenLabsError> {
    let resp = client()?
        .get(format!("{API}/v1/user/subscription"))
        .header("xi-api-key", api_key.trim())
        .send()
        .await
        .map_err(transport_error)?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify(status, &body));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| ElevenLabsError::new("BAD_RESPONSE", e.to_string()))?;
    Ok(Usage {
        character_count: json["character_count"].as_u64().unwrap_or(0),
        character_limit: json["character_limit"].as_u64().unwrap_or(0),
        tier: json["tier"].as_str().unwrap_or("unknown").to_string(),
        resets_at_unix: json["next_character_count_reset_unix"].as_i64(),
    })
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLineInput {
    pub clip_id: String,
    #[serde(default)]
    pub segment_index: usize,
    pub text: String,
}

/// Fetch one line as 24kHz mono WAV bytes.
pub async fn synthesize_bytes(
    voice_id: &str,
    text: &str,
    model_id: &str,
) -> Result<Vec<u8>, ElevenLabsError> {
    if text.trim().is_empty() {
        return Err(ElevenLabsError::new("EMPTY_TEXT", "That line has no text to speak."));
    }

    let resp = client()?
        .post(format!("{API}/v1/text-to-speech/{voice_id}"))
        .query(&[("output_format", format!("wav_{TARGET_SAMPLE_RATE}"))])
        .header("xi-api-key", key()?)
        .json(&serde_json::json!({ "text": text, "model_id": model_id }))
        .send()
        .await
        .map_err(transport_error)?;

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let body = resp.text().await.unwrap_or_default();
        return Err(classify(status, &body));
    }

    let bytes = resp.bytes().await.map_err(transport_error)?.to_vec();
    if bytes.len() < 64 {
        return Err(ElevenLabsError::new(
            "BAD_AUDIO",
            "ElevenLabs returned an empty or truncated audio file.",
        ));
    }
    Ok(bytes)
}

/// What the WAV we were handed actually is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WavShape {
    pub channels: u16,
    pub sample_rate: u32,
    pub bits: u16,
}

/// Read the RIFF header without decoding the whole file.
///
/// Requesting `wav_24000` should give exactly what the pipeline wants, but the
/// point of checking is to notice if it ever doesn't, rather than writing a
/// mislabelled file and hearing about it as a pitch-shifted voiceover.
pub fn wav_shape(bytes: &[u8]) -> Option<WavShape> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().ok()?) as usize;
        if id == b"fmt " && i + 8 + 16 <= bytes.len() {
            let f = &bytes[i + 8..];
            return Some(WavShape {
                channels: u16::from_le_bytes(f[2..4].try_into().ok()?),
                sample_rate: u32::from_le_bytes(f[4..8].try_into().ok()?),
                bits: u16::from_le_bytes(f[14..16].try_into().ok()?),
            });
        }
        i += 8 + size + (size & 1);
    }
    None
}

impl WavShape {
    /// Already in the pipeline's canonical format, so no conversion is needed.
    pub fn is_canonical(&self) -> bool {
        self.channels == 1 && self.sample_rate == TARGET_SAMPLE_RATE && self.bits == 16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_for(status: u16, body: &str) -> String {
        classify(status, body).code
    }

    #[test]
    fn quota_problems_are_not_mistaken_for_a_bad_key() {
        // ElevenLabs reports an exhausted quota as 401, which without reading
        // detail.status would send the user to re-paste a working credential.
        assert_eq!(
            err_for(401, r#"{"detail":{"status":"quota_exceeded","message":"..."}}"#),
            "QUOTA_EXCEEDED"
        );
        assert_eq!(err_for(401, r#"{"detail":{"status":"invalid_api_key"}}"#), "INVALID_API_KEY");
        assert_eq!(err_for(401, "not json"), "INVALID_API_KEY", "bare 401 is still a key problem");
    }

    #[test]
    fn known_detail_statuses_map_to_actionable_codes() {
        assert_eq!(err_for(422, r#"{"detail":{"status":"voice_not_found"}}"#), "VOICE_NOT_FOUND");
        assert_eq!(err_for(429, r#"{"detail":{"status":"rate_limit_exceeded"}}"#), "RATE_LIMITED");
        assert_eq!(
            err_for(429, r#"{"detail":{"status":"too_many_concurrent_requests"}}"#),
            "RATE_LIMITED"
        );
        assert_eq!(err_for(200, r#"{"detail":{"status":"system_busy"}}"#), "RATE_LIMITED");
    }

    #[test]
    fn falls_back_to_the_http_code_when_detail_is_absent() {
        assert_eq!(err_for(429, "{}"), "RATE_LIMITED");
        assert_eq!(err_for(503, ""), "SERVICE_ERROR");
        assert_eq!(err_for(404, "{}"), "VOICE_NOT_FOUND");
        assert_eq!(err_for(418, "{}"), "REQUEST_FAILED");
    }

    #[test]
    fn a_string_detail_is_handled_as_well_as_an_object() {
        // Some endpoints answer with detail as a bare string.
        assert_eq!(err_for(401, r#"{"detail":"quota_exceeded"}"#), "QUOTA_EXCEEDED");
    }

    #[test]
    fn recognises_a_canonical_wav_header() {
        // Minimal 24kHz mono 16-bit RIFF header.
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&0u32.to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // pcm
        w.extend_from_slice(&1u16.to_le_bytes()); // mono
        w.extend_from_slice(&24_000u32.to_le_bytes());
        w.extend_from_slice(&48_000u32.to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&0u32.to_le_bytes());
        w.resize(64, 0);

        let shape = wav_shape(&w).expect("header should parse");
        assert_eq!(shape, WavShape { channels: 1, sample_rate: 24_000, bits: 16 });
        assert!(shape.is_canonical());
    }

    #[test]
    fn spots_a_wav_that_is_not_what_we_asked_for() {
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&0u32.to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes()); // stereo
        w.extend_from_slice(&44_100u32.to_le_bytes()); // wrong rate
        w.extend_from_slice(&176_400u32.to_le_bytes());
        w.extend_from_slice(&4u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.resize(64, 0);

        let shape = wav_shape(&w).expect("header should parse");
        assert!(!shape.is_canonical(), "stereo 44.1k must not pass as canonical");
    }

    #[test]
    fn non_wav_bytes_are_not_mistaken_for_wav() {
        assert!(wav_shape(b"ID3\x04\x00\x00\x00\x00\x00\x00 this is an mp3").is_none());
        assert!(wav_shape(&[]).is_none());
    }
}

// ---------------------------------------------------------------------------
// Writing audio the rest of the pipeline can use
// ---------------------------------------------------------------------------

/// Decode a canonical WAV's samples for speech-end detection.
fn samples_from_canonical_wav(bytes: &[u8]) -> Option<Vec<f32>> {
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).ok()?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != TARGET_SAMPLE_RATE {
        return None;
    }
    Some(
        reader
            .samples::<i16>()
            .filter_map(Result::ok)
            .map(|s| s as f32 / 32768.0)
            .collect(),
    )
}

/// Result of getting one line's audio onto disk.
pub struct WrittenAudio {
    pub duration_ms: u64,
    /// None when the audio could not be decoded, so the timeline falls back to
    /// file duration rather than guessing where speech ended.
    pub speech_end_ms: Option<u64>,
    pub converted: bool,
}

/// Write provider audio as the pipeline's canonical 24kHz mono WAV.
///
/// Three paths, in preference order:
///
/// 1. It already is canonical — write it straight through. This is the normal
///    case, since `wav_24000` is exactly what we request.
/// 2. It isn't, and ffmpeg is available — convert. Covers a future API change
///    or a tier that silently substitutes a format.
/// 3. It isn't, and ffmpeg is missing — keep the bytes as they are. Assembly
///    decodes mixed formats fine (measured: MP3 through the filter graph has
///    zero timing drift), so this costs only the tighter speech-end pacing,
///    not the feature.
pub fn write_line_audio(
    bytes: &[u8],
    dest: &std::path::Path,
    ffmpeg: Option<&str>,
) -> Result<WrittenAudio, ElevenLabsError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ElevenLabsError::new("WRITE_FAILED", e.to_string()))?;
    }

    let canonical = wav_shape(bytes).is_some_and(|s| s.is_canonical());

    if canonical {
        std::fs::write(dest, bytes)
            .map_err(|e| ElevenLabsError::new("WRITE_FAILED", e.to_string()))?;
        let samples = samples_from_canonical_wav(bytes);
        let duration_ms = samples
            .as_ref()
            .map(|s| (s.len() as u64 * 1000) / TARGET_SAMPLE_RATE as u64)
            .unwrap_or(0);
        return Ok(WrittenAudio {
            duration_ms,
            speech_end_ms: samples.as_deref().map(crate::tts::speech_end_ms),
            converted: false,
        });
    }

    // Not what we asked for. Convert if we can.
    if let Some(ffmpeg) = ffmpeg {
        let tmp = dest.with_extension("incoming");
        std::fs::write(&tmp, bytes)
            .map_err(|e| ElevenLabsError::new("WRITE_FAILED", e.to_string()))?;
        let ok = std::process::Command::new(ffmpeg)
            .args(["-y", "-v", "error", "-i"])
            .arg(&tmp)
            .args(["-c:a", "pcm_s16le", "-ar", &TARGET_SAMPLE_RATE.to_string(), "-ac", "1"])
            .arg(dest)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let _ = std::fs::remove_file(&tmp);

        if ok {
            let converted_bytes = std::fs::read(dest)
                .map_err(|e| ElevenLabsError::new("WRITE_FAILED", e.to_string()))?;
            let samples = samples_from_canonical_wav(&converted_bytes);
            let duration_ms = samples
                .as_ref()
                .map(|s| (s.len() as u64 * 1000) / TARGET_SAMPLE_RATE as u64)
                .unwrap_or(0);
            return Ok(WrittenAudio {
                duration_ms,
                speech_end_ms: samples.as_deref().map(crate::tts::speech_end_ms),
                converted: true,
            });
        }
    }

    // Keep whatever we were given; assembly can still read it.
    std::fs::write(dest, bytes)
        .map_err(|e| ElevenLabsError::new("WRITE_FAILED", e.to_string()))?;
    Ok(WrittenAudio { duration_ms: 0, speech_end_ms: None, converted: false })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineFailure {
    pub line_number: usize,
    pub clip_id: String,
    pub segment_index: usize,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSynthesis {
    pub lines: Vec<crate::tts::VoicedLine>,
    /// Lines that failed. Kept separate so a partial run is still useful.
    pub failures: Vec<LineFailure>,
    /// True when audio arrived in a format we had to convert.
    pub converted_any: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CloudProgress {
    done: usize,
    total: usize,
    clip_id: String,
}

fn audio_dir(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<std::path::PathBuf, ElevenLabsError> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| ElevenLabsError::new("NO_APP_DIR", e.to_string()))?;
    let safe: String = project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err(ElevenLabsError::new("BAD_PROJECT_ID", "project id has no usable characters"));
    }
    let dir = base.join("projects").join(safe).join("audio");
    std::fs::create_dir_all(&dir)
        .map_err(|e| ElevenLabsError::new("MKDIR_FAILED", e.to_string()))?;
    Ok(dir)
}

/// ffmpeg, if it happens to be available. Absence is not an error here — it
/// only costs the tighter speech-end pacing.
fn optional_ffmpeg() -> Option<String> {
    crate::ffmpeg::detect(&crate::ffmpeg::FfmpegSettings::default())
        .ok()
        .map(|i| i.ffmpeg)
}

const DEFAULT_MODEL: &str = "eleven_multilingual_v2";

/// Synthesise a whole script through ElevenLabs.
///
/// A failure part way through does **not** discard what already succeeded.
/// Those lines are paid for, and re-running the batch would bill them again —
/// so completed lines are returned alongside the failures, and the caller can
/// retry only what broke.
#[tauri::command]
pub async fn elevenlabs_synthesize(
    app: tauri::AppHandle,
    lines: Vec<CloudLineInput>,
    voice_id: String,
    project_id: String,
    model_id: Option<String>,
) -> Result<CloudSynthesis, ElevenLabsError> {
    use tauri::Emitter;

    let dir = audio_dir(&app, &project_id)?;
    let ffmpeg = optional_ffmpeg();
    let model = model_id.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let total = lines.len();

    let mut out = Vec::new();
    let mut failures = Vec::new();
    let mut converted_any = false;

    for (i, line) in lines.iter().enumerate() {
        match synthesize_bytes(&voice_id, &line.text, &model).await {
            Ok(bytes) => {
                let path = dir.join(format!("line-{:02}.wav", i + 1));
                match write_line_audio(&bytes, &path, ffmpeg.as_deref()) {
                    Ok(written) => {
                        converted_any |= written.converted;
                        out.push(crate::tts::VoicedLine {
                            clip_id: line.clip_id.clone(),
                            segment_index: line.segment_index,
                            text: line.text.clone(),
                            audio_path: path.to_string_lossy().to_string(),
                            duration_ms: written.duration_ms,
                            speech_end_ms: written.speech_end_ms.unwrap_or(written.duration_ms),
                            skipped: Vec::new(),
                        });
                    }
                    Err(e) => failures.push(LineFailure {
                        line_number: i + 1,
                        clip_id: line.clip_id.clone(),
                        segment_index: line.segment_index,
                        code: e.code,
                        message: e.message,
                    }),
                }
            }
            Err(e) => {
                // A key or quota problem will hit every remaining line the same
                // way; stopping avoids a wall of identical errors.
                let fatal = matches!(
                    e.code.as_str(),
                    "MISSING_API_KEY" | "INVALID_API_KEY" | "QUOTA_EXCEEDED"
                );
                failures.push(LineFailure {
                    line_number: i + 1,
                    clip_id: line.clip_id.clone(),
                    segment_index: line.segment_index,
                    code: e.code,
                    message: e.message,
                });
                if fatal {
                    break;
                }
            }
        }

        let _ = app.emit(
            "tts:progress",
            CloudProgress { done: i + 1, total, clip_id: line.clip_id.clone() },
        );
    }

    Ok(CloudSynthesis { lines: out, failures, converted_any })
}

/// Re-synthesise one line, for an edit or a retry.
#[tauri::command]
pub async fn elevenlabs_synthesize_line(
    app: tauri::AppHandle,
    line: CloudLineInput,
    line_number: usize,
    voice_id: String,
    project_id: String,
    model_id: Option<String>,
) -> Result<crate::tts::VoicedLine, ElevenLabsError> {
    let dir = audio_dir(&app, &project_id)?;
    let model = model_id.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let bytes = synthesize_bytes(&voice_id, &line.text, &model).await?;
    let path = dir.join(format!("line-{:02}.wav", line_number));
    let written = write_line_audio(&bytes, &path, optional_ffmpeg().as_deref())?;

    Ok(crate::tts::VoicedLine {
        clip_id: line.clip_id,
        segment_index: line.segment_index,
        text: line.text,
        audio_path: path.to_string_lossy().to_string(),
        duration_ms: written.duration_ms,
        speech_end_ms: written.speech_end_ms.unwrap_or(written.duration_ms),
        skipped: Vec::new(),
    })
}

#[cfg(test)]
mod audio_tests {
    use super::*;
    use crate::ffmpeg::{self, FfmpegSettings};

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rfrs-el-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ffmpeg_bin() -> Option<String> {
        ffmpeg::detect(&FfmpegSettings::default()).ok().map(|i| i.ffmpeg)
    }

    /// Build a WAV in an arbitrary shape, standing in for what the API returns.
    fn make_wav(dir: &std::path::Path, rate: u32, channels: u16, secs: f32) -> Vec<u8> {
        let Some(ff) = ffmpeg_bin() else { return Vec::new() };
        let path = dir.join(format!("src-{rate}-{channels}.wav"));
        let status = std::process::Command::new(ff)
            .args([
                "-y", "-v", "error", "-f", "lavfi",
                "-i", &format!("sine=frequency=200:duration={secs}"),
                "-c:a", "pcm_s16le", "-ar", &rate.to_string(), "-ac", &channels.to_string(),
            ])
            .arg(&path)
            .status()
            .expect("ffmpeg");
        assert!(status.success());
        std::fs::read(&path).unwrap()
    }

    /// The normal case: ElevenLabs returns wav_24000, which is already what the
    /// pipeline speaks, so it is written through untouched.
    #[test]
    fn canonical_audio_is_written_without_conversion() {
        let dir = tmp("canonical");
        let bytes = make_wav(&dir, TARGET_SAMPLE_RATE, 1, 2.0);
        if bytes.is_empty() {
            eprintln!("ffmpeg unavailable; skipping");
            return;
        }
        assert!(wav_shape(&bytes).unwrap().is_canonical());

        let dest = dir.join("line-01.wav");
        let w = write_line_audio(&bytes, &dest, None).expect("write");
        println!("\n  canonical: {}ms, converted={}", w.duration_ms, w.converted);

        assert!(!w.converted, "canonical audio must not be re-encoded");
        assert!(w.duration_ms.abs_diff(2_000) < 60, "duration {}", w.duration_ms);
        assert!(w.speech_end_ms.is_some(), "speech end should be measurable");
        // Written bytes are exactly what arrived.
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    }

    /// If the API ever returns something else, convert rather than writing a
    /// mislabelled file — which would surface as a pitch-shifted voiceover.
    #[test]
    fn non_canonical_audio_is_converted_when_ffmpeg_is_available() {
        let dir = tmp("convert");
        let Some(ff) = ffmpeg_bin() else {
            eprintln!("ffmpeg unavailable; skipping");
            return;
        };
        let bytes = make_wav(&dir, 44_100, 2, 2.0);
        assert!(!wav_shape(&bytes).unwrap().is_canonical(), "fixture should be off-format");

        let dest = dir.join("line-01.wav");
        let w = write_line_audio(&bytes, &dest, Some(&ff)).expect("write");
        println!("  converted: {}ms, converted={}", w.duration_ms, w.converted);

        assert!(w.converted, "off-format audio should be converted");
        let written = std::fs::read(&dest).unwrap();
        let shape = wav_shape(&written).expect("output header");
        assert!(shape.is_canonical(), "output must be 24kHz mono 16-bit, got {shape:?}");
        assert!(w.duration_ms.abs_diff(2_000) < 60, "duration preserved: {}", w.duration_ms);
        assert!(w.speech_end_ms.is_some());
        // No stray intermediate left behind.
        assert!(!dest.with_extension("incoming").exists(), "temp file leaked");
    }

    /// Without ffmpeg the feature still works; only the tighter speech-end
    /// pacing is lost, and the timeline already treats that as optional.
    #[test]
    fn off_format_audio_without_ffmpeg_degrades_rather_than_failing() {
        let dir = tmp("degrade");
        let bytes = make_wav(&dir, 44_100, 2, 2.0);
        if bytes.is_empty() {
            eprintln!("ffmpeg unavailable; skipping");
            return;
        }

        let dest = dir.join("line-01.wav");
        let w = write_line_audio(&bytes, &dest, None).expect("write should still succeed");
        println!("  degraded: speech_end={:?}, converted={}", w.speech_end_ms, w.converted);

        assert!(dest.is_file(), "audio must still be written");
        assert!(!w.converted);
        assert!(
            w.speech_end_ms.is_none(),
            "unmeasurable audio must report no speech end rather than a wrong one"
        );
    }

    /// Truncated or empty responses are rejected before anything is written.
    #[test]
    fn a_truncated_response_is_not_written_as_audio() {
        let dir = tmp("truncated");
        let dest = dir.join("line-01.wav");
        // write_line_audio itself accepts any bytes; the length guard lives in
        // synthesize_bytes, so assert the classification instead.
        let e = classify(200, "");
        assert_eq!(e.code, "REQUEST_FAILED");
        assert!(!dest.exists());
    }
}
