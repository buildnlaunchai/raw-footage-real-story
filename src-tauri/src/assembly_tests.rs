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
        LineInput::whole("c0", 2_000), // vs 10s source -> Trimmed
        LineInput::whole("c1", 3_000), // vs 1s source  -> capped and replayed
        LineInput::whole("c2", 1_700), // vs 2s source  -> Exact
        LineInput::whole("c3", 2_500), // no source     -> placeholder
    ];
    let sources = [Some(10_000u64), Some(1_000), Some(2_000), None];
    let clips: Vec<ClipInput> = lines
        .iter()
        .zip(sources)
        .map(|(l, s)| ClipInput::whole(l.clip_id.clone(), s))
        .collect();

    let items = timeline::plan(&clips, &lines);
    assert_eq!(
        items.iter().map(|i| i.fit).collect::<Vec<_>>(),
        [Fit::Trimmed, Fit::Replayed, Fit::Exact, Fit::Exact],
        "planner should exercise every fit mode"
    );

    // Build media: a coloured card per clip, and narration-length silence.
    let settings = RenderSettings { width: 640, height: 360, fps: 30, ..Default::default() };
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

        render_items.push(RenderItem { video, audio, item: item.clone(), is_hdr: false, has_audio: false });
    }

    let out = fx.dir.join("rough-cut.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &settings, &ffmpeg::FfmpegCaps::default(), &out)
        .expect("render");
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

/// Locks in the behaviour the render pipeline depends on: ffmpeg applies the
/// display matrix on decode, and that survives `filter_complex`.
///
/// If a future ffmpeg changes this, every portrait phone clip renders sideways
/// — silently. The test synthesises a landscape source, stamps a 90° display
/// matrix on it, and pushes it through the real filter chain. Correct handling
/// makes the content portrait, which our 16:9 letterbox turns into black
/// pillarbox bars; ignoring the rotation leaves the frame full-width red.
#[test]
fn rotation_survives_filter_complex() {
    let Some(fx) = Fixture::new("rotation") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    let src = fx.dir.join("landscape.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &src, "0xFF0000", 2_000, 640, 360, 30).expect("source");

    // Re-mux with a 90 degree display matrix, as a phone would record it.
    let rotated = fx.dir.join("portrait.mp4");
    let status = std::process::Command::new(&fx.ffmpeg)
        .args(["-y", "-v", "error", "-display_rotation", "90", "-i"])
        .arg(&src)
        .args(["-c", "copy"])
        .arg(&rotated)
        .status()
        .expect("remux");
    assert!(status.success(), "could not stamp rotation metadata");

    let info = ffmpeg::probe_media(&fx.ffprobe, &rotated).expect("probe");
    assert_eq!(info.rotation.abs(), 90, "rotation metadata should be readable");
    assert_eq!(
        info.display_size(),
        (360, 640),
        "display size should be portrait even though the coded frame is landscape"
    );

    let lines = [LineInput::whole("r", 1_000)];
    let clips = [ClipInput::whole("r", Some(2_000))];
    let items = timeline::plan(&clips, &lines);

    let audio = fx.dir.join("silence.wav");
    tts::write_wav(&audio, &vec![0f32; 1_000 * 24]).expect("wav");

    let out = fx.dir.join("rotated-out.mp4");
    let settings = RenderSettings { width: 1920, height: 1080, fps: 30, ..Default::default() };
    ffmpeg::render_rough_cut(
        &fx.ffmpeg,
        &[RenderItem { video: rotated, audio, item: items[0].clone(), is_hdr: false, has_audio: false }],
        &settings,
        &ffmpeg::FfmpegCaps::default(),
        &out,
    )
    .expect("render");

    // Sample well inside the left edge, where pillarbox bars would be.
    let edge = ffmpeg::frame_rgb_region(&fx.ffmpeg, &out, 700, 0, 0, 120, 1080).expect("edge");
    let centre = ffmpeg::frame_rgb_region(&fx.ffmpeg, &out, 700, 860, 0, 200, 1080).expect("mid");
    println!("\n  left edge rgb{edge:?}  centre rgb{centre:?}");

    let brightness = |c: (u8, u8, u8)| c.0 as u32 + c.1 as u32 + c.2 as u32;
    assert!(
        brightness(edge) < 40,
        "left edge should be pillarbox black (rotation applied), got rgb{edge:?}"
    );
    assert!(
        centre.0 > 150,
        "centre should hold the red source content, got rgb{centre:?}"
    );
}

/// Shell out for sources `make_placeholder` can't express — other containers,
/// other codecs, an audio track.
fn generate(ffmpeg: &str, out: &std::path::Path, args: &[&str]) {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(["-v", "error", "-y"]).args(args).arg(out);
    let status = cmd.status().expect("spawn ffmpeg");
    assert!(status.success(), "could not generate {}", out.display());
}

/// Heterogeneous real-world-ish footage, validated and then assembled together.
///
/// The point is the mixture: different containers, codecs, resolutions, aspect
/// ratios and frame rates in a single render. Normalisation either holds for
/// all of them or the rough cut is broken in a way one uniform source would
/// never reveal.
#[test]
fn handles_awkward_sources_and_normalises_them() {
    let Some(fx) = Fixture::new("awkward") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let caps = ffmpeg::FfmpegCaps { zscale: true, tonemap: true, subtitles: true };

    struct Case {
        name: &'static str,
        file: &'static str,
        args: Vec<&'static str>,
        expect_warning: Option<&'static str>,
    }

    let cases = vec![
        Case {
            name: "4K 60fps",
            file: "4k60.mp4",
            args: vec!["-f", "lavfi", "-i", "color=0x2244AA:s=3840x2160:r=60:d=2",
                       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "2"],
            expect_warning: Some("large"),
        },
        Case {
            name: "silent 720p",
            file: "noaudio.mp4",
            args: vec!["-f", "lavfi", "-i", "color=0x44AA22:s=1280x720:r=30:d=2",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "2"],
            expect_warning: Some("No audio"),
        },
        Case {
            name: "720p with audio",
            file: "withaudio.mp4",
            args: vec!["-f", "lavfi", "-i", "color=0xAA4422:s=1280x720:r=30:d=2",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2"],
            expect_warning: None,
        },
        Case {
            name: "AVI / mpeg4 / 4:3",
            file: "old.avi",
            args: vec!["-f", "lavfi", "-i", "color=0xAA22AA:s=640x480:r=25:d=2",
                       "-c:v", "mpeg4", "-vtag", "DIVX", "-t", "2"],
            expect_warning: None,
        },
        Case {
            name: "Matroska",
            file: "clip.mkv",
            args: vec!["-f", "lavfi", "-i", "color=0x22AAAA:s=1920x1080:r=30:d=2",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "2"],
            expect_warning: None,
        },
        Case {
            name: "native portrait",
            file: "portrait.mp4",
            args: vec!["-f", "lavfi", "-i", "color=0xAAAA22:s=1080x1920:r=30:d=2",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "2"],
            expect_warning: None,
        },
        Case {
            name: "120fps",
            file: "highfps.mp4",
            args: vec!["-f", "lavfi", "-i", "color=0xFF00FF:s=1280x720:r=120:d=2",
                       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "2"],
            expect_warning: Some("fps"),
        },
    ];

    println!("\n  validation:");
    let mut sources = Vec::new();
    for case in &cases {
        let path = fx.dir.join(case.file);
        generate(&fx.ffmpeg, &path, &case.args);

        let check = ffmpeg::check_media(&fx.ffprobe, &path, &caps);
        let info = check.info.clone().expect("probe should succeed");
        println!(
            "    {:<18} {}x{} {} {:.0}fps audio={} -> {:?} {:?}",
            case.name, info.width, info.height, info.codec, info.fps,
            info.has_audio, check.verdict, check.reasons
        );

        assert_ne!(
            check.verdict, ffmpeg::MediaVerdict::Rejected,
            "{} should be usable", case.name
        );
        if let Some(fragment) = case.expect_warning {
            assert!(
                check.reasons.iter().any(|r| r.contains(fragment)),
                "{} should warn about {fragment:?}, got {:?}", case.name, check.reasons
            );
        }
        sources.push((path, info));
    }

    // Audio detection must actually discriminate, not just always say false.
    let with_audio = &sources[2].1;
    let without_audio = &sources[1].1;
    assert!(with_audio.has_audio, "sine source should report an audio track");
    assert!(!without_audio.has_audio, "silent source should report none");

    // --- assemble every one of them into a single cut -----------------------
    let lines: Vec<LineInput> = sources
        .iter()
        .enumerate()
        .map(|(i, _)| LineInput::whole(format!("c{i}"), 1_200 + (i as u64 * 200)))
        .collect();
    let clips: Vec<ClipInput> = sources
        .iter()
        .enumerate()
        .map(|(i, (_, info))| ClipInput::whole(format!("c{i}"), Some(info.duration_ms)))
        .collect();

    let items = timeline::plan(&clips, &lines);
    let settings = RenderSettings { width: 1920, height: 1080, fps: 30, ..Default::default() };

    let mut render_items = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let audio = fx.dir.join(format!("a{i}.wav"));
        tts::write_wav(&audio, &vec![0f32; (lines[i].duration_ms as usize * 24_000) / 1000])
            .expect("wav");
        render_items.push(RenderItem {
            video: sources[i].0.clone(),
            audio,
            item: item.clone(),
            is_hdr: false,
            has_audio: false,
        });
    }

    let out = fx.dir.join("mixed.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &settings, &caps, &out)
        .expect("mixed-source render should succeed");

    let expected = timeline::total_duration_ms(&items);
    let actual = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    let drift = (actual as i64 - expected as i64).abs();
    println!("\n  assembled {} sources: expected {expected}ms, got {actual}ms (drift {drift}ms)",
             sources.len());
    assert!(drift <= 200, "timeline drifted {drift}ms across mixed sources");

    // Everything must land in one normalised format regardless of what went in.
    let final_info = ffmpeg::probe_media(&fx.ffprobe, &out).expect("probe output");
    assert_eq!((final_info.width, final_info.height), (1920, 1080));
    assert_eq!(final_info.codec, "h264");
    assert!(final_info.has_audio, "narration track must be present");
    assert!((final_info.fps - 30.0).abs() < 0.5, "fps {}", final_info.fps);

    // The 4:3 and portrait sources must be padded, never cropped: a letterboxed
    // frame has black at the edge where a cropped one would still show content.
    for (idx, label) in [(3usize, "4:3 AVI"), (5, "portrait")] {
        let mid = items[idx].timeline_start_ms + items[idx].timeline_duration_ms / 2;
        let edge = ffmpeg::frame_rgb_region(&fx.ffmpeg, &out, mid, 0, 0, 60, 1080).expect("edge");
        let centre = ffmpeg::frame_rgb_region(&fx.ffmpeg, &out, mid, 900, 440, 120, 200)
            .expect("centre");
        let bright = |c: (u8, u8, u8)| c.0 as u32 + c.1 as u32 + c.2 as u32;
        println!("    {label}: edge rgb{edge:?} centre rgb{centre:?}");
        assert!(bright(edge) < 40, "{label} should be pillarboxed, edge rgb{edge:?}");
        assert!(bright(centre) > 60, "{label} centre should hold picture, rgb{centre:?}");
    }
}

/// Automatic discovery should not settle for a build that cannot tone-map HDR
/// when a capable one is installed.
///
/// Skips unless the machine actually has both kinds, since that is the only
/// state where the preference is observable.
#[test]
fn auto_detection_prefers_a_zscale_capable_build() {
    let Ok(auto) = ffmpeg::detect(&FfmpegSettings::default()) else {
        eprintln!("no ffmpeg available; skipping");
        return;
    };

    // Is there a capable build anywhere? Check the ffmpeg-full locations that
    // are keg-only and therefore never on PATH.
    let capable_exists = [
        "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
        "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
    ]
    .iter()
    .any(|p| std::path::Path::new(p).is_file());

    println!("\n  auto-detected: {} (zscale={})", auto.ffmpeg, auto.caps.zscale);
    if !capable_exists {
        eprintln!("  no zscale-capable build installed; preference not observable, skipping");
        return;
    }
    assert!(
        auto.caps.zscale,
        "a zscale-capable ffmpeg is installed but detection chose {} without it",
        auto.ffmpeg
    );
}

/// An explicit choice is used as-is. Substituting a different binary than the
/// one a user named would be worse than the limitation it works around.
#[test]
fn explicit_choice_is_never_overridden_by_a_more_capable_build() {
    // Find a build WITHOUT zscale to name explicitly.
    let limited = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
        .iter()
        .map(std::path::Path::new)
        .find(|p| {
            p.is_file()
                && std::process::Command::new(p)
                    .arg("-filters")
                    .output()
                    .map(|o| !String::from_utf8_lossy(&o.stdout).contains(" zscale "))
                    .unwrap_or(false)
        });
    let Some(limited) = limited else {
        eprintln!("no zscale-less ffmpeg to pin; skipping");
        return;
    };

    let settings = FfmpegSettings {
        ffmpeg_path: Some(limited.to_string_lossy().to_string()),
        ffprobe_path: None,
    };
    let info = ffmpeg::detect(&settings).expect("detect with explicit path");
    println!(
        "\n  asked for : {}\n  got       : {} (zscale={})",
        limited.display(), info.ffmpeg, info.caps.zscale
    );

    assert_eq!(
        info.ffmpeg,
        limited.to_string_lossy(),
        "explicit choice must be honoured verbatim"
    );
    // ...and the limitation surfaces through caps rather than being papered over.
    assert!(!info.caps.zscale, "the limitation should still be reported");

    // ffprobe must come from the same install, not a different one.
    let same_dir = std::path::Path::new(&info.ffprobe).parent() == limited.parent();
    assert!(same_dir, "ffprobe {} should sit beside the chosen ffmpeg", info.ffprobe);
}

/// The same clip, used twice at different moments, must show different footage.
///
/// Planning-level tests can only prove the numbers differ. This builds a clip
/// whose first half is red and second half is blue, asks for both halves in one
/// story, and reads the rendered frames back — so a regression that quietly
/// reused one offset for both would show the same colour twice and fail.
#[test]
fn one_clip_used_twice_shows_two_different_moments() {
    let Some(fx) = Fixture::new("twice") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    // A six second clip: red for the first three, blue for the last three.
    let red = fx.dir.join("red.mp4");
    let blue = fx.dir.join("blue.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &red, "0xFF0000", 3_000, 640, 360, 30).expect("red");
    ffmpeg::make_placeholder(&fx.ffmpeg, &blue, "0x0000FF", 3_000, 640, 360, 30).expect("blue");
    let list = fx.dir.join("list.txt");
    std::fs::write(
        &list,
        format!("file '{}'\nfile '{}'\n", red.display(), blue.display()),
    )
    .unwrap();
    let source = fx.dir.join("two-halves.mp4");
    let status = std::process::Command::new(&fx.ffmpeg)
        .args(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy"])
        .arg(&source)
        .status()
        .expect("concat");
    assert!(status.success(), "could not build the two-halves clip");

    // Story order: the blue moment first, then the red one.
    let clips = [
        ClipInput { clip_id: "a".into(), segment_index: 1, source_duration_ms: Some(6_000), source_start_ms: 3_200 },
        ClipInput { clip_id: "a".into(), segment_index: 0, source_duration_ms: Some(6_000), source_start_ms: 0 },
    ];
    let lines = [
        LineInput { clip_id: "a".into(), segment_index: 1, duration_ms: 1_200,
                    speech_end_ms: None, text: None },
        LineInput { clip_id: "a".into(), segment_index: 0, duration_ms: 1_200,
                    speech_end_ms: None, text: None },
    ];
    let items = timeline::plan(&clips, &lines);
    assert_eq!(items[0].source_in_ms, 3_200, "blue moment keeps its own offset");
    assert_eq!(items[1].source_in_ms, 0, "red moment is unaffected");

    let settings = RenderSettings { width: 640, height: 360, fps: 30, ..Default::default() };
    let mut render_items = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let audio = fx.dir.join(format!("a{i}.wav"));
        tts::write_wav(&audio, &vec![0f32; 1_200 * 24]).expect("wav");
        render_items.push(RenderItem {
            video: source.clone(),
            audio,
            item: item.clone(),
            is_hdr: false,
            has_audio: false,
        });
    }

    let out = fx.dir.join("twice.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &settings, &ffmpeg::FfmpegCaps::default(), &out)
        .expect("render");

    let first = ffmpeg::frame_rgb(
        &fx.ffmpeg, &out, items[0].timeline_start_ms + items[0].timeline_duration_ms / 2,
    ).expect("frame 1");
    let second = ffmpeg::frame_rgb(
        &fx.ffmpeg, &out, items[1].timeline_start_ms + items[1].timeline_duration_ms / 2,
    ).expect("frame 2");
    println!("\n  item 1 (segment 1, from 3.2s): rgb{first:?} -> {}", nearest(first));
    println!("  item 2 (segment 0, from 0.0s): rgb{second:?} -> {}", nearest(second));

    assert_eq!(nearest(first), "blue", "first item should show the clip's later half");
    assert_eq!(nearest(second), "red", "second item should show the clip's earlier half");
    assert_ne!(nearest(first), nearest(second), "the two moments must differ");
}

#[test]
fn probe_reads_real_media_properties() {
    let Some(fx) = Fixture::new("probe") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let src = fx.dir.join("probe.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &src, "0x123456", 2_500, 1280, 720, 30).expect("source");

    let info = ffmpeg::probe_media(&fx.ffprobe, &src).expect("probe");
    println!("\n  {info:?}");
    assert_eq!((info.width, info.height), (1280, 720));
    assert_eq!(info.codec, "h264");
    assert!((info.fps - 30.0).abs() < 0.5, "fps {}", info.fps);
    assert!(info.duration_ms.abs_diff(2_500) < 150, "duration {}", info.duration_ms);
    assert!(!info.has_audio, "placeholder has no audio track");
    assert!(!info.is_hdr);
    assert_eq!(info.rotation, 0);
}

#[test]
fn validation_accepts_reports_and_rejects_explicitly() {
    let Some(fx) = Fixture::new("validate") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let caps = ffmpeg::FfmpegCaps { zscale: true, tonemap: true, subtitles: true };

    // A silent clip is usable, but the user should be told it is silent.
    let ok = fx.dir.join("ok.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &ok, "0x00AA55", 1_500, 640, 360, 30).expect("source");
    let check = ffmpeg::check_media(&fx.ffprobe, &ok, &caps);
    println!("\n  video-only: {:?} {:?}", check.verdict, check.reasons);
    assert_eq!(check.verdict, ffmpeg::MediaVerdict::Warning);
    assert!(check.reasons.iter().any(|r| r.contains("No audio")));

    // An audio-only file must be rejected with a reason, never silently ignored.
    let wav = fx.dir.join("audio-only.wav");
    tts::write_wav(&wav, &vec![0f32; 24_000]).expect("wav");
    let check = ffmpeg::check_media(&fx.ffprobe, &wav, &caps);
    println!("  audio-only: {:?} {:?}", check.verdict, check.reasons);
    assert_eq!(check.verdict, ffmpeg::MediaVerdict::Rejected);
    assert!(!check.reasons.is_empty(), "a rejection must always say why");

    // Garbage must fail cleanly rather than panic or hang.
    let junk = fx.dir.join("junk.mp4");
    std::fs::write(&junk, b"this is not a video").unwrap();
    let check = ffmpeg::check_media(&fx.ffprobe, &junk, &caps);
    println!("  corrupt:    {:?} {:?}", check.verdict, check.reasons);
    assert_eq!(check.verdict, ffmpeg::MediaVerdict::Rejected);
    assert!(!check.reasons.is_empty());
}

#[test]
fn thumbnails_are_written_from_ten_percent_in() {
    let Some(fx) = Fixture::new("thumb") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let src = fx.dir.join("clip.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &src, "0xFF8800", 3_000, 1280, 720, 30).expect("source");

    let thumb = fx.dir.join("thumbs/clip.jpg");
    ffmpeg::make_thumbnail(&fx.ffmpeg, &src, &thumb, 3_000, 320).expect("thumbnail");
    assert!(thumb.is_file(), "thumbnail should exist");

    let info = ffmpeg::probe_media(&fx.ffprobe, &thumb).expect("probe thumb");
    println!("\n  thumbnail {}x{}", info.width, info.height);
    assert_eq!(info.width, 320, "thumbnail should be scaled to the requested width");
    assert!(std::fs::metadata(&thumb).unwrap().len() > 0);
}

#[test]
fn output_has_the_expected_streams_and_format() {
    let Some(fx) = Fixture::new("streams") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    let lines = [LineInput::whole("c0", 1_200)];
    let clips = [ClipInput::whole("c0", None)];
    let items = timeline::plan(&clips, &lines);

    let settings = RenderSettings { width: 640, height: 360, fps: 30, ..Default::default() };
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
        &[RenderItem { video, audio, item: items[0].clone(), is_hdr: false, has_audio: false }],
        &settings,
        &ffmpeg::FfmpegCaps::default(),
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

/// Crossfade must dissolve between clips without losing time or picture.
#[test]
fn crossfade_shortens_the_cut_and_still_shows_every_clip() {
    let Some(fx) = Fixture::new("xfade") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    let lines: Vec<LineInput> = (0..3)
        .map(|i| LineInput::whole(format!("c{i}"), 1_800))
        .collect();
    let clips: Vec<ClipInput> = (0..3)
        .map(|i| ClipInput::whole(format!("c{i}"), Some(4_000)))
        .collect();
    let items = timeline::plan(&clips, &lines);

    let mut render_items = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let video = fx.dir.join(format!("c{i}.mp4"));
        ffmpeg::make_placeholder(&fx.ffmpeg, &video, PALETTE[i].1, 4_000, 640, 360, 30)
            .expect("placeholder");
        let audio = fx.dir.join(format!("a{i}.wav"));
        tts::write_wav(&audio, &vec![0f32; 1_800 * 24]).expect("wav");
        render_items.push(RenderItem { video, audio, item: item.clone(), is_hdr: false, has_audio: false });
    }

    let plain = timeline::total_duration_ms(&items);
    let fade_ms = 400u32;

    let hard = fx.dir.join("hard.mp4");
    ffmpeg::render_rough_cut(
        &fx.ffmpeg, &render_items,
        &RenderSettings { width: 640, height: 360, fps: 30, ..Default::default() },
        &ffmpeg::FfmpegCaps::default(), &hard,
    ).expect("hard cuts");

    let faded = fx.dir.join("faded.mp4");
    ffmpeg::render_rough_cut(
        &fx.ffmpeg, &render_items,
        &RenderSettings {
            width: 640, height: 360, fps: 30, crossfade_ms: fade_ms, ..Default::default()
        },
        &ffmpeg::FfmpegCaps::default(), &faded,
    ).expect("crossfade");

    let hard_ms = ffmpeg::probe_duration_ms(&fx.ffprobe, &hard).expect("probe hard");
    let fade_dur = ffmpeg::probe_duration_ms(&fx.ffprobe, &faded).expect("probe faded");
    // Each dissolve overlaps two clips, so the film loses one fade per join.
    let expected = plain - (items.len() as u64 - 1) * fade_ms as u64;
    println!("\n  hard cuts {hard_ms}ms · crossfaded {fade_dur}ms · expected ~{expected}ms");
    assert!(
        (fade_dur as i64 - expected as i64).abs() <= 200,
        "crossfaded film should be shorter by one fade per join"
    );
    assert!(fade_dur < hard_ms, "crossfade must shorten, not lengthen");

    // Every clip must still resolve to itself somewhere, not be permanently
    // half-dissolved into its neighbour.
    for (i, _) in items.iter().enumerate() {
        let centre = expected * (2 * i as u64 + 1) / (2 * items.len() as u64);
        let rgb = ffmpeg::frame_rgb(&fx.ffmpeg, &faded, centre).expect("frame");
        println!("    {centre:>5}ms rgb{rgb:?} -> {}", nearest(rgb));
        assert_eq!(nearest(rgb), PALETTE[i].0, "clip {i} should be itself mid-slot");
    }
}

/// A dissolve longer than the shot would leave nothing un-faded.
#[test]
fn crossfade_is_capped_so_short_clips_still_resolve() {
    let items: Vec<RenderItem> = (0..3)
        .map(|i| RenderItem {
            video: PathBuf::from("/dev/null"),
            audio: PathBuf::from("/dev/null"),
            item: crate::timeline::TimelineItem {
                clip_id: format!("c{i}"),
                segment_index: 0,
                source_in_ms: 0,
                source_out_ms: 1_500,
                timeline_start_ms: i as u64 * 1_500,
                timeline_duration_ms: 1_500,
                stretch: 1.0,
                fit: Fit::Exact,
            },
            is_hdr: false,
            has_audio: false,
        })
        .collect();

    // Asking for 3s of dissolve on 1.5s shots is clamped to a third of a shot.
    assert_eq!(ffmpeg::clamp_crossfade(3_000, &items), 500);
    assert_eq!(ffmpeg::clamp_crossfade(400, &items), 400, "a sane request passes through");
    assert_eq!(ffmpeg::clamp_crossfade(0, &items), 0, "zero stays hard cuts");
    assert_eq!(ffmpeg::clamp_crossfade(500, &items[..1]), 0, "one clip has no joins");
}

/// Music must sit under the narration, not replace or outlast it.
#[test]
fn music_bed_is_mixed_under_the_narration() {
    let Some(fx) = Fixture::new("music") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    // A short bed, deliberately shorter than the film so looping is exercised.
    let music = fx.dir.join("bed.wav");
    let status = std::process::Command::new(&fx.ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1.5",
               "-c:a", "pcm_s16le"])
        .arg(&music)
        .status()
        .expect("bed");
    assert!(status.success());

    let lines = [LineInput::whole("c0", 2_000), LineInput::whole("c1", 2_000)];
    let clips = [ClipInput::whole("c0", Some(4_000)), ClipInput::whole("c1", Some(4_000))];
    let items = timeline::plan(&clips, &lines);

    let mut render_items = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let video = fx.dir.join(format!("c{i}.mp4"));
        ffmpeg::make_placeholder(&fx.ffmpeg, &video, PALETTE[i].1, 4_000, 640, 360, 30)
            .expect("placeholder");
        // Silent narration: anything audible in the output must be the bed.
        let audio = fx.dir.join(format!("a{i}.wav"));
        tts::write_wav(&audio, &vec![0f32; 2_000 * 24]).expect("wav");
        render_items.push(RenderItem { video, audio, item: item.clone(), is_hdr: false, has_audio: false });
    }

    let out = fx.dir.join("with-music.mp4");
    ffmpeg::render_rough_cut(
        &fx.ffmpeg, &render_items,
        &RenderSettings {
            width: 640, height: 360, fps: 30,
            music_path: Some(music.to_string_lossy().into()),
            music_gain: 0.10,
            ..Default::default()
        },
        &ffmpeg::FfmpegCaps::default(), &out,
    ).expect("render with music");

    let expected = timeline::total_duration_ms(&items);
    let actual = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    println!("\n  film {actual}ms (expected {expected}ms), bed was only 1500ms");
    assert!(
        (actual as i64 - expected as i64).abs() <= 250,
        "a looping bed must not extend the film past the narration"
    );

    // The bed should be audible but quiet.
    let probe = std::process::Command::new(&fx.ffmpeg)
        .args(["-v", "info", "-i"])
        .arg(&out)
        .args(["-af", "volumedetect", "-f", "null", "-"])
        .output()
        .expect("volumedetect");
    let text = String::from_utf8_lossy(&probe.stderr);
    let mean = text
        .lines()
        .find(|l| l.contains("mean_volume"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().trim_end_matches(" dB").parse::<f32>().ok())
        .expect("mean volume");
    println!("  mean volume {mean:.1} dB");
    assert!(mean > -70.0, "the bed should be audible, got {mean} dB");
    assert!(mean < -20.0, "the bed should sit low under the voice, got {mean} dB");
}

/// The opening montage, rendered for real and inspected frame by frame.
///
/// Duration alone would pass for a hard cut, and "it did not crash" would pass
/// for a black screen. So this checks three separate things: that each shot
/// actually appears in order, that the montage is exactly as long as the hook
/// narration, and — at the join into the first narrated line — that the picture
/// is a *blend* of two colours rather than either one of them.
#[test]
fn intro_montage_cuts_hard_inside_and_dissolves_into_the_film() {
    let Some(fx) = Fixture::new("intro") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    let settings = RenderSettings { width: 320, height: 180, fps: 30, ..Default::default() };

    // Three montage shots, each a flat colour, plus the clip the film opens on.
    let mut shots = Vec::new();
    for i in 0..3 {
        let (_, hex, _) = PALETTE[i];
        let src = fx.dir.join(format!("shot{i}.mp4"));
        ffmpeg::make_placeholder(&fx.ffmpeg, &src, hex, 4_000, 320, 180, 30).expect("shot");
        shots.push(ffmpeg::IntroShot {
            source_path: src.to_string_lossy().to_string(),
            source_in_ms: 500,
            duration_ms: 1_000,
            is_hdr: false,
        });
    }

    // 3s of hook narration over three 1s shots.
    let hook = fx.dir.join("hook.wav");
    tts::write_wav(&hook, &vec![0f32; 3 * 24_000]).expect("hook wav");

    let intro = fx.dir.join("intro.mp4");
    let intro_ms =
        ffmpeg::render_intro(&fx.ffmpeg, &shots, &hook, &settings, &ffmpeg::FfmpegCaps::default(), &intro)
            .expect("intro renders");
    assert_eq!(intro_ms, 3_000, "the montage is as long as the hook");

    let probed = ffmpeg::probe_duration_ms(&fx.ffprobe, &intro).expect("probe intro");
    assert!(
        probed.abs_diff(3_000) < 150,
        "intro should be 3s, measured {probed}ms",
    );

    // Each shot in order, sampled mid-shot so a boundary cannot be mistaken
    // for the shot itself.
    for (i, at) in [500u64, 1_500, 2_500].iter().enumerate() {
        let rgb = ffmpeg::frame_rgb(&fx.ffmpeg, &intro, *at).expect("frame");
        assert_eq!(
            nearest(rgb),
            PALETTE[i].0,
            "at {at}ms the montage should show {}, saw {rgb:?}",
            PALETTE[i].0,
        );
    }

    // --- and now the join into the film -----------------------------------
    let body = fx.dir.join("body.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &body, PALETTE[3].1, 4_000, 320, 180, 30).expect("body");
    let silence = fx.dir.join("line.wav");
    tts::write_wav(&silence, &vec![0f32; 2 * 24_000]).expect("line wav");

    let items = vec![
        ffmpeg::RenderItem {
            video: intro.clone(),
            audio: hook.clone(),
            item: timeline::TimelineItem {
                clip_id: "intro".into(),
                segment_index: 0,
                source_in_ms: 0,
                source_out_ms: 3_000,
                timeline_start_ms: 0,
                timeline_duration_ms: 3_000,
                stretch: 1.0,
                fit: timeline::Fit::Exact,
            },
            is_hdr: false,
                    has_audio: false,
                },
        ffmpeg::RenderItem {
            video: body.clone(),
            audio: silence.clone(),
            item: timeline::TimelineItem {
                clip_id: "c0".into(),
                segment_index: 0,
                source_in_ms: 0,
                source_out_ms: 2_000,
                timeline_start_ms: 3_000,
                timeline_duration_ms: 2_000,
                stretch: 1.0,
                fit: timeline::Fit::Exact,
            },
            is_hdr: false,
                    has_audio: false,
                },
    ];

    // Hard cuts everywhere, dissolve only out of the intro: the shape the
    // spike proved composes once `settb` matches the timebases.
    let with_intro = RenderSettings { intro_fade_ms: 600, ..settings.clone() };
    let out = fx.dir.join("full.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &items, &with_intro, &ffmpeg::FfmpegCaps::default(), &out)
        .expect("full render");

    // 3s + 2s minus the 0.6s the dissolve consumes.
    let total = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe full");
    assert!(
        total.abs_diff(4_400) < 200,
        "intro + body less the overlap should be 4.4s, measured {total}ms",
    );

    // The proof that it is a dissolve and not a cut: mid-transition the frame
    // is neither colour. The montage ends blue, the film opens yellow.
    let before = ffmpeg::frame_rgb(&fx.ffmpeg, &out, 2_200).expect("before");
    let middle = ffmpeg::frame_rgb(&fx.ffmpeg, &out, 2_700).expect("middle");
    let after = ffmpeg::frame_rgb(&fx.ffmpeg, &out, 3_600).expect("after");
    println!("\n  before {before:?}  middle {middle:?}  after {after:?}");

    assert_eq!(nearest(before), "blue", "last montage shot");
    assert_eq!(nearest(after), "yellow", "first shot of the film");
    assert!(
        middle.0 > 30 && middle.2 > 30,
        "mid-dissolve should carry both colours, saw {middle:?}",
    );
    assert_ne!(nearest(middle), nearest(before), "a cut would still be blue here");
}

/// The opening keeps its own dissolve when the rest of the film also dissolves.
///
/// `intro_fade_ms` is a separate setting because the opening's dissolve is part
/// of the opening, not a style choice. In the pairwise crossfade path it would
/// be easy — and invisible — for boundary zero to quietly take the body's
/// setting instead. Duration is the observable: each dissolve eats its own
/// length out of the total, so a wrong fade at one boundary shows up as a film
/// of the wrong length.
#[test]
fn the_opening_dissolve_is_not_the_body_crossfade() {
    let Some(fx) = Fixture::new("intro-fades") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let base = RenderSettings { width: 320, height: 180, fps: 30, ..Default::default() };

    // 3s intro, then two 2s items. Fades: 600ms out of the intro, 200ms between
    // the body's own shots.
    let mut items = Vec::new();
    for (i, (dur, name)) in [(3_000u64, "intro"), (2_000, "one"), (2_000, "two")].iter().enumerate()
    {
        let v = fx.dir.join(format!("{name}.mp4"));
        let a = fx.dir.join(format!("{name}.wav"));
        ffmpeg::make_placeholder(&fx.ffmpeg, &v, PALETTE[i].1, *dur + 1_000, 320, 180, 30)
            .expect("video");
        tts::write_wav(&a, &vec![0f32; (*dur as usize) * 24]).expect("audio");
        items.push(ffmpeg::RenderItem {
            video: v,
            audio: a,
            item: timeline::TimelineItem {
                clip_id: name.to_string(),
                segment_index: 0,
                source_in_ms: 0,
                source_out_ms: *dur,
                timeline_start_ms: 0,
                timeline_duration_ms: *dur,
                stretch: 1.0,
                fit: timeline::Fit::Exact,
            },
            is_hdr: false,
            has_audio: false,
        });
    }

    let settings = RenderSettings { crossfade_ms: 200, intro_fade_ms: 600, ..base };
    let out = fx.dir.join("both.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &items, &settings, &ffmpeg::FfmpegCaps::default(), &out)
        .expect("renders with two different fade lengths");

    // 7000 less 600 at the opening and 200 in the body. Taking the body's 200
    // at both boundaries would give 6600 — 400ms away, far outside this margin.
    let total = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    println!("\n  total {total}ms (expected 6200, 6600 if the opening lost its own fade)");
    assert!(
        total.abs_diff(6_200) < 200,
        "expected 6.2s, measured {total}ms",
    );
}

/// The 2x cap, proved against real ffmpeg rather than only in the planner.
///
/// A clip far too short for its line used to be slowed without limit, which at
/// a fifth speed reads as a broken video rather than as pacing. Now it slows to
/// the cap and replays. The check that matters is that the narration is still
/// covered end to end and the picture is still moving — a silent regression
/// here would be a frozen frame nobody notices until they watch the export.
#[test]
fn a_clip_too_short_for_its_line_is_capped_and_replayed() {
    let Some(fx) = Fixture::new("cap") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let settings = RenderSettings { width: 320, height: 180, fps: 30, ..Default::default() };

    // Two seconds of footage under eight seconds of narration: 4x if it were
    // allowed to stretch, which it is not.
    let short = fx.dir.join("short.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &short, PALETTE[0].1, 2_000, 320, 180, 30).expect("clip");
    let audio = fx.dir.join("long.wav");
    tts::write_wav(&audio, &vec![0f32; 8 * 24_000]).expect("wav");

    let items = timeline::plan(
        &[timeline::ClipInput::whole("c0", Some(2_000))],
        &[timeline::LineInput::whole("c0", 8_000)],
    );
    assert_eq!(items[0].fit, timeline::Fit::Replayed, "the cap bound");
    assert_eq!(items[0].stretch, timeline::COMFORTABLE_STRETCH, "and stopped exactly there");

    let render_items = vec![ffmpeg::RenderItem {
        video: short,
        audio,
        item: items[0].clone(),
        is_hdr: false,
                                        has_audio: false,
                                    }];
    let out = fx.dir.join("capped.mp4");
    ffmpeg::render_rough_cut(
        &fx.ffmpeg, &render_items, &settings, &ffmpeg::FfmpegCaps::default(), &out,
    )
    .expect("a capped shot still renders");

    // The narration is never cut, so the slot is still the length the planner
    // asked for — the replay fills it, rather than the video ending early.
    let slot = items[0].timeline_duration_ms;
    let measured = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    println!("\n  slot {slot}ms, rendered {measured}ms, stretch {:.2}", items[0].stretch);
    assert!(
        measured.abs_diff(slot) < 200,
        "the shot must cover its whole line: wanted {slot}ms, got {measured}ms",
    );

    // Picture throughout, including in the stretch past the first play-through
    // where the old code would have run out of frames.
    for at in [200u64, 3_000, 5_000, slot - 400] {
        let rgb = ffmpeg::frame_rgb(&fx.ffmpeg, &out, at).expect("frame");
        assert_eq!(nearest(rgb), PALETTE[0].0, "black or frozen at {at}ms: {rgb:?}");
    }
}

/// The arithmetic behind the replay, without paying for a render each time.
#[test]
fn a_capped_shot_replays_exactly_as_often_as_it_must() {
    use timeline::Fit;
    // 2s of footage, slowed to 4s, under an 8s line: two plays.
    assert_eq!(Fit::Replayed.plays(8_000, 2_000, 2.0), 2);
    // Just over two plays' worth needs a third, since the tail is trimmed.
    assert_eq!(Fit::Replayed.plays(8_500, 2_000, 2.0), 3);
    // Anything that fits plays once, whatever it is asked.
    assert_eq!(Fit::Slowed.plays(8_000, 2_000, 2.0), 1);
    assert_eq!(Fit::Exact.plays(8_000, 2_000, 1.0), 1);
    assert_eq!(Fit::Trimmed.plays(8_000, 60_000, 1.0), 1);
    // Degenerate input must not divide by zero or loop forever.
    assert_eq!(Fit::Replayed.plays(8_000, 0, 2.0), 1);
}

/// Subtitles, burned in for real and then looked at.
///
/// "It rendered" proves nothing here: a filter that silently draws nothing
/// produces a perfectly valid video of the footage without captions. So this
/// samples the strip of frame where the text sits and requires it to differ
/// from the same strip on the same render without subtitles.
#[test]
fn subtitles_are_drawn_into_the_picture() {
    let Some(fx) = Fixture::new("subs") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let info = ffmpeg::detect(&FfmpegSettings::default()).expect("detect");
    if !info.caps.subtitles {
        eprintln!("this ffmpeg has no libass; skipping the burn-in check");
        return;
    }

    // Larger than the other fixtures: at 320x180 the text is a few pixels tall
    // and averages away to almost nothing, which would make this pass or fail
    // on rounding rather than on whether anything was drawn.
    let settings = RenderSettings { width: 640, height: 360, fps: 30, ..Default::default() };
    let video = fx.dir.join("clip.mp4");
    ffmpeg::make_placeholder(&fx.ffmpeg, &video, PALETTE[2].1, 6_000, 640, 360, 30).expect("clip");
    let audio = fx.dir.join("line.wav");
    tts::write_wav(&audio, &vec![0f32; 4 * 24_000]).expect("wav");

    let items = timeline::plan(
        &[timeline::ClipInput::whole("c0", Some(6_000))],
        &[timeline::LineInput::whole("c0", 4_000)],
    );
    let render_items = vec![ffmpeg::RenderItem {
        video,
        audio,
        item: items[0].clone(),
        is_hdr: false,
                                        has_audio: false,
                                    }];

    // Non-Latin on purpose. Bengali needs conjunct shaping and reordering that
    // only a real text stack gets right, and it is the language this app is
    // most used in — a check that only ever proved "ABC" would prove nothing
    // about the case that matters.
    let cues = crate::subtitles::cues(&items, |_| {
        Some("বন্দরটা জমে যায়নি, থেমে গেছে।".into())
    });
    assert_eq!(cues.len(), 1);
    let srt = fx.dir.join("cut-test.srt");
    std::fs::write(&srt, crate::subtitles::to_srt(&cues, Some(crate::subtitles::WRAP_CHARS)))
        .expect("write srt");

    let plain = fx.dir.join("plain.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &settings, &info.caps, &plain)
        .expect("render without subtitles");

    let burned = fx.dir.join("burned.mp4");
    let with_subs = RenderSettings {
        subtitle_path: Some(srt.to_string_lossy().to_string()),
        ..settings.clone()
    };
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &with_subs, &info.caps, &burned)
        .expect("render with subtitles");

    // The lower fifth of the frame, where a caption sits.
    let at = 1_500;
    let (x, y, w, h) = (0, 260, 640, 100);
    let clean = ffmpeg::frame_rgb_region(&fx.ffmpeg, &plain, at, x, y, w, h).expect("clean strip");
    let capped = ffmpeg::frame_rgb_region(&fx.ffmpeg, &burned, at, x, y, w, h).expect("caption strip");
    println!("\n  caption strip: clean {clean:?} -> burned {capped:?}");

    assert_ne!(clean, capped, "nothing was drawn into the frame");
    // How much the strip moved, in any direction. White glyphs with a dark
    // outline over a flat colour push some channels up and others down, so a
    // signed measure can cancel itself out to nearly zero on a blue frame and
    // report "nothing drawn" about a perfectly good caption.
    let moved = capped.0.abs_diff(clean.0) as u32
        + capped.1.abs_diff(clean.1) as u32
        + capped.2.abs_diff(clean.2) as u32;
    assert!(moved > 10, "the strip barely changed ({moved}); is the text being drawn?");

    // And nowhere else: the top of the frame is untouched.
    let top_plain = ffmpeg::frame_rgb_region(&fx.ffmpeg, &plain, at, 0, 0, 640, 80).expect("top");
    let top_burned = ffmpeg::frame_rgb_region(&fx.ffmpeg, &burned, at, 0, 0, 640, 80).expect("top");
    assert_eq!(top_plain, top_burned, "captions must not cover the picture");

    // The caption ends with the words, not with the shot, so the beat of
    // silence the cut leaves after the sentence is uncaptioned. The slot runs
    // to 4300ms and the cue to 4000, so this samples between the two.
    assert_eq!(cues[0].end_ms, 4_000);
    let late_plain = ffmpeg::frame_rgb_region(&fx.ffmpeg, &plain, 4_150, x, y, w, h).expect("late");
    let late_burned = ffmpeg::frame_rgb_region(&fx.ffmpeg, &burned, 4_150, x, y, w, h).expect("late");
    assert_eq!(late_plain, late_burned, "the caption outlived its line");
}

/// The order footage was shot in, read from the files themselves.
#[test]
fn capture_time_is_read_and_is_the_order_things_happened() {
    let Some(fx) = Fixture::new("capture-time") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };

    // Written with an explicit creation_time, the way a camera does.
    let mut made = Vec::new();
    for (i, stamp) in ["2026-08-13T09:15:00.000000Z", "2026-08-13T09:20:30.000000Z"]
        .iter()
        .enumerate()
    {
        let path = fx.dir.join(format!("shot{i}.mp4"));
        let status = std::process::Command::new(&fx.ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-r", "30"])
            .args(["-metadata", &format!("creation_time={stamp}")])
            .arg(&path)
            .status()
            .expect("write clip");
        assert!(status.success());
        made.push(path);
    }

    let first = ffmpeg::probe_media(&fx.ffprobe, &made[0]).expect("probe");
    let second = ffmpeg::probe_media(&fx.ffprobe, &made[1]).expect("probe");
    let (a, b) = (first.created_at_ms.expect("first"), second.created_at_ms.expect("second"));
    println!("\n  created {a} then {b} (+{}ms)", b - a);

    assert!(b > a, "the later clip must sort later");
    assert_eq!(b - a, 5 * 60_000 + 30_000, "five and a half minutes apart, exactly");
    // Sanity: mid-2026, not 1970 and not the year 56000.
    assert!(a > 1_770_000_000_000 && a < 1_900_000_000_000, "implausible epoch: {a}");
}

/// The date maths, without paying ffmpeg to make a file for each case.
#[test]
fn iso_timestamps_parse_to_the_right_instant() {
    use ffmpeg::parse_iso8601_ms_for_test as parse;
    // Epoch itself.
    assert_eq!(parse("1970-01-01T00:00:00.000000Z"), Some(0));
    // A leap day, which is where hand-rolled date maths usually breaks.
    assert_eq!(parse("2024-02-29T00:00:00.000000Z"), Some(1_709_164_800_000));
    // A century year that is a leap year, and one that is not.
    assert_eq!(parse("2000-03-01T00:00:00.000000Z"), Some(951_868_800_000));
    assert_eq!(parse("1900-03-01T00:00:00.000000Z"), Some(-2_203_891_200_000));
    // Sub-second precision survives.
    assert_eq!(parse("2026-08-13T09:15:00.500000Z"), Some(1_786_612_500_500));
    // Rubbish is refused rather than guessed at.
    assert_eq!(parse(""), None);
    assert_eq!(parse("not a date"), None);
    assert_eq!(parse("2026-08-13"), None);
}

/// A clip with a tone on its own audio track, for testing the sound mix.
fn clip_with_tone(fx: &Fixture, name: &str, colour: &str, ms: u64) -> PathBuf {
    let path = fx.dir.join(format!("{name}.mp4"));
    let secs = ms as f64 / 1000.0;
    let status = std::process::Command::new(&fx.ffmpeg)
        .args(["-y", "-v", "error"])
        .args(["-f", "lavfi", "-i", &format!("color=c={colour}:s=320x180:d={secs}:r=30")])
        .args(["-f", "lavfi", "-i", &format!("sine=frequency=440:duration={secs}")])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&path)
        .status()
        .expect("make clip with tone");
    assert!(status.success());
    path
}

/// The clip's own sound, under the narration, when the timeline asks for it.
///
/// Duration proves nothing here — a graph that drops the source audio renders
/// a perfectly good silent film of the right length. So this measures the
/// level: off must be silence, on must not be, and the gain must move it.
#[test]
fn a_clips_own_sound_can_be_mixed_under_the_narration() {
    let Some(fx) = Fixture::new("srcaudio") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let settings = RenderSettings { width: 320, height: 180, fps: 30, ..Default::default() };

    let video = clip_with_tone(&fx, "toned", "red", 6_000);
    // Silent narration, so anything audible in the render came from the clip.
    let narration = fx.dir.join("silent.wav");
    tts::write_wav(&narration, &vec![0f32; 4 * 24_000]).expect("wav");

    let items = timeline::plan(
        &[timeline::ClipInput::whole("c0", Some(6_000))],
        &[timeline::LineInput::whole("c0", 4_000)],
    );
    let mk = |has_audio: bool| vec![ffmpeg::RenderItem {
        video: video.clone(),
        audio: narration.clone(),
        item: items[0].clone(),
        is_hdr: false,
        has_audio,
    }];

    let off = fx.dir.join("off.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &mk(false), &settings, &ffmpeg::FfmpegCaps::default(), &off)
        .expect("render with the clip's sound off");

    let loud = RenderSettings { source_audio_gain: 1.0, ..settings.clone() };
    let on = fx.dir.join("on.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &mk(true), &loud, &ffmpeg::FfmpegCaps::default(), &on)
        .expect("render with the clip's sound on");

    let quiet = RenderSettings { source_audio_gain: 0.25, ..settings.clone() };
    let low = fx.dir.join("low.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &mk(true), &quiet, &ffmpeg::FfmpegCaps::default(), &low)
        .expect("render at a lower gain");

    let db_off = ffmpeg::mean_volume_db(&fx.ffmpeg, &off).expect("measure off");
    let db_on = ffmpeg::mean_volume_db(&fx.ffmpeg, &on).expect("measure on");
    let db_low = ffmpeg::mean_volume_db(&fx.ffmpeg, &low).expect("measure low");
    println!("\n  mean volume: off {db_off:.1}dB, on {db_on:.1}dB, quarter gain {db_low:.1}dB");

    assert!(db_off < -60.0, "with the clip's sound off the film should be silent, got {db_off}");
    assert!(db_on > -30.0, "the clip's sound is not in the mix, got {db_on}");
    // A quarter of the amplitude is about 12dB down, give or take the codec.
    assert!(
        db_low < db_on - 8.0,
        "the gain does nothing: full {db_on:.1}dB vs quarter {db_low:.1}dB",
    );
}

/// A dissolve at one boundary and hard cuts at the others.
///
/// The thing a timeline can express that the old all-or-nothing setting could
/// not. Measured by duration: each dissolve eats its own length out of the
/// total, so putting one at the wrong boundary — or at all of them — lands the
/// film somewhere else.
#[test]
fn a_transition_can_be_set_on_one_boundary_alone() {
    let Some(fx) = Fixture::new("per-boundary") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let base = RenderSettings { width: 320, height: 180, fps: 30, ..Default::default() };

    // Three 3s shots. One 600ms dissolve, between the second and third.
    let mut items = Vec::new();
    for i in 0..3 {
        let v = fx.dir.join(format!("s{i}.mp4"));
        let a = fx.dir.join(format!("s{i}.wav"));
        ffmpeg::make_placeholder(&fx.ffmpeg, &v, PALETTE[i].1, 4_000, 320, 180, 30).expect("clip");
        tts::write_wav(&a, &vec![0f32; 3 * 24_000]).expect("wav");
        items.push(ffmpeg::RenderItem {
            video: v,
            audio: a,
            item: timeline::TimelineItem {
                clip_id: format!("c{i}"),
                segment_index: 0,
                source_in_ms: 0,
                source_out_ms: 3_000,
                timeline_start_ms: i as u64 * 3_000,
                timeline_duration_ms: 3_000,
                stretch: 1.0,
                fit: timeline::Fit::Exact,
            },
            is_hdr: false,
            has_audio: false,
        });
    }

    let settings = RenderSettings { transitions: vec![0, 600], ..base.clone() };
    let out = fx.dir.join("one-fade.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &items, &settings, &ffmpeg::FfmpegCaps::default(), &out)
        .expect("renders with a fade at one boundary");

    // 9s less the single 600ms overlap. A fade at both would give 7.8s; none
    // would give 9.0s.
    let total = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    println!("\n  total {total}ms (8400 expected; 7800 if both faded, 9000 if neither)");
    assert!(total.abs_diff(8_400) < 200, "expected 8.4s, measured {total}ms");

    // Boundary one is a cut: the frame either side of 3.0s is one colour or
    // the other, never a blend.
    let before = ffmpeg::frame_rgb(&fx.ffmpeg, &out, 2_900).expect("before the cut");
    let after = ffmpeg::frame_rgb(&fx.ffmpeg, &out, 3_100).expect("after the cut");
    assert_eq!(nearest(before), PALETTE[0].0);
    assert_eq!(nearest(after), PALETTE[1].0, "a cut, not a dissolve");

    // Boundary two is a dissolve: mid-transition carries both colours.
    let mid = ffmpeg::frame_rgb(&fx.ffmpeg, &out, 5_700).expect("mid-dissolve");
    println!("  mid-dissolve {mid:?} between {} and {}", PALETTE[1].0, PALETTE[2].0);
    assert_ne!(nearest(mid), nearest(before), "the second boundary should blend");
    assert!(mid.1 > 20 && mid.2 > 20, "expected a green/blue blend, saw {mid:?}");
}

/// Boundary numbering survives an opening montage.
///
/// The montage becomes item zero, so every boundary the timeline named moves
/// along one. Getting this wrong puts a dissolve one cut early, and only in
/// films that happen to have an opening — which is exactly the kind of bug
/// that ships.
#[test]
fn timeline_transitions_stay_on_their_own_boundaries_behind_an_intro() {
    use crate::ffmpeg::boundary_fades_for_test as fades;

    let items: Vec<ffmpeg::RenderItem> = (0..4)
        .map(|i| ffmpeg::RenderItem {
            video: PathBuf::from("/x.mp4"),
            audio: PathBuf::from("/x.wav"),
            item: timeline::TimelineItem {
                clip_id: format!("c{i}"),
                segment_index: 0,
                source_in_ms: 0,
                source_out_ms: 6_000,
                timeline_start_ms: i as u64 * 6_000,
                timeline_duration_ms: 6_000,
                stretch: 1.0,
                fit: timeline::Fit::Exact,
            },
            is_hdr: false,
            has_audio: false,
        })
        .collect();

    // Without an opening: the timeline's list maps straight onto boundaries.
    let plain = RenderSettings { transitions: vec![0, 500, 0], ..Default::default() };
    assert_eq!(fades(&plain, &items), vec![0, 500, 0]);

    // With one, the command prepends a placeholder for the montage's own
    // boundary, which `intro_fade_ms` governs instead.
    let with_intro = RenderSettings {
        transitions: vec![0, 0, 500, 0],
        intro_fade_ms: 600,
        ..Default::default()
    };
    assert_eq!(
        fades(&with_intro, &items),
        vec![600, 0, 500],
        "the dissolve must stay between the same two shots",
    );
}

/// Everything the timeline can do, in one render.
///
/// The individual paths are covered above. This is the one that catches them
/// interfering: a replayed shot whose own audio must replay with it, under a
/// dissolve, under a music bed, with captions burned over the result.
#[test]
fn a_fully_edited_timeline_renders() {
    let Some(fx) = Fixture::new("tl-all") else {
        eprintln!("ffmpeg not available; skipping");
        return;
    };
    let info = ffmpeg::detect(&FfmpegSettings::default()).expect("detect");
    let settings_base = RenderSettings { width: 320, height: 180, fps: 30, ..Default::default() };

    // Shot one is far too short for its line, so it caps and replays — with
    // its own sound, which has to replay too or the picture loops over silence.
    let short = clip_with_tone(&fx, "short", "red", 2_000);
    let long = clip_with_tone(&fx, "long", "green", 12_000);
    let narration = fx.dir.join("nar.wav");
    tts::write_wav(&narration, &vec![0f32; 6 * 24_000]).expect("wav");

    let items = timeline::plan(
        &[
            timeline::ClipInput::whole("a", Some(2_000)),
            timeline::ClipInput::whole("b", Some(12_000)),
        ],
        &[
            timeline::LineInput::whole("a", 6_000),
            timeline::LineInput::whole("b", 6_000),
        ],
    );
    assert_eq!(items[0].fit, timeline::Fit::Replayed, "the fixture must exercise the cap");

    let render_items = vec![
        ffmpeg::RenderItem {
            video: short,
            audio: narration.clone(),
            item: items[0].clone(),
            is_hdr: false,
            has_audio: true,
        },
        ffmpeg::RenderItem {
            video: long,
            audio: narration.clone(),
            item: items[1].clone(),
            is_hdr: false,
            has_audio: true,
        },
    ];

    // A caption over the whole thing.
    let cues = crate::subtitles::cues(&items, |_| Some("বন্দরটা থেমে গেছে।".into()));
    let srt = fx.dir.join("cut-all.srt");
    std::fs::write(&srt, crate::subtitles::to_srt(&cues, Some(crate::subtitles::WRAP_CHARS)))
        .expect("srt");

    // And a music bed, made here rather than depending on the bundled ones.
    let music = fx.dir.join("bed.m4a");
    let status = std::process::Command::new(&fx.ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=20"])
        .arg(&music)
        .status()
        .expect("bed");
    assert!(status.success());

    let settings = RenderSettings {
        transitions: vec![500],
        source_audio_gain: 0.3,
        music_path: Some(music.to_string_lossy().to_string()),
        music_gain: 0.2,
        subtitle_path: info.caps.subtitles.then(|| srt.to_string_lossy().to_string()),
        ..settings_base
    };
    let out = fx.dir.join("everything.mp4");
    ffmpeg::render_rough_cut(&fx.ffmpeg, &render_items, &settings, &info.caps, &out)
        .expect("every timeline feature at once");

    // Both slots, less the one dissolve.
    let want = items[0].timeline_duration_ms + items[1].timeline_duration_ms - 500;
    let total = ffmpeg::probe_duration_ms(&fx.ffprobe, &out).expect("probe");
    println!("\n  total {total}ms (want {want}ms)");
    assert!(total.abs_diff(want) < 250, "wanted {want}ms, got {total}ms");

    // There is sound, and it is not just the music: the clips' tone is in it.
    let db = ffmpeg::mean_volume_db(&fx.ffmpeg, &out).expect("volume");
    println!("  mean volume {db:.1}dB");
    assert!(db > -40.0, "the mix came out near-silent at {db}dB");

    // Picture throughout, including the replayed stretch of shot one.
    for at in [300u64, 3_000, 5_500, 8_000] {
        let rgb = ffmpeg::frame_rgb(&fx.ffmpeg, &out, at).expect("frame");
        assert!(
            rgb.0 as u32 + rgb.1 as u32 + rgb.2 as u32 > 40,
            "black frame at {at}ms: {rgb:?}",
        );
    }
}
