//! Kokoro TTS via ONNX Runtime.
//!
//! Text arrives as English, is phonemised by [`crate::g2p`] (no espeak-ng, so
//! no GPL), and comes out as 24kHz mono WAV on disk.
//!
//! The inference session costs ~0.7s to build and `Session::run` takes
//! `&mut self`, so one session lives in Tauri managed state behind a Mutex.
//! Rebuilding it per sentence measured 1.2x realtime against 1.9x reused.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::g2p;
use crate::resources;

/// Kokoro emits 24kHz mono.
pub const SAMPLE_RATE: u32 = 24_000;

/// Voice packs are (510, 1, 256) f32: one style row per token count.
const STYLE_DIM: usize = 256;
const STYLE_ROWS: usize = 510;

fn resources_dir() -> PathBuf {
    resources::kokoro()
}

/// Load a voice pack and return the style row for a given token count.
fn style_row(voice_path: &Path, token_count: usize) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(voice_path).map_err(|e| format!("read voice: {e}"))?;
    let expected = STYLE_ROWS * STYLE_DIM * 4;
    if bytes.len() != expected {
        return Err(format!(
            "voice pack is {} bytes, expected {expected}",
            bytes.len()
        ));
    }
    if token_count >= STYLE_ROWS {
        return Err(format!("token count {token_count} exceeds {STYLE_ROWS}"));
    }
    let start = token_count * STYLE_DIM * 4;
    let row = bytes[start..start + STYLE_DIM * 4]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok(row)
}

/// Map an IPA phoneme string to Kokoro token ids using the shipped tokenizer.
fn tokenize(phonemes: &str, vocab: &serde_json::Value) -> Vec<i64> {
    phonemes
        .chars()
        .filter_map(|c| vocab.get(c.to_string()).and_then(|v| v.as_i64()))
        .collect()
}

/// Build the inference session. Expensive (loads ~86MB), so real code holds one
/// of these in Tauri managed state rather than rebuilding it per sentence.
pub fn load_session() -> Result<ort::session::Session, String> {
    ort::session::Session::builder()
        .map_err(|e| format!("session builder: {e}"))?
        .commit_from_file(resources_dir().join("model_q8f16.onnx"))
        .map_err(|e| format!("load model: {e}"))
}

/// Synthesise raw f32 samples from an IPA phoneme string, reusing a session.
pub fn synthesize_with(
    session: &mut ort::session::Session,
    phonemes: &str,
    voice: &str,
    speed: f32,
) -> Result<Vec<f32>, String> {
    use ort::value::TensorRef;

    let dir = resources_dir();

    let tokenizer: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join("tokenizer.json")).map_err(|e| format!("read tokenizer: {e}"))?,
    )
    .map_err(|e| format!("parse tokenizer: {e}"))?;
    let vocab = tokenizer
        .get("model")
        .and_then(|m| m.get("vocab"))
        .ok_or("tokenizer.json missing model.vocab")?;

    let ids = tokenize(phonemes, vocab);
    if ids.is_empty() {
        return Err("no recognisable phonemes".into());
    }
    let n = ids.len();

    // Kokoro expects the sequence wrapped in boundary tokens.
    let mut padded = Vec::with_capacity(n + 2);
    padded.push(0i64);
    padded.extend_from_slice(&ids);
    padded.push(0i64);

    let style = style_row(&dir.join("voices").join(format!("{voice}.bin")), n)?;

    let speed_vec = vec![speed];

    let outputs = session
        .run(ort::inputs![
            "input_ids" => TensorRef::from_array_view(([1, padded.len()], padded.as_slice()))
                .map_err(|e| e.to_string())?,
            "style" => TensorRef::from_array_view(([1, STYLE_DIM], style.as_slice()))
                .map_err(|e| e.to_string())?,
            "speed" => TensorRef::from_array_view(([1], speed_vec.as_slice()))
                .map_err(|e| e.to_string())?,
        ])
        .map_err(|e| format!("inference: {e}"))?;

    let (_shape, data) = outputs["waveform"]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("extract waveform: {e}"))?;

    Ok(data.to_vec())
}

