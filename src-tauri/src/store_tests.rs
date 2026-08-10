//! Project persistence tests, including at the scale the product actually
//! targets (~300 clips from one trip, each with several described segments).
//!
//! The scale tests exist to settle an architectural question with numbers
//! rather than intuition: is a single whole-file JSON manifest fine, or does
//! segment data need lazy loading?

#![cfg(test)]

use std::path::PathBuf;
use std::time::Instant;

use crate::project::{self, ProjectClip, ProjectFile, Segment, SelectedSegment, VideoProject};

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rfrs-store-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const NOW: &str = "2026-08-10T00:00:00Z";

fn clip_with_segments(i: usize, segments: usize) -> ProjectClip {
    let duration_ms = 20_000 + (i as u64 % 40) * 1_000;
    let per = duration_ms as f64 / 1000.0 / segments as f64;
    ProjectClip {
        id: format!("clip-{i:04}"),
        source_path: Some(format!("/Volumes/Trip/DCIM/IMG_{:04}.MOV", 4000 + i)),
        sha256: Some(format!("{:064x}", i)),
        source_duration_ms: Some(duration_ms),
        is_placeholder: false,
        file_name: Some(format!("IMG_{:04}.MOV", 4000 + i)),
        thumbnail_path: Some(format!("thumbs/{i:04}.jpg")),
        is_hdr: i % 3 == 0,
        segments: (0..segments)
            .map(|s| Segment {
                start_sec: s as f64 * per,
                end_sec: (s + 1) as f64 * per,
                text: format!(
                    "Clip {i} moment {s}: the harbour was still frozen and the light came in low \
                     across the water, with boats held fast in the ice"
                ),
            })
            .collect(),
    }
}

fn project_with(clips: usize, segments_each: usize) -> ProjectFile {
    let mut p = ProjectFile::new("proj-scale".into(), "Iceland trip".into(), NOW.into());
    p.clips = (0..clips).map(|i| clip_with_segments(i, segments_each)).collect();
    p
}

#[test]
fn round_trips_segments_and_videos() {
    let dir = tmp("roundtrip");
    let path = dir.join("project.json");

    let mut p = project_with(3, 2);
    let mut video = VideoProject::new("vid-1".into(), "Frozen North".into(), NOW.into());
    video.selection = vec![
        SelectedSegment { clip_id: "clip-0002".into(), segment_index: 1 },
        SelectedSegment { clip_id: "clip-0000".into(), segment_index: 0 },
    ];
    video.pronunciations.insert("Reykjavik".into(), "RAY-kya-vik".into());
    p.videos.push(video);

    project::write_json(&p, &path).unwrap();
    let back = project::load(&path).unwrap();

    assert_eq!(back.schema_version, project::SCHEMA_VERSION);
    assert_eq!(back.clips.len(), 3);
    assert_eq!(back.segment_count(), 6);
    assert_eq!(back.clips[0].segments[0].text, p.clips[0].segments[0].text);
    assert_eq!(back.videos.len(), 1);
    // Selection order is the story order and must survive verbatim.
    assert_eq!(back.videos[0].selection, p.videos[0].selection);
    assert_eq!(back.videos[0].pronunciations.get("Reykjavik").map(String::as_str), Some("RAY-kya-vik"));
}

