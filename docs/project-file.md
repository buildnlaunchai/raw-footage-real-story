# Project file format

`project.json` is the handoff between this desktop app and the v2 web timeline
editor. It is an interface between two codebases, so it is versioned and
documented rather than left implicit.

Written by `src-tauri/src/project.rs`. Keep this document and that file in step.

---

## The one rule that matters

**The timeline is stored explicitly, never derived.**

An importer must be able to place every clip on a timeline using only the
numbers in `timeline[]`. It must never re-run the app's duration reconciliation
to work out where things sit.

If the editor derived timings instead, any future change to the reconciliation
rules — a different tail length, a different minimum on-screen time — would
silently move every previously exported project. Storing absolute values makes
old projects immutable and correct forever, even as the app evolves.

---

## Encoding

- UTF-8 JSON, pretty-printed.
- All keys are `camelCase`.
- All durations and offsets are **integer milliseconds**.
- All paths are **relative to the project file**, using forward slashes on every
  platform, so a bundle written on Windows resolves in a browser.

## Versioning

`schemaVersion` is an integer, currently `1`. It increments only on breaking
changes. An importer should refuse a version it does not understand rather than
guess.

---

## Shape

```jsonc
{
  "schemaVersion": 1,

  "app": { "slug": "raw-footage-real-story", "version": "0.1.0" },

  "project": {
    "id": "uuid",
    "name": "Iceland trip",
    "createdAt": "2026-08-10T00:00:00Z",
    "updatedAt": "2026-08-10T00:00:00Z"
  },

  "clips": [
    {
      "id": "uuid",
      "sourcePath": "clips/placeholder-00.mp4",  // null if no media yet
      "sha256": "…",                             // null if no media
      "sourceDurationMs": 4700,                  // null if unknown
      "description": "Empty harbour, boats frozen in",
      "isPlaceholder": true
    }
  ],

  "script": {
    "model": "qwen2.5:7b",
    "generatedAt": "…",
    "lines": [{ "clipId": "uuid", "text": "The harbour lies still." }]
  },

  "audio": {
    "voice": "af_heart",
    "sampleRate": 24000,
    "lines": [
      {
        "clipId": "uuid",
        "path": "audio/line-01.wav",
        "durationMs": 4400,
        "skippedWords": ["Aqsa"]
      }
    ]
  },

  "timeline": [
    {
      "clipId": "uuid",
      "sourceInMs": 0,
      "sourceOutMs": 4700,
      "timelineStartMs": 0,
      "timelineDurationMs": 4700,
      "holdMs": 0,
      "fit": "trimmed"
    }
  ],

  "render": {
    "width": 1920, "height": 1080, "fps": 30,
    "vcodec": "h264", "acodec": "aac",
    "outputPath": "render/rough-cut.mp4"
  }
}
```

---

## Field notes

### `clips[]`

`sha256` lets an importer detect media that moved or changed underneath the
project, and say so, instead of failing obscurely on a missing or altered file.

`isPlaceholder` marks generated stand-in footage rather than real video. An
importer should treat placeholders as slots awaiting media, not as content.

### `audio.skippedWords`

Words the phonemiser could not pronounce, carried through from stage 2. They
were **left out of the audio**. Surfacing them lets the editor flag lines worth
rewording rather than rediscovering the problem by ear.

### `timeline[].fit`

Why the item is the length it is. This is what makes "restore original clip
length" implementable without guesswork.

| Value | Meaning |
|---|---|
| `exact` | Source was already the right length, or generated to order |
| `trimmed` | Source was longer than the narration; the tail was discarded |
| `held` | Source was shorter; its final frame is frozen for `holdMs` |

### `timeline[]` invariants

An importer may rely on all of these:

- Items are ordered by `timelineStartMs`, ascending.
- Items are contiguous and non-overlapping: each item's
  `timelineStartMs` equals the previous item's
  `timelineStartMs + timelineDurationMs`, and the first is `0`.
- `timelineDurationMs == (sourceOutMs - sourceInMs) + holdMs`.
- `holdMs > 0` if and only if `fit == "held"`.
- Every `clipId` in `timeline[]` has a matching entry in both `clips[]` and
  `audio.lines[]`.
- A clip with no narration line does not appear in `timeline[]` at all — there
  would be nothing to say over it.

Total runtime is the last item's `timelineStartMs + timelineDurationMs`.

---

## Timing model

Narration is the master clock. Each clip is on screen for its narration line's
duration plus a 300ms tail, floored at 1500ms so a very short sentence still
registers as a shot.

The voiceover is never time-stretched and never cut. A chopped or sped-up word
is noticed instantly; a trimmed shot essentially never is. An importer should
preserve this relationship by default and treat any change to it as a user
edit.

Constants live in `src-tauri/src/timeline.rs` (`TAIL_MS`, `MIN_ON_SCREEN_MS`).
They are *inputs* to the values stored here, not something to recompute from.

---

## Export forms

| Form | Contents | Use |
|---|---|---|
| **Bundle** (`.zip`, default) | `project.json` + `clips/` + `audio/` + `render/` | Portable, self-contained. The only form that round-trips into the web editor. |
| **Project only** (`.json`) | manifest alone | Small. References media by relative path, so it breaks if files move. |

Bundle layout mirrors the on-disk project directory exactly, so relative paths
in the manifest resolve identically whether read from the zip or the folder.
