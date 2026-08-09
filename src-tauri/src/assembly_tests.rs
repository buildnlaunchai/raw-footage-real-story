//! End-to-end assembly tests against real ffmpeg.
//!
//! Placeholder clips are flat colours, which makes ordering and timing
//! machine-checkable: extract a frame at a given timeline offset and the colour
//! tells you which clip is on screen. Compression and limited-range YUV shift
//! the exact values, so a frame is classified by *nearest* palette entry rather
//! than by an exact match — robust to codec noise, still unambiguous because
//! the palette is widely separated.

#![cfg(test)]

use std::path::PathBuf;

use crate::ffmpeg::{self, FfmpegSettings, RenderItem, RenderSettings};
use crate::timeline::{self, ClipInput, Fit, LineInput};
use crate::tts;

/// Deliberately far apart in RGB space so codec noise cannot confuse them.
///
/// Hex rather than colour names: `color=c=green` is ffmpeg's *HTML* green
/// (0,128,0), not (0,255,0), so a named palette would declare one value and
/// produce another.
const PALETTE: &[(&str, &str, (u8, u8, u8))] = &[
    ("red", "0xFF0000", (255, 0, 0)),
    ("green", "0x00FF00", (0, 255, 0)),
    ("blue", "0x0000FF", (0, 0, 255)),
    ("yellow", "0xFFFF00", (255, 255, 0)),
];

fn nearest(rgb: (u8, u8, u8)) -> &'static str {
    PALETTE
        .iter()
        .min_by_key(|(_, _, p)| {
            let d = |a: u8, b: u8| (a as i64 - b as i64).pow(2);
            d(p.0, rgb.0) + d(p.1, rgb.1) + d(p.2, rgb.2)
        })
        .map(|(name, _, _)| *name)
        .unwrap()
}

struct Fixture {
    dir: PathBuf,
    ffmpeg: String,
    ffprobe: String,
}

