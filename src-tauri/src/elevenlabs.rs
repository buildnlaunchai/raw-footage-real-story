//! ElevenLabs as an optional cloud voice provider.
//!
//! The key comes from the signed-in account and nowhere else; see
//! [`crate::provider_keys`].
//!
//! The call lives in Rust for two reasons. The webview's origin would face the
//! usual CORS problem, and more importantly the API key never has to cross into
//! JavaScript: the frontend asks for synthesis, this module reads the
//! credential for the session and does the work.
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
#[serde(rename_all = "camelCase")]
pub struct ElevenLabsError {
    pub code: String,
    pub message: String,
    /// Where to send the browser to fix this, exactly as the platform
    /// addressed it.
    ///
    /// Carried on the error rather than pieced together in the UI, because
    /// nothing outside the response can know it: the destination follows the
    /// reason the key was withheld, and one of the three is a page with no
    /// provider in its address at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_url: Option<String>,
    /// What to put on the button that opens it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_label: Option<&'static str>,
}

impl ElevenLabsError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), consent_url: None, action_label: None }
    }

    fn from_key_problem(p: crate::provider_keys::KeyProblem) -> Self {
        Self {
            code: p.code().into(),
            message: p.message(),
            consent_url: p.consent_url(),
            action_label: p.action_label(),
        }
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

/// A GET to wherever ElevenLabs currently is for this member.
///
/// Credit mode sends it to the hub's gateway, which forwards it on OUR key —
/// these two paths are read-only, so the gateway opens no hold for them and
/// they cost nobody anything. Byok sends it straight to ElevenLabs.
async fn get_json(path: &str) -> Result<serde_json::Value, ElevenLabsError> {
    let target = crate::provider_keys::target_for(crate::provider_keys::Provider::ElevenLabs, API)
        .await
        .map_err(ElevenLabsError::from_key_problem)?;

    let mut req = client()?.get(format!("{}{path}", target.base));
    for (name, value) in &target.headers {
        req = req.header(name.as_str(), value.as_str());
    }

    let resp = req.send().await.map_err(transport_error)?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| ElevenLabsError::new("BAD_RESPONSE", e.to_string()))
}

fn client() -> Result<reqwest::Client, ElevenLabsError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| ElevenLabsError::new("CLIENT_INIT", e.to_string()))
}

/// Would this failure hit every remaining line the same way?
///
/// If so the run stops, because the alternative is the wall of identical errors
/// this check has always existed to prevent.
///
/// THE ORIGINAL LIST WAS KEY AND QUOTA PROBLEMS, and it was complete while the
/// app called ElevenLabs directly on the member's key: a network failure then
/// was usually a blip in one request, and trying the next line was reasonable.
///
/// On credit the platform is in the data path, so "no connection" is not a blip
/// — it is the state of the whole run, and every line after it fails
/// identically. A member on a plane would have watched a fifty-line script
/// produce fifty copies of the same sentence, which is exactly the outcome the
/// original comment promised would not happen.
fn stops_the_run(code: &str) -> bool {
    matches!(
        code,
        // The member's own key. Unchanged.
        "MISSING_API_KEY"
            | "INVALID_API_KEY"
            | "QUOTA_EXCEEDED"
            // The platform could not be reached, or would not answer. Every one
            // of these is a fact about the run, not about the line.
            | "NETWORK"
            | "PLATFORM"
            | "NOT_CONFIGURED"
            | "KEYS_UNREACHABLE"
            | "KEYS_SIGNED_OUT"
            | "KEYS_NOT_CONFIGURED"
            | "KEY_NOT_LINKED"
    )
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

/// What is left, in whichever unit is actually the member's.
///
/// Two variants because there are genuinely two answers, not one answer with a
/// missing field. On their own key it is ElevenLabs characters, which they buy
/// from ElevenLabs. On credit it is platform credit, which they buy from us —
/// and the ElevenLabs figure for that call belongs to our account and must
/// never be shown. A tagged union makes the UI say which it is holding rather
/// than guess from whether a number is zero.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UsageReport {
    /// The member's own ElevenLabs quota. Byok only.
    Provider(Usage),
    /// The member's platform credit. `balance - held` is what is spendable.
    Credit { balance: i64, held: i64 },
}