#[test]
fn migrates_a_v1_project_without_losing_anything() {
    let dir = tmp("migrate");
    let path = dir.join("project.json");

    // A v1 manifest exactly as the previous build wrote them.
    let v1 = serde_json::json!({
        "schemaVersion": 1,
        "app": { "slug": "raw-footage-real-story", "version": "0.1.0" },
        "project": {
            "id": "old", "name": "Old project",
            "createdAt": NOW, "updatedAt": NOW
        },
        "clips": [{
            "id": "c0",
            "sourcePath": "clips/000-holiday.mp4",
            "sha256": "abc",
            "sourceDurationMs": 9000,
            "description": "Empty harbour, boats frozen in",
            "isPlaceholder": false
        }],
        "script": {
            "model": "qwen2.5:7b", "generatedAt": NOW,
            "lines": [{ "clipId": "c0", "text": "The harbour lies still." }]
        },
        "audio": {
            "voice": "af_heart", "sampleRate": 24000,
            "lines": [{ "clipId": "c0", "path": "audio/line-01.wav",
                        "durationMs": 2000, "skippedWords": ["Aqsa"] }]
        },
        "timeline": [{
            "clipId": "c0", "sourceInMs": 0, "sourceOutMs": 2300,
            "timelineStartMs": 0, "timelineDurationMs": 2300,
            "holdMs": 0, "fit": "trimmed"
        }],
        "render": { "width": 1920, "height": 1080, "fps": 30,
                    "vcodec": "h264", "acodec": "aac",
                    "outputPath": "render/rough-cut.mp4" }
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&v1).unwrap()).unwrap();

    let p = project::load(&path).unwrap();
    assert_eq!(p.schema_version, project::SCHEMA_VERSION, "should be upgraded in memory");
    assert_eq!(p.project.name, "Old project");

    // The flat description becomes one segment spanning the whole clip, which
    // preserves its v1 meaning exactly.
    assert_eq!(p.clips.len(), 1);
    assert_eq!(p.clips[0].segments.len(), 1);
    assert_eq!(p.clips[0].segments[0].text, "Empty harbour, boats frozen in");
    assert_eq!(p.clips[0].segments[0].start_sec, 0.0);
    assert_eq!(p.clips[0].segments[0].end_sec, 9.0);

    // The single v1 video is carried over intact.
    assert_eq!(p.videos.len(), 1);
    let v = &p.videos[0];
    assert_eq!(v.script.as_ref().unwrap().lines[0].text, "The harbour lies still.");
    assert_eq!(v.audio.as_ref().unwrap().lines[0].skipped_words, vec!["Aqsa".to_string()]);
    assert_eq!(v.timeline.len(), 1);
    assert_eq!(v.selection.len(), 1, "selection reconstructed from the timeline");
    println!("\n  v1 -> v2 migration preserved clips, script, audio, timeline and render");
}