/// Write samples as 24kHz mono 16-bit PCM.
pub fn write_wav(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| format!("create wav: {e}"))?;
    for &s in samples {
        w.write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .map_err(|e| format!("write sample: {e}"))?;
    }
    w.finalize().map_err(|e| format!("finalize wav: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri command layer
// ---------------------------------------------------------------------------

/// The session is ~86MB to build and `Session::run` needs `&mut self`, so it
/// lives behind a Mutex in managed state and is built once, lazily.
#[derive(Default)]
pub struct TtsState {
    session: Mutex<Option<ort::session::Session>>,
}

#[derive(Debug, Serialize)]
pub struct TtsError {
    pub code: String,
    pub message: String,
}

impl TtsError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLineInput {
    pub clip_id: String,
    #[serde(default)]
    pub segment_index: usize,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoicedLine {
    pub clip_id: String,
    #[serde(default)]
    pub segment_index: usize,
    pub text: String,
    pub audio_path: String,
    pub duration_ms: u64,
    pub skipped: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    clip_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    /// "American" / "British" etc., derived from Kokoro's naming convention.
    pub accent: String,
    pub gender: String,
    pub label: String,
}

/// Kokoro voice ids encode accent and gender in their first two letters:
/// a=American, b=British; f=female, m=male.
fn describe_voice(id: &str) -> VoiceInfo {
    let bytes = id.as_bytes();
    let accent = match bytes.first() {
        Some(b'a') => "American",
        Some(b'b') => "British",
        Some(b'e') => "Spanish",
        Some(b'f') => "French",
        Some(b'h') => "Hindi",
        Some(b'i') => "Italian",
        Some(b'j') => "Japanese",
        Some(b'p') => "Portuguese",
        Some(b'z') => "Chinese",
        _ => "Other",
    };
    let gender = match bytes.get(1) {
        Some(b'f') => "Female",
        Some(b'm') => "Male",
        _ => "Other",
    };
    let name = id.split_once('_').map(|(_, n)| n).unwrap_or(id);
    let label = {
        let mut c = name.chars();
        match c.next() {
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            None => name.to_string(),
        }
    };
    VoiceInfo { id: id.to_string(), accent: accent.into(), gender: gender.into(), label }
}

#[tauri::command]
pub fn tts_list_voices() -> Result<Vec<VoiceInfo>, TtsError> {
    let dir = resources_dir().join("voices");
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| TtsError::new("VOICES_MISSING", format!("{}: {e}", dir.display())))?;

    let mut voices: Vec<VoiceInfo> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".bin").map(describe_voice)
        })
        .collect();
    voices.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(voices)
}

/// Run one synthesis on the shared session, building it on first use.
fn with_session<T>(
    state: &TtsState,
    f: impl FnOnce(&mut ort::session::Session) -> Result<T, String>,
) -> Result<T, TtsError> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| TtsError::new("LOCK_POISONED", "TTS session lock was poisoned"))?;
    if guard.is_none() {
        *guard = Some(load_session().map_err(|e| TtsError::new("MODEL_LOAD_FAILED", e))?);
    }
    let session = guard.as_mut().expect("session present");
    f(session).map_err(|e| TtsError::new("SYNTHESIS_FAILED", e))
}

fn audio_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, TtsError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| TtsError::new("NO_APP_DIR", e.to_string()))?;
    // project_id comes from the frontend; keep it to a safe charset so it can
    // never escape the app data directory.
    let safe: String = project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err(TtsError::new("BAD_PROJECT_ID", "project id has no usable characters"));
    }
    let dir = base.join("projects").join(safe).join("audio");
    std::fs::create_dir_all(&dir)
        .map_err(|e| TtsError::new("MKDIR_FAILED", format!("{}: {e}", dir.display())))?;
    Ok(dir)
}

/// Synthesise a whole script, emitting `tts:progress` after each line so the UI
/// can show "3 of 8" rather than freezing for a minute.
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    state: tauri::State<'_, TtsState>,
    lines: Vec<ScriptLineInput>,
    voice: String,
    project_id: String,
    speed: Option<f32>,
    pronunciations: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<VoicedLine>, TtsError> {
    let dir = audio_dir(&app, &project_id)?;
    let speed = speed.unwrap_or(1.0);
    let total = lines.len();
    let mut out = Vec::with_capacity(total);

    let overrides = normalise_overrides(pronunciations);

    for (i, line) in lines.iter().enumerate() {
        let ph = g2p::text_to_phonemes_with(&line.text, &overrides);
        if ph.phonemes.is_empty() {
            return Err(TtsError::new(
                "EMPTY_PHONEMES",
                format!("Nothing pronounceable in: {:?}", line.text),
            ));
        }

        let samples = with_session(&state, |s| synthesize_with(s, &ph.phonemes, &voice, speed))?;

        let path = dir.join(format!("line-{:02}.wav", i + 1));
        write_wav(&path, &samples).map_err(|e| TtsError::new("WAV_WRITE_FAILED", e))?;

        out.push(VoicedLine {
            clip_id: line.clip_id.clone(),
            segment_index: line.segment_index,
            text: line.text.clone(),
            audio_path: path.to_string_lossy().to_string(),
            duration_ms: (samples.len() as u64 * 1000) / SAMPLE_RATE as u64,
            skipped: ph.skipped,
        });

        let _ = app.emit(
            "tts:progress",
            Progress { done: i + 1, total, clip_id: line.clip_id.clone() },
        );
    }

    Ok(out)
}

