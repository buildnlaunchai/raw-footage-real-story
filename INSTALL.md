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

**Which file:** `Raw Footage, Real Story_0.2.0_aarch64.dmg`

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

**Which file:** `Raw Footage, Real Story_0.2.0_x64-setup.exe` (about 87 MB)

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

## Signing in

This build asks you to sign in before it opens. You need a **BuildnLaunchAI
account with an active subscription** — the app opens your browser to sign in,
and never sees your password.

**You have to be online the first time.** After that the app keeps working
offline for up to a month, so a trip with no usable wifi is not a problem; it
starts reminding you to connect about a week before that runs out. Even past
it, your existing projects still open and still export — only starting new work
waits for a connection.

### Your OpenAI and ElevenLabs keys live on your account too

If you use either cloud service, its key is held against your BuildnLaunchAI
account rather than typed into the app. There is no key box on this build and
nothing kept on your computer — the app fetches the key for each session and
forgets it when you quit.

That means one key works on every machine you sign in on, and revoking it on
your dashboard takes effect everywhere at once rather than leaving a copy live
in a keychain somebody has to remember to clear.

Where a key is missing, or where you have not yet allowed the app to use one,
the screen says which of those it is and gives you a button straight to the
page that fixes it. Neither service is required: script writing runs locally
through Ollama, and English narration uses the voices built into the app.

### If it asks you to sign in again after an update

That is expected on this beta, and it is the same root cause as the warnings
above: the app is unsigned, so macOS does not reliably recognise a new version
as the same application that saved your sign-in. Signing in again is all it
needs, and it will stop happening once the app is properly signed. Worth
reporting only if it happens on *every* launch rather than after an update.

### If it will not let you in, read which message it is

The sign-in screen says something different for each reason, because the way
out is different for each:

| What it says | What it means |
|---|---|
| No subscription on this account yet | You have never subscribed. The **See plans** button is the whole fix. |
| Your membership ended on *(date)* | It lapsed on that date. **Renew membership** picks it back up. |
| Your account has been suspended | Not something paying again will fix — and paying again on a suspended account takes the money and changes nothing. Email **support@buildnlaunchai.com**. |
| We couldn't give this account access | A fault at our end, not a billing problem. There is nothing for you to pay. Email **support@buildnlaunchai.com** and we will fix it. |

The last two are the ones worth writing in about. The app shows the right one
of these offline as well as online, so a message you get on a plane is the same
message you would have got at your desk.

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

If you would rather not, link an OpenAI key to your BuildnLaunchAI account
instead and skip Ollama entirely. Keys are managed on your account rather than
typed into the app, so one key works on every machine you sign in on — the app
has a button that takes you straight to the page.

### Narration voices

English narration works out of the box — the voice model and 55 voices are
inside the app already, nothing to install, no account, no internet.

**Bengali, Hindi, Arabic, Thai, Chinese and Japanese narration need an
ElevenLabs key**, linked to your BuildnLaunchAI account and billing to your own
ElevenLabs account. As with OpenAI, the key lives on your account rather than on
this computer; the app links out to the page where you manage it. The built-in
voice model has no Bengali voice at all, so
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