#[test]
fn refuses_a_future_schema_rather_than_guessing() {
    let dir = tmp("future");
    let path = dir.join("project.json");
    std::fs::write(&path, br#"{"schemaVersion": 99}"#).unwrap();
    let err = project::load(&path).expect_err("should refuse");
    assert!(err.contains("newer version"), "got: {err}");
}

/// Settles the "do we need lazy loading?" question with measurements.
#[test]
fn measures_manifest_size_at_scale() {
    let dir = tmp("scale");
    let path = dir.join("project.json");

    // 300 clips x 6 segments = 1800 described moments: a full trip.
    let p = project_with(300, 6);
    assert_eq!(p.segment_count(), 1800);

    let t = Instant::now();
    project::write_json(&p, &path).unwrap();
    let write_ms = t.elapsed().as_secs_f64() * 1000.0;

    let bytes = std::fs::metadata(&path).unwrap().len();

    let t = Instant::now();
    let back = project::load(&path).unwrap();
    let read_ms = t.elapsed().as_secs_f64() * 1000.0;

    println!("\n  300 clips x 6 segments = {} segments", back.segment_count());
    println!("  manifest : {:.1} KB", bytes as f64 / 1024.0);
    println!("  write    : {write_ms:.1} ms");
    println!("  read     : {read_ms:.1} ms");

    assert_eq!(back.clips.len(), 300);
    assert_eq!(back.segment_count(), 1800);

    // The thresholds are deliberately generous; the point is to catch an order
    // of magnitude change, not to police milliseconds.
    assert!(bytes < 8 * 1024 * 1024, "manifest unexpectedly large: {bytes} bytes");
    assert!(read_ms < 1000.0, "load too slow at scale: {read_ms:.1}ms");
    assert!(write_ms < 1000.0, "save too slow at scale: {write_ms:.1}ms");
}

/// A save must never leave a half-written manifest behind: losing a described
/// 300-clip library to an interrupted write would be unrecoverable by hand.
#[test]
fn save_is_atomic() {
    let dir = tmp("atomic");
    let path = dir.join("project.json");

    project::write_json(&project_with(2, 1), &path).unwrap();
    let first = std::fs::read(&path).unwrap();

    project::write_json(&project_with(40, 3), &path).unwrap();
    let second = std::fs::read(&path).unwrap();

    assert!(second.len() > first.len(), "second save should be larger");
    // No temp file left behind, and the manifest always parses.
    assert!(!path.with_extension("json.tmp").exists(), "temp file leaked");
    assert!(project::load(&path).is_ok(), "manifest must always be parseable");
}

#[test]
fn combined_text_joins_segments_for_prompting() {
    let clip = clip_with_segments(7, 3);
    let combined = clip.combined_text();
    assert!(combined.contains("moment 0"));
    assert!(combined.contains("moment 2"));
    assert!(clip.is_described());

    let mut blank = clip_with_segments(8, 2);
    for s in &mut blank.segments {
        s.text = "   ".into();
    }
    assert!(!blank.is_described(), "whitespace-only segments are not descriptions");
    assert_eq!(blank.combined_text(), "");
}

// --- bundle export (coverage carried over from the v1 project tests) --------

use crate::ffmpeg::RenderSettings;
use crate::project::{AudioLineRecord, AudioSection, RenderSection, ScriptLineRecord, ScriptSection};
use crate::timeline::{self, ClipInput, LineInput};
use std::path::Path;

fn project_with_video() -> ProjectFile {
    let mut p = ProjectFile::new("p1".into(), "Test".into(), NOW.into());
    p.clips.push(ProjectClip {
        id: "c0".into(),
        source_path: Some("clips/c0.mp4".into()),
        sha256: None,
        source_duration_ms: Some(9_000),
        is_placeholder: true,
        file_name: None,
        thumbnail_path: None,
        is_hdr: false,
        segments: vec![Segment { start_sec: 0.0, end_sec: 9.0, text: "harbour".into() }],
    });
    let mut v = VideoProject::new("v1".into(), "Frozen".into(), NOW.into());
    v.selection = vec![SelectedSegment { clip_id: "c0".into(), segment_index: 0 }];
    v.script = Some(ScriptSection {
        model: "qwen2.5:7b".into(),
        generated_at: NOW.into(),
        lines: vec![ScriptLineRecord {
            clip_id: "c0".into(),
            segment_index: 0,
            text: "The harbour.".into(),
            edited: false,
        }],
        word_count_target: Some(150),
    });
    v.audio = Some(AudioSection {
        voice: "af_heart".into(),
        sample_rate: 24_000,
        lines: vec![AudioLineRecord {
            clip_id: "c0".into(),
            segment_index: 0,
            path: "audio/line-01.wav".into(),
            duration_ms: 2_000,
            skipped_words: vec!["Aqsa".into()],
        }],
    });
    v.timeline = timeline::plan(
        &[ClipInput::whole("c0", Some(9_000))],
        &[LineInput { clip_id: "c0".into(), duration_ms: 2_000 }],
    );
    v.render = Some(RenderSection {
        settings: RenderSettings::default(),
        vcodec: "h264".into(),
        acodec: "aac".into(),
        output_path: Some("render/rough-cut.mp4".into()),
    });
    p.videos.push(v);
    p
}

#[test]
fn json_uses_camel_case_for_the_web_editor() {
    let json = serde_json::to_string(&project_with_video()).unwrap();
    for key in [
        "schemaVersion", "sourceDurationMs", "isPlaceholder", "skippedWords",
        "timelineStartMs", "timelineDurationMs", "sourceInMs", "sourceOutMs", "holdMs",
        "startSec", "endSec", "segmentIndex", "wordCountTarget",
    ] {
        assert!(json.contains(&format!("\"{key}\"")), "missing key {key}");
    }
    assert!(!json.contains("schema_version"), "snake_case leaked into the manifest");
    assert!(!json.contains("start_sec"), "snake_case leaked into segments");
}

#[test]
fn timeline_is_absolute_not_derived() {
    let p = project_with_video();
    let item = &p.videos[0].timeline[0];
    assert_eq!(item.timeline_start_ms, 0);
    assert_eq!(item.timeline_duration_ms, 2_300);
    assert_eq!(format!("{:?}", item.fit), "Trimmed");
}

#[test]
fn relative_paths_use_forward_slashes() {
    let base = Path::new("/tmp/proj");
    assert_eq!(project::relative_to(base, &base.join("audio").join("line-01.wav")), "audio/line-01.wav");
}

#[test]
fn hashes_are_stable_and_content_dependent() {
    let dir = tmp("hash");
    let a = dir.join("a.bin");
    std::fs::write(&a, b"hello").unwrap();
    let h1 = project::sha256_file(&a).unwrap();
    assert_eq!(h1, project::sha256_file(&a).unwrap());
    std::fs::write(&a, b"hello!").unwrap();
    assert_ne!(h1, project::sha256_file(&a).unwrap());
}

#[test]
fn bundle_pulls_in_externally_referenced_media_and_rewrites_paths() {
    let root = tmp("external");
    let dir = root.join("project");
    let elsewhere = root.join("Movies");
    std::fs::create_dir_all(dir.join("audio")).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    let external = elsewhere.join("holiday.mp4");
    std::fs::write(&external, b"pretend this is video").unwrap();

    let mut p = project_with_video();
    p.clips[0].source_path = Some(external.to_string_lossy().to_string());
    p.clips[0].is_placeholder = false;
    project::write_json(&p, &dir.join("project.json")).unwrap();
    std::fs::write(dir.join("audio/line-01.wav"), b"fake").unwrap();

    let zip_path = root.join("bundle.zip");
    project::write_bundle(&dir, &zip_path).unwrap();

    let f = std::fs::File::open(&zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    println!("\n  bundle: {names:?}");
    let copied = names.iter().find(|n| n.ends_with("holiday.mp4")).cloned();
    assert!(copied.is_some(), "external media should be copied in: {names:?}");

    let mut raw = String::new();
    {
        use std::io::Read;
        archive.by_name("project.json").unwrap().read_to_string(&mut raw).unwrap();
    }
    let bundled: ProjectFile = serde_json::from_str(&raw).unwrap();
    let path = bundled.clips[0].source_path.as_ref().unwrap();
    assert!(!Path::new(path).is_absolute(), "bundle path must be relative, got {path}");
    assert_eq!(Some(path.clone()), copied);
    // Segments and video data must survive the rewrite untouched.
    assert_eq!(bundled.clips[0].segments, p.clips[0].segments);
    assert_eq!(bundled.videos[0].timeline, p.videos[0].timeline);
}

#[test]
fn bundle_drops_paths_whose_media_is_missing() {
    let dir = tmp("missing");
    let mut p = project_with_video();
    p.clips[0].source_path = Some("/nowhere/gone.mp4".into());
    project::write_json(&p, &dir.join("project.json")).unwrap();

    let zip_path = dir.join("bundle.zip");
    project::write_bundle(&dir, &zip_path).unwrap();

    let f = std::fs::File::open(&zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let mut raw = String::new();
    {
        use std::io::Read;
        archive.by_name("project.json").unwrap().read_to_string(&mut raw).unwrap();
    }
    let bundled: ProjectFile = serde_json::from_str(&raw).unwrap();
    assert_eq!(bundled.clips[0].source_path, None, "dangling path should be cleared");
}
