//! Deciding how long each clip stays on screen.
//!
//! Narration is the master clock. A clip is shown for exactly as long as its
//! narration line needs, and the video is trimmed or held to fit — never the
//! other way around.
//!
//! The reasoning is perceptual: a chopped or time-stretched *word* is noticed
//! instantly, a trimmed *shot* essentially never. Letting video drive timing
//! would mean stretching the voiceover, degrading the one track this product
//! exists to deliver.
//!
//! Everything here is pure. The output is stored verbatim in the project file
//! so the v2 timeline editor never has to re-derive it — if this algorithm ever
//! changes, previously exported projects must not silently move.

use serde::{Deserialize, Serialize};

/// Breathing room after each narration line, so cuts don't land on the final
/// syllable.
pub const TAIL_MS: u64 = 300;

/// Extra beat when a line finishes a thought.
///
/// A cut lands better when it respects how the sentence ended. A full stop is a
/// place to breathe; a comma or dash is mid-thought, and pausing there as long
/// makes the narration sound like it lost its place. This is why cuts felt
/// mechanical before: every line got the same 300ms regardless of whether
/// anything had actually concluded.
pub const SENTENCE_TAIL_MS: u64 = 520;

/// Mid-thought endings get less than a full stop, not more.
pub const CLAUSE_TAIL_MS: u64 = 180;

/// How long the narration audio may trail off in near-silence before we stop
/// counting it as speech. Kokoro often leaves a little room at the end, and
/// cutting on the file length rather than on the last word adds a pause nobody
/// asked for on top of the one we chose deliberately.
pub const TRAILING_SILENCE_GRACE_MS: u64 = 60;

/// The beat owed to a line, from how it ends.
pub fn tail_for(text: &str) -> u64 {
    match text.trim_end().chars().last() {
        Some('.') | Some('!') | Some('?') | Some('…') => SENTENCE_TAIL_MS,
        Some(',') | Some(';') | Some(':') | Some('—') | Some('-') => CLAUSE_TAIL_MS,
        // No terminal punctuation at all: treat as a soft ending.
        _ => TAIL_MS,
    }
}

/// A very short sentence should still leave its clip on screen long enough to
/// register as a shot rather than a flash.
pub const MIN_ON_SCREEN_MS: u64 = 1500;

/// Why an item is the length it is. Recorded so the v2 editor can offer a
/// meaningful "restore original clip length" rather than guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// Source was already the right length (or is generated to order).
    Exact,
    /// Source was longer than needed; the tail was discarded.
    Trimmed,
    /// Source was shorter than needed and has been slowed to fill the time.
    ///
    /// Replaces the old `Held`, which froze the last frame while the narration
    /// carried on. A still image under a talking voice reads as a broken video,
    /// and it happened wherever a line outran its footage. Slowing keeps the
    /// picture moving, which is the thing a viewer actually notices.
    Slowed,
    /// Slowed to the cap and then replayed, because even at `COMFORTABLE_STRETCH`
    /// the footage could not cover its line.
    ///
    /// The last resort, and one the script writer is meant to make unreachable
    /// by keeping each line inside what its clip can carry. It exists because a
    /// line edited by hand afterwards can still outrun its footage, and the
    /// renderer has to do *something* — and of the things it could do, showing
    /// the shot again is the only one that neither freezes the picture nor cuts
    /// a word of narration.
    Replayed,
}

impl Fit {
    /// How many times the trimmed source must play to fill its slot.
    ///
    /// One for everything that fits or is merely slowed. More only where the
    /// cap has bound, and then exactly enough — the graph trims the tail.
    pub fn plays(&self, slot_ms: u64, source_ms: u64, stretch: f64) -> u32 {
        if *self != Fit::Replayed || source_ms == 0 {
            return 1;
        }
        let each = source_ms as f64 * stretch;
        if each <= 0.0 {
            return 1;
        }
        (slot_ms as f64 / each).ceil().max(1.0) as u32
    }
}

/// The most a clip may ever be stretched. A hard limit, not a guideline.
///
/// Past roughly this, slow motion stops reading as pacing and starts reading
/// as a fault in the video. It used to be advisory — declared here, checked by
/// nothing — so a line with more words than its footage had seconds produced
/// footage at a fifth speed and the app called it `Slowed` and moved on.
///
/// Nothing downstream may exceed it. Where narration needs more time than
/// twice the footage can give, the answer is a shorter line, which is settled
/// while the script is being written; `MAX_STRETCH` is what makes that a
/// guarantee rather than an intention.
pub const COMFORTABLE_STRETCH: f64 = 2.0;

