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
#[derive(Debug, Clone, PartialEq)]
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
pub fn cues(items: &[TimelineItem], mut text_for: impl FnMut(&TimelineItem) -> Option<String>) -> Vec<Cue> {
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
        let parts = split_for_reading(&text, MAX_CUE_CHARS);
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

/// The most a single caption may carry: two lines at the wrap width.
pub const MAX_CUE_CHARS: usize = WRAP_CHARS * 2;

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

/// How many characters a caption line may run to before it is broken.
///
/// Two shortish lines read faster than one long one, and a caption wider than
/// the frame is simply lost. Counted in characters rather than pixels because
/// the renderer, not this, knows the frame size — and because the failure this
/// prevents is a wall of text, which no exact measurement is needed to see.
pub const WRAP_CHARS: usize = 42;

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
    fn a_line_too_long_to_read_at_once_becomes_two_captions() {
        // Ninety-one characters will not fit two readable lines, and one
        // caption that wide runs off the frame. Two in sequence is what a
        // subtitler would do.
        let text = "The harbour did not so much freeze as stop, boats caught mid-turn where the water took them";
        assert!(text.chars().count() > MAX_CUE_CHARS);
        let items = [item("a", 0, 8_000)];
        let out = cues(&items, |_| Some(text.into()));

        assert_eq!(out.len(), 2, "{out:?}");
        assert!(out.iter().all(|c| c.text.chars().count() <= MAX_CUE_CHARS), "{out:?}");
        assert_eq!(out[0].start_ms, 0, "the first starts with the shot");
        assert_eq!(out[0].end_ms, out[1].start_ms, "and they meet, with no gap");
        assert_eq!(out[1].end_ms, 8_000 - TAIL_MS, "the last ends with the words");

        // Every word, in order, across the two.
        let rejoined = format!("{} {}", out[0].text, out[1].text);
        assert_eq!(rejoined, text);
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
