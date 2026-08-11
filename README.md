# Raw Footage, Real Story

A desktop app that turns a pile of raw travel footage into a narrated rough cut.

You add your clips, write a one-line description of what's in each, and the app
writes a narration script, speaks it, and assembles the clips underneath it. Every
step runs **locally on your own machine** — no upload, no cloud processing, no
subscription, and nothing leaves your computer.

Part of the [Build & Launch AI](https://www.buildnlaunchai.com) ecosystem.
See `TEMPLATE.md` for the ecosystem rules this repo follows.

---

## Status

**Working end to end.** Import footage, describe it, generate a script, record a
narration and render a rough cut — all of it runs. Cloud providers (OpenAI for
scripts, ElevenLabs for voices) are optional and bring-your-own-key.

Packaging is in progress: CI builds unsigned installers for macOS and Windows.
Unsigned means both operating systems will warn before opening the app — see
`INSTALL.md`.

---

## How it works

```
clips + per-clip descriptions
        ↓  local LLM (Ollama)
   narration script
        ↓  local TTS
   voiceover audio
        ↓  local ffmpeg
   rough-cut video + project file
```

Matching is **clip-level**: each script sentence is paired with the clip whose
description fits it best, and the clips are ordered accordingly. It is deliberately
not frame-accurate auto-editing — the rough cut is a starting point you finish by
hand.

---

## Why a desktop app

All the heavy lifting is local inference and video encoding: LLM generation, TTS
synthesis, and ffmpeg muxing. Running that on a server would mean uploading gigabytes
of personal footage and paying for GPU time. Tauri (not Electron) keeps the bundle
small and lets those tools be invoked as ordinary local processes.

---

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| Node.js 18+ | frontend build | `node -v` |
| Rust + Cargo (stable) | Tauri builds the native shell | `cargo --version` |
| Xcode Command Line Tools (macOS) | native linker | `xcode-select -p` |
| ffmpeg + ffprobe | video assembly | `ffmpeg -version` |
| Ollama | local script generation | `ollama --version` |
| A local TTS engine | voiceover | see below |

Rust: install from <https://www.rust-lang.org/tools/install>.
Ollama: install from <https://ollama.com/download>, then pull a model.

ffmpeg — use the **full** build. The plain formula omits libzimg, so it has no
`zscale` and cannot tone-map HDR footage, which most phone video now is:

| macOS | `brew install ffmpeg-full` |
| Windows | `winget install -e --id Gyan.FFmpeg` |
| Linux | `sudo apt install ffmpeg` |

Neither ffmpeg nor Ollama is bundled. The app detects both and tells you what is
missing; the cloud providers need neither.

---

## First build: fetch the model

The Kokoro speech model is **not in the repo**. Fetch it once:

```bash
./scripts/fetch-model.sh
```

82MB, pulled from Hugging Face, pinned to a revision and checked against a
SHA-256 before it is accepted. It is gitignored, so this is a one-time step per
clone (the script is a no-op once the file is present and correct).

Why not in the repo: at 82MB it burned GitHub's free 1GB/month LFS bandwidth in
about four releases, and a throttled LFS repo stops serving clones to everyone.
The 55 voice packs (28MB) do stay in LFS, so a clone still needs `git lfs`
installed. `npm run tauri dev` will fail with a resource error if you skip this
step; `./src-tauri/target/debug/raw-footage-real-story --selftest` says exactly
what is wrong.

---

## Run it locally

```bash
npm install
cp .env.example .env.local     # then fill in the values, each is commented
npm run tauri dev              # native app window
```

`npm run dev` alone runs only the web frontend in a browser — useful for UI work,
but anything that touches the local pipeline needs the Tauri shell.

## Build a distributable

```bash
./scripts/fetch-model.sh    # once
npm run tauri build
```

Produces a `.dmg` on macOS and an NSIS `.exe` on Windows, in
`src-tauri/target/release/bundle/`.

Verify a build before trusting it:

```bash
"src-tauri/target/release/bundle/macos/Raw Footage, Real Story.app/Contents/MacOS/raw-footage-real-story" --selftest
```

This loads the bundled model, phonemises a sentence and synthesises it. A bundle
missing its resources is still a valid bundle that builds and launches, so
"it compiled" is not evidence the app works — this is.

## Releasing

CI builds both platforms on a version tag and attaches the installers to a
**draft** release for review.

```bash
npm version patch     # or minor / major — updates package.json
git push && git push --tags
```

`src-tauri/tauri.conf.json` reads its version from `package.json`, so there is
one number to bump. `workflow_dispatch` runs the same build without touching
releases, for checking a change before tagging.

---

## Configuration

Every configurable value is an environment variable — nothing is hardcoded. Copy
`.env.example` to `.env.local` and fill it in; each variable is explained inline in
that file. `.env.local` is gitignored and must never be committed.

Note that `VITE_`-prefixed variables are the ones readable from the React frontend;
the rest are for the Rust side.

---

## Repo layout

```
src/                 React + TypeScript frontend
src-tauri/           Rust shell — process invocation, filesystem, ffmpeg calls
src-tauri/tauri.conf.json   window, bundle, and app identity config
scripts/preflight.sh Fails if a secret-shaped string is committed or .env.example drifts
.env.example         Every variable, blank, one comment per line
TEMPLATE.md          Build & Launch AI ecosystem rules — do not delete
```

---

## Scope

**v1 (this repo, now):** clip upload + descriptions, script generation, voiceover
generation, clip-level rough-cut assembly, export of the video plus a project file.

**Out of scope for v1:** frame-accurate auto-editing, scene detection, and the
web timeline editor.

**v2 (separate repo):** a browser-based timeline editor on the hub that imports the
project file this app exports and takes it to a finished edit. Hub embedded-mode
integration (signed JWT, `aud` enforcement, cookie transport — see `TEMPLATE.md`)
also lands then. The code here keeps that seam clear rather than implementing it.
