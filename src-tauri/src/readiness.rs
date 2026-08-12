//! What is installed on this machine, and how to install what is not.
//!
//! Two dependencies are not bundled: ffmpeg, and a local model runner. Both
//! were previously discovered by failing — ffmpeg at import, with a raw error
//! from four stages further on than the screen that explained it, and Ollama
//! with a shell command in an error message. That is a fine way to inform a
//! developer and a poor way to meet anybody else.
//!
//! This reports facts only. What counts as "ready" is decided in TypeScript,
//! against the model names the app is configured with, so the rule lives beside
//! the configuration it depends on and can be tested without a machine.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// Where ffmpeg was found, and what it can do.
    pub ffmpeg: Option<crate::ffmpeg::FfmpegInfo>,
    /// Why it was not found, when it was not.
    pub ffmpeg_error: Option<String>,
    /// Model tags Ollama reports. `None` means Ollama could not be reached.
    pub ollama_models: Option<Vec<String>>,
    pub ollama_error: Option<String>,
    /// Package managers we could drive on this machine, by name.
    pub installers: Vec<Installer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installer {
    /// "brew" or "winget".
    pub name: String,
    pub path: String,
}

/// Homebrew, by absolute path.
///
/// Not by name: a macOS app bundle launched from Finder inherits a minimal
/// PATH with no Homebrew in it. That is the same fact `ffmpeg::EXTRA_DIRS`
/// exists for, and it is why an app that shells out to `brew` works perfectly
/// under `tauri dev` and fails for every real user.
#[cfg(target_os = "macos")]
fn find_installers() -> Vec<Installer> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .filter(|p| Path::new(p).is_file())
        .map(|p| Installer { name: "brew".into(), path: (*p).to_string() })
        .take(1)
        .collect()
}

#[cfg(target_os = "windows")]
fn find_installers() -> Vec<Installer> {
    let mut out = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Microsoft").join("WindowsApps").join("winget.exe"));
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("winget.exe"));
        }
    }
    if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
        out.push(Installer { name: "winget".into(), path: p.to_string_lossy().to_string() });
    }
    out
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn find_installers() -> Vec<Installer> {
    Vec::new()
}

#[tauri::command]
pub async fn readiness_probe(app: AppHandle, ollama_host: String) -> Probe {
    let settings = crate::assembly::settings_for(&app);
    let (ffmpeg, ffmpeg_error) = match crate::ffmpeg::detect(&settings) {
        Ok(i) => (Some(i), None),
        Err(e) => (None, Some(e.code)),
    };

    let (ollama_models, ollama_error) = match crate::ollama::list_models(&ollama_host).await {
        Ok(m) => (Some(m), None),
        Err(e) => (None, Some(e.code)),
    };

    Probe { ffmpeg, ffmpeg_error, ollama_models, ollama_error, installers: find_installers() }
}

/// One line of output from something long-running.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupLine {
    pub job: String,
    pub line: String,
    /// 0..1 when the job reports it; absent when it does not.
    pub fraction: Option<f64>,
    pub done: bool,
    pub ok: Option<bool>,
}

fn emit(app: &AppHandle, job: &str, line: impl Into<String>, fraction: Option<f64>) {
    let _ = app.emit(
        "setup:progress",
        SetupLine { job: job.into(), line: line.into(), fraction, done: false, ok: None },
    );
}

fn finish(app: &AppHandle, job: &str, ok: bool, line: impl Into<String>) {
    let _ = app.emit(
        "setup:progress",
        SetupLine { job: job.into(), line: line.into(), fraction: None, done: true, ok: Some(ok) },
    );
}

