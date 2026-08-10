//! Auditioning all bundled voices on one fixed narration sentence.
//!
//! The picker used to show 55 voices in accent/gender groups, which is honest
//! but unhelpful: most people want a good narration voice, not a survey. This
//! measures every voice on identical text and scores it on properties that are
//! checkable rather than matters of taste.
//!
//! What is measurable, and why each matters for narration specifically:
//!
//! - **Speech rate.** Documentary narration sits around 140–190 wpm. Much
//!   faster is hard to follow over picture; much slower drags.
//! - **Silence ratio.** Long internal pauses read as halting. Kokoro voices
//!   differ noticeably here on identical input.
//! - **Level and headroom.** A voice that sits very quiet forces the music bed
//!   down with it; one that clips cannot be fixed later.
//! - **Dynamic range.** Too flat is robotic, too wide fights a music bed.
//!
//! What this cannot measure is timbre, warmth, or whether a voice suits a
//! particular film. Those are exactly the judgements to leave to a person, so
//! the full list stays available and this only decides what surfaces first.
//!
//! Run: `cargo test --lib voice_audition -- --ignored --nocapture`

#![cfg(test)]

use crate::{g2p, tts};

/// Deliberately narration-shaped: mixed sentence lengths, a comma pause, and
/// ordinary vocabulary the lexicon resolves fully, so differences between
/// voices are not confounded by a skipped word.
const TEST_LINE: &str =
    "The harbour was still frozen, and the light came in low across the water. \
     We stayed until the cold made the decision for us.";

#[derive(Debug, Clone)]
struct Audition {
    voice: String,
    accent: String,
    gender: String,
    wpm: f32,
    silence_ratio: f32,
    rms: f32,
    peak: f32,
    crest_db: f32,
}

impl Audition {
    /// Narration suitability, 0–100. Each term is a distance from a band that
    /// is defensible for spoken narration rather than a preference.
    fn score(&self) -> f32 {
        // Pace: flat inside 140–190, falling away outside it.
        let pace = if (140.0..=190.0).contains(&self.wpm) {
            1.0
        } else {
            let d = if self.wpm < 140.0 { 140.0 - self.wpm } else { self.wpm - 190.0 };
            (1.0 - d / 60.0).max(0.0)
        };
        // Some internal pause is natural; a lot is halting.
        let flow = (1.0 - (self.silence_ratio / 0.35)).clamp(0.0, 1.0);
        // Enough level to sit over a bed, without touching the ceiling.
        let level = if self.peak > 0.99 {
            0.0 // clipped
        } else {
            (1.0 - ((self.rms - 0.11).abs() / 0.09)).clamp(0.0, 1.0)
        };
        // Crest factor: expressive but not wild. ~10–18 dB is the useful band.
        let dynamics = (1.0 - ((self.crest_db - 14.0).abs() / 8.0)).clamp(0.0, 1.0);

        (pace * 0.35 + flow * 0.30 + level * 0.20 + dynamics * 0.15) * 100.0
    }
}

fn analyse(samples: &[f32]) -> (f32, f32, f32, f32) {
    let n = samples.len().max(1) as f32;
    let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / n).sqrt();

    // Silence in 20ms frames, relative to this voice's own level, so a quiet
    // voice is not scored as if it were pausing.
    let frame = (tts::SAMPLE_RATE as usize) / 50;
    let threshold = (rms * 0.15).max(0.002);
    let (mut quiet, mut total) = (0usize, 0usize);
    for chunk in samples.chunks(frame) {
        let f = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len().max(1) as f32).sqrt();
        if f < threshold {
            quiet += 1;
        }
        total += 1;
    }
    let silence_ratio = quiet as f32 / total.max(1) as f32;
    let crest_db = if rms > 0.0 { 20.0 * (peak / rms).log10() } else { 0.0 };
    (rms, peak, silence_ratio, crest_db)
}

