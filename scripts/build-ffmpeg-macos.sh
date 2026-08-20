#!/usr/bin/env bash
# build-ffmpeg-macos — the minimal, permissively-licensed ffmpeg from
# docs/ffmpeg-bundling-research.md §6 and §7, built for Apple silicon.
#
#   ./scripts/build-ffmpeg-macos.sh [output-dir]
#
# NOT A SHIPPING STEP. This is the build-and-measure exercise agreed while the
# two questions in that document's counsel memo are outstanding. Nothing this
# produces goes into an installer until those are answered — see §7.4, which is
# specifically about the HEVC decoder this build contains.
#
# ## What makes it different from `brew install ffmpeg-full`
#
# No libx264, no libx265, no OpenH264, no GPL component of any kind. H.264
# encoding is `h264_videotoolbox`, which calls the encoder already in macOS
# rather than redistributing one. Configured `--disable-gpl --disable-nonfree
# --disable-version3`, so the result is LGPL 2.1 ffmpeg plus WTFPL libzimg.
#
# ## Why shared libraries rather than one static binary
#
# LGPL relinking. Shipping libav*.dylib beside the executable means a user can
# replace them, which satisfies the obligation without anyone having to think
# about it. Static linking is also compliant and somewhat smaller, but it puts
# the burden on paperwork instead of on the file layout. `--install-name-dir`
# and an @executable_path rpath make the result relocatable, which is what
# bundling would need.
#
# ## Why the component list looks like that
#
# It is derived from every ffmpeg invocation in src-tauri/src/, not chosen for
# neatness. Two deliberate inclusions worth defending:
#
#   lavfi indev + color/sine — used only by assembly_tests.rs and the ffmpeg.rs
#   test helpers to synthesise fixtures. A few KB, and without them the app's
#   own test suite cannot run against this binary, which is the whole point of
#   building it. A shipping build could drop them.
#
#   volumedetect — ffmpeg.rs:1397 reads mean volume from it.
#
# Absent on purpose: libass, libfreetype, drawtext, subtitles. Captions are
# drawn by the webview and composited as pictures, so the whole LGPL/FTL
# text-shaping subtree stays out. See §3.
set -euo pipefail

FFMPEG_VERSION=${FFMPEG_VERSION:-8.1.2}
# Pinned. ffmpeg.org publishes a .asc but no .md5/.sha256 for this release, so
# this hash is recorded from the first download rather than checked against an
# upstream list. It pins *this* tarball; it does not independently attest it.
# Anyone wanting stronger provenance should verify the .asc against ffmpeg's
# published GPG key.
FFMPEG_SHA256=${FFMPEG_SHA256:-464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c}

# libzimg, statically linked so the result carries no Homebrew dependency.
# A shipping build should vendor and build zimg from source rather than borrow
# Homebrew's — this is a shortcut appropriate to a measurement build.
ZIMG_PREFIX=${ZIMG_PREFIX:-/opt/homebrew/opt/zimg}

# Deliberately outside the repository. **ffmpeg's build system cannot handle
# spaces in paths** — and this checkout lives under "BuildnLaunchAI - Apps/Raw
# Footage Real Story", which has three. configure fails obscurely, with clang
# reporting `no such file or directory: 'Apps/Raw'` from a split -I flag. So the
# work and output directories default somewhere space-free, and a path with a
# space in it is rejected up front rather than 200 lines into a config.log.
BUILD_ROOT=${BUILD_ROOT:-${TMPDIR:-/tmp}/rfrs-ffmpeg-build}
OUT=${1:-$BUILD_ROOT/out}
WORK=${WORK:-$BUILD_ROOT/work}

for d in "$OUT" "$WORK" "$ZIMG_PREFIX"; do
  case "$d" in
    *\ *) echo "path contains a space, which ffmpeg's build cannot handle: $d" >&2
          echo "set BUILD_ROOT=/some/space-free/path and try again" >&2; exit 2;;
  esac
done

