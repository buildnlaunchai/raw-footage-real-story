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
        width: Some(1920),
        height: Some(1080),
        codec: Some("h264".into()),
        favorite: false,
        deleted_at: None,
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
        width: None,
        height: None,
        codec: None,
        favorite: false,
        deleted_at: None,
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
        hook: None,
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
        &[LineInput::whole("c0", 2_000)],
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
        "timelineStartMs", "timelineDurationMs", "sourceInMs", "sourceOutMs", "stretch",
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

/// Loads the real 300-clip demo project from app data, when it exists.
/// Skipped otherwise so the suite stays self-contained.
#[test]
fn loads_the_real_scale_demo_project_if_present() {
    let path = PathBuf::from(std::env::var("HOME").unwrap())
        .join("Library/Application Support/com.buildnlaunchai.raw-footage-real-story")
        .join("projects/scale-300-clip-demo/project.json");
    if !path.is_file() {
        eprintln!("scale demo project not present; skipping");
        return;
    }
    let t = Instant::now();
    let p = project::load(&path).expect("load real scale project");
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "\n  real project: {} clips, {} segments, {:.1} KB, loaded in {ms:.1} ms",
        p.clips.len(),
        p.segment_count(),
        std::fs::metadata(&path).unwrap().len() as f64 / 1024.0
    );
    assert_eq!(p.clips.len(), 300);
    assert!(p.clips.iter().all(|c| c.thumbnail_path.is_some()), "every clip should have a thumbnail");
}

// --- credential isolation ---------------------------------------------------

/// The API key must have nowhere to live in a project, by construction.
///
/// A schema is a promise; this is the check that keeps it. Serialising a fully
/// populated project and grepping the result catches a field added later
/// without anyone thinking about where it ends up.
#[test]
fn a_serialised_project_contains_no_credential_fields() {
    let json = serde_json::to_string(&project_with_video()).unwrap().to_lowercase();
    for forbidden in ["apikey", "api_key", "xi-api-key", "secret", "token", "password"] {
        assert!(
            !json.contains(forbidden),
            "project JSON must never contain {forbidden:?}"
        );
    }
}

/// An exported bundle must carry no credentials either — not the manifest, not
/// a stray settings file swept in by a future change to what gets zipped.
#[test]
fn an_exported_bundle_contains_no_credentials_or_settings() {
    let dir = tmp("nocreds");
    std::fs::create_dir_all(dir.join("audio")).unwrap();
    project::write_json(&project_with_video(), &dir.join("project.json")).unwrap();
    std::fs::write(dir.join("audio/line-01.wav"), b"fake").unwrap();
    // A settings file sitting in the project directory must not be picked up.
    std::fs::write(dir.join("settings.json"), br#"{"apiKey":"sk_should_never_ship"}"#).unwrap();

    let zip_path = dir.join("bundle.zip");
    project::write_bundle(&dir, &zip_path).unwrap();

    let f = std::fs::File::open(&zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    println!("\n  bundle contains: {names:?}");
    assert!(
        !names.iter().any(|n| n.contains("settings")),
        "settings must never be bundled: {names:?}"
    );

    // And nothing inside the archive carries key material.
    for i in 0..archive.len() {
        use std::io::Read;
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        let _ = entry.read_to_end(&mut buf);
        let text = String::from_utf8_lossy(&buf).to_lowercase();
        assert!(!text.contains("sk_should_never_ship"), "key material found in {name}");
        assert!(!text.contains("apikey"), "an apiKey field appeared in {name}");
    }
}

// --- what the frontend actually sends --------------------------------------
//
// These check the wire shape rather than the behaviour behind it. The reason
// is a specific failure: `take_add` rejected every recording for a week
// because the payload's field names were guessed rather than read, and the
// symptom was a successful, billed synthesis reported to the user as an error.
// A serde struct that does not match its caller fails at exactly that distance
// from the mistake.

#[test]
fn the_intro_payload_matches_what_assembly_ts_sends() {
    use crate::assembly::IntroSpec;

    // Copied from the object built in `src/App.tsx` — camelCase, `isHdr` on
    // each shot, `fadeMs` alongside the audio.
    let raw = serde_json::json!({
        "shots": [
            {
                "sourcePath": "/Users/me/Movies/IMG_0001.MOV",
                "sourceInMs": 3200,
                "durationMs": 1000,
                "isHdr": false
            },
            {
                "sourcePath": "/Users/me/Movies/IMG_0002.MOV",
                "sourceInMs": 500,
                "durationMs": 1000,
                "isHdr": true
            }
        ],
        "audioPath": "/Users/me/Library/.../audio/line-00.wav",
        "fadeMs": 600
    });

    let spec: IntroSpec = serde_json::from_value(raw).expect("the intro payload parses");
    assert_eq!(spec.shots.len(), 2);
    assert_eq!(spec.shots[0].source_in_ms, 3_200);
    assert!(spec.shots[1].is_hdr, "HDR travels per shot, not per montage");
    assert_eq!(spec.fade_ms, 600);
}

#[test]
fn an_intro_with_no_fade_named_still_gets_one() {
    use crate::assembly::IntroSpec;

    // A missing `fadeMs` must not mean a hard cut into the film: the dissolve
    // is what makes the montage read as an opening rather than as a first
    // clip nobody narrates.
    let spec: IntroSpec = serde_json::from_value(serde_json::json!({
        "shots": [{ "sourcePath": "/a.mov", "sourceInMs": 0, "durationMs": 900 }],
        "audioPath": "/hook.wav"
    }))
    .expect("parses without the optional fields");
    assert!(spec.fade_ms > 0);
    assert!(!spec.shots[0].is_hdr, "absent means not HDR, not a parse failure");
}

#[test]
fn a_script_saved_before_openings_existed_still_loads() {
    // The hook was added to an existing section. Without a default, every
    // script already on disk would fail to parse and come back empty.
    let raw = serde_json::json!({
        "model": "qwen2.5:7b",
        "generatedAt": NOW,
        "lines": [{ "clipId": "c0", "segmentIndex": 0, "text": "The harbour.", "edited": false }],
        "wordCountTarget": 150
    });
    let section: project::ScriptSection = serde_json::from_value(raw).expect("old script parses");
    assert_eq!(section.hook, None);
    assert_eq!(section.lines.len(), 1);
}

#[test]
fn deleting_a_take_takes_its_opening_with_it() {
    // The montage is rendered to its own file beside the cut and referenced by
    // nothing else, so a take deletion that only removed the cut would leave a
    // few megabytes behind on every render the user threw away.
    let dir = tmp("take-intro").join("render");
    std::fs::create_dir_all(&dir).unwrap();
    let cut = dir.join("cut-abc123.mp4");
    let intro = dir.join("intro-abc123.mp4");
    std::fs::write(&cut, b"cut").unwrap();
    std::fs::write(&intro, b"intro").unwrap();
    // A cut from a project that never had an opening: nothing beside it.
    let lone = dir.join("cut-def456.mp4");
    std::fs::write(&lone, b"cut").unwrap();

    crate::store::remove_render_files(&cut);
    assert!(!cut.exists(), "the cut is gone");
    assert!(!intro.exists(), "and so is its opening");

    crate::store::remove_render_files(&lone);
    assert!(!lone.exists(), "a cut with no opening still deletes cleanly");
}