/// Short one-off synthesis so a user can audition a voice without committing to
/// a full run. Overwrites a single file rather than accumulating previews.
#[tauri::command]
pub async fn tts_preview(
    app: AppHandle,
    state: tauri::State<'_, TtsState>,
    text: String,
    voice: String,
) -> Result<VoicedLine, TtsError> {
    let ph = g2p::text_to_phonemes(&text);
    if ph.phonemes.is_empty() {
        return Err(TtsError::new("EMPTY_PHONEMES", "Nothing pronounceable in the preview text"));
    }
    let samples = with_session(&state, |s| synthesize_with(s, &ph.phonemes, &voice, 1.0))?;

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| TtsError::new("NO_APP_DIR", e.to_string()))?;
    std::fs::create_dir_all(&base)
        .map_err(|e| TtsError::new("MKDIR_FAILED", e.to_string()))?;
    let path = base.join(format!("preview-{voice}.wav"));
    write_wav(&path, &samples).map_err(|e| TtsError::new("WAV_WRITE_FAILED", e))?;

    Ok(VoicedLine {
        clip_id: "preview".into(),
        segment_index: 0,
        text,
        audio_path: path.to_string_lossy().to_string(),
        duration_ms: (samples.len() as u64 * 1000) / SAMPLE_RATE as u64,
        skipped: ph.skipped,
    })
}

/// Lowercased keys, blank corrections dropped.
fn normalise_overrides(
    map: Option<std::collections::HashMap<String, String>>,
) -> std::collections::HashMap<String, String> {
    map.unwrap_or_default()
        .into_iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| (k.to_lowercase(), v))
        .collect()
}