[ "$(uname -s)" = Darwin ] || { echo "macOS only; Windows is deliberately not attempted yet (§7.6)" >&2; exit 2; }
[ "$(uname -m)" = arm64 ] || echo "warning: not arm64; the release builds aarch64-apple-darwin only" >&2
command -v pkg-config >/dev/null || { echo "need pkg-config: brew install pkg-config" >&2; exit 2; }
[ -f "$ZIMG_PREFIX/lib/libzimg.a" ] || { echo "need a static libzimg at $ZIMG_PREFIX/lib/libzimg.a (brew install zimg)" >&2; exit 2; }

mkdir -p "$WORK" "$OUT"
cd "$WORK"

# ── source ──────────────────────────────────────────────────────────────────
TAR="ffmpeg-$FFMPEG_VERSION.tar.xz"
if [ ! -f "$TAR" ]; then
  echo "→ fetching $TAR"
  curl -fsSL -o "$TAR" "https://ffmpeg.org/releases/$TAR"
fi
GOT=$(shasum -a 256 "$TAR" | awk '{print $1}')
[ "$GOT" = "$FFMPEG_SHA256" ] || { echo "checksum mismatch: got $GOT want $FFMPEG_SHA256" >&2; exit 1; }
echo "→ sha256 ok"

SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
[ -d "$SRC" ] || tar xf "$TAR"

# ── a private pkg-config prefix holding only the static zimg ────────────────
# The linker prefers .dylib when both are present, so the static one is given a
# prefix of its own where the dylib does not exist.
PC="$WORK/zimg-static"
mkdir -p "$PC/lib/pkgconfig" "$PC/include"
cp -f "$ZIMG_PREFIX/lib/libzimg.a" "$PC/lib/"
cp -f "$ZIMG_PREFIX"/include/zimg*.h "$PC/include/"
ZIMG_VERSION=$(awk '/^Version:/{print $2}' "$ZIMG_PREFIX/lib/pkgconfig/zimg.pc")
# `-lc++` goes in Libs, not Libs.private. zimg is C++, and ffmpeg's
# `check_pkg_config` link-tests with Libs alone — so leaving the C++ runtime in
# Libs.private (where Homebrew puts it, and where it is only consulted for
# --static) fails the test with a page of undefined `zimg::` symbols and the
# unhelpful summary "zimg >= 2.7.0 not found using pkg-config". It is also
# -lc++ on macOS, not the -lstdc++ Homebrew's own .pc names.
cat > "$PC/lib/pkgconfig/zimg.pc" <<EOF
prefix=$PC
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: zimg
Description: static zimg for the bundled ffmpeg build
Version: $ZIMG_VERSION
Libs: -L\${libdir} -lzimg -lc++
Cflags: -I\${includedir}
EOF
echo "→ zimg $ZIMG_VERSION, static"