/// Identity of a described moment.
///
/// A clip id alone is not enough: one story may return to the same clip for two
/// different moments, and each needs its own source offset. Matching on the
/// pair is what keeps them independent.
#[derive(Debug, Clone)]
pub struct ClipInput {
    pub clip_id: String,
    pub segment_index: usize,
    /// None until video upload exists, or for generated placeholders.
    pub source_duration_ms: Option<u64>,
    /// Where in the source this item starts. Non-zero when a story uses one
    /// described segment out of a longer clip rather than the whole thing.
    pub source_start_ms: u64,
}

impl ClipInput {
    /// A whole clip: segment 0, starting at the beginning.
    pub fn whole(clip_id: impl Into<String>, source_duration_ms: Option<u64>) -> Self {
        Self {
            clip_id: clip_id.into(),
            segment_index: 0,
            source_duration_ms,
            source_start_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LineInput {
    pub clip_id: String,
    pub segment_index: usize,
    /// Length of the narration audio file.
    pub duration_ms: u64,
    /// Where the last word actually ends, if measured. Falls back to
    /// `duration_ms`, which is the old behaviour.
    pub speech_end_ms: Option<u64>,
    /// The line's text, so the cut can respect how the sentence ended.
    pub text: Option<String>,
}

impl LineInput {
    pub fn whole(clip_id: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            clip_id: clip_id.into(),
            segment_index: 0,
            duration_ms,
            speech_end_ms: None,
            text: None,
        }
    }

    /// Where narration effectively ends: the last word, not the end of a file
    /// that may trail off into room tone.
    fn effective_end_ms(&self) -> u64 {
        match self.speech_end_ms {
            Some(end) if end + TRAILING_SILENCE_GRACE_MS < self.duration_ms => {
                end + TRAILING_SILENCE_GRACE_MS
            }
            _ => self.duration_ms,
        }
    }

    fn tail_ms(&self) -> u64 {
        self.text.as_deref().map_or(TAIL_MS, tail_for)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub clip_id: String,
    /// Which described moment of that clip this item shows.
    #[serde(default)]
    pub segment_index: usize,
    /// Where in the source media this item starts.
    pub source_in_ms: u64,
    /// Where in the source media it stops. For `Held`, this is the full source
    /// length and the remainder is a frozen frame.
    pub source_out_ms: u64,
    pub timeline_start_ms: u64,
    pub timeline_duration_ms: u64,
    /// How much the source is slowed, as a multiplier on its duration.
    ///
    /// 1.0 for everything that fits. 1.4 means the footage plays at five
    /// sevenths of its speed to cover the narration.
    ///
    /// Defaulted, because projects saved before this existed carry `holdMs`
    /// and no `stretch`. Without a default they would fail to parse and every
    /// timeline already on disk would come back empty.
    #[serde(default = "unstretched")]
    pub stretch: f64,
    pub fit: Fit,
}

fn unstretched() -> f64 {
    1.0
}

/// How long a clip should stay on screen for a given narration length.
pub fn on_screen_ms(narration_ms: u64) -> u64 {
    (narration_ms + TAIL_MS).max(MIN_ON_SCREEN_MS)
}

/// As above, but respecting where speech actually ended and how it ended.
fn on_screen_for(line: &LineInput) -> u64 {
    (line.effective_end_ms() + line.tail_ms()).max(MIN_ON_SCREEN_MS)
}

/// Lay narration lines out in order, sizing each clip to its line.
///
/// Lines drive the result: a clip with no narration line is not shown, since
/// there would be nothing to say over it. Lines are matched to clips by id.
pub fn plan(clips: &[ClipInput], lines: &[LineInput]) -> Vec<TimelineItem> {
    let mut cursor = 0u64;
    let mut out = Vec::with_capacity(lines.len());

    for line in lines {
        let target = on_screen_for(line);
        // Match on the pair, not the clip alone: the same clip can appear
        // twice in one story at different moments.
        let matched = clips
            .iter()
            .find(|c| c.clip_id == line.clip_id && c.segment_index == line.segment_index);
        let start = matched.map_or(0, |c| c.source_start_ms);
        // How much material is available from the start point onward. A segment
        // late in a clip has less runway than the clip's full length suggests.
        let available = matched
            .and_then(|c| c.source_duration_ms)
            .map(|len| len.saturating_sub(start));

        let (source_in_ms, source_out_ms, stretch, fit) = match available {
            // No media yet: a placeholder is generated at exactly the length
            // required, so nothing needs trimming or holding.
            None => (start, start + target, 1.0, Fit::Exact),
            Some(len) if len > target => (start, start + target, 1.0, Fit::Trimmed),
            // Slowed rather than frozen. The clip plays from `start` to the end
            // of its footage, stretched to cover the narration — but never
            // past the cap. Beyond it the shot replays rather than crawling:
            // the picture keeps moving, the narration is never cut, and no
            // frame is ever held.
            Some(len) if len < target && len > 0 => {
                let wanted = target as f64 / len as f64;
                if wanted > COMFORTABLE_STRETCH {
                    (start, start + len, COMFORTABLE_STRETCH, Fit::Replayed)
                } else {
                    (start, start + len, wanted, Fit::Slowed)
                }
            }
            Some(len) => (start, start + len, 1.0, Fit::Exact),
        };

        out.push(TimelineItem {
            clip_id: line.clip_id.clone(),
            segment_index: line.segment_index,
            source_in_ms,
            source_out_ms,
            timeline_start_ms: cursor,
            timeline_duration_ms: target,
            stretch,
            fit,
        });
        cursor += target;
    }

    out
}

/// Total runtime of a planned timeline.
pub fn total_duration_ms(items: &[TimelineItem]) -> u64 {
    items.last().map_or(0, |i| i.timeline_start_ms + i.timeline_duration_ms)
}

/// Put the opening montage in front of a planned timeline.
///
/// The montage is one rendered file, so it enters as an ordinary item under a
/// reserved clip id rather than as a new kind of thing. The only arithmetic
/// that matters is the shift: the dissolve overlaps the montage and the first
/// line, so the film starts `fade_ms` *before* the montage ends, and every
/// following item moves by the difference. Shift by the full montage length and
/// the reported timeline drifts a fade further from the file with each render
/// anybody compares it to.
pub fn with_intro(items: &[TimelineItem], intro_ms: u64, fade_ms: u32) -> Vec<TimelineItem> {
    let shift = intro_ms.saturating_sub(fade_ms as u64);
    let mut out = Vec::with_capacity(items.len() + 1);
    out.push(TimelineItem {
        clip_id: INTRO_CLIP_ID.into(),
        segment_index: 0,
        source_in_ms: 0,
        source_out_ms: intro_ms,
        timeline_start_ms: 0,
        timeline_duration_ms: intro_ms,
        stretch: 1.0,
        fit: Fit::Exact,
    });
    out.extend(items.iter().cloned().map(|mut i| {
        i.timeline_start_ms += shift;
        i
    }));
    out
}

/// The clip id the opening montage occupies.
///
/// A reserved name rather than a new timeline concept: everything downstream —
/// the assembly list, the durations, the takes — needs no special case beyond
/// recognising it.
pub const INTRO_CLIP_ID: &str = "__intro__";

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(id: &str, dur: Option<u64>) -> ClipInput {
        ClipInput::whole(id, dur)
    }
    fn segment_of(id: &str, dur: Option<u64>, start_ms: u64) -> ClipInput {
        seg_at(id, 0, dur, start_ms)
    }
    fn seg_at(id: &str, idx: usize, dur: Option<u64>, start_ms: u64) -> ClipInput {
        ClipInput {
            clip_id: id.into(),
            segment_index: idx,
            source_duration_ms: dur,
            source_start_ms: start_ms,
        }
    }
    fn line(id: &str, dur: u64) -> LineInput {
        LineInput::whole(id, dur)
    }
    fn line_at(id: &str, idx: usize, dur: u64) -> LineInput {
        LineInput {
            clip_id: id.into(),
            segment_index: idx,
            duration_ms: dur,
            speech_end_ms: None,
            text: None,
        }
    }
    fn spoken(id: &str, dur: u64, speech_end: u64, text: &str) -> LineInput {
        LineInput {
            clip_id: id.into(),
            segment_index: 0,
            duration_ms: dur,
            speech_end_ms: Some(speech_end),
            text: Some(text.into()),
        }
    }

    #[test]
    fn clip_longer_than_narration_is_trimmed() {
        let items = plan(&[clip("a", Some(10_000))], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Trimmed);
        assert_eq!(items[0].timeline_duration_ms, 4_700); // 4400 + 300 tail
        assert_eq!(items[0].source_out_ms, 4_700, "tail of the clip discarded");
        assert_eq!(items[0].stretch, 1.0);
    }

    #[test]
    fn clip_shorter_than_narration_is_slowed_never_frozen() {
        // 2s of footage under 4.7s of narration. It used to freeze the last
        // frame for 2.7s, which reads as the video having broken; then it was
        // stretched 2.35x, which reads as the video being wrong.
        let items = plan(&[clip("a", Some(2_000))], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Replayed, "2.35x is past the cap");
        assert_eq!(items[0].timeline_duration_ms, 4_700, "the line is never cut");
        assert_eq!(items[0].source_out_ms, 2_000, "whole clip is used");
        assert_eq!(items[0].stretch, COMFORTABLE_STRETCH, "and stops exactly at the cap");
    }

    #[test]
    fn nothing_is_ever_stretched_past_the_cap() {
        // The guarantee the cap exists to give. It was declared and enforced
        // nowhere, so a line with far more words than its clip had seconds
        // produced footage at a fifth speed and the app called it fine.
        for source in [200u64, 500, 1_000, 2_000, 4_000, 9_000] {
            for narration in [1_000u64, 4_400, 20_000] {
                let items = plan(&[clip("a", Some(source))], &[line("a", narration)]);
                assert!(
                    items[0].stretch <= COMFORTABLE_STRETCH,
                    "{source}ms under {narration}ms stretched {}x",
                    items[0].stretch,
                );
            }
        }
    }

    #[test]
    fn a_gentle_shortfall_is_stretched_without_complaint() {
        // 4s under 4.7s: a 1.18x stretch, which just reads as pacing.
        let items = plan(&[clip("a", Some(4_000))], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Slowed);
        assert!(items[0].stretch < COMFORTABLE_STRETCH);
    }

    #[test]
    fn nothing_is_ever_frozen() {
        // The property the whole change exists for: whatever the shortfall,
        // the picture keeps moving for the whole slot. Slowing covers it up to
        // the cap; past that the shot replays, and `plays` says how often.
        for source in [500u64, 1_000, 2_000, 4_000, 9_000] {
            let it = &plan(&[clip("a", Some(source))], &[line("a", 4_400)])[0];
            let used = it.source_out_ms - it.source_in_ms;
            let covered =
                used as f64 * it.stretch * it.fit.plays(it.timeline_duration_ms, used, it.stretch) as f64;
            assert!(
                covered + 2.0 >= it.timeline_duration_ms as f64,
                "{source}ms of footage must cover the whole slot, covered {covered}",
            );
        }
    }

    #[test]
    fn missing_media_plans_an_exact_placeholder() {
        let items = plan(&[clip("a", None)], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Exact);
        assert_eq!(items[0].source_out_ms, 4_700);
        assert_eq!(items[0].stretch, 1.0);
    }

    #[test]
    fn very_short_narration_still_gets_a_minimum_on_screen_time() {
        // 200ms + 300ms tail = 500ms, well under the floor.
        let items = plan(&[clip("a", Some(10_000))], &[line("a", 200)]);
        assert_eq!(items[0].timeline_duration_ms, MIN_ON_SCREEN_MS);
        assert_eq!(items[0].fit, Fit::Trimmed);
    }

    #[test]
    fn items_are_contiguous_and_ordered() {
        let clips = [clip("a", Some(10_000)), clip("b", Some(1_000)), clip("c", None)];
        let lines = [line("a", 4_400), line("b", 3_000), line("c", 2_000)];
        let items = plan(&clips, &lines);

        assert_eq!(items.len(), 3);
        assert_eq!(items.iter().map(|i| i.clip_id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);

        // No gaps, no overlaps: each starts exactly where the previous ended.
        let mut expected = 0;
        for item in &items {
            assert_eq!(item.timeline_start_ms, expected, "gap or overlap at {}", item.clip_id);
            expected += item.timeline_duration_ms;
        }
        assert_eq!(total_duration_ms(&items), expected);
        assert_eq!(expected, 4_700 + 3_300 + 2_300);
    }

    #[test]
    fn clips_without_narration_are_not_shown() {
        // 'b' has media but nothing to say over it.
        let clips = [clip("a", Some(5_000)), clip("b", Some(5_000))];
        let items = plan(&clips, &[line("a", 2_000)]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].clip_id, "a");
    }

    #[test]
    fn line_order_wins_over_clip_order() {
        // The script decides sequence; clip array order is irrelevant.
        let clips = [clip("a", Some(9_000)), clip("b", Some(9_000))];
        let items = plan(&clips, &[line("b", 2_000), line("a", 2_000)]);
        assert_eq!(items.iter().map(|i| i.clip_id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn a_segment_starts_where_the_segment_starts() {
        // 60s clip, the story wants the moment beginning at 40s.
        let items = plan(&[segment_of("a", Some(60_000), 40_000)], &[line("a", 4_400)]);
        assert_eq!(items[0].source_in_ms, 40_000, "must start at the segment, not the clip");
        assert_eq!(items[0].source_out_ms, 44_700);
        assert_eq!(items[0].fit, Fit::Trimmed, "20s remain, only 4.7s needed");
        assert_eq!(items[0].timeline_start_ms, 0, "timeline position is unrelated to source position");
    }

    #[test]
    fn a_segment_near_the_end_is_slowed_rather_than_running_past_the_clip() {
        // Only 2s of footage left after the start point, but 4.7s is needed —
        // more than twice, so it caps and replays rather than reading on into
        // footage this moment does not own.
        let items = plan(&[segment_of("a", Some(60_000), 58_000)], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Replayed);
        assert_eq!(items[0].source_in_ms, 58_000);
        assert_eq!(items[0].source_out_ms, 60_000, "never reads past the end of the clip");
        assert_eq!(items[0].stretch, COMFORTABLE_STRETCH);
        assert_eq!(items[0].timeline_duration_ms, 4_700);
    }

    /// One story returning to the same clip for two different moments must get
    /// two independent offsets. Keying on the clip alone silently gave the
    /// second item the first one's start, showing the wrong footage under it.
    #[test]
    fn the_same_clip_can_appear_twice_at_different_moments() {
        let clips = [
            seg_at("a", 0, Some(60_000), 0),
            seg_at("a", 3, Some(60_000), 30_000),
            seg_at("b", 1, Some(20_000), 5_000),
        ];
        let lines = [
            line_at("a", 3, 2_000), // the later moment first: story order, not clip order
            line_at("b", 1, 2_000),
            line_at("a", 0, 2_000), // back to the same clip, earlier moment
        ];
        let items = plan(&clips, &lines);

        assert_eq!(items.len(), 3);
        assert_eq!(items[0].clip_id, "a");
        assert_eq!(items[0].segment_index, 3);
        assert_eq!(items[0].source_in_ms, 30_000, "second moment keeps its own offset");
        assert_eq!(items[1].source_in_ms, 5_000);
        assert_eq!(items[2].clip_id, "a");
        assert_eq!(items[2].segment_index, 0);
        assert_eq!(items[2].source_in_ms, 0, "first moment is unaffected by the other");

        // And they still tile the timeline without gaps.
        let mut expected = 0;
        for item in &items {
            assert_eq!(item.timeline_start_ms, expected);
            expected += item.timeline_duration_ms;
        }
    }

    /// A line whose segment has no matching clip entry must not silently borrow
    /// another segment's offset.
    #[test]
    fn an_unmatched_segment_does_not_borrow_another_offset() {
        let clips = [seg_at("a", 0, Some(60_000), 45_000)];
        let items = plan(&clips, &[line_at("a", 7, 2_000)]);
        assert_eq!(items[0].source_in_ms, 0, "no match means no offset, not the wrong one");
        assert_eq!(items[0].segment_index, 7, "the line's own identity is preserved");
    }

    #[test]
    fn a_finished_sentence_gets_a_longer_beat_than_a_clause() {
        let full = plan(&[clip("a", Some(60_000))], &[spoken("a", 4_000, 4_000, "We landed at dawn.")]);
        let mid = plan(&[clip("a", Some(60_000))], &[spoken("a", 4_000, 4_000, "We landed at dawn,")]);
        assert_eq!(full[0].timeline_duration_ms, 4_000 + SENTENCE_TAIL_MS);
        assert_eq!(mid[0].timeline_duration_ms, 4_000 + CLAUSE_TAIL_MS);
        assert!(
            full[0].timeline_duration_ms > mid[0].timeline_duration_ms,
            "a completed thought should get more room than a mid-sentence pause"
        );
    }

    #[test]
    fn trailing_silence_in_the_audio_does_not_become_an_extra_pause() {
        // 5s file, but the last word lands at 3.6s.
        let items = plan(
            &[clip("a", Some(60_000))],
            &[spoken("a", 5_000, 3_600, "The harbour was still.")],
        );
        // Cut from the last word plus grace, not from the end of the file.
        assert_eq!(
            items[0].timeline_duration_ms,
            3_600 + TRAILING_SILENCE_GRACE_MS + SENTENCE_TAIL_MS
        );
        assert!(
            items[0].timeline_duration_ms < 5_000 + SENTENCE_TAIL_MS,
            "measured speech end should shorten the slot, not lengthen it"
        );
    }

    #[test]
    fn a_file_with_no_trailing_silence_is_unchanged() {
        let items = plan(
            &[clip("a", Some(60_000))],
            &[spoken("a", 4_000, 3_990, "Done.")],
        );
        // Within the grace window, so the file length still governs.
        assert_eq!(items[0].timeline_duration_ms, 4_000 + SENTENCE_TAIL_MS);
    }

    #[test]
    fn lines_without_measurements_behave_exactly_as_before() {
        let items = plan(&[clip("a", Some(60_000))], &[line("a", 4_400)]);
        assert_eq!(items[0].timeline_duration_ms, 4_400 + TAIL_MS);
    }

    // --- the opening montage ---------------------------------------------

    #[test]
    fn the_opening_pushes_the_film_back_by_all_but_the_dissolve() {
        // The dissolve overlaps the montage and the first line, so the film
        // starts before the montage ends. Shifting by the full montage length
        // would report a timeline a fade longer than the file it describes.
        let body = plan(&[clip("a", Some(60_000)), clip("b", Some(60_000))],
                        &[line("a", 4_000), line("b", 3_000)]);
        let with = with_intro(&body, 3_000, 600);

        assert_eq!(with.len(), body.len() + 1);
        assert_eq!(with[0].clip_id, INTRO_CLIP_ID);
        assert_eq!(with[0].timeline_start_ms, 0);
        assert_eq!(with[0].timeline_duration_ms, 3_000);
        assert_eq!(with[1].timeline_start_ms, body[0].timeline_start_ms + 2_400);
        assert_eq!(with[2].timeline_start_ms, body[1].timeline_start_ms + 2_400);
        assert_eq!(
            total_duration_ms(&with),
            total_duration_ms(&body) + 2_400,
            "the film is longer by the montage less the overlap",
        );
    }

    #[test]
    fn the_opening_never_stretches_or_trims() {
        // It is rendered at exactly the hook's length, so any other fit would
        // be a claim about footage that no longer exists as separate clips.
        let body = plan(&[clip("a", Some(60_000))], &[line("a", 4_000)]);
        let with = with_intro(&body, 2_500, 600);
        assert_eq!(with[0].fit, Fit::Exact);
        assert_eq!(with[0].stretch, 1.0);
        assert_eq!(with[0].source_in_ms, 0);
        assert_eq!(with[0].source_out_ms, 2_500);
    }

    #[test]
    fn a_dissolve_longer_than_the_montage_cannot_move_the_film_backwards() {
        // The clamp should never let this happen, but a negative shift would
        // wrap a u64 and put the first line hours into the film.
        let body = plan(&[clip("a", Some(60_000))], &[line("a", 4_000)]);
        let with = with_intro(&body, 500, 5_000);
        assert_eq!(with[1].timeline_start_ms, body[0].timeline_start_ms);
    }

    #[test]
    fn the_body_keeps_its_own_shape() {
        // Only the start times move. A line slowed to cover its narration is
        // still slowed by the same amount once there is an opening in front.
        let body = plan(&[clip("a", Some(1_000))], &[line("a", 4_000)]);
        let with = with_intro(&body, 3_000, 600);
        assert_eq!(with[1].fit, body[0].fit);
        assert_eq!(with[1].stretch, body[0].stretch);
        assert_eq!(with[1].timeline_duration_ms, body[0].timeline_duration_ms);
        assert_eq!(with[1].clip_id, "a");
    }

    #[test]
    fn narration_is_never_shortened() {
        // Whatever the media length, the slot always fits the whole narration.
        for source in [Some(500), Some(3_000), Some(60_000), None] {
            let items = plan(&[clip("a", source)], &[line("a", 4_400)]);
            assert!(
                items[0].timeline_duration_ms >= 4_400,
                "narration would be cut off for source {source:?}"
            );
        }
    }
}
