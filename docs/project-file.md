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
- Paths use forward slashes on every platform, so a bundle written on Windows
  resolves in a browser.
- **In a bundle, every path is relative** to the project file. Importers may
  rely on this.
- A *working* `project.json` inside the app's own project folder may hold
  **absolute** `clips[].sourcePath` values. Imported video is referenced where
  it sits rather than copied, so that importing 40GB of footage is instant. The
  bundle export copies those files in and rewrites the paths, which is what
  makes the invariant above hold for the interchange format specifically.

## Versioning

`schemaVersion` is an integer, currently **`2`**. It increments only on breaking
changes. An importer should refuse a version it does not understand rather than
guess.

### What changed in v2

Two breaking changes, both driven by the product becoming "one project, many
videos cut from one library":

1. **A clip's description became an ordered list of timestamped segments.**
   Selecting story material needs the eight seconds of a plane landing without
   the ninety seconds of taxiing after it, which a single flat description
   cannot express.
2. **A project holds many videos.** `script`, `audio`, `timeline` and `render`
   moved off the project and onto entries in a `videos[]` array.

v1 files are migrated on load rather than rejected: a flat `description` becomes
one segment spanning the whole clip, which preserves its meaning exactly, and
the single v1 video becomes `videos[0]` with its selection reconstructed from
its timeline.

---

## Shape

```jsonc
{
  "schemaVersion": 2,

  "app": { "slug": "raw-footage-real-story", "version": "0.1.0" },

  "project": {
    "id": "uuid",
    "name": "Iceland trip",
    "createdAt": "2026-08-10T00:00:00Z",
    "updatedAt": "2026-08-10T00:00:00Z"
  },

  // The clip library. Described once, reused by every video.
  "clips": [
    {
      "id": "uuid",
      "sourcePath": "clips/placeholder-00.mp4",  // null if no media yet
      "sha256": "…",                             // null if no media
      "sourceDurationMs": 47000,                 // null if unknown
      "isPlaceholder": false,
      "fileName": "IMG_4021.MOV",
      "thumbnailPath": "thumbs/000.jpg",
      "isHdr": true,
      // Contiguous and gapless, ordered by startSec.
      "segments": [
        { "startSec": 0,  "endSec": 8,  "text": "plane landing at sunrise" },
        { "startSec": 8,  "endSec": 47, "text": "frost forming on the window" }
      ]
    }
  ],

  // Each video cut from the library above.
  "videos": [
    {
      "id": "video-1",
      "title": "Frozen Harbour",
      "createdAt": "…", "updatedAt": "…",

      // The chosen moments, in story order — not clip order.
      "selection": [{ "clipId": "uuid", "segmentIndex": 1 }],

      "script": {
        "model": "qwen2.5:7b",
        "generatedAt": "…",
        "wordCountTarget": 150,
        "lines": [
          { "clipId": "uuid", "segmentIndex": 1,
            "text": "The harbour lies still.", "edited": false }
        ]
      },

      "audio": {
        "voice": "af_heart",
        "sampleRate": 24000,
        "lines": [
          { "clipId": "uuid", "segmentIndex": 1,
            "path": "audio/line-01.wav", "durationMs": 4400,
            "skippedWords": ["Aqsa"] }
        ]
      },

      "timeline": [
        {
          "clipId": "uuid",
          "sourceInMs": 8000,      // where the chosen segment starts
          "sourceOutMs": 12700,
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
      },

      // word -> respelling, for words the phonemiser could not pronounce.
      "pronunciations": { "reykjavik": "rake see vik" }
    }
  ]
}
```

---

## Field notes

### `clips[]`

`sha256` lets an importer detect media that moved or changed underneath the
project, and say so, instead of failing obscurely on a missing or altered file.

`isPlaceholder` marks generated stand-in footage rather than real video. An
importer should treat placeholders as slots awaiting media, not as content.

`segments[]` are **contiguous and gapless**, ordered by `startSec`, together
covering the whole clip. The editor that produces them only lets users mark
boundaries, never ranges, so a gap or an overlap is not representable. An
importer may rely on that, and a clip with no segments is simply undescribed.

### `videos[]`

A project is a library; each entry here is one video cut from it. They share the
clips and nothing else — separate selection, script, audio, timeline, render and
pronunciation corrections.

`selection[]` is the chosen moments **in story order**, which is generally not
clip order. It is what `timeline[]` is built from.

`pronunciations` maps a lowercased word to an ordinary-spelling respelling
("rake see vik"), not to IPA. Corrections live per video because how a word
should sound in this narration is a creative choice about this video, not a fact
about the footage.

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
  `audio.lines[]`, and its `segmentIndex` is valid for that clip.
- `sourceInMs` is where the chosen *segment* begins, which is non-zero whenever
  a story uses a moment from partway into a clip.
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
| **Bundle** (`.zip`, default) | `project.json` + `clips/` + `audio/` + `render/` + `thumbs/` | Portable, self-contained. The only form that round-trips into the web editor. |
| **Project only** (`.json`) | manifest alone | Small. Media paths may be absolute and machine-specific, so it does not travel. |

Writing a bundle copies any externally-referenced media into `clips/` and
rewrites `sourcePath` to match, so the "every path is relative" invariant holds
regardless of what the working project looked like.

If a referenced file has gone missing by export time, its `sourcePath` is set to
`null` rather than shipped as a path that resolves to nothing — an importer can
then show that clip as media-offline instead of failing obscurely.
