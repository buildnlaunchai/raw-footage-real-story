mod readiness;
mod selftest;
mod assembly;
mod elevenlabs;
mod assembly_tests;
mod ffmpeg;
mod g2p;
mod hdr_check;
mod ollama;
mod openai;
mod project;
mod store;
mod store_tests;
mod subtitles;
mod resources;
mod secrets;
mod timeline;
mod tts;
mod voice_audition;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any window: a build that cannot find its own resources should say
    // so on a CI runner, not on a stranger's laptop.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest::run());
    }
    // `--probe-model <path>`: does ONNX Runtime survive this file?
    if let Some(i) = args.iter().position(|a| a == "--probe-model") {
        let path = args.get(i + 1).cloned().unwrap_or_default();
        let _ = resources::init_from_exe();
        std::process::exit(selftest::probe_model(&path));
    }


    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(tts::TtsState::default())
        .setup(|app| {
            // Where the bundled model, voices and lexicons live. In `tauri dev`
            // this path doesn't hold them, and `resources::root` falls back to
            // the crate directory in that case.
            if let Ok(dir) = app.path().resource_dir() {
                resources::init(dir.join("resources"));
            }
            // Loud on stderr rather than silent until first use. A packaging
            // mistake is not the user's to diagnose from "synthesis failed".
            if let Some(problem) = resources::problem() {
                eprintln!("resources unusable: {problem}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ollama::ollama_generate,
            ollama::ollama_health,
            tts::tts_list_voices,
            tts::tts_synthesize,
            tts::tts_preview,
            tts::tts_synthesize_line,
            secrets::secret_present,
            secrets::secret_set,
            secrets::secret_clear,
            elevenlabs::elevenlabs_voices,
            elevenlabs::elevenlabs_usage,
            elevenlabs::elevenlabs_test_key,
            elevenlabs::elevenlabs_synthesize,
            elevenlabs::elevenlabs_synthesize_line,
            openai::openai_generate,
            openai::openai_test_key,
            openai::openai_probe_sampling,
            assembly::ffmpeg_detect,
            assembly::ffmpeg_set_path,
            assembly::assembly_make_placeholders,
            assembly::assembly_render,
            assembly::assembly_plan,
            assembly::assembly_caption_cues,
            assembly::assembly_import_media,
            assembly::assembly_consolidate_media,
            assembly::assembly_export_bundle,
            assembly::assembly_export_project_only,
            store::project_create,
            store::project_save,
            store::project_open,
            store::project_list,
            store::project_delete,
            store::project_poster_from_frame,
            store::project_poster_from_image,
            store::project_clear_poster,
            store::storage_usage,
            store::library_list,
            store::clip_set_favorite,
            store::clip_set_deleted,
            store::clip_purge,
            store::clip_set_description,
            store::clip_set_segments,
            store::clip_reorder,
            store::clip_backfill_capture,
            store::allow_media,
            tts::narration_concat,
            assembly::save_video_as,
            store::take_add,
            store::take_delete,
            store::take_list,
            store::writing_instructions_get,
            store::writing_instructions_set,
            store::intro_enabled_get,
            store::intro_enabled_set,
            store::machine_user,
            readiness::readiness_probe,
            readiness::run_installer,
            readiness::ollama_pull
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
