# Bundling ffmpeg

Research into shipping our own ffmpeg build, so that installing ffmpeg stops
being something we ask a new user to do. Written 21 August 2026, against
v0.3.0.

**Status: backlog, blocked on legal review.** Nothing here has been built and
nothing should be, until counsel has answered the three questions in
[Questions for counsel](#questions-for-counsel). The blocker is Cisco's
patent-redistribution terms, not the engineering.

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
and the linkage question in [Questions for counsel](#questions-for-counsel)
needs answering.

### Route C — no third-party H.264 encoder at all

Use the encoder the operating system already ships: `h264_videotoolbox` on
macOS, and on Windows one of `h264_nvenc` / `h264_qsv` / `h264_amf` with
`h264_mf` as the floor. Both are built into ffmpeg with no external library, no
GPL, and nothing to bundle.

- **macOS is clean.** `h264_videotoolbox` is present in the Homebrew build
  already on this machine, is hardware-accelerated, and on Apple silicon
  supports a constant-quality mode that is the nearest thing to CRF in this
  whole comparison.
- **Windows is the weak spot.** Which encoder exists depends on the GPU, so it
  needs a probe-and-fall-back chain, and `h264_mf` — the only universal option
  — has a poor quality reputation. This is where Route C gets expensive.
- **The patent position is an assumption**, and it is the third question for
  counsel below.

### Worth pricing before committing to a build pipeline

[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) publishes daily
`lgpl-shared` builds for Windows and macOS. Not minimal and not tuned to this
app, so it does not get the CVE-surface benefit — but it is a way to test the
whole idea in an afternoon.

---

## Questions for counsel

These three are what the backlog item is blocked on. All are quoted from
primary sources above.

**1. The field-of-use clause, as it applies to a paid product with monetising
users.** The AVC Patent Portfolio Licence grants rights "FOR THE PERSONAL USE
OF A CONSUMER OR OTHER USES IN WHICH IT DOES NOT RECEIVE REMUNERATION". It is
not clear whether "it" is the software distributor or the end user, and it
matters twice over here: this is a paid subscription product, and its users
make videos some of them will monetise. The working reading is that the clause
constrains the *use of the encoded video* rather than whether the software was
sold — which is why paid products ship H.264 routinely — but that reading is
not confident enough to rely on.

**2. Whether an app-initiated download of Cisco's module satisfies condition 1,
given that ffmpeg links rather than dlopens it.** Cisco's model assumes the
binary module is loaded dynamically at runtime. ffmpeg's `libopenh264` wrapper
links against it at build time; an ffmpeg developer notes this explicitly in
the [2023 thread dropping the runtime version
checks](https://ffmpeg.org/pipermail/ffmpeg-devel/2023-December/318013.html),
describing dlopen as "what one has to do to take advantage of Cisco's patent
offer". A downloaded Cisco dylib can be dropped into place to satisfy the
dynamic link, but whether that arrangement satisfies Cisco's terms as written
is a legal question, not an engineering one.

**3. Whether relying on OS-provided encoders (Route C) carries the patent
coverage people assume it does.** The industry reading is that Apple and
Microsoft license AVC for the encoders they ship as part of the OS, so an
application calling them is covered. **This has not been verified and is not a
formal indemnity to us.**

---

## If counsel clears it

In order:

1. **Measure the quality delta** (§1). Three HDR clips, both encoders, VMAF and
   file size. This does not depend on the legal answer and can start any time.
2. **Prototype the minimal build** (§6) with `h264_videotoolbox` on macOS,
   which is buildable today with no licensing question attached and answers the
   size and test-suite questions for real rather than by estimate.
3. **Pick a route** on the combination of counsel's answer and the measured
   quality delta. If OpenH264 costs more than a few percent at our bitrates,
   Route C wins on merit rather than on paperwork.
4. **Only then** take on the CI and security-update burden in §4.

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