#[test]
#[ignore = "auditions all 55 voices; slow, and only needed when curating"]
fn audition_every_voice_and_rank_for_narration() {
    let voices = tts::tts_list_voices().expect("voices should list");
    let ph = g2p::text_to_phonemes(TEST_LINE);
    assert!(ph.skipped.is_empty(), "test line must phonemise fully: {:?}", ph.skipped);
    let words = TEST_LINE.split_whitespace().count() as f32;

    let mut session = tts::load_session().expect("session");
    let mut results = Vec::new();

    for v in &voices {
        let Ok(samples) = tts::synthesize_with(&mut session, &ph.phonemes, &v.id, 1.0) else {
            eprintln!("  {} failed to synthesise; skipping", v.id);
            continue;
        };
        let secs = samples.len() as f32 / tts::SAMPLE_RATE as f32;
        if secs <= 0.5 {
            continue;
        }
        let (rms, peak, silence_ratio, crest_db) = analyse(&samples);
        results.push(Audition {
            voice: v.id.clone(),
            accent: v.accent.clone(),
            gender: v.gender.clone(),
            wpm: words / (secs / 60.0),
            silence_ratio,
            rms,
            peak,
            crest_db,
        });
    }

    assert!(results.len() >= 50, "expected most voices to synthesise, got {}", results.len());
    results.sort_by(|a, b| b.score().partial_cmp(&a.score()).unwrap());

    println!("\n  {} voices auditioned on the same line\n", results.len());
    println!(
        "  {:<14} {:>6} {:>7} {:>7} {:>7} {:>7}  {}",
        "voice", "score", "wpm", "silence", "rms", "crest", "accent/gender"
    );
    for a in &results {
        println!(
            "  {:<14} {:>6.1} {:>7.0} {:>6.0}% {:>7.3} {:>6.1}dB  {} {}",
            a.voice, a.score(), a.wpm, a.silence_ratio * 100.0, a.rms, a.crest_db,
            a.accent, a.gender
        );
    }

    // Curate. Two rules, in this order:
    //
    // 1. English accents only. Kokoro's Japanese and Chinese voices score well
    //    on pace and flow because those measures are language-agnostic, but the
    //    app narrates in English and they read it with a marked accent.
    //    Recommending them by default would be an accident of the metric, not a
    //    judgement anyone made. They stay in the full list.
    // 2. Vary within that: a shortlist of six voices that all sound alike is a
    //    worse menu than six that differ.
    let mut picked: Vec<&Audition> = Vec::new();
    for a in results.iter().filter(|a| a.accent == "American" || a.accent == "British") {
        if picked.len() >= 7 {
            break;
        }
        let same_kind = picked
            .iter()
            .filter(|p| p.accent == a.accent && p.gender == a.gender)
            .count();
        if same_kind < 2 {
            picked.push(a);
        }
    }

    println!("\n  recommended for narration:");
    for p in &picked {
        println!(
            "    {:<14} score {:>5.1}  {:>3.0} wpm  {} {}",
            p.voice, p.score(), p.wpm, p.accent, p.gender
        );
    }
    println!("\n  paste-ready:");
    println!(
        "  const RECOMMENDED = [{}];",
        picked.iter().map(|p| format!("\"{}\"", p.voice)).collect::<Vec<_>>().join(", ")
    );

    assert!(picked.len() >= 5, "should recommend at least five voices");
    assert!(
        picked.iter().all(|p| p.peak <= 0.99),
        "a recommended voice must not clip"
    );
    assert!(
        picked.iter().any(|p| p.gender == "Female") && picked.iter().any(|p| p.gender == "Male"),
        "the shortlist should not be single-gender"
    );
    assert!(
        picked.iter().all(|p| p.accent == "American" || p.accent == "British"),
        "recommendations must be English-accented for English narration"
    );
    assert!(
        picked.iter().any(|p| p.accent == "American") && picked.iter().any(|p| p.accent == "British"),
        "offer both English accents"
    );
}