/// Re-synthesise a single line, overwriting just that file.
///
/// Correcting one mispronounced word should not cost a whole voiceover: a
/// twenty-line script is well over a minute of synthesis, and the other
/// nineteen lines were already right.
#[tauri::command]
pub async fn tts_synthesize_line(
    app: AppHandle,
    state: tauri::State<'_, TtsState>,
    line: ScriptLineInput,
    line_number: usize,
    voice: String,
    project_id: String,
    speed: Option<f32>,
    pronunciations: Option<std::collections::HashMap<String, String>>,
) -> Result<VoicedLine, TtsError> {
    let dir = audio_dir(&app, &project_id)?;
    let overrides = normalise_overrides(pronunciations);

    let ph = g2p::text_to_phonemes_with(&line.text, &overrides);
    if ph.phonemes.is_empty() {
        return Err(TtsError::new(
            "EMPTY_PHONEMES",
            format!("Nothing pronounceable in: {:?}", line.text),
        ));
    }

    let samples = with_session(&state, |s| {
        synthesize_with(s, &ph.phonemes, &voice, speed.unwrap_or(1.0))
    })?;

    // Same naming as the batch path, so the rendered timeline picks it up.
    let path = dir.join(format!("line-{:02}.wav", line_number));
    write_wav(&path, &samples).map_err(|e| TtsError::new("WAV_WRITE_FAILED", e))?;

    Ok(VoicedLine {
        clip_id: line.clip_id.clone(),
        segment_index: line.segment_index,
        text: line.text.clone(),
        audio_path: path.to_string_lossy().to_string(),
        duration_ms: (samples.len() as u64 * 1000) / SAMPLE_RATE as u64,
        skipped: ph.skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Raw footage, real story." in IPA, straight from the lexicon — no G2P
    /// involved, so this isolates the ONNX path.
    const PHONEMES: &str = "ɹˈɔ fˈʊtɪʤ, ɹˈiəl stˈɔɹi.";

    #[test]
    fn synthesizes_audio_from_hardcoded_phonemes() {
        let load_started = std::time::Instant::now();
        let mut session = load_session().expect("session should build");
        let load_time = load_started.elapsed();

        let started = std::time::Instant::now();
        let samples = synthesize_with(&mut session, PHONEMES, "af_heart", 1.0)
            .expect("synthesis should succeed");
        let elapsed = started.elapsed();

        println!("\n  session load: {:.2}s (one-time)", load_time.as_secs_f32());

        let duration = samples.len() as f32 / SAMPLE_RATE as f32;
        let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();

        let out = std::env::temp_dir().join("ort_spike.wav");
        write_wav(&out, &samples).expect("wav write should succeed");

        println!("\n  samples   : {}", samples.len());
        println!("  duration  : {duration:.2}s @ {SAMPLE_RATE}Hz");
        println!("  inference : {:.2}s ({:.1}x realtime)", elapsed.as_secs_f32(),
                 duration / elapsed.as_secs_f32());
        println!("  peak amp  : {peak:.3}");
        println!("  rms       : {rms:.4}");
        println!("  wrote     : {}", out.display());

        assert!(!samples.is_empty(), "must produce samples");
        assert!(duration > 0.5, "expected >0.5s of audio, got {duration:.2}s");
        assert!(peak > 0.05, "audio is silent (peak {peak:.4})");
        assert!(peak <= 1.0, "audio clips (peak {peak:.4})");
        assert!(rms > 0.005, "audio is near-silent noise (rms {rms:.5})");
    }

    #[test]
    fn lists_and_describes_every_bundled_voice() {
        let voices = tts_list_voices().expect("voices should list");
        assert_eq!(voices.len(), 55, "expected all 55 voice packs");
        assert!(voices.iter().any(|v| v.id == "af_heart"), "default voice present");

        // Every voice must land in a real group, or the picker shows "Other".
        let unclassified: Vec<&str> = voices
            .iter()
            .filter(|v| v.accent == "Other" || v.gender == "Other")
            .map(|v| v.id.as_str())
            .collect();
        assert!(unclassified.is_empty(), "unclassified voices: {unclassified:?}");

        let heart = voices.iter().find(|v| v.id == "af_heart").unwrap();
        assert_eq!((heart.accent.as_str(), heart.gender.as_str()), ("American", "Female"));
        assert_eq!(heart.label, "Heart");

        let mut groups: std::collections::BTreeMap<String, usize> = Default::default();
        for v in &voices {
            *groups.entry(format!("{} {}", v.accent, v.gender)).or_default() += 1;
        }
        println!("\n  {} voices in {} groups:", voices.len(), groups.len());
        for (g, n) in &groups {
            println!("    {g}: {n}");
        }
    }

    /// The actual Stage 2 path: plain English straight through G2P into audio,
    /// with no hand-written phonemes anywhere.
    #[test]
    fn synthesizes_from_plain_english_text() {
        let text = "We landed in Reykjavik just after sunrise, and the harbour was still frozen.";
        let ph = crate::g2p::text_to_phonemes(text);
        assert!(ph.skipped.is_empty(), "unexpected OOV: {:?}", ph.skipped);

        let mut session = load_session().expect("session");
        let samples = synthesize_with(&mut session, &ph.phonemes, "af_heart", 1.0)
            .expect("synthesis");

        let duration = samples.len() as f32 / SAMPLE_RATE as f32;
        let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        let words = text.split_whitespace().count();
        let wpm = words as f32 / (duration / 60.0);

        println!("\n  text     : {text}");
        println!("  phonemes : {}", ph.phonemes);
        println!("  duration : {duration:.2}s for {words} words -> {wpm:.0} wpm");
        println!("  peak amp : {peak:.3}");

        assert!(peak > 0.05, "silent output");
        // Natural narration sits roughly in this band; well outside it means the
        // phonemes are wrong even though audio was produced.
        assert!((100.0..260.0).contains(&wpm), "implausible speech rate: {wpm:.0} wpm");
    }

    /// A script is many sentences through one session — the shape the real
    /// pipeline uses. Confirms the session is reusable and shows the true
    /// per-sentence cost once the one-time model load is out of the way.
    #[test]
    fn reuses_one_session_across_sentences() {
        let lines = [
            ("ɹˈɔ fˈʊtɪʤ, ɹˈiəl stˈɔɹi.", "clip 1"),
            ("ðɪs ɹˈʌf kˈʌt wʌz nˈæɹeɪtᵻd ˌɑn jʊɹ ˈoʊn məʃˈin.", "clip 2"),
            ("hˈɑɹbəɹ wʌz stˈɪl fɹˈoʊzən.", "clip 3"),
        ];

        let mut session = load_session().expect("session should build");
        let mut total_audio = 0f32;
        let mut total_time = 0f32;

        for (phonemes, label) in lines {
            let t = std::time::Instant::now();
            let samples =
                synthesize_with(&mut session, phonemes, "af_heart", 1.0).expect("synthesis");
            let secs = t.elapsed().as_secs_f32();
            let dur = samples.len() as f32 / SAMPLE_RATE as f32;
            total_audio += dur;
            total_time += secs;
            println!("  {label}: {dur:.2}s audio in {secs:.2}s ({:.1}x realtime)", dur / secs);
            assert!(samples.iter().fold(0f32, |m, s| m.max(s.abs())) > 0.05, "{label} silent");
        }

        println!(
            "  total: {total_audio:.2}s audio in {total_time:.2}s ({:.1}x realtime)",
            total_audio / total_time
        );
        assert!(total_audio / total_time > 1.0, "should beat realtime");
    }
}
