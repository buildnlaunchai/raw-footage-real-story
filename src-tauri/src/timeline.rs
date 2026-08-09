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

#[derive(Debug, Clone)]
pub struct ClipInput {
    pub clip_id: String,
    /// None until video upload exists, or for generated placeholders.
    pub source_duration_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct LineInput {
    pub clip_id: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub clip_id: String,
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
        let source = clips
            .iter()
            .find(|c| c.clip_id == line.clip_id)
            .and_then(|c| c.source_duration_ms);

        let (source_in_ms, source_out_ms, hold_ms, fit) = match source {
            // No media yet: a placeholder is generated at exactly the length
            // required, so nothing needs trimming or holding.
            None => (0, target, 0, Fit::Exact),
            Some(len) if len > target => (0, target, 0, Fit::Trimmed),
            Some(len) if len < target => (0, len, target - len, Fit::Held),
            Some(len) => (0, len, 0, Fit::Exact),
        };

        out.push(TimelineItem {
            clip_id: line.clip_id.clone(),
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
        ClipInput { clip_id: id.into(), source_duration_ms: dur }
    }
    fn line(id: &str, dur: u64) -> LineInput {
        LineInput { clip_id: id.into(), duration_ms: dur }
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
