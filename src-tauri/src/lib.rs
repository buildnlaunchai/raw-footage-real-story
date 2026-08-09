mod g2p;
mod ollama;
mod resources;
mod tts;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            tts::tts_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
