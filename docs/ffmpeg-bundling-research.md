# Bundling ffmpeg

Research into shipping our own ffmpeg build, so that installing ffmpeg stops
being something we ask a new user to do. Written 21 August 2026, against
v0.3.0.

**Status: backlog, blocked on legal review.** Nothing here has been built and
nothing should be, until counsel has answered the questions in
[Memo for counsel](#memo-for-counsel).

Updated 21 August 2026 with [§7](#7-route-c-examined-os-native-encoders), a
detailed examination of Route C — calling the operating system's own H.264
encoder instead of redistributing any codec. **Route C is the recommended
direction**, and Route C on macOS has now been built and measured
([§7.7](#77-the-build-as-built)). It is a build-and-measure exercise: the
binary is not going into an installer, and the branch is not merged or tagged,
until counsel has answered.

**Two questions are open, and they are not equally understood.** Route C
removes two of the original three legal questions and leaves the AVC
field-of-use one, which the product already faces today. It also surfaces a
question nobody had asked, and which applies to every route: bundling ffmpeg
means shipping an **HEVC decoder**, which has its own patent pools and is
unavoidable for this app's input footage. That one is newly-created exposure,
not pre-existing, which is why it is treated as the more serious of the two.
Both are set out in full in the [memo for counsel](#memo-for-counsel), which is
written to be read on its own.

---

## The one thing that matters

**The GPL problem and the patent problem are two different problems, and
swapping encoders only solves the first one.**

The project's aversion to ffmpeg has always been stated as a GPL question:
typical builds use libx264, libx264 is GPL, and this codebase has kept GPL out
(espeak-ng was rejected on the same grounds). That framing is correct as far as
it goes, and OpenH264 does answer it — it is two-clause BSD, it sits in
ffmpeg's ordinary `EXTERNAL_LIBRARY_LIST` rather than `EXTERNAL_LIBRARY_GPL_LIST`,
and a `--disable-gpl` build with `--enable-libopenh264` is a well-trodden
configuration.

But GPL is a *copyright* licence on one encoder's source. The H.264/AVC patent
pool covers the *bitstream*, and applies identically whichever encoder produced
it — x264, OpenH264, or one we wrote ourselves. Today the app ships no H.264
encoder at all; it calls one the user installed. **That, and not the licence
choice, is why none of this has ever come up.** Bundling any encoder is what
creates the exposure.

OpenH264 is interesting because Cisco pays the pool on behalf of redistributors
of its compiled binary. That offer has conditions, and the first one rules out
bundling.

### And the encoder is only half of it

**Bundling ffmpeg also means shipping an HEVC *decoder*, and that is the
exposure this project would be newly creating rather than inheriting.**

Every route in this document — A, B and C alike — has to decode HEVC, because
that is what phones record: 107 of the 145 clips in the development library.
Access Advance licenses HEVC decoders "installed in devices or software at the
time of First Sale" and says a licence is most likely needed by anyone selling
products with HEVC decoding functionality.

The AVC question is one the product already lives with, since the app already
encodes H.264 through the user's own ffmpeg. **The HEVC question is not.** Both
are in the [memo for counsel](#memo-for-counsel); if only one of them gets
attention, it should be this one. See [§7.4](#74-the-problem-route-c-does-not-solve-hevc-decode).

---

## 1. Feasibility: can it be built, and what is lost

Yes, routinely. The encoder's limits are concrete, read from ffmpeg's
`libavcodec/libopenh264enc.c`:

| | libx264 (today) | libopenh264 |
|---|---|---|
| Rate control | CRF, ABR, CBR, 2-pass | Bitrate-target only (`rc_mode` of off / quality / bitrate / buffer / timestamp). **No CRF.** |
| B-frames | Yes, adaptive | **None.** No `max_b_frames` on the wrapper. |
| Pixel formats | 8/10/12-bit, 4:2:0 to 4:4:4 | `yuv420p` and `yuvj420p` only |
| Profiles | baseline to high444 | constrained_baseline, main, high |
| Speed presets | ultrafast to placebo | no equivalent knob |

**The HDR bar is not affected.** Tone-mapping happens upstream in the filter
graph — `zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
— and what reaches the encoder is already 8-bit BT.709. OpenH264's 8-bit-only
limit therefore costs nothing here, and libzimg, which does the actual colour
work, is untouched by any of this.

**The render command is affected.** Both paths in `ffmpeg.rs` use
`-c:v libx264 -preset veryfast -crf 20`. CRF has no OpenH264 equivalent, so
quality would become a bitrate target — no longer resolution- and
content-adaptive, but a number we pick per output size. That is a product
change, not a flag swap.

### On quality, and what is not being asserted

The reputation is accurate in direction. OpenH264 was built for real-time
WebRTC, and the public comparisons that exist — the most-cited being
[cisco/openh264#2949](https://github.com/cisco/openh264/issues/2949) — describe
visibly worse output than x264 at matched bitrate, with blocking and motion
artefacts that raising the bitrate did not fully close.

**No current, rigorous BD-rate comparison was found.** The ones that exist are
single-user, low-bitrate, small-frame tests from several years ago, and
OpenH264 has had rate-control work since (through v2.6.0, February 2025). The
direction is known; the magnitude is not, and the magnitude is the only part
that decides anything.

Before this is decided: encode the same three HDR clips through the existing
graph twice — once `libx264 -preset veryfast -crf 20`, once `libopenh264` at
the bitrate that file lands on — and compare VMAF and file size. That is an
afternoon, and it does not depend on the legal answer, so it can run in
parallel with the review.

---

## 2. Licence audit: the licence is fine, the patent arrangement is not

OpenH264's **source** is two-clause BSD. Its **binary**, as distributed by
Cisco, carries Cisco's AVC/H.264 Patent Portfolio Licence from MPEG LA at no
cost to the redistributor — provided four conditions are met. The first:

> The Cisco-provided binary is separately downloaded to an end user's device,
> and **not integrated into or combined with third party software prior to
> being downloaded.**

The other three: the user must be able to enable, disable and re-enable its
use; the software must display "OpenH264 Video Codec provided by Cisco Systems,
Inc."; and the full licence text must be reproduced in the EULA or licensing
information.

**Bundling OpenH264 inside our installer fails the first condition on its
face.** This is not a grey area. It is the exact reason Firefox downloads the
codec from Cisco at runtime rather than shipping it, and Mozilla says so
openly. A build we compile and ship is, by construction, "combined with third
party software prior to being downloaded".

Fall outside Cisco's offer and the position reverts to the default: whoever
distributes an H.264 encoder is who the pool looks to. Via LA administers that
programme now and has been visibly raising prices — the streaming tier moved
from a flat $100,000 cap to as much as $4.5m/year for new licensees in 2026.
That figure is for content distribution and does not apply to us, but the
direction of travel is not friendly.

---

## 3. The rest of the dependency chain

**libzimg is WTFPL** — permissive to the point of being a joke about
permissiveness, and unambiguously fine to bundle. It carries no GPL flag in
ffmpeg's configure and the shared library measures 380 KB on arm64. High
confidence; still worth eyeballing the `LICENSE` file of the exact tag we
build, which is a thirty-second check rather than a research question.

**This codebase does not use libass or libfreetype.** Captions are drawn by
the app's own webview and composited as pictures through `overlay`, because
both ffmpeg text filters render Bengali wrong — `drawtext` misplaces the vowel
signs and libass does no complex shaping at all. That decision, made for
typography, removes the whole LGPL/FTL text-shaping subtree from this audit: no
libass, no FreeType, no HarfBuzz, and critically **no FriBidi, which is LGPL**
and would have been the one genuinely awkward static-linking obligation in the
set.

What is left, derived from every ffmpeg call site in `ffmpeg.rs`,
`assembly.rs` and `elevenlabs.rs`:

| Component | Role | Licence |
|---|---|---|
| ffmpeg core | everything | LGPL 2.1+ with `--disable-gpl --disable-nonfree --disable-version3` |
| libzimg | `zscale`, HDR tone-mapping | WTFPL |
| H.264 encoder | final render | **the open question — see §2 and §6** |
| native AAC encoder | `-c:a aac`, 192k | LGPL, in-tree (not FDK) |
| native h264 / hevc / prores decoders | reading phone footage | LGPL, in-tree |
| zlib | mov/mp4 handling | zlib licence |

Nothing in that set reintroduces a GPL or otherwise restrictive component. It
is a genuinely permissive build.

**That table is about copyright, and it is silent about patents — which is a
gap, not a clean bill of health.** The "native h264 / hevc / prores decoders"
line is LGPL and therefore free to redistribute as *code*; it says nothing
about the HEVC patent pool, which licenses decoders in software at first sale.
See [§7.4](#74-the-problem-route-c-does-not-solve-hevc-decode), which is the
more serious of the two patent questions in this document.

### The LGPL detail, and the easy way out

ffmpeg itself stays LGPL, which carries a relinking obligation. Ship ffmpeg as
**shared libraries next to the executable** rather than one static binary and
that obligation is satisfied trivially — a user can replace `libavcodec.dylib`
themselves. Publishing the exact source tarball and build script alongside
costs nothing and closes it completely. Static linking is also compliant but
needs more care for very little gain.

### Worth noticing about today

The build the setup screen currently recommends — `brew install ffmpeg-full` —
is configured `--enable-gpl --enable-version3`, so it is GPLv3 software. The
project has been avoiding GPL *distribution*, not GPL *use*, and the
distinction has been doing real work. Nothing changes about that if we keep
asking the user to install it. Everything changes the moment we ship it
ourselves.

---

## 4. Maintenance: this is not a one-time build

**This is the strongest argument against bundling, and it is not a licensing
argument.**

The instinct to vendor a binary once and commit it does not survive contact
with ffmpeg's CVE record. ffmpeg had **25 CVEs published in 2025 and 7 already
in 2026**. The most recent is not theoretical:

> **CVE-2026-8461, CVSS 8.8** — out-of-bounds write in the MagicYUV decoder in
> `libavcodec`. Denial of service and remote code execution. Patched in ffmpeg
> 8.1.2, which is the version currently installed on the development machine.

This matters more here than in most products, because ffmpeg is the component
that parses **files the user hands it from anywhere**. Right now that risk sits
with Homebrew and winget, which patch it without us being involved. Bundle it
and the risk moves to us, along with the duty to ship an update when the next
one lands.

What the ongoing work actually looks like:

- **Two platforms, two toolchains.** macOS arm64 (the release workflow builds
  host-target only; the universal build was tried and abandoned) and Windows
  x64. Two CI jobs, two sets of build scripts, two sets of signing.
- **Reproducibility.** The build has to be scripted and pinned, or nobody can
  rebuild it in a hurry six months from now, when it will be needed in a hurry.
- **A watch on releases.** ffmpeg point releases arrive irregularly — 8.0 in
  August 2025, 8.0.1 in November, 8.1.2 with the urgent patch. Somebody has to
  be subscribed to <https://ffmpeg.org/security.html> and act on it.
- **Licence paperwork.** An about-box or licensing page reproducing the LGPL
  text, the zimg licence, and — if OpenH264 is used — Cisco's required
  attribution.

Rough shape: **2–5 days per platform** to get a reproducible build into CI,
then **a few hours per rebuild**, needed perhaps quarterly plus whenever a
high-severity CVE lands. It is not enormous. It is permanent.

**The minimal build in §6 is a security argument, not only a size one.** The
MagicYUV decoder is not something this app will ever need. A build configured
`--disable-everything` and re-enabled component by component would not have
contained that decoder, and so would not have been affected by CVE-2026-8461 at
all. Most ffmpeg CVEs live in obscure decoders and demuxers; cutting them out
cuts the patching obligation down with them.

---

## 5. Size

Measured on the development machine, Homebrew's `ffmpeg-full` — every codec and
filter ffmpeg has — is about **17 MB of ffmpeg shared libraries**
(`libavcodec` alone is 10 MB), before its external dependencies.

| Shape | Per platform | Note |
|---|---|---|
| Minimal shared build + `ffprobe` | ~8–14 MB | the recommendation |
| libzimg | ~0.4 MB | measured, arm64 dylib |
| OpenH264, if used | ~1–2 MB | Cisco's module, per arch |
| General-purpose LGPL build | ~25–40 MB | for comparison |

So **10–16 MB per installer** for the minimal route. Against
`src-tauri/resources`, already **124 MB** of which the Kokoro voice model is
116 MB, that is a single-digit percentage increase. macOS ships arm64 only and
Windows x64 only, so there is no universal-binary doubling.

**Size should not decide this**, and it is worth saying plainly, because "it
makes the installer bigger" is the objection that sounds serious and is not.

---

## 6. A minimal build, and the three routes

A purpose-built ffmpeg is the right shape regardless of how the encoder
question resolves: smaller, a far smaller audit surface, and materially less
CVE exposure. The component list below is derived from every ffmpeg call site
in the codebase rather than guessed:

```
--disable-everything --disable-gpl --disable-nonfree --disable-version3
--disable-doc --disable-network --disable-programs --enable-ffmpeg --enable-ffprobe

# containers
--enable-demuxer=mov,matroska,mp3,wav,image2,concat,srt,rawvideo
--enable-muxer=mp4,mov,wav,mp3,image2,rawvideo,null
--enable-protocol=file,pipe

# decode: what phones produce, plus our own intermediates
--enable-decoder=h264,hevc,prores,mjpeg,png,aac,mp3,pcm_s16le,pcm_f32le

# encode
--enable-encoder=aac,mjpeg,png,pcm_s16le,rawvideo   # + the H.264 encoder, see below
--enable-parser=h264,hevc,aac,mpegaudio
--enable-bsf=h264_mp4toannexb,extract_extradata

# filters — the exact set the graph builder emits
--enable-filter=scale,zscale,tonemap,format,fps,setpts,settb,setsar,pad,crop,
                split,overlay,xfade,concat,trim,null,color
--enable-filter=atrim,asetpts,aresample,aformat,apad,amix,volume,atempo,afade,anull
--enable-libzimg
--enable-lto --disable-debug
```

**Verify that list mechanically rather than trusting it.** It is read from the
source, but a filter or decoder reached only on an unusual path would produce a
build that works in testing and fails on somebody's footage. Before shipping:
run the existing assembly and HDR test suites against the minimal binary, and
keep `hdr_check.rs` in CI. A build that silently lacks `zscale` is the exact
failure the readiness probe already looks for.

### Route A — bundle, with OpenH264

The literal proposal. Removes GPL cleanly, but forfeits Cisco's royalty
coverage per §2, so it leaves us facing the AVC pool directly. **Not to be
done without counsel confirming the pool exposure is acceptable** — and if that
answer comes back fine, then libx264 was never the blocker either, and the
whole GPL framing was solving the wrong problem.

### Route B — bundle everything except the codec, fetch that at runtime

Ship the minimal ffmpeg in the installer; have the app download Cisco's binary
module on first run, exactly as Firefox does. This is the *only* shape that
plausibly keeps Cisco's coverage intact, and it is a very different download
from today's: a couple of megabytes, automatic, with a progress bar — not "open
a terminal and paste a brew command". Costs: a download step still technically
exists, the conditions about enable/disable and attribution must be honoured,
and the linkage question in [Memo for counsel](#memo-for-counsel)
needs answering.

### Route C — no third-party H.264 encoder at all

Use the encoder the operating system already ships: `h264_videotoolbox` on
macOS, and on Windows one of `h264_nvenc` / `h264_qsv` / `h264_amf` with
`h264_mf` as the floor. All are built into ffmpeg with no external codec
library, no GPL, and nothing to bundle.

**This is now the recommended direction and has its own section — see
[§7](#7-route-c-examined-os-native-encoders), which measures it rather than
guessing at it.** The summary that used to sit here said Windows was the weak
spot and the patent position was an assumption. Both survived examination; what
did not survive is the assumption that macOS VideoToolbox would cost quality.

### Worth pricing before committing to a build pipeline

[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) publishes daily
`lgpl-shared` builds for Windows and macOS. Not minimal and not tuned to this
app, so it does not get the CVE-surface benefit — but it is a way to test the
whole idea in an afternoon.

---

## 7. Route C examined: OS-native encoders

Added 21 August 2026. The question: build ffmpeg with `--enable-videotoolbox`
(macOS) and Media Foundation support (Windows) and no x264 or OpenH264 at all,
so that no codec software is redistributed — the OS vendor's own encoder is
called through an API.

### 7.1 Feasibility — yes, and the classification is not in doubt

Checked against ffmpeg's own `configure`. Neither `EXTERNAL_LIBRARY_GPL_LIST`
nor `EXTERNAL_LIBRARY_NONFREE_LIST` contains any of the components Route C
needs:

| Component | Where it sits in ffmpeg's configure | Platform |
|---|---|---|
| `videotoolbox` | `HWACCEL_AUTODETECT_LIBRARY_LIST` | macOS |
| `mediafoundation` | `EXTERNAL_AUTODETECT_LIBRARY_LIST` | Windows |
| `nvenc` / `ffnvcodec` | `HWACCEL_AUTODETECT_LIBRARY_LIST` | Windows, NVIDIA |
| `amf` | `HWACCEL_AUTODETECT_LIBRARY_LIST` | Windows, AMD |
| `libvpl` | `HWACCEL_LIBRARY_LIST` | Windows, Intel |

The GPL list is `avisynth frei0r libcdio libdavs2 libdvdnav libdvdread
librubberband libvidstab libx264 libx265 libxavs libxavs2 libxvid`; the
nonfree list is `decklink libfdk_aac libmpeghdec`. Nothing Route C touches is
on either. `--enable-nonfree` is **not** required for NVENC in current ffmpeg,
which was true of much older versions and is the sort of stale fact worth
retiring explicitly.

The vendor SDK headers (nv-codec-headers, AMF, libvpl) are MIT and the actual
encoder lives in the driver, loaded at runtime. Same structural shape as
VideoToolbox: headers to compile against, somebody else's binary to call.

On Windows, `libavcodec/mfenc.c` registers `h264_mf`, `hevc_mf`, `av1_mf`,
`aac_mf`, `ac3_mf` and `mp3_mf`, with options for `rate_control`, `quality`
(-1 to 100), `hw_encoding` and `scenario`. It distinguishes async (hardware)
from sync (software) MFTs internally.

**Measured on this machine** (`h264_videotoolbox`, ffmpeg 8.1.2, Apple
silicon), because two of these were assumptions worth killing:

- **`-q:v` constant quality works.** This is the CRF-like knob OpenH264 does
  not have, and it is the single biggest advantage Route C has over Route A.
  `-q:v 30` and `-q:v 60` produced 43 KB and 120 KB from the same source.
- **`-require_sw 1` works** — the software path is real and selectable.
- Profiles to `high`, CABAC, `spatial_aq`, `max_ref_frames` all exposed.
- **No B-frames.** A test encode contained only I and P frames. x264 at
  `veryfast` does use B-frames, so this is a real handicap — and, per §7.2, not
  one that shows up in the output.

### 7.2 Quality — measured against the app's own settings

Three HDR clips from the development library (HLG, HEVC, 1920×1080), 8 seconds
each. Each clip was pushed through the app's real tone-map and geometry chain
and written to a **lossless ffv1 reference**, so every encoder received
identical pixels and the filter graph is not part of the comparison. VMAF was
then measured for each encode against that reference.

The harness is `scripts/encoder-probe.sh`, committed so these numbers can be
reproduced and argued with:

```
./scripts/encoder-probe.sh clip1.MOV clip2.MOV clip3.MOV
```

It already knows how to measure OpenH264 and `h264_mf` as well, and will
include either when pointed at an ffmpeg that has them — so the two gaps below
are a matter of running it somewhere else, not of writing anything new.

Two harness bugs were found before any of these numbers were believed, and the
second is worth naming here because it produced results that looked entirely
plausible and were wrong: pairing VMAF's two inputs **by timestamp** silently
mismatched the mkv reference against the mp4 encodes, and scored a visually
perfect encode at 63.9 instead of 99.9. Pair frames by index instead, and have
the harness assert that the reference scores >99 against itself before it
reports anything. Anyone repeating this measurement should reproduce that
self-check first — the failure is silent and the numbers it produces are
internally consistent.

**At matched bitrate** — VideoToolbox given exactly the bitrate x264 chose at
`-crf 20`:

| Clip | x264 veryfast crf20 | VT hardware | VT software |
|---|---|---|---|
| 1 | 12 296 kbps · **99.899** | 12 467 kbps · 99.867 | 12 774 kbps · 99.932 |
| 2 | 15 574 kbps · **99.169** | 15 825 kbps · 98.685 | 16 280 kbps · 98.622 |
| 3 | 9 134 kbps · **97.977** | 9 348 kbps · 98.119 | 9 684 kbps · 98.798 |

Hardware VideoToolbox lands within **half a VMAF point** of x264 on every clip,
in both directions — behind on clip 2, ahead on clip 3, level on clip 1. Mean
difference is about −0.1 VMAF, which is not a difference. The software path is
no worse and on clip 3 is meaningfully better.

**Constant quality**, for calibrating the replacement for `-crf 20`:

| Clip | `-q:v 55` | `-q:v 65` | `-q:v 75` |
|---|---|---|---|
| 1 | 7 528 · 99.737 | 11 750 · 99.942 | 21 204 · 99.964 |
| 2 | 11 469 · 97.403 | 18 252 · 99.926 | 32 144 · 99.976 |
| 3 | 6 320 · 96.671 | 9 715 · 98.551 | 17 219 · 99.452 |

`-q:v 65` reaches or beats x264's quality on all three clips — at 4% *less*
bitrate on clip 1, and 17% more on clip 2. Somewhere around 60–65 is the
operating point; it would want calibrating across more footage before shipping.

**What this test does and does not show.** Four caveats, and they matter:

1. **It compares against x264 at `veryfast`, not x264 at its best.** That is
   deliberate — `veryfast` is what the app actually ships — but x264 at
   `medium` or `slow` would widen the gap in x264's favour.
2. **These are near-transparent encodes.** At `-crf 20` on tone-mapped 1080p,
   everything scores 98–100, which is the saturation zone where VMAF
   discriminates poorly. This measures "does VideoToolbox hold up where we
   actually run", not "is VideoToolbox as efficient in general". At low
   bitrates hardware encoders usually lose, and this test does not go there.
3. **Three clips, one chip, one machine.** Not a codec study.
4. **Windows is not measured at all.** There is no Windows machine here.
   `h264_mf` quality is the largest unknown in Route C and nothing in this
   section speaks to it.

**The software-fallback question is moot on macOS.** Every Apple silicon chip
from M1 to M4, base models included, has a hardware H.264 encoder in its media
engine, and the release workflow builds `aarch64-apple-darwin` only. There is
no supported Mac without it. The `-require_sw` path was measured anyway and is
fine, so the fallback exists and works; it just should never be needed.

### 7.3 Does this eliminate the need for legal review? No — it halves it

This is the part of the premise that does not hold, so it is worth being
precise about what Route C does and does not remove.

**Removed completely:**

- **The GPL question.** No x264, no GPL component, verified against ffmpeg's
  own classification lists. This is the one thing Route C settles outright, and
  it settles it permanently.
- **Cisco's condition 1.** Moot — nothing of Cisco's is redistributed, so there
  is no binary-licence condition to satisfy or breach.
- **[the Cisco linkage question](#questions-we-are-no-longer-asking)**, the dlopen-versus-link
  question. Moot for the same reason.

**Not removed:** the AVC field-of-use clause — counsel question 1 — survives
Route C **verbatim**, because both OS vendors pass the identical restriction
through in their own licence terms.

Apple's macOS software licence agreement:

> To the extent that the Apple Software contains AVC encoding and/or decoding
> functionality, **commercial use of H.264/AVC requires additional licensing**
> […] LICENSED HEREIN ONLY FOR THE PERSONAL AND NON-COMMERCIAL USE OF A
> CONSUMER TO (i) ENCODE VIDEO IN COMPLIANCE WITH THE AVC STANDARD.

Microsoft's Windows licence terms:

> THIS PRODUCT IS LICENSED UNDER THE AVC […] PATENT PORTFOLIO LICENSES FOR THE
> PERSONAL AND NON-COMMERCIAL USE OF A CONSUMER […] **NO LICENSE IS GRANTED OR
> SHALL BE IMPLIED FOR ANY OTHER USE.**

So the comfortable assumption in the old counsel question 3 — that the OS
vendors license AVC on our behalf — is **not supported by their own words**.
They pass the consumer field-of-use restriction downstream rather than
absorbing it.

**Why Route C is nonetheless a materially stronger position**, and this is the
argument to put to counsel rather than a conclusion to rely on:

- Under Route A we would be *distributing an AVC encoder implementation*, which
  is squarely what the pool's per-unit product licence is written for.
- Under Route C we distribute no encoder at all. ffmpeg carries a wrapper that
  calls an OS API; the encoder is Apple's or Microsoft's, and they are
  licensees. What remains is a field-of-use question that attaches to *use*.
- And that residual question **is one the product already lives with today**.
  The app already produces H.264 — via the ffmpeg the user installed — and
  already sells a subscription to users who may monetise the result. Route C
  does not add exposure relative to the status quo. It simply does not remove
  it.

Every paid video tool on both platforms encodes H.264 through these same OS
APIs — Final Cut Pro, Resolve, Camtasia, ScreenFlow. That is evidence about
industry practice and **is not a legal opinion**, and it should not be
presented to anyone as if it were.

### 7.4 The problem Route C does not solve: HEVC decode

This did not come up in the original research and it should have.

Our input is HEVC. In the development library, **107 of 145 clips are HEVC
HDR** — that is what modern iPhones record. Any bundled ffmpeg must therefore
contain an HEVC *decoder*, and HEVC has its own patent pools, which are more
aggressive than AVC's. Access Advance, in its own words:

> HEVC Advance is primarily focused on licensing HEVC Decoders and/or HEVC
> Encoders installed in devices **or software** at the time of First Sale,
> seeking to be paid one royalty per device/software copy on First Sale. You
> most likely need a license if you sell any products that have HEVC/H.265
> […] encoding and/or **decoding** capability/functionality.

Today the app ships no HEVC decoder — the user's own ffmpeg has one. Bundling
changes that, and it changes it on the *decode* side, which Route C's encoder
argument does not touch.

**Route C's own logic extends to it, at a cost.** Decode HEVC through
`-hwaccel videotoolbox` on macOS and `d3d11va` on Windows, and build with
ffmpeg's native `hevc` decoder disabled — then no HEVC decoder is shipped
either, and the OS does that work too. On macOS this is clean: every Apple
silicon chip has HEVC hardware decode. On Windows it is **unverified** — HEVC
decode availability varies by GPU, and Microsoft's own Media Foundation path
famously requires a Store-installed HEVC extension on some SKUs, though
driver-level D3D11VA is a separate mechanism. This needs checking on real
Windows hardware before it can be claimed.

The engineering cost is real: hardware-decoded frames live in GPU memory and
must be downloaded before the tone-map chain can touch them, and a machine
where hwaccel fails needs *some* fallback — which, if it is ffmpeg's native
decoder, puts the decoder back in the bundle and undoes the argument.

**My reading is that this is the more serious of the two patent questions in
this document**, because unlike the AVC field-of-use clause it is not something
the product already lives with — it would be newly created by bundling. Flagged
with low confidence on the conclusion and high confidence on the quote.

### 7.5 Build complexity and size

**Size: the codec contributes zero bytes.** VideoToolbox and Media Foundation
are operating-system frameworks. Route C's installer cost is exactly the
minimal-build figure from §5 — **10–16 MB per platform** — minus the 1–2 MB
OpenH264 would have added. It is the cheapest of the three routes on size, and
size still should not decide this.

**macOS is simple.** One added configure flag, one encoder, one code path.
`-c:v libx264 -preset veryfast -crf 20` becomes `-c:v h264_videotoolbox
-q:v 6x -profile:v high -coder cabac`, with the exact `q` calibrated per §7.2.

**Windows is where the cost is.** Which encoder exists depends on the GPU, so
`ffmpeg.rs` needs a probe-and-fall-back chain — NVENC, then QSV, then AMF, then
`h264_mf` as the floor — and each of the first three needs vendored MIT headers
present at build time. That means:

- A runtime probe for "what can this machine encode with", cached, plus a
  readiness-screen row for it.
- Four encoders' worth of quality calibration instead of one, since `-q:v` does
  not mean the same thing across them.
- A quality floor set by whatever `h264_mf` does on a machine with no GPU
  encoder, which is the case nothing here has measured.

**The CVE and maintenance burden of §4 is completely unchanged.** Route C
removes codec licensing questions; it does not remove one line of the
obligation to rebuild and re-ship ffmpeg when the next `libavcodec` RCE lands.
That remains the dominant ongoing cost of bundling anything, on every route.

### 7.6 Recommendation

**Yes, pursue Route C — on macOS, now. Do not commit to it on Windows yet. And
do not treat it as removing the need for legal review.**

The reasoning, in order of how much weight it carries:

1. **The quality objection to Route C is dead**, at least on macOS and at the
   settings this app actually uses. That was the main thing expected to sink
   it, and it measured within half a VMAF point of x264 in both directions.
   VideoToolbox also has a working constant-quality mode, which is a genuine
   advantage over OpenH264 and preserves the resolution- and content-adaptive
   behaviour `-crf 20` currently provides.
2. **It removes the GPL question outright and permanently**, which is the
   constraint this project has organised itself around since espeak-ng.
3. **It removes two of the three counsel questions**, leaving one that the
   product already faces today and does not make worse.
4. **It costs nothing in installer size** beyond the minimal ffmpeg itself.

Against that:

5. **Windows is unmeasured and structurally harder** — four encoders, a probe
   chain, and an unquantified floor.
6. **The HEVC decode question in §7.4 is new, applies to every route, and is
   the one genuinely new exposure bundling creates.** It should go to counsel
   with the AVC question.
7. **The §4 maintenance burden is untouched** and remains the strongest
   argument for doing none of this.

**Concretely, what to do next:**

1. **Build the minimal macOS ffmpeg now** — §6's configure line plus
   `--enable-videotoolbox`, no x264, no OpenH264. It has no open copyright
   question, the encoder is measured, and it turns §5's size estimate and the
   §6 "verify the component list mechanically" warning into facts. Run
   `assembly_tests.rs` and `hdr_check.rs` against it.
2. **Send counsel two questions, not three** — the AVC field-of-use clause
   (§7.3, now with Apple's and Microsoft's own wording, which is less
   comfortable than the old framing assumed) and the HEVC decoder question
   (§7.4, which is new). Drop the Cisco linkage question unless Route A comes
   back.
3. **Measure `h264_mf` and Windows HEVC hwaccel on real hardware** before any
   decision about Windows. Until that exists, Windows keeps `winget install`.
4. **Accept a platform-asymmetric outcome as the likely landing point.** macOS
   users get no install step; Windows users keep the one they have. The app
   already gives the two platforms different setup instructions, and halving
   the friction on one platform while the other is still being measured is
   better than holding both back.

**What would change this recommendation:** if the team cannot commit to owning
an ffmpeg security-update channel (§4), then no route is right and the answer
is to keep asking users to install it. That is a resourcing decision, not a
licensing one, and it should be made deliberately rather than by drift.

---

## 7.7 The build, as built

Added 21 August 2026, on branch `ffmpeg-minimal-macos`. **Built and measured,
not shipped** — nothing here goes into an installer, and the branch is not
merged or tagged, until the [memo for counsel](#memo-for-counsel) is answered.

Reproduce with `./scripts/build-ffmpeg-macos.sh`.

### What it is

ffmpeg 8.1.2, `aarch64-apple-darwin`, configured `--disable-everything
--disable-gpl --disable-nonfree --disable-version3`, with VideoToolbox and a
statically-linked WTFPL libzimg. Shared libraries with an `@rpath` install
name, so it relocates into a bundle and satisfies LGPL relinking by file layout
rather than by paperwork (§3).

| | |
|---|---|
| **Total size** | **7.3 MB** (0.6 MB binaries + 6.7 MB libraries) |
| H.264 encoder | `h264_videotoolbox` — the only one present |
| GPL components | none. No libx264, libx265 or OpenH264 in the binary |
| External linkage | system frameworks only. zimg is inside; nothing from Homebrew |

That is **under §5's 10–16 MB estimate**, and against the 124 MB of resources
the installer already carries it is a ~6% increase.

### That it works

- **The app's own Rust suite: 233 of 234 pass** driving the minimal binary via
  `FFMPEG_PATH`. The one failure is
  `explicit_choice_is_never_overridden_by_a_more_capable_build`, which asserts
  that an explicitly-configured path is honoured — and `FFMPEG_PATH` is by
  design the thing that outranks an explicit setting, so setting it to run the
  suite is what breaks that test. It passes on its own. Not a build defect.
- **No regression for anyone on a normal ffmpeg: 234 of 234** against Homebrew
  `ffmpeg-full`, unchanged.
- **HDR tone-mapping verified end to end** on real HLG footage from the
  library, through the app's own filter chain:

| | luma | saturation |
|---|---|---|
| ffmpeg-full + libx264 (today) | 110.1 | 0.056 |
| **minimal build + VideoToolbox** | **110.0** | **0.056** |
| minimal build, tone-map removed | 111.3 | 0.046 |

  The first two are the same picture. The third is there to show the filter is
  doing something — 0.046 against 0.056 is the washed-out HDR this project has
  spent effort avoiding. Output is High profile `yuv420p` in both cases, and at
  `-q:v 65` the VideoToolbox file was *smaller* (5.6 MB against 6.2 MB).

### What the build taught us that the paper analysis did not

Four things, all of which cost real time and none of which were visible from
reading:

1. **ffmpeg cannot build under a path containing spaces**, and this checkout
   lives under `BuildnLaunchAI - Apps/Raw Footage Real Story`, which has three.
   configure fails with clang complaining about a file called `Apps/Raw`. The
   script now builds outside the repo and rejects a spaced path up front.
2. **Statically linking zimg needs `-lc++` in the `.pc` file's `Libs`**, not
   `Libs.private` where Homebrew puts it — ffmpeg link-tests with `Libs` alone.
   The failure message is `zimg >= 2.7.0 not found using pkg-config`, which
   points at detection when the problem is the C++ runtime.
3. **The derived component list was wrong in three places.** §6 said to verify
   it mechanically; this is what that warning was worth. Missing were
   `wrapped_avframe` (the codec the lavfi device wraps frames in — named in no
   command line anywhere), `acrossfade` and `asplit` (invisible to a grep for
   `filtername=`), and the **matroska muxer** (enabled as a demuxer only). Each
   surfaced as a different unhelpful error: "no decoder found", "Filter not
   found", "Error initializing the muxer".
4. **The app's test suite could not validate a non-GPL build at all**, because
   it generates its own fixtures with `-c:v libx264`. Twenty-two tests failed
   for a reason unrelated to what they test. That would have blocked Route C at
   CI regardless of how the legal question resolved.

### App changes on this branch — and what they are not

Small and deliberately conservative, made so the build could be exercised:

- `ffmpeg::h264_encoder()` and `has_encoder()` ask the binary what it has.
- `make_placeholder` and the test fixtures use whatever encoder exists.
- `h264_args()` picks the render encoder: **libx264 keeps precisely the
  settings it has today** (`-preset veryfast -crf 20`), so anyone on a Homebrew
  ffmpeg sees no change at all; VideoToolbox is used only when there is no
  x264, at `-q:v 65 -profile:v high -coder cabac`.

**This is not Route C implemented.** There is no Windows encoder path, no
probe-and-fallback chain, and `-q:v 65` is calibrated on three clips (§7.2) and
should not be shipped on that evidence. It is the smallest change that makes
the app run against a build with no GPL encoder in it.

---

## 7.8 What `--disable-everything` costs the user

**This is the risk the licence and size analysis both missed**, and it is not
small.

| | video decoders | audio decoders | demuxers |
|---|---|---|---|
| Homebrew `ffmpeg-full` (what users install today) | 276 | 241 | 364 |
| **This minimal build** | **8** | **7** | **12** |

Today the app inherits all 276 for free, because the user installs a
general-purpose ffmpeg. A bundled minimal build decodes exactly what we
anticipated, and **refuses everything else**.

Formats a real user of a footage app might plausibly hand it, all of which work
today and none of which this build accepts:

- **VP8 / VP9** — WebM, screen recordings, anything downloaded
- **AV1** — increasingly what phones and platforms produce
- **MPEG-4 part 2 (DivX/Xvid)** — old camcorder AVI. The test suite has a case
  for exactly this, which now skips
- **GoPro CineForm, DNxHD** — worth noticing for an app about raw footage
- **VC-1 / WMV3, DV, Theora, Sorenson** — older libraries
- Audio: **AC-3, DTS, FLAC, Opus, Vorbis, ALAC, WMA** — a clip whose video
  decodes but whose audio does not still loses its sound

**And it is in direct tension with §4.** The security argument for a minimal
build is that the MagicYUV decoder we never compiled in cannot expose us to
CVE-2026-8461. That argument and the coverage problem are *the same dial*:
every decoder added to widen format support widens the CVE surface we would
then be responsible for patching.

**A middle path exists.** Enabling ffmpeg's full in-tree decoder set — all
LGPL, no external libraries, no GPL — restores most of that coverage for a few
megabytes. It does not reintroduce any copyright problem. It does add more
patent-pooled decoders (VC-1 and MPEG-4 part 2 have pools of their own), which
feeds straight back into question 2 of the memo.

**Unmeasured, and it matters:** how often real users actually have footage
outside H.264/HEVC. Every one of the 145 clips in the development library is
one or the other, which is evidence — but it is one person's phone, and an app
that silently refuses a file a competitor opens is a support problem before it
is a licensing one.

The point is that the decoder list should be **chosen deliberately**, weighing
coverage against CVE surface and patent exposure, rather than inherited from
whatever made the tests pass.

---

## Memo for counsel

**This section is self-contained.** Everything needed to answer the two
questions is in it; the rest of the document is engineering background and does
not need to be read first.

**On the quotations below.** They were gathered from vendor licence pages and
patent-pool sites during research and are reproduced verbatim as found.
Two of the primary documents could not be retrieved directly during that work
(Apple's SLA PDF failed to fetch; ffmpeg.org publishes no checksum file for the
release we build). **Counsel should pull the current primary documents rather
than rely on these excerpts** — the wording is version-dated and both vendors
revise it.

---

### The product, and what would change

Raw Footage, Real Story is a **paid-subscription desktop application** for
macOS and Windows. It turns a user's own phone footage into a narrated short
film. The footage never leaves the user's machine; the finished film is written
to their disk as an H.264/AAC MP4.

**What we distribute today:** no video codec of any kind. The app requires the
user to install ffmpeg themselves (`brew install ffmpeg-full` /
`winget install Gyan.FFmpeg`) and shells out to that binary. Every H.264
encode and HEVC decode happens in software the user obtained independently.

**What is proposed:** bundle our own ffmpeg build inside the installer, to
remove that setup step. The build would contain:

| | |
|---|---|
| ffmpeg itself | LGPL 2.1, no GPL components |
| libzimg | WTFPL, for HDR tone-mapping |
| **No H.264 encoder implementation** | encoding calls `h264_videotoolbox` on macOS / Media Foundation on Windows — the encoder already in the operating system |
| **An HEVC decoder** | ffmpeg's own, in-tree, LGPL. Unavoidable: modern iPhones record HEVC, and 107 of the 145 clips in our development library are HEVC |

The two questions below are the only ones blocking that change. We will not
ship anything until they are answered.

---

### Question 1 — Does the AVC field-of-use restriction reach us?

Both operating-system vendors ship H.264 encoders and both **pass a consumer
field-of-use restriction through to whoever uses them**, rather than absorbing
it. We had assumed the opposite, which is why this question exists.

**Apple, macOS Software Licence Agreement:**

> To the extent that the Apple Software contains AVC encoding and/or decoding
> functionality, commercial use of H.264/AVC requires additional licensing […]
> LICENSED HEREIN ONLY FOR THE PERSONAL AND NON-COMMERCIAL USE OF A CONSUMER TO
> (i) ENCODE VIDEO IN COMPLIANCE WITH THE AVC STANDARD ("AVC VIDEO") AND/OR
> (ii) DECODE AVC VIDEO THAT WAS ENCODED BY A CONSUMER ENGAGED IN A PERSONAL
> AND NON-COMMERCIAL ACTIVITY.

**Microsoft, Windows licence terms:**

> THIS PRODUCT IS LICENSED UNDER THE AVC, THE VC-1, AND THE MPEG-4 PART 2
> VISUAL PATENT PORTFOLIO LICENSES FOR THE PERSONAL AND NON-COMMERCIAL USE OF A
> CONSUMER TO (i) ENCODE VIDEO IN COMPLIANCE WITH THE ABOVE STANDARDS […]
> **NO LICENSE IS GRANTED OR SHALL BE IMPLIED FOR ANY OTHER USE.**

The same restriction appears in the AVC Patent Portfolio Licence itself, in the
form quoted in Cisco's OpenH264 binary licence:

> FOR THE PERSONAL USE OF A CONSUMER OR OTHER USES IN WHICH IT DOES NOT RECEIVE
> REMUNERATION.

**What we need to know:**

1. Does "personal and non-commercial use of a consumer" describe **the use of
   the encoded video**, or **the character of the software that performs the
   encoding**? We sell a subscription; our users encode their own footage, and
   some of them will monetise the result on YouTube or similar.
2. If it describes the video's use, does the fact that some users monetise
   their output create an obligation for **them**, for **us**, or for neither?
3. Does our position differ from the status quo? Today the app already produces
   H.264 through the user's own ffmpeg. Our reading is that bundling changes
   *who supplies the encoder* but not *what the user does with the output* —
   and under the proposal the encoder is Apple's or Microsoft's either way.

**Our working reading, which we are not relying on:** that the clause
constrains the use of the video rather than the sale of the software, which is
why paid video tools — Final Cut Pro, DaVinci Resolve, Camtasia, ScreenFlow —
ship H.264 export through these same OS APIs as a matter of course. That is an
observation about industry practice and we are treating it as worth exactly
nothing until you tell us otherwise.

---

### Question 2 — Does bundling an HEVC *decoder* require a pool licence?

**This is the question we consider more serious**, because unlike question 1 it
is not something the product already lives with. Today we ship no decoder. The
proposal would create this exposure where none exists.

Our input footage is HEVC — that is what modern iPhones record, and it is 107
of 145 clips in our development library. Any bundled ffmpeg must be able to
decode it.

**Access Advance, administrator of the HEVC Advance pool, on what it licenses:**

> HEVC Advance is primarily focused on licensing HEVC Decoders and/or HEVC
> Encoders installed in devices **or software** at the time of First Sale,
> seeking to be paid one royalty per device/software copy on First Sale.

> You most likely need a license if you sell any products that have HEVC/H.265
> and/or VVC/H.266 encoding and/or **decoding** capability/functionality.

**What we need to know:**

1. Taken at face value, does shipping ffmpeg's HEVC decoder inside a paid
   product require a licence from Access Advance, from Via LA's HEVC programme,
   or from both? HEVC is licensed by multiple pools plus unpooled holders,
   which is the part we are least equipped to assess.
2. **Does it change the answer if we never ship a decoder implementation?** We
   can build ffmpeg with its native HEVC decoder compiled out and decode
   exclusively through the operating system's own hardware decoder
   (VideoToolbox on macOS, D3D11VA on Windows) — the same structural move
   question 1 describes for the encoder. This costs us engineering effort and a
   fallback path, so we would like to know whether it actually helps before
   building it.
3. Is there a threshold — unit volume, revenue — below which no licence is
   required, and if so what reporting does staying under it involve?

---

### Questions we are no longer asking

Recorded so it is clear they were considered and dropped, not overlooked:

- **Cisco's OpenH264 redistribution conditions.** An earlier proposal used
  Cisco's OpenH264 binary, whose royalty coverage requires that the binary be
  "separately downloaded to an end user's device, and not integrated into or
  combined with third party software prior to being downloaded". Bundling fails
  that condition. That route is shelved, so the question is moot.
- **Whether ffmpeg linking rather than `dlopen`-ing OpenH264 satisfies Cisco's
  terms.** Moot for the same reason.
- **Whether the OS vendors license AVC on our behalf.** Asked and effectively
  answered by the quotations in question 1: they do not, they pass the
  restriction through. It has collapsed into question 1.

---

### What we will do with the answer

Nothing ships until both are answered. If either answer is "you need a
licence", that is actionable — we would rather buy one, change the design, or
abandon the bundling plan than proceed on an assumption. The specific decision
waiting on you is whether to put a built-and-tested macOS binary into an
installer; the binary exists, and it is not going anywhere until this is
resolved.

---

## If counsel clears it

In order:

1. ~~**Measure the quality delta.**~~ *Done for VideoToolbox — see
   [§7.2](#72-quality--measured-against-the-apps-own-settings). Within half a
   VMAF point of x264 at the settings the app ships. Still outstanding for
   OpenH264 and for everything on Windows.*
2. ~~**Build the minimal macOS ffmpeg.**~~ *Done — see
   [§7.7](#77-the-build-as-built). 7.3 MB, 233/234 of the app's own tests, HDR
   tone-mapping identical to today's output. It also surfaced
   [§7.8](#78-what---disable-everything-costs-the-user), the format-coverage
   problem, which is now an open design question in its own right.*
3. **Send counsel questions 1 and 4.** Question 4 — the HEVC decoder — is the
   new one and applies whichever route wins.
4. **Measure the Windows encoder chain on real hardware** before deciding
   anything about Windows.
5. **Only then** take on the CI and security-update burden in §4, which no
   route reduces.

This is not blocking onboarding work. Script generation no longer requires a
14 GB download, so ffmpeg is the only remaining install step and it is a
two-minute one. The friction is real but it is no longer what stands between a
new user and their first video.

---

## Sources

| | |
|---|---|
| [openh264.org/BINARY_LICENSE.txt](https://www.openh264.org/BINARY_LICENSE.txt) | the four conditions and the AVC field-of-use clause |
| [Mozilla — Why is there an OpenH264 plugin in Firefox?](https://support.mozilla.org/en-US/kb/open-h264-plugin-firefox) | why it is downloaded rather than bundled |
| [FFmpeg — libopenh264enc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/libopenh264enc.c) | options, profiles, pixel formats, absence of B-frames |
| [ffmpeg-devel — dropping openh264 runtime version checks](https://ffmpeg.org/pipermail/ffmpeg-devel/2023-December/318013.html) | ffmpeg links rather than dlopens |
| [cisco/openh264 #2949](https://github.com/cisco/openh264/issues/2949) | the most-cited quality comparison against x264 |
| [cisco/openh264 — RELEASES](https://github.com/cisco/openh264/blob/master/RELEASES) | rate-control work through v2.6.0 |
| [sekrit-twc/zimg](https://github.com/sekrit-twc/zimg) | the library behind zscale, WTFPL |
| [ffmpeg.org — Security](https://ffmpeg.org/security.html) | the advisory channel we would have to watch |
| [CVE Details — ffmpeg](https://www.cvedetails.com/vulnerability-list/vendor_id-3611/product_id-6315/Ffmpeg-Ffmpeg.html) | 25 CVEs in 2025, 7 in 2026 |
| [Rapid7 — CVE-2026-8461](https://www.rapid7.com/db/vulnerabilities/ffmpeg-cve-2026-8461/) | the MagicYUV out-of-bounds write, fixed in 8.1.2 |
| [Via LA — AVC/H.264 programme](https://www.via-la.com/licensing-programs/avc-h-264/) | the pool we would be dealing with |
| [Tom's Hardware — H.264 streaming fees raised for 2026](https://www.tomshardware.com/service-providers/streaming/h264-streaming-license-fees-jump-from-100000-to-4-5-million) | context on the pool's direction |
| [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | maintained lgpl-shared builds, for prototyping |
| [Apple — macOS Software Licence Agreement](https://www.apple.com/legal/sla/) | the AVC notice quoted in §7.3 |
| [Microsoft — Windows licence terms](https://www.microsoft.com/en-us/Useterms) | the AVC notice quoted in §7.3 |
| [Access Advance — what we license](https://accessadvance.com/topic-what-do-we-license/) | HEVC decoders in software at first sale, §7.4 |
| [FFmpeg — mfenc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mfenc.c) | the Media Foundation encoders and their options |
| [FFmpeg — configure](https://github.com/FFmpeg/FFmpeg/blob/master/configure) | the GPL and nonfree lists quoted in §7.1 |
| [FFmpeg/nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | MIT headers, driver loaded at runtime |
