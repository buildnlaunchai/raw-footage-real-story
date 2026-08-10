//! Verification harness for real HDR footage.
//!
//! Phone HLG footage cannot be synthesised, so this drives the production code
//! paths against actual clips instead. It is `#[ignore]`d because it depends on
//! files outside the repo, and it takes the project directory from an
//! environment variable rather than hardcoding one, so it is usable by anyone
//! with HDR clips imported.
//!
//!   RFRS_HDR_PROJECT="~/Library/Application Support/…/projects/<id>" \
//!     cargo test --lib hdr_check -- --ignored --nocapture
//!
//! Expects that project to hold N clips in `clips/` and N narration WAVs in
//! `audio/`, i.e. the state after running stages 1-3 on HDR footage.

#![cfg(test)]

use std::path::PathBuf;

use crate::ffmpeg::{self, FfmpegSettings, RenderItem, RenderSettings};
use crate::timeline::{self, ClipInput, LineInput};

/// Project directory to verify, or None when the variable is unset.
fn project() -> Option<PathBuf> {
    let raw = std::env::var("RFRS_HDR_PROJECT").ok()?;
    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").ok()?).join(rest),
        None => PathBuf::from(raw),
    };
    expanded.is_dir().then_some(expanded)
}

/// Mean luma and saturation of a frame, so "washed out" becomes a number.
fn frame_stats(ffmpeg_bin: &str, media: &std::path::Path, at_ms: u64) -> (f64, f64) {
    let out = std::process::Command::new(ffmpeg_bin)
        .args(["-v", "error", "-ss", &format!("{:.3}", at_ms as f64 / 1000.0)])
        .arg("-i")
        .arg(media)
        .args(["-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .expect("frame grab");

    let px: Vec<(f64, f64, f64)> = out
        .stdout
        .chunks_exact(3)
        .map(|c| (c[0] as f64, c[1] as f64, c[2] as f64))
        .collect();
    let n = px.len() as f64;
    let luma = px.iter().map(|(r, g, b)| 0.2126 * r + 0.7152 * g + 0.0722 * b).sum::<f64>() / n;
    let sat = px
        .iter()
        .map(|(r, g, b)| {
            let (mx, mn) = (r.max(*g).max(*b), r.min(*g).min(*b));
            if mx == 0.0 { 0.0 } else { (mx - mn) / mx }
        })
        .sum::<f64>()
        / n;
    (luma, sat)
}

#[test]
#[ignore = "needs the user's real HDR footage in the app project folder"]
fn tone_maps_real_hdr_footage_with_zscale() {
    let Some(dir) = project() else {
        eprintln!("set RFRS_HDR_PROJECT to a project directory holding HDR clips; skipping");
        return;
    };

    // Detection goes through the same settings file the setup screen writes.
    let settings_path = dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("settings.json"))
        .expect("project dir should sit under the app data directory");
    let settings: FfmpegSettings = std::fs::read(&settings_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    let info = ffmpeg::detect(&settings).expect("detect ffmpeg");
    println!("\n  binary : {}", info.ffmpeg);
    println!("  version: {}", info.version);
    println!("  caps   : zscale={} tonemap={}", info.caps.zscale, info.caps.tonemap);
    assert!(info.caps.zscale, "expected a zscale-capable build");

    let mut clips: Vec<PathBuf> = std::fs::read_dir(dir.join("clips"))
        .expect("clips dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    clips.sort();
    assert!(!clips.is_empty(), "no clips in {}", dir.join("clips").display());

    let mut audio: Vec<PathBuf> = std::fs::read_dir(dir.join("audio"))
        .expect("audio dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    audio.sort();
    assert_eq!(audio.len(), clips.len(), "one narration line per clip expected");

    println!("\n  sources:");
    let mut clip_inputs = Vec::new();
    let mut line_inputs = Vec::new();
    for (i, (clip, wav)) in clips.iter().zip(&audio).enumerate() {
        let media = ffmpeg::probe_media(&info.ffprobe, clip).expect("probe clip");
        let narration = ffmpeg::probe_duration_ms(&info.ffprobe, wav).expect("probe wav");
        println!(
            "    {} {}x{} {} {} hdr={} | narration {}ms",
            clip.file_name().unwrap().to_string_lossy(),
            media.width, media.height, media.codec, media.color_transfer, media.is_hdr, narration
        );
        assert!(media.is_hdr, "clip {i} should be detected as HDR");

        let check = ffmpeg::check_media(&info.ffprobe, clip, &info.caps);
        println!("      warning: {:?}", check.reasons);
        assert!(
            check.reasons.iter().any(|r| r.contains("will be tone-mapped")),
            "expected the benign tone-map notice, got {:?}", check.reasons
        );

        clip_inputs.push(ClipInput::whole(format!("c{i}"), Some(media.duration_ms)));
        line_inputs.push(LineInput { clip_id: format!("c{i}"), duration_ms: narration });
    }

    let items = timeline::plan(&clip_inputs, &line_inputs);
    let render_items: Vec<RenderItem> = items
        .iter()
        .enumerate()
        .map(|(i, item)| RenderItem {
            video: clips[i].clone(),
            audio: audio[i].clone(),
            item: item.clone(),
            is_hdr: true,
        })
        .collect();

    let out = dir.join("render").join("rough-cut-tonemapped.mp4");
    let started = std::time::Instant::now();
    ffmpeg::render_rough_cut(&info.ffmpeg, &render_items, &RenderSettings::default(), &info.caps, &out)
        .expect("render with zscale tone map");
    println!("\n  rendered in {:.1}s -> {}", started.elapsed().as_secs_f32(), out.display());

    // Compare against the previous, un-tone-mapped render if it is still there.
    let previous = dir.join("render").join("rough-cut.mp4");
    let sample_at = items[0].timeline_start_ms + items[0].timeline_duration_ms / 2;
    let (nl, ns) = frame_stats(&info.ffmpeg, &previous, sample_at);
    let (tl, ts) = frame_stats(&info.ffmpeg, &out, sample_at);
    println!("\n  frame at {sample_at}ms:");
    println!("    before (no tone map): luma {nl:6.1}  saturation {ns:.3}");
    println!("    after  (zscale)     : luma {tl:6.1}  saturation {ts:.3}");

    let final_info = ffmpeg::probe_media(&info.ffprobe, &out).expect("probe output");
    assert_eq!((final_info.width, final_info.height), (1920, 1080));
    assert!(!final_info.is_hdr, "output must be SDR after tone mapping");
    assert_eq!(final_info.color_transfer, "bt709", "output should be bt709");
    println!("    output transfer     : {} (was {})", final_info.color_transfer, "arib-std-b67");
}
