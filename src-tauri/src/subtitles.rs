//! Turning a planned timeline back into subtitles.
//!
//! The timings are not estimated and not re-derived: every line already has a
//! slot on the timeline, decided by the length of its own narration audio, so a
//! subtitle is that slot minus the pause deliberately left at the end of it. A
//! caption that ran to the cut would sit on screen through the silence after
//! the sentence, which reads as the next shot's caption arriving early.
//!
//! SRT rather than ASS. It is the format every site accepts as an upload, it
//! survives being opened in a text editor by someone who wants to fix a
//! spelling, and libass renders it perfectly well when it is burned in. Styling
//! that SRT cannot carry is passed to the `subtitles` filter as `force_style`
//! instead, so the file on disk stays plain.
//!
//! Pure, so the whole thing is testable without ffmpeg.

use crate::timeline::{TimelineItem, TAIL_MS};

/// One caption: what is said, and the window it is on screen for.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// The shortest a caption may stay up.
///
/// Below this it registers as a flash rather than as words. A very short line
/// borrows from the pause after it rather than being cut off.
pub const MIN_CUE_MS: u64 = 900;

/// Build the cues for a rendered timeline.
///
/// `text_for` supplies a line's words given its `(clip_id, segment_index)`,
/// which is the pair everything in this app addresses a line by. Items with no
/// text — a montage, a clip nobody narrated — get no caption rather than an
/// empty one.
pub fn cues(items: &[TimelineItem], text_for: impl FnMut(&TimelineItem) -> Option<String>) -> Vec<Cue> {
    cues_for("en", items, text_for)
}

/// As above, sized for the script the captions are written in.
pub fn cues_for(
    language: &str,
    items: &[TimelineItem],
    mut text_for: impl FnMut(&TimelineItem) -> Option<String>,
) -> Vec<Cue> {
    let mut out: Vec<Cue> = Vec::new();
    for item in items {
        let Some(text) = text_for(item).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
        else {
            continue;
        };
        let start = item.timeline_start_ms;
        let slot_end = start + item.timeline_duration_ms;
        // The slot carries a deliberate beat after the last word. The caption
        // belongs to the words, not to the breath after them.
        let spoken_end = slot_end
            .saturating_sub(TAIL_MS)
            .max(start + MIN_CUE_MS.min(item.timeline_duration_ms))
            .min(slot_end);

        // A line too long for two readable lines becomes two captions in
        // sequence rather than one block that overflows the frame. The slot is
        // shared out by length, which is a good enough stand-in for how long
        // each part takes to say — the parts come from one continuous
        // recording, so nothing here can drift out of step with the audio.
        let parts = split_for_reading(&text, max_cue_chars(language));
        let total: usize = parts.iter().map(|p| p.chars().count()).sum::<usize>().max(1);
        let window = spoken_end.saturating_sub(start);
        let mut cursor = start;
        for (n, part) in parts.iter().enumerate() {
            let last = n + 1 == parts.len();
            let share = window * part.chars().count() as u64 / total as u64;
            let end = if last { spoken_end } else { (cursor + share).min(spoken_end) };
            out.push(Cue { start_ms: cursor, end_ms: end.max(cursor), text: part.clone() });
            cursor = end;
        }
    }
    out
}

/// The most a single caption may carry.
///
/// One line's worth, not two. A caption is read in the half-second it is on
/// screen, and a second line doubles what the eye has to take in while the
/// picture is also asking for attention — so a long line becomes two captions
/// in sequence instead of one tall block sitting over the footage.
pub fn max_cue_chars(language: &str) -> usize {
    wrap_chars(language)
}

/// The Latin default, kept for callers with no language to hand.
pub const MAX_CUE_CHARS: usize = WRAP_CHARS;