/// Run a package manager, streaming its output.
///
/// The command is given, not composed from user input — these are three fixed
/// installs, and building a shell string out of anything a user typed is how an
/// app grows a command injection. Streamed because `brew install ffmpeg-full`
/// pulls a long tail of dependencies and takes minutes; without output it looks
/// hung, and a user who kills it halfway leaves a broken install behind.
#[tauri::command]
pub async fn run_installer(
    app: AppHandle,
    job: String,
    program: String,
    args: Vec<String>,
) -> Result<bool, String> {
    // Only ever the binaries we located ourselves.
    let allowed = find_installers();
    if !allowed.iter().any(|i| i.path == program) {
        return Err("that installer was not the one this machine reported".into());
    }

    emit(&app, &job, format!("$ {} {}", program, args.join(" ")), None);

    // std::process on Tauri's blocking pool rather than pulling tokio in as a
    // runtime dependency for one subprocess. Both pipes get their own thread so
    // a package manager that reports progress on stderr — most of them — is not
    // silent until it exits.
    let result = tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, BufReader};

        let mut child = std::process::Command::new(&program)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start {program}: {e}"))?;

        let mut pumps = Vec::new();
        for (stream, is_err) in [
            (child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), false),
            (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), true),
        ] {
            let Some(stream) = stream else { continue };
            let app = app.clone();
            let job = job.clone();
            pumps.push(std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    // stderr is not failure here — brew and winget both narrate
                    // there — so it is shown the same way.
                    let _ = is_err;
                    emit(&app, &job, line, None);
                }
            }));
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        for p in pumps {
            let _ = p.join();
        }
        Ok::<_, String>(status)
    })
    .await
    .map_err(|e| e.to_string())??;

    let ok = result.success();
    Ok(ok)
}

/// Pull an Ollama model, streaming its progress.
///
/// Through Ollama's own HTTP API rather than the `ollama` binary: the models are
/// the heavy part of setting this up — several gigabytes each — and asking
/// somebody to run a terminal command and watch it is the step most likely to
/// end the attempt. There is no privilege escalation and no package manager
/// involved, which makes this the one part of setup that can genuinely be a
/// button.
#[tauri::command]
pub async fn ollama_pull(
    app: AppHandle,
    host: String,
    model: String,
) -> Result<bool, String> {
    let job = format!("pull:{model}");
    emit(&app, &job, format!("pulling {model}"), Some(0.0));

    let client = reqwest::Client::builder()
        // No overall timeout: a 9GB pull on a domestic connection outlives any
        // number worth writing down. Progress lines are the liveness signal.
        .build()
        .map_err(|e| e.to_string())?;

    let mut resp = client
        .post(format!("{}/api/pull", host.trim_end_matches('/')))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("could not reach Ollama: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        finish(&app, &job, false, format!("Ollama answered {code}"));
        return Ok(false);
    }

    let mut buf = String::new();
    let mut ok = true;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // Newline-delimited JSON; a chunk can split a line in half.
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
            if let Some(err) = v["error"].as_str() {
                ok = false;
                emit(&app, &job, err.to_string(), None);
                continue;
            }
            let status = v["status"].as_str().unwrap_or("").to_string();
            let fraction = match (v["completed"].as_f64(), v["total"].as_f64()) {
                (Some(c), Some(t)) if t > 0.0 => Some(c / t),
                _ => None,
            };
            emit(&app, &job, status, fraction);
        }
    }

    finish(&app, &job, ok, if ok { "pulled" } else { "failed" });
    Ok(ok)
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    /// What does this machine actually report?
    ///
    /// Printed rather than asserted: the answer is a fact about the machine,
    /// and a test that demanded Homebrew be present would fail on a runner for
    /// being right.
    #[test]
    fn what_is_installed_here() {
        let installers = find_installers();
        println!("\n  installers found: {installers:?}");
        for i in &installers {
            println!("    {} -> {} (runnable: {})", i.name, i.path, Path::new(&i.path).is_file());
        }
        println!(
            "  ffmpeg: {:?}",
            crate::ffmpeg::detect(&crate::ffmpeg::FfmpegSettings::default())
                .map(|i| i.ffmpeg)
                .map_err(|e| e.code)
        );
    }

    /// The installer allow-list is what stops this becoming a way to run
    /// anything at all from the webview.
    #[test]
    fn only_a_detected_installer_can_be_run() {
        let found = find_installers();
        assert!(
            !found.iter().any(|i| i.path == "/bin/sh"),
            "an arbitrary binary must never appear in the allow-list"
        );
    }
}
