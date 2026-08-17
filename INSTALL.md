# Installing the beta

These builds are **unsigned**. Both macOS and Windows will warn you before they
let the app open, and the warnings are worded as though something is wrong with
the file. Nothing is wrong with it — signing certificates cost money per year
and we have not bought them yet, so the operating system has no way to check who
made this. Every unsigned app gets the same treatment.

You only have to get past the warning **once**. After that the app opens
normally.

---

## macOS

**Which file:** `Raw Footage, Real Story_0.1.0_aarch64.dmg`

**Apple Silicon only** — an M1, M2, M3 or M4 Mac, running macOS 11 or later.

This beta will not run on an Intel Mac. Not an oversight: the speech model this
app uses is built on ONNX Runtime, and the Rust binding for it publishes no
Intel-macOS build at all, so the app cannot be compiled for those machines
without changing how the model is loaded on every platform. If you have an
Intel Mac and want to test, say so — it is a decision about effort, not a
closed door.

To check which you have: Apple menu → About This Mac. "Apple M1" or later
is fine; "Intel" is not.

1. Open the `.dmg` and drag **Raw Footage, Real Story** into your Applications
   folder, then eject the disk image.
2. Open the app from Applications. macOS will refuse, saying it cannot verify
   the app is free of malware. Click **Done** — *not* "Move to Trash".
3. Open  **System Settings → Privacy & Security**, and scroll to the
   **Security** section near the bottom. There will be a line naming the app
   and a button: **Open Anyway**. Click it.
4. Confirm when asked, and enter your password or Touch ID.
5. The app opens, and every launch after this one is normal.

### If you are on macOS 14 Sonoma or earlier

There is a shortcut on older versions: **Control-click the app → Open**, then
click **Open** in the dialog. That is all.

This no longer works on macOS 15 Sequoia and later — Apple removed it
deliberately, so on 15, 26 and later you have to use the System Settings route
above. If you Control-click and see no usable **Open**, that is why; nothing is
broken.

### If macOS says the app is "damaged"

That message means the download was interrupted or the file was altered in
transit — it is a different problem from the one above, and there is no "Open
Anyway" for it. Delete the app and download the `.dmg` again.

---

## Windows

**Which file:** `Raw Footage, Real Story_0.1.0_x64-setup.exe` (about 87 MB)

64-bit Windows 10 or 11. It installs for your user only, so it does **not** ask
for an administrator password.

1. Run the installer. Windows SmartScreen will show a blue window headed
   **"Windows protected your PC"**, saying it prevented an unrecognised app
   from starting, with **Publisher: Unknown publisher**.
2. Click **More info** — the small link in the body of that window. It is easy
   to miss, and without it the only button is **Don't run**.
3. A **Run anyway** button appears. Click it.
4. The installer proceeds normally.

Your browser may also warn while downloading — Chrome and Edge sometimes label
unsigned installers as "not commonly downloaded". Choose **Keep** and continue.

If the app does not start after installing, install the Microsoft Edge WebView2
Runtime from Microsoft and try again. The installer carries it and should set it
up for you; this is only a fallback for older Windows 10 machines.

---

## First run: what the app needs

The app does most of its work on your own machine, so it needs two outside
tools. **You do not have to install either one to start** — the app checks for
them on first run and shows a setup screen with the exact command to paste, and
you can also skip both and use cloud services instead.

### ffmpeg — needed to build the video

This is the only genuinely required piece, and it is not bundled: ffmpeg is
licensed in a way that makes shipping it inside the app a decision we have not
made yet.

| | |
|---|---|
| macOS | `brew install ffmpeg-full` |
| Windows | `winget install -e --id Gyan.FFmpeg` |

Use `ffmpeg-full` on macOS rather than plain `ffmpeg`. The plain build is
missing the parts that handle HDR footage from newer phones, and without them
your video comes out grey and washed out.

The app finds it by itself afterwards. There is a **Re-check** button on the
setup screen if you install it while the app is open.

### Ollama — writes the script on your machine, for free

Optional. Install from [ollama.com](https://ollama.com) if you want script
writing to run locally at no cost. The app will offer to download the model it
needs.

If you would rather not, add an OpenAI API key in the app instead and skip
Ollama entirely.

### Narration voices

English narration works out of the box — the voice model and 55 voices are
inside the app already, nothing to install, no account, no internet.

**Bengali, Hindi, Arabic, Thai, Chinese and Japanese narration need an
ElevenLabs API key**, which you add in the app and which bills to your own
ElevenLabs account. The built-in voice model has no Bengali voice at all, so
the app will move you to ElevenLabs automatically when it sees a script in one
of those languages. This is a real limitation of the beta, not a bug.

---

## What to expect

Your footage is never uploaded anywhere. Video files are read where they sit
and are not copied into the app.

If you use the OpenAI or ElevenLabs options, only the **text** of your script
goes to those companies, under your own account. The app tells you on screen
before it sends anything.

---

## Reporting problems

Please include:

- Which operating system and version
- What you were doing, and what you expected instead
- The exact wording of any error message
- Roughly how many clips were in the project

Long films are where the interesting bugs live — if something breaks on a
fifty-clip project, that is worth reporting even if a short one works.
