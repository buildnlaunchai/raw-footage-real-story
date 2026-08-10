mod assembly;
mod assembly_tests;
mod ffmpeg;
mod g2p;
mod hdr_check;
mod ollama;
mod project;
mod store;
mod store_tests;
mod resources;
mod timeline;
mod tts;
mod voice_audition;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ollama::ollama_generate,
            ollama::ollama_health,
            tts::tts_list_voices,
            tts::tts_synthesize,
            tts::tts_preview,
            tts::tts_synthesize_line,
            assembly::ffmpeg_detect,
            assembly::ffmpeg_set_path,
            assembly::assembly_make_placeholders,
            assembly::assembly_render,
            assembly::assembly_import_media,
            assembly::assembly_consolidate_media,
            assembly::assembly_export_bundle,
            assembly::assembly_export_project_only,
            store::project_create,
            store::project_save,
            store::project_open,
            store::project_list,
            store::project_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