# ── configure ───────────────────────────────────────────────────────────────
# Demuxers/muxers/codecs/filters below are the derived set. Keep in step with
# src-tauri/src/*.rs; a component reached only on an unusual path produces a
# build that passes tests and fails on somebody's footage.
#
# `acrossfade` and `asplit` were the other two the first list missed, and they
# hide the same way: a grep for `name=` in the filter graphs finds `xfade=` but
# not a bare `asplit`, and misses `acrossfade` inside a longer chain. The build
# then fails with "Filter not found" and no clue which filter.
#
# `wrapped_avframe` is the cautionary example, and it was missing from the
# first version of this list. It appears in no ffmpeg command line anywhere in
# the codebase, because it is not a codec anybody asks for: the lavfi input
# device wraps its frames in it, and `-f null` unwraps them. Leaving it out
# produced a build where every test that synthesises a fixture died on
# "Decoding requested, but no decoder found for: wrapped_avframe" — which reads
# like a VideoToolbox problem and is not one. Derive the list from the source,
# then find the rest by running the tests.
cd "$SRC"
PKG_CONFIG_PATH="$PC/lib/pkgconfig" ./configure \
  --prefix="$OUT" \
  --disable-everything \
  --disable-autodetect \
  --disable-gpl --disable-nonfree --disable-version3 \
  --disable-doc --disable-network --disable-debug --disable-ffplay \
  --enable-shared --disable-static \
  --install-name-dir='@rpath' \
  --extra-ldexeflags='-Wl,-rpath,@executable_path/../lib' \
  --enable-pthreads --enable-zlib \
  --enable-videotoolbox \
  --enable-libzimg \
  --enable-avdevice --enable-indev=lavfi \
  --enable-ffmpeg --enable-ffprobe \
  --enable-demuxer=mov,matroska,mp3,wav,image2,image2pipe,concat,srt,rawvideo,aac \
  --enable-muxer=mp4,mov,ipod,matroska,wav,mp3,image2,rawvideo,null,srt \
  --enable-protocol=file,pipe \
  --enable-decoder=h264,hevc,prores,mjpeg,png,aac,mp3,pcm_s16le,pcm_s24le,pcm_f32le,pcm_u8,rawvideo,wrapped_avframe \
  --enable-encoder=h264_videotoolbox,aac,mjpeg,png,pcm_s16le,rawvideo,wrapped_avframe \
  --enable-parser=h264,hevc,aac,mpegaudio,png \
  --enable-bsf=h264_mp4toannexb,extract_extradata,aac_adtstoasc \
  --enable-filter=scale,zscale,tonemap,format,fps,setpts,settb,setsar,pad,crop,split,overlay,xfade,concat,trim,null,color,copy,hwdownload,hwupload \
  --enable-filter=atrim,asetpts,aresample,aformat,apad,amix,volume,atempo,afade,acrossfade,anull,anullsrc,asplit,sine,volumedetect

echo "→ building"
make -j"$(sysctl -n hw.ncpu)"
make install

# ── report ──────────────────────────────────────────────────────────────────
FF="$OUT/bin/ffmpeg"
echo
echo "── built ─────────────────────────────────────────────────────────────"
"$FF" -hide_banner -version | head -2
echo
echo "size:"
# In KiB throughout, then converted once. Summing `du -sh` output was the first
# version of this and it reported 636K + 6.7M as "642.7M", because awk drops the
# unit and adds the numbers.
BIN_K=$(du -sk "$OUT/bin" | awk '{print $1}')
LIB_K=$(du -sk "$OUT/lib" | awk '{print $1}')
printf "  %-10s %6.1f MB\n" bin "$(echo "$BIN_K" | awk '{print $1/1024}')"
printf "  %-10s %6.1f MB\n" lib "$(echo "$LIB_K" | awk '{print $1/1024}')"
printf "  %-10s %6.1f MB   <- what an installer would carry\n" total \
  "$(awk -v a="$BIN_K" -v b="$LIB_K" 'BEGIN{print (a+b)/1024}')"
echo
echo "capabilities the app probes for:"
FILTERS=$("$FF" -hide_banner -filters 2>/dev/null)
ENCODERS=$("$FF" -hide_banner -encoders 2>/dev/null)
for f in zscale tonemap overlay xfade; do
  case "$FILTERS" in *" $f "*) echo "  ✓ $f";; *) echo "  ✗ $f  MISSING";; esac
done
for e in h264_videotoolbox aac; do
  case "$ENCODERS" in *" $e "*) echo "  ✓ $e";; *) echo "  ✗ $e  MISSING";; esac
done
for bad in libx264 libx265 libopenh264; do
  case "$ENCODERS" in *"$bad"*) echo "  ✗ $bad PRESENT — this build is not clean";; *) echo "  ✓ no $bad";; esac
done
echo
echo "linked against (non-system libraries here would defeat the point):"
otool -L "$OUT/lib/libavfilter."*.dylib | grep -v "^$OUT" | grep -vE "/usr/lib/|/System/" | sed 's/^/  /' || true
echo
echo "output: $OUT"
