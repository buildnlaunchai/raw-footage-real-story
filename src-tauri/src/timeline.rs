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
    /// Source was shorter than needed; its last frame is held.
    Held,
}

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
    pub duration_ms: u64,
}

impl LineInput {
    pub fn whole(clip_id: impl Into<String>, duration_ms: u64) -> Self {
        Self { clip_id: clip_id.into(), segment_index: 0, duration_ms }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// How long the final frame is held. Zero unless `fit` is `Held`.
    pub hold_ms: u64,
    pub fit: Fit,
}

/// How long a clip should stay on screen for a given narration length.
pub fn on_screen_ms(narration_ms: u64) -> u64 {
    (narration_ms + TAIL_MS).max(MIN_ON_SCREEN_MS)
}

/// Lay narration lines out in order, sizing each clip to its line.
///
/// Lines drive the result: a clip with no narration line is not shown, since
/// there would be nothing to say over it. Lines are matched to clips by id.
pub fn plan(clips: &[ClipInput], lines: &[LineInput]) -> Vec<TimelineItem> {
    let mut cursor = 0u64;
    let mut out = Vec::with_capacity(lines.len());

    for line in lines {
        let target = on_screen_ms(line.duration_ms);
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

        let (source_in_ms, source_out_ms, hold_ms, fit) = match available {
            // No media yet: a placeholder is generated at exactly the length
            // required, so nothing needs trimming or holding.
            None => (start, start + target, 0, Fit::Exact),
            Some(len) if len > target => (start, start + target, 0, Fit::Trimmed),
            Some(len) if len < target => (start, start + len, target - len, Fit::Held),
            Some(len) => (start, start + len, 0, Fit::Exact),
        };

        out.push(TimelineItem {
            clip_id: line.clip_id.clone(),
            segment_index: line.segment_index,
            source_in_ms,
            source_out_ms,
            timeline_start_ms: cursor,
            timeline_duration_ms: target,
            hold_ms,
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
        LineInput { clip_id: id.into(), segment_index: idx, duration_ms: dur }
    }

    #[test]
    fn clip_longer_than_narration_is_trimmed() {
        let items = plan(&[clip("a", Some(10_000))], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Trimmed);
        assert_eq!(items[0].timeline_duration_ms, 4_700); // 4400 + 300 tail
        assert_eq!(items[0].source_out_ms, 4_700, "tail of the clip discarded");
        assert_eq!(items[0].hold_ms, 0);
    }

    #[test]
    fn clip_shorter_than_narration_holds_last_frame() {
        let items = plan(&[clip("a", Some(2_000))], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Held);
        assert_eq!(items[0].timeline_duration_ms, 4_700);
        assert_eq!(items[0].source_out_ms, 2_000, "whole clip is used");
        assert_eq!(items[0].hold_ms, 2_700, "remainder is a frozen frame");
    }

    #[test]
    fn missing_media_plans_an_exact_placeholder() {
        let items = plan(&[clip("a", None)], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Exact);
        assert_eq!(items[0].source_out_ms, 4_700);
        assert_eq!(items[0].hold_ms, 0);
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
    fn a_segment_near_the_end_holds_rather_than_running_past_the_clip() {
        // Only 2s of footage left after the start point, but 4.7s is needed.
        let items = plan(&[segment_of("a", Some(60_000), 58_000)], &[line("a", 4_400)]);
        assert_eq!(items[0].fit, Fit::Held);
        assert_eq!(items[0].source_in_ms, 58_000);
        assert_eq!(items[0].source_out_ms, 60_000, "never reads past the end of the clip");
        assert_eq!(items[0].hold_ms, 2_700);
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