impl Fixture {
    fn new(name: &str) -> Option<Self> {
        let info = ffmpeg::detect(&FfmpegSettings::default()).ok()?;
        let dir = std::env::temp_dir().join(format!("rfrs-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        Some(Self { dir, ffmpeg: info.ffmpeg, ffprobe: info.ffprobe })
    }
}

/// Four clips whose lengths are deliberately awkward relative to narration:
/// far too long, far too short, near-exact, and absent entirely.
#[test]
fn assembles_a_rough_cut_with_correct_order_and_timing() {
    let Some(fx) = Fixture::new("assembly") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    // Narration durations chosen to exercise every branch of the planner.
    let lines = [
        LineInput { clip_id: "c0".into(), duration_ms: 2_000 }, // vs 10s source -> Trimmed
        LineInput { clip_id: "c1".into(), duration_ms: 3_000 }, // vs 1s source  -> Held
        LineInput { clip_id: "c2".into(), duration_ms: 1_700 }, // vs 2s source  -> Exact
        LineInput { clip_id: "c3".into(), duration_ms: 2_500 }, // no source     -> placeholder
    ];
    let sources = [Some(10_000u64), Some(1_000), Some(2_000), None];
    let clips: Vec<ClipInput> = lines
        .iter()
        .zip(sources)
        .map(|(l, s)| ClipInput { clip_id: l.clip_id.clone(), source_duration_ms: s })
        .collect();

    let items = timeline::plan(&clips, &lines);
    assert_eq!(
        items.iter().map(|i| i.fit).collect::<Vec<_>>(),
        [Fit::Trimmed, Fit::Held, Fit::Exact, Fit::Exact],
        "planner should exercise every fit mode"
    );

    // Build media: a coloured card per clip, and narration-length silence.
    let settings = RenderSettings { width: 640, height: 360, fps: 30 };
    let mut render_items = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let (_, hex, _) = PALETTE[i];
        let video = fx.dir.join(format!("clip{i}.mp4"));
        // A real source is made at its own length; a missing one is generated
        // to order, exactly as the planner assumed.
        let make_ms = sources[i].unwrap_or(item.timeline_duration_ms);
        ffmpeg::make_placeholder(
            &fx.ffmpeg, &video, hex, make_ms, settings.width, settings.height, settings.fps,
        )
        .expect("placeholder");

        let audio = fx.dir.join(format!("line{i}.wav"));
        let samples = vec![0f32; (lines[i].duration_ms as usize * 24_000) / 1000];
        tts::write_wav(&audio, &samples).expect("silence wav");

        render_items.push(RenderItem { video, audio, item: item.clone() });
    }

    let out = fx.dir.join("rough-cut.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &settings, &out).expect("render");
    assert!(out.is_file(), "output file should exist");

    // --- duration -----------------------------------------------------------
    let expected_total = timeline::total_duration_ms(&items);
    let actual_total = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    let drift = (actual_total as i64 - expected_total as i64).abs();
    println!("\n  expected {expected_total}ms, got {actual_total}ms (drift {drift}ms)");
    assert!(drift <= 150, "timeline drifted {drift}ms from plan");

    // --- ordering: sample the middle of each slot ---------------------------
    println!("  slot colours:");
    for (i, item) in items.iter().enumerate() {
        let mid = item.timeline_start_ms + item.timeline_duration_ms / 2;
        let rgb = ffmpeg::frame_rgb(&fx.ffmpeg, &out, mid).expect("frame");
        let got = nearest(rgb);
        let want = PALETTE[i].0;
        println!(
            "    {mid:>5}ms  rgb{rgb:?} -> {got:<7} (want {want}, {:?})",
            item.fit
        );
        assert_eq!(got, want, "wrong clip on screen at {mid}ms");
    }

    // --- the held clip is still itself after its source ran out -------------
    let held = &items[1];
    let after_source = held.timeline_start_ms + held.source_out_ms + 500;
    let rgb = ffmpeg::frame_rgb(&fx.ffmpeg, &out, after_source).expect("frame");
    assert_eq!(
        nearest(rgb), PALETTE[1].0,
        "held clip should still show its own last frame at {after_source}ms, got rgb{rgb:?}"
    );
    println!("  held frame at {after_source}ms: rgb{rgb:?} -> {}", nearest(rgb));
}

#[test]
fn output_has_the_expected_streams_and_format() {
    let Some(fx) = Fixture::new("streams") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    let lines = [LineInput { clip_id: "c0".into(), duration_ms: 1_200 }];
    let clips = [ClipInput { clip_id: "c0".into(), source_duration_ms: None }];
    let items = timeline::plan(&clips, &lines);

    let settings = RenderSettings { width: 640, height: 360, fps: 30 };
    let video = fx.dir.join("c0.mp4");
    ffmpeg::make_placeholder(
        &fx.ffmpeg, &video, "0xFF0000", items[0].timeline_duration_ms,
        settings.width, settings.height, settings.fps,
    )
    .expect("placeholder");
    let audio = fx.dir.join("a0.wav");
    tts::write_wav(&audio, &vec![0f32; 1_200 * 24]).expect("wav");

    let out = fx.dir.join("out.mp4");
    ffmpeg::render_rough_cut(
        &fx.ffmpeg,
        &[RenderItem { video, audio, item: items[0].clone() }],
        &settings,
        &out,
    )
    .expect("render");

    let probe = std::process::Command::new(&fx.ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "stream=codec_name,pix_fmt,sample_rate,channels",
            "-of", "default=noprint_wrappers=1",
        ])
        .arg(&out)
        .output()
        .expect("ffprobe");
    let text = String::from_utf8_lossy(&probe.stdout);
    println!("\n{text}");

    // yuv420p is the one that actually bites: without it QuickTime and browsers
    // refuse the file even though it is valid H.264.
    for expected in ["codec_name=h264", "pix_fmt=yuv420p", "codec_name=aac", "sample_rate=48000", "channels=2"] {
        assert!(text.contains(expected), "missing {expected} in:\n{text}");
    }
}