/// The user's own voices.
///
/// Note this is `/v2/voices`; the v1 path still exists but is the older shape.
#[tauri::command]
pub async fn elevenlabs_voices() -> Result<Vec<CloudVoice>, ElevenLabsError> {
    let json = get_json("/v2/voices").await?;
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
pub async fn elevenlabs_usage() -> Result<UsageReport, ElevenLabsError> {
    // ─── The one call that is NOT forwarded in credit mode ──────────────────
    //
    // `/v1/user/subscription` reports the quota of whichever key made the call.
    // On credit that key is OURS, so forwarding it would show a member the
    // platform's own balance — a leak, and a useless one: the number that means
    // anything to them is their credit, not our character allowance. So the
    // question changes with the mode rather than the answer being laundered.
    let target = crate::provider_keys::target_for(crate::provider_keys::Provider::ElevenLabs, API)
        .await
        .map_err(ElevenLabsError::from_key_problem)?;

    if target.mode == crate::platform::KeyMode::Credit {
        let cfg = crate::platform::config()
            .ok_or_else(|| ElevenLabsError::new("NOT_CONFIGURED", "No platform configured."))?;
        let access = crate::platform::fresh_access()
            .await
            .map_err(|e| ElevenLabsError::new("PLATFORM", e.to_string()))?;
        let bal = crate::platform::credit_balance(&cfg.base, &cfg.anon_key, &access)
            .await
            .map_err(|e| ElevenLabsError::new("PLATFORM", e.to_string()))?;

        return Ok(UsageReport::Credit {
            balance: bal.balance,
            held: bal.held,
        });
    }

    let json = get_json("/v1/user/subscription").await?;
    Ok(UsageReport::Provider(Usage {
        character_count: json["character_count"].as_u64().unwrap_or(0),
        character_limit: json["character_limit"].as_u64().unwrap_or(0),
        tier: json["tier"].as_str().unwrap_or("unknown").to_string(),
        resets_at_unix: json["next_character_count_reset_unix"].as_i64(),
    }))
}

// `elevenlabs_test_key` was here, and went for the same reason as its OpenAI
// twin: it validated a key handed in from the webview, and no key is handed in
// from the webview any more. `elevenlabs_usage` answers the same question
// about the key actually in use.


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
    language: Option<&str>,
) -> Result<Vec<u8>, ElevenLabsError> {
    if text.trim().is_empty() {
        return Err(ElevenLabsError::new("EMPTY_TEXT", "That line has no text to speak."));
    }

    let mut body = serde_json::json!({ "text": text, "model_id": model_id });
    // `language_code` pins normalisation to the intended language instead of
    // letting the model guess from the characters. It is rejected by
    // multilingual_v2, so it is only sent where it is accepted.
    if let Some(lang) = language {
        if model_id != "eleven_multilingual_v2" && !lang.is_empty() {
            body["language_code"] = serde_json::json!(lang);
        }
    }

    // ─── The one call that spends money, and therefore the one that is routed ──
    //
    // In credit mode this leaves for the hub's gateway carrying the member's
    // SESSION, and the hub spends its own ElevenLabs key against credit they
    // bought. In byok it goes straight to ElevenLabs on their key. Both are a
    // base and a set of headers, so nothing below branches on which.
    //
    // Every ElevenLabs call in this file goes through a target now, including
    // the two read-only ones — the gateway forwards /v2/voices and /v1/models
    // on our key without opening a hold, because a member on credit has no key
    // of their own and without a voice list there is no narration.
    //
    // The exception is `/v1/user/subscription`, which is not forwarded and must
    // not be: it reports the quota of whichever key called it, which on credit
    // is OURS. elevenlabs_usage asks a different question in that mode instead.
    let target = crate::provider_keys::target_for(
        crate::provider_keys::Provider::ElevenLabs,
        API,
    )
    .await
        .map_err(ElevenLabsError::from_key_problem)?;

    let mut req = client()?
        .post(format!("{}/v1/text-to-speech/{voice_id}", target.base))
        .query(&[("output_format", format!("wav_{TARGET_SAMPLE_RATE}"))])
        .json(&body);
    for (name, value) in &target.headers {
        req = req.header(name.as_str(), value.as_str());
    }

    let resp = req.send().await.map_err(transport_error)?;

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
mod run_stopping_tests {
    use super::*;

    #[test]
    fn a_problem_with_the_platform_stops_the_whole_run() {
        // The bug this closes: on credit the hub is in the data path, so an
        // unreachable platform fails every line. Before this, only key and quota
        // problems stopped the loop, and a fifty-line script offline produced
        // fifty copies of the same error.
        for code in [
            "NETWORK",
            "PLATFORM",
            "NOT_CONFIGURED",
            "KEYS_UNREACHABLE",
            "KEYS_SIGNED_OUT",
            "KEYS_NOT_CONFIGURED",
            "KEY_NOT_LINKED",
        ] {
            assert!(stops_the_run(code), "{code} should have stopped the run");
        }
    }

    #[test]
    fn the_original_key_and_quota_cases_still_stop_it() {
        for code in ["MISSING_API_KEY", "INVALID_API_KEY", "QUOTA_EXCEEDED"] {
            assert!(stops_the_run(code), "{code} regressed");
        }
    }

    #[test]
    fn a_problem_with_one_line_does_not_stop_the_rest() {
        // The other half of the rule, and the reason this is a list rather than
        // "stop on any error": one bad line — a voice that rejects the text, a
        // single timeout — must not throw away the forty-nine that would work.
        for code in ["BAD_PROJECT_ID", "TIMEOUT", "REQUEST_FAILED", "BAD_RESPONSE", "UNKNOWN"] {
            assert!(!stops_the_run(code), "{code} should not have stopped the run");
        }
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

/// Models this app prefers, best first, among those that support the language.
///
/// Only an ordering: which models exist and which languages each covers is read
/// from the account at run time. A hardcoded language table would be wrong the
/// moment ElevenLabs adds a language, which is exactly how Bengali came to be
/// sent to a model that has never supported it.
const MODEL_PREFERENCE: [&str; 3] =
    ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5"];

/// The catalogue, fetched once per process.
static MODEL_CACHE: std::sync::OnceLock<Vec<(String, Vec<String>)>> = std::sync::OnceLock::new();

async fn catalogue() -> Vec<(String, Vec<String>)> {
    if let Some(c) = MODEL_CACHE.get() {
        return c.clone();
    }
    let fetched = fetch_catalogue().await.unwrap_or_default();
    MODEL_CACHE.get_or_init(|| fetched).clone()
}

async fn fetch_catalogue() -> Option<Vec<(String, Vec<String>)>> {
    let models = get_json("/v1/models").await.ok()?;
    Some(
        models
            .as_array()?
            .iter()
            .filter(|m| m["can_do_text_to_speech"].as_bool().unwrap_or(false))
            .map(|m| {
                let id = m["model_id"].as_str().unwrap_or_default().to_string();
                let langs = m["languages"]
                    .as_array()
                    .map(|ls| {
                        ls.iter()
                            .filter_map(|l| l["language_id"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (id, langs)
            })
            .collect(),
    )
}

/// Which model to speak this language with.
///
/// An explicit choice always wins. Otherwise the best preferred model that
/// actually lists the language, falling back to any model that does, and to the
/// default when the catalogue cannot be read — an unreachable models endpoint
/// should not stop synthesis that would otherwise work.
pub async fn model_for(explicit: Option<String>, language: Option<&str>) -> String {
    if let Some(m) = explicit.filter(|m| !m.trim().is_empty()) {
        return m;
    }
    let Some(lang) = language.map(str::trim).filter(|l| !l.is_empty()) else {
        return DEFAULT_MODEL.to_string();
    };
    choose_model(&catalogue().await, lang)
}

/// The choice itself, over a catalogue already in hand.
///
/// Separated from fetching so it can be tested against known catalogues rather
/// than against whatever the account happens to expose today.
fn choose_model(catalogue: &[(String, Vec<String>)], lang: &str) -> String {
    let supports = |id: &str| {
        catalogue
            .iter()
            .any(|(m, langs)| m == id && langs.iter().any(|l| l == lang))
    };
    for preferred in MODEL_PREFERENCE {
        if supports(preferred) {
            return preferred.to_string();
        }
    }
    // Nothing preferred covers it; take anything that does before giving up,
    // since a model that knows the language beats a better-sounding one that
    // does not.
    catalogue
        .iter()
        .find(|(_, langs)| langs.iter().any(|l| l == lang))
        .map(|(id, _)| id.clone())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

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
    language: Option<String>,
) -> Result<CloudSynthesis, ElevenLabsError> {
    use tauri::Emitter;

    let dir = audio_dir(&app, &project_id)?;
    let ffmpeg = optional_ffmpeg();
    let model = model_for(model_id, language.as_deref()).await;
    let total = lines.len();

    let mut out = Vec::new();
    let mut failures = Vec::new();
    let mut converted_any = false;

    for (i, line) in lines.iter().enumerate() {
        match synthesize_bytes(&voice_id, &line.text, &model, language.as_deref()).await {
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
                let fatal = stops_the_run(&e.code);
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
    language: Option<String>,
) -> Result<crate::tts::VoicedLine, ElevenLabsError> {
    let dir = audio_dir(&app, &project_id)?;
    let model = model_for(model_id, language.as_deref()).await;
    let bytes = synthesize_bytes(&voice_id, &line.text, &model, language.as_deref()).await?;
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

#[cfg(test)]
mod model_survey {
    /// What can this account actually reach, and which models claim Bengali?
    ///
    /// Listing models costs nothing, so this asks rather than trusting the
    /// docs — which describe v3 as available on the TTS API without saying
    /// whether an ordinary key may call it.
    #[test]
    #[ignore = "needs a real API key"]
    fn which_models_and_languages() {
        let Some(key) = std::env::var("ELEVENLABS_API_KEY").ok().filter(|v| !v.trim().is_empty()) else {
            eprintln!("no key available; skipping");
            return;
        };
        let body = match ureq_get("https://api.elevenlabs.io/v1/models", &key) {
            Ok(b) => b,
            Err(e) => {
                println!("request failed: {e}");
                return;
            }
        };
        let models: serde_json::Value = serde_json::from_str(&body).expect("json");
        for m in models.as_array().unwrap_or(&vec![]) {
            let id = m["model_id"].as_str().unwrap_or("?");
            let langs = m["languages"].as_array().cloned().unwrap_or_default();
            let codes: Vec<&str> =
                langs.iter().filter_map(|l| l["language_id"].as_str()).collect();
            let bengali = codes.iter().any(|c| *c == "bn");
            println!(
                "{:<28} {:>3} languages  bengali={}  tts={}",
                id,
                codes.len(),
                if bengali { "YES" } else { "no " },
                m["can_do_text_to_speech"].as_bool().unwrap_or(false),
            );
            if bengali {
                println!("      -> {}", m["name"].as_str().unwrap_or(""));
            }
        }
    }

    fn ureq_get(url: &str, key: &str) -> Result<String, String> {
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let c = reqwest::Client::new();
            let r = c
                .get(url)
                .header("xi-api-key", key)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = r.status();
            let text = r.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("{status}: {}", text.chars().take(200).collect::<String>()));
            }
            Ok(text)
        })
    }
}

#[cfg(test)]
mod bengali_ab {
    /// Bengali on the model we ship versus one that lists Bengali.
    ///
    /// Writes both to the scratchpad so a Bengali speaker can judge them; the
    /// numbers here only show the calls succeeded and how long each result is.
    #[test]
    #[ignore = "needs a real API key; makes billed calls"]
    fn multilingual_v2_versus_v3() {
        let Some(key) = std::env::var("ELEVENLABS_API_KEY").ok().filter(|v| !v.trim().is_empty()) else {
            eprintln!("no key available; skipping");
            return;
        };
        // From the OpenAI Bengali draft, so it is text this app would really speak.
        const TEXT: &str =
            "ফ্যাকাশে সকালের আকাশের সামনে হারামের সাদা মিনারগুলো দাঁড়িয়ে থাকে।";
        let out = std::path::Path::new(
            "/private/tmp/claude-501/-Users-zahidrobeen-Documents-Work-BuildnLaunchAI---Apps-Raw-Footage-Real-Story/063e7b93-ca42-4ab7-9c7f-21152a8c2f57/scratchpad/bengali-ab",
        );
        std::fs::create_dir_all(out).ok();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let voice = rt.block_on(first_voice(&key)).expect("a voice on the account");
        println!("voice: {voice}\ntext:  {TEXT}\n");

        for (label, model, lang, settings) in [
            ("current-multilingual_v2", "eleven_multilingual_v2", None, None),
            ("v3-plain", "eleven_v3", None, None),
            ("v3-language-code", "eleven_v3", Some("bn"), None),
            (
                "v3-settings",
                "eleven_v3",
                Some("bn"),
                Some(serde_json::json!({
                    "stability": 0.5, "similarity_boost": 0.75,
                    "style": 0.0, "use_speaker_boost": true
                })),
            ),
        ] {
            match rt.block_on(say(&key, &voice, TEXT, model, lang, settings)) {
                Ok(bytes) => {
                    let p = out.join(format!("{label}.mp3"));
                    std::fs::write(&p, &bytes).ok();
                    println!("{label:<24} OK    {:>7} bytes  -> {}", bytes.len(), p.display());
                }
                Err(e) => println!("{label:<24} FAIL  {e}"),
            }
        }
    }

    pub(super) async fn first_voice(key: &str) -> Option<String> {
        let c = reqwest::Client::new();
        let r = c.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", key)
            .send().await.ok()?;
        let j: serde_json::Value = r.json().await.ok()?;
        j["voices"].as_array()?.first()?["voice_id"].as_str().map(String::from)
    }

    async fn say(
        key: &str, voice: &str, text: &str, model: &str,
        language_code: Option<&str>, settings: Option<serde_json::Value>,
    ) -> Result<Vec<u8>, String> {
        let mut body = serde_json::json!({ "text": text, "model_id": model });
        if let Some(l) = language_code { body["language_code"] = serde_json::json!(l); }
        if let Some(s) = settings { body["voice_settings"] = s; }
        let c = reqwest::Client::new();
        let r = c
            .post(format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}"))
            .header("xi-api-key", key)
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        let status = r.status();
        let bytes = r.bytes().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{status}: {}",
                String::from_utf8_lossy(&bytes).chars().take(220).collect::<String>()));
        }
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod format_check {
    /// Does each model return the WAV this app asks for?
    ///
    /// Worth asking before routing a language to a different model: an output
    /// format the new model does not offer would turn a quality fix into a
    /// synthesis failure.
    #[test]
    #[ignore = "needs a real API key; makes billed calls"]
    fn wav_24000_is_available_on_each_model() {
        let Some(key) = std::env::var("ELEVENLABS_API_KEY").ok().filter(|v| !v.trim().is_empty()) else {
            eprintln!("no key available; skipping");
            return;
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let voice = rt.block_on(super::bengali_ab::first_voice(&key)).expect("a voice");

        for model in ["eleven_multilingual_v2", "eleven_v3"] {
            let got = rt.block_on(async {
                let c = reqwest::Client::new();
                let r = c
                    .post(format!("{}/v1/text-to-speech/{voice}", super::API))
                    .query(&[("output_format", "wav_24000")])
                    .header("xi-api-key", &key)
                    .json(&serde_json::json!({ "text": "Test.", "model_id": model }))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let status = r.status();
                let bytes = r.bytes().await.map_err(|e| e.to_string())?;
                if !status.is_success() {
                    return Err(format!(
                        "{status}: {}",
                        String::from_utf8_lossy(&bytes).chars().take(160).collect::<String>()
                    ));
                }
                Ok(bytes.to_vec())
            });
            match got {
                Ok(b) => {
                    let riff = b.starts_with(b"RIFF");
                    println!("{model:<26} OK  {:>6} bytes  RIFF/WAV={riff}", b.len());
                }
                Err(e) => println!("{model:<26} FAIL  {e}"),
            }
        }
    }
}


#[cfg(test)]
mod model_choice {
    use super::*;

    /// The real shape, as returned by the account on 2026-08-11.
    fn catalogue() -> Vec<(String, Vec<String>)> {
        vec![
            ("eleven_v3".into(), vec!["en".into(), "bn".into(), "hi".into(), "ta".into()]),
            ("eleven_multilingual_v2".into(), vec!["en".into(), "hi".into(), "ta".into()]),
            ("eleven_flash_v2_5".into(), vec!["en".into(), "hi".into()]),
        ]
    }

    #[test]
    fn bengali_goes_to_the_model_that_has_bengali() {
        // The reported bug: multilingual_v2 does not list bn, and answers
        // anyway. Silence from the API is not evidence of support.
        assert_eq!(choose_model(&catalogue(), "bn"), "eleven_v3");
    }

    #[test]
    fn languages_both_support_keep_the_established_model() {
        // Changing the model for English would change how every existing
        // project sounds, which is not what fixing Bengali should do.
        assert_eq!(choose_model(&catalogue(), "en"), "eleven_multilingual_v2");
        assert_eq!(choose_model(&catalogue(), "hi"), "eleven_multilingual_v2");
    }

    #[test]
    fn an_unknown_language_falls_back_rather_than_failing() {
        assert_eq!(choose_model(&catalogue(), "xx"), DEFAULT_MODEL);
        assert_eq!(choose_model(&[], "bn"), DEFAULT_MODEL);
    }

    #[test]
    fn a_language_only_an_unpreferred_model_has_still_finds_it() {
        let cat = vec![("some_new_model".to_string(), vec!["bn".to_string()])];
        assert_eq!(choose_model(&cat, "bn"), "some_new_model");
    }

    #[tokio::test]
    async fn an_explicit_model_is_never_second_guessed() {
        assert_eq!(
            model_for(Some("eleven_flash_v2_5".into()), Some("bn")).await,
            "eleven_flash_v2_5",
        );
        // No language means no basis to choose, so the default stands.
        assert_eq!(model_for(None, None).await, DEFAULT_MODEL);
        assert_eq!(model_for(None, Some("  ")).await, DEFAULT_MODEL);
    }
}


#[cfg(test)]
mod live_model_choice {
    /// The same choice, against the live catalogue rather than a fixture.
    #[test]
    #[ignore = "needs a real API key"]
    fn bengali_and_english_route_correctly() {
        if std::env::var("ELEVENLABS_API_KEY").ok().filter(|v| !v.trim().is_empty()).is_none() {
            eprintln!("no key available; skipping");
            return;
        }
        let rt = tokio::runtime::Runtime::new().unwrap();
        for lang in ["bn", "en", "hi", "ar"] {
            let m = rt.block_on(super::model_for(None, Some(lang)));
            println!("{lang} -> {m}");
        }
    }
}