/// Break a line into caption-sized pieces on word boundaries.
///
/// Scripts without whitespace are left whole: there is no boundary to break on
/// and splitting by character count lands mid-word. libass wraps those itself.
fn split_for_reading(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit || !text.contains(' ') {
        return vec![text.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let added = if current.is_empty() { word.chars().count() } else { current.chars().count() + 1 + word.chars().count() };
        if !current.is_empty() && added > limit {
            out.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// `hh:mm:ss,mmm` — SRT's own timestamp, comma and all.
fn stamp(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    format!("{h:02}:{m:02}:{s:02},{:03}", ms % 1_000)
}

/// How many characters a caption may run to, per script.
///
/// A number counted in characters cannot be one number. Bengali and Devanagari
/// glyphs are far wider than Latin ones and carry more per character; Chinese,
/// Japanese and Thai more again. Forty-two Latin characters is a comfortable
/// line; forty-two Bengali characters is roughly twice the width of the frame,
/// which is how a caption ends up wrapped over four lines covering the picture.
pub fn wrap_chars(language: &str) -> usize {
    match language {
        // No spaces, and one character is a whole word's worth.
        "zh" | "ja" => 18,
        "th" => 26,
        // Bengali, Devanagari, Arabic: wide glyphs, dense meaning.
        "bn" | "hi" | "ar" | "ta" | "te" | "ml" | "kn" | "gu" | "pa" | "or" => 28,
        _ => 42,
    }
}

/// The Latin default, kept for callers with no language to hand.
pub const WRAP_CHARS: usize = 42;

/// Which script a caption is actually written in.
///
/// Read from the text rather than taken from the language setting. The setting
/// is a separate piece of state that can be wrong — it was: it did not survive
/// a restart, so a Bengali script reopened as English and every caption was
/// drawn in a Latin font that cannot place a Bengali vowel sign. The text
/// cannot be wrong about what it is.
pub fn dominant_script(text: &str) -> &'static str {
    let mut counts = [0usize; 8];
    for c in text.chars() {
        let i = match c as u32 {
            0x0980..=0x09FF => 0, // Bengali
            0x0900..=0x097F => 1, // Devanagari
            0x0600..=0x06FF | 0x0750..=0x077F => 2, // Arabic
            0x0E00..=0x0E7F => 3, // Thai
            0x3040..=0x30FF => 4, // Hiragana and Katakana
            0xAC00..=0xD7AF | 0x1100..=0x11FF => 5, // Hangul
            0x4E00..=0x9FFF | 0x3400..=0x4DBF => 6, // Han
            _ => continue,
        };
        counts[i] += 1;
    }
    let (best, n) = counts.iter().enumerate().max_by_key(|(_, n)| **n).unwrap();
    if *n == 0 {
        return "en";
    }
    ["bn", "hi", "ar", "th", "ja", "ko", "zh", "en"][best]
}

/// The bundled font file that can draw this script.
///
/// A file shipped with the app, not a family name looked up on the machine.
/// Two findings forced that:
///
/// - libass, which ffmpeg's `subtitles` filter uses, does no complex shaping in
///   the builds people have. Bengali vowel signs land after their consonant,
///   Arabic does not join, Devanagari does not reorder — the same wrong output
///   from every font tried, so the text is drawn with `drawtext` instead.
/// - `drawtext` shapes correctly only from a plain `.ttf`. Handed a `.ttc`
///   collection — which is what every Bengali font on macOS is — it loses the
///   shaping tables and produces the same mess.
///
/// So each script gets a `.ttf` of its own, fetched by `scripts/fetch-fonts.sh`.
pub fn font_file_for(script: &str) -> &'static str {
    match script {
        "bn" => "NotoSansBengali-Regular.ttf",
        "hi" | "mr" | "ne" => "NotoSansDevanagari-Regular.ttf",
        "ar" | "fa" | "ur" => "NotoSansArabic-Regular.ttf",
        "th" => "NotoSansThai-Regular.ttf",
        // Latin, Greek and Cyrillic, and the fallback for anything not
        // bundled — Chinese, Japanese and Korean among them, whose fonts are
        // tens of megabytes each and are left to the system for now.
        _ => "NotoSans-Regular.ttf",
    }
}

/// A font family that can draw this language, for the libass path.
///
/// Kept for the `.srt` sidecar's sake and for builds without `drawtext`.
pub fn font_for(language: &str, exists: impl Fn(&str) -> bool) -> String {
    let candidates: &[&str] = match language {
        // Sangam first, and not by reputation. Rendered side by side through
        // libass, Kohinoor Bangla and Bangla MN both *drop the pre-base vowel
        // sign* — শেষ comes out শষ, ভেতরে comes out ভতরে — while Sangam places
        // it correctly. Kohinoor is Apple's modern Bengali face and the obvious
        // choice; it is wrong here, which is only visible by looking at the
        // pixels. See the images in `bengali_captions_use_a_font_that_can_draw_them`.
        "bn" => &["Bangla Sangam MN", "Noto Sans Bengali", "Nirmala UI", "Kohinoor Bangla"],
        "hi" | "mr" | "ne" => &["Kohinoor Devanagari", "Devanagari MT", "Nirmala UI", "Noto Sans Devanagari"],
        "ar" => &["Geeza Pro", "Al Nile", "Segoe UI", "Noto Naskh Arabic"],
        "th" => &["Thonburi", "Leelawadee UI", "Noto Sans Thai"],
        "zh" => &["PingFang SC", "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC"],
        "ja" => &["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans CJK JP"],
        "ko" => &["Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR"],
        _ => &["Helvetica Neue", "Helvetica", "Arial"],
    };
    candidates
        .iter()
        .find(|f| exists(f))
        // Arial Unicode MS covers nearly everything and ships with macOS and
        // Office; past that, whatever fontconfig finds beats naming nothing.
        .map(|f| f.to_string())
        .unwrap_or_else(|| {
            for last in ["Arial Unicode MS", "Helvetica", "Arial"] {
                if exists(last) {
                    return last.to_string();
                }
            }
            "Arial".to_string()
        })
}

/// Break a caption into at most two balanced lines.
///
/// Wrapping is by whitespace, which is why it is skipped for scripts that do
/// not use it: Chinese, Japanese and Thai have no spaces to break on, and
/// splitting them by character count lands mid-word. libass wraps those itself.
pub fn wrap(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit || !text.contains(' ') {
        return text.to_string();
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    // Balance the two halves rather than filling the first line greedily: a
    // long line above a two-word orphan looks like a mistake.
    let total: usize = text.chars().count();
    let mut best = (usize::MAX, 1usize);
    for split in 1..words.len() {
        let first: usize = words[..split].iter().map(|w| w.chars().count() + 1).sum::<usize>() - 1;
        let second = total.saturating_sub(first + 1);
        if first > limit || second > limit {
            continue;
        }
        let imbalance = first.abs_diff(second);
        if imbalance < best.0 {
            best = (imbalance, split);
        }
    }
    if best.0 == usize::MAX {
        // No two-line split fits; leave it whole and let libass wrap it.
        return text.to_string();
    }
    format!("{}\n{}", words[..best.1].join(" "), words[best.1..].join(" "))
}

/// Render cues as an SRT document.
pub fn to_srt(cues: &[Cue], wrap_at: Option<usize>) -> String {
    let mut out = String::new();
    for (i, c) in cues.iter().enumerate() {
        let body = match wrap_at {
            Some(limit) => wrap(&c.text, limit),
            None => c.text.clone(),
        };
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            stamp(c.start_ms),
            stamp(c.end_ms),
            body,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::Fit;

    fn item(clip: &str, start: u64, dur: u64) -> TimelineItem {
        TimelineItem {
            clip_id: clip.into(),
            segment_index: 0,
            source_in_ms: 0,
            source_out_ms: dur,
            timeline_start_ms: start,
            timeline_duration_ms: dur,
            stretch: 1.0,
            fit: Fit::Exact,
        }
    }

    #[test]
    fn a_caption_ends_with_the_words_not_with_the_shot() {
        // The slot carries a deliberate pause after the last syllable. A
        // caption that ran to the cut would sit through that silence and read
        // as the next shot's caption arriving early.
        let items = [item("a", 0, 4_000)];
        let out = cues(&items, |_| Some("The harbour was still frozen.".into()));
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[0].end_ms, 4_000 - TAIL_MS);
        assert!(out[0].end_ms < 4_000);
    }

    #[test]
    fn a_very_short_line_still_stays_up_long_enough_to_read() {
        let items = [item("a", 0, 1_000)];
        let out = cues(&items, |_| Some("Snow.".into()));
        assert!(
            out[0].end_ms - out[0].start_ms >= 700,
            "a caption that flashes is a caption nobody reads: {out:?}",
        );
        assert!(out[0].end_ms <= 1_000, "and never past its own shot");
    }

    #[test]
    fn captions_never_overlap_the_next_shot() {
        let items = [item("a", 0, 4_000), item("b", 4_000, 3_000)];
        let out = cues(&items, |i| Some(format!("line for {}", i.clip_id)));
        assert_eq!(out.len(), 2);
        assert!(out[0].end_ms <= out[1].start_ms, "{out:?}");
    }

    #[test]
    fn an_item_with_nothing_said_over_it_gets_no_caption() {
        // The opening montage is one such item, and an empty cue would show as
        // a blank box for three seconds.
        let items = [item("__intro__", 0, 3_000), item("a", 3_000, 4_000)];
        let out = cues(&items, |i| (i.clip_id != "__intro__").then(|| "spoken".into()));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_ms, 3_000);
    }

    #[test]
    fn whitespace_only_text_is_not_a_caption() {
        let items = [item("a", 0, 4_000)];
        assert!(cues(&items, |_| Some("   ".into())).is_empty());
    }

    #[test]
    fn srt_timestamps_are_srt_timestamps() {
        // Comma, not a full stop, and zero-padded to three places. Players are
        // unforgiving about this and fail by showing nothing at all.
        assert_eq!(stamp(0), "00:00:00,000");
        assert_eq!(stamp(1_500), "00:00:01,500");
        assert_eq!(stamp(61_042), "00:01:01,042");
        assert_eq!(stamp(3_723_004), "01:02:03,004");
    }

    #[test]
    fn the_document_is_numbered_from_one() {
        let list = vec![
            Cue { start_ms: 0, end_ms: 2_000, text: "One".into() },
            Cue { start_ms: 2_000, end_ms: 4_000, text: "Two".into() },
        ];
        let srt = to_srt(&list, None);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:02,000\nOne\n\n"), "{srt}");
        assert!(srt.contains("2\n00:00:02,000 --> 00:00:04,000\nTwo\n\n"), "{srt}");
    }

    #[test]
    fn long_captions_break_into_two_balanced_lines() {
        let text = "The harbour did not so much freeze as stop, boats caught";
        let wrapped = wrap(text, WRAP_CHARS);
        let lines: Vec<&str> = wrapped.split('\n').collect();
        assert_eq!(lines.len(), 2, "{wrapped}");
        assert!(lines.iter().all(|l| l.chars().count() <= WRAP_CHARS), "{wrapped}");
        let diff = lines[0].chars().count().abs_diff(lines[1].chars().count());
        assert!(diff < 12, "a long line over an orphan reads as a mistake: {wrapped}");
    }

    #[test]
    fn a_long_line_becomes_several_single_line_captions() {
        // One line each, in sequence. Two stacked lines double what the eye
        // has to take in while the picture is also asking for attention, and
        // four of them — which is what a wide script produced — cover it.
        let text = "The harbour did not so much freeze as stop, boats caught mid-turn where the water took them";
        let items = [item("a", 0, 8_000)];
        let out = cues(&items, |_| Some(text.into()));

        assert!(out.len() >= 2, "{out:?}");
        assert!(
            out.iter().all(|c| c.text.chars().count() <= MAX_CUE_CHARS),
            "every caption fits one line: {out:?}",
        );
        assert_eq!(out[0].start_ms, 0, "the first starts with the shot");
        assert_eq!(out.last().unwrap().end_ms, 8_000 - TAIL_MS, "the last ends with the words");
        for pair in out.windows(2) {
            assert_eq!(pair[0].end_ms, pair[1].start_ms, "no gap between them");
        }
        assert_eq!(
            out.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join(" "),
            text,
            "every word, in order",
        );
    }

    #[test]
    fn a_wide_script_gets_a_shorter_line_than_a_narrow_one() {
        // The bug this fixes: one character count for every language. Forty-two
        // Bengali characters is about twice the width of the frame, so a caption
        // wrapped at the Latin width covered the picture.
        assert!(wrap_chars("bn") < wrap_chars("en"));
        assert!(wrap_chars("zh") < wrap_chars("bn"));
        assert_eq!(wrap_chars("fr"), wrap_chars("en"), "unknown scripts take the Latin width");
    }

    #[test]
    fn bengali_is_never_set_in_a_font_without_bengali_in_it() {
        // libass defaults to Arial, which has not one Bengali glyph, and then
        // substitutes per character — which for a conjunct script is at best a
        // different font per letter.
        let have = |f: &str| matches!(f, "Bangla Sangam MN" | "Helvetica" | "Arial");
        assert_eq!(font_for("bn", have), "Bangla Sangam MN");
        assert_eq!(font_for("en", have), "Helvetica");
    }

    #[test]
    fn a_language_with_nothing_installed_still_gets_a_font() {
        // Never nothing: a caption that fails to draw is worse than one drawn
        // in a substitute.
        let only_arial = |f: &str| f == "Arial";
        assert_eq!(font_for("bn", only_arial), "Arial");
        let nothing = |_: &str| false;
        assert_eq!(font_for("bn", nothing), "Arial");
    }

    #[test]
    fn the_script_is_read_from_the_words_themselves() {
        // The setting is separate state and was wrong: it did not survive a
        // restart, so a Bengali script reopened as English and every caption
        // was drawn in a Latin font. The text cannot be wrong about what it is.
        assert_eq!(dominant_script("ক্রেডিট কার্ড থাকলে এই লাউঞ্জ বিনা খরচে"), "bn");
        assert_eq!(dominant_script("The harbour did not so much freeze as stop."), "en");
        assert_eq!(dominant_script("港口并没有结冰"), "zh");
        assert_eq!(dominant_script("ここは空港のラウンジです"), "ja");
        assert_eq!(dominant_script("ท่าเรือไม่ได้แข็งตัว"), "th");
        assert_eq!(dominant_script("المطار"), "ar");
    }

    #[test]
    fn a_few_latin_words_do_not_make_a_bengali_line_english() {
        // Place names, brands and numbers turn up inside every script.
        assert_eq!(dominant_script("এটা UCB Imperial Lounge, ঢাকা বিমানবন্দরে"), "bn");
    }

    #[test]
    fn text_with_no_letters_at_all_falls_back_rather_than_panicking() {
        assert_eq!(dominant_script(""), "en");
        assert_eq!(dominant_script("123 ... !!!"), "en");
    }

    #[test]
    fn the_first_installed_candidate_wins() {
        let all = |_: &str| true;
        assert_eq!(font_for("bn", all), "Bangla Sangam MN");
        let no_sangam = |f: &str| f != "Bangla Sangam MN";
        assert_eq!(font_for("bn", no_sangam), "Noto Sans Bengali");
    }

    #[test]
    fn a_short_caption_is_left_alone() {
        assert_eq!(wrap("The road ran forty miles.", WRAP_CHARS), "The road ran forty miles.");
    }

    #[test]
    fn a_script_without_spaces_is_never_split_by_hand() {
        // Chinese, Japanese and Thai have no whitespace to break on, and
        // splitting on character count lands mid-word. libass wraps them.
        let zh = "港口并没有结冰只是停住了船只停在水把它们带到的地方一动不动";
        assert_eq!(wrap(zh, 10), zh);
    }

    #[test]
    fn wrapping_never_loses_or_reorders_a_word() {
        let text = "One two three four five six seven eight nine ten eleven twelve thirteen";
        let wrapped = wrap(text, 30);
        assert_eq!(
            wrapped.split_whitespace().collect::<Vec<_>>(),
            text.split_whitespace().collect::<Vec<_>>(),
        );
    }
}
