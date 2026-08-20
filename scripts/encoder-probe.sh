#!/usr/bin/env bash
# encoder-probe — compare H.264 encoders at this app's real settings.
#
# Written for docs/ffmpeg-bundling-research.md §7.2, which reports the numbers
# this produces. Kept so those numbers can be reproduced and disputed rather
# than taken on trust — and so the next person measuring a different encoder
# (OpenH264, h264_mf, h264_nvenc) starts from a harness that is already right.
#
#   ./scripts/encoder-probe.sh clip1.MOV clip2.MOV clip3.MOV
#
# What it does: pushes each clip through the app's own tone-map and geometry
# chain, writes a LOSSLESS ffv1 reference, then encodes that reference with
# each candidate and scores it with VMAF. Every encoder sees identical pixels,
# so the filter graph is not part of the comparison.
#
# Needs an ffmpeg with libvmaf, libzimg and libx264 — on macOS that is
# `brew install ffmpeg-full`. This is a measurement tool, not something the app
# ships, so a GPL ffmpeg is fine here in a way it would not be in a bundle.
#
# ## Two bugs that are already fixed here, and must stay fixed
#
# `-nostdin`, because ffmpeg otherwise consumes this loop's stdin and the
# second clip is handed a truncated path.
#
# `settb=AVTB,setpts=N/30/TB` on BOTH libvmaf inputs. Pairing the two streams
# by timestamp silently mismatches the mkv reference against the mp4 encodes
# and scores a visually perfect encode at 63.9 instead of 99.9 — plausible
# numbers, internally consistent, and wrong. Frames are paired by index, and
# the self-check below refuses to report anything if that breaks again.
set -uo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <clip> [clip...]" >&2; exit 2; }

# The first ffmpeg on PATH is usually the wrong one — Homebrew's plain formula
# has neither libvmaf nor libzimg — so candidates are tried in order and the
# first complete build wins. Same problem `ffmpeg::best()` solves for the app,
# and the same reason: being on PATH says nothing about being capable.
#
# Capabilities are captured into a variable and matched there, never piped
# straight into `grep -q`. Under `pipefail` that pipeline reports failure on a
# *successful* match: grep exits at the first hit, closes the pipe, and ffmpeg
# dies of SIGPIPE. The release workflow shipped that exact bug once already.
has () { case "$2" in *"$1"*) return 0;; *) return 1;; esac; }
usable () {
  [ -x "$1" ] || command -v "$1" >/dev/null 2>&1 || return 1
  local filters encoders
  filters=$("$1" -hide_banner -filters 2>/dev/null) || return 1
  encoders=$("$1" -hide_banner -encoders 2>/dev/null) || return 1
  has libvmaf "$filters" && has zscale "$filters" && has libx264 "$encoders"
}
FFMPEG=${FFMPEG:-}
if [ -z "$FFMPEG" ]; then
  for c in /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg /usr/local/opt/ffmpeg-full/bin/ffmpeg ffmpeg; do
    if usable "$c"; then FFMPEG=$c; break; fi
  done
fi
if [ -z "$FFMPEG" ] || ! usable "$FFMPEG"; then
  echo "Need an ffmpeg with libvmaf, libzimg and libx264 — try:" >&2
  echo "  brew install ffmpeg-full     (or set FFMPEG=/path/to/ffmpeg)" >&2
  exit 2
fi
FFPROBE=${FFPROBE:-${FFMPEG%ffmpeg}ffprobe}
command -v "$FFPROBE" >/dev/null 2>&1 || [ -x "$FFPROBE" ] || FFPROBE=ffprobe
FF="$FFMPEG -nostdin -hide_banner"
ENCODERS=$("$FFMPEG" -hide_banner -encoders 2>/dev/null)
echo "using $FFMPEG" >&2

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# Lifted from ffmpeg.rs. Keep in step with it, or this measures the wrong thing.
TONEMAP="zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
GEOM="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
SYNC="[0:v]settb=AVTB,setpts=N/30/TB[d];[1:v]settb=AVTB,setpts=N/30/TB[r];[d][r]libvmaf=n_threads=8"
SECONDS_PER_CLIP=${SECONDS_PER_CLIP:-8}

vmaf () { # $1 distorted, $2 reference
  local out
  out=$($FF -i "$1" -i "$2" -lavfi "$SYNC" -f null - 2>&1 | tr '\r' '\n')
  printf '%s\n' "$out" | grep -oE "VMAF score: [0-9.]+" | tail -1 | grep -oE "[0-9.]+$"
}
kbps () { "$FFPROBE" -v error -select_streams v:0 -show_entries stream=bit_rate -of csv=p=0 "$1" \
    | awk '{printf "%d", $1/1000}'; }
secs () { local t0=$SECONDS; "$@" >/dev/null 2>&1; echo $((SECONDS-t0)); }
row  () { printf "%-6s  %-26s  %8s  %9s  %6ss\n" "$1" "$2" "$(kbps "$3")" "$(vmaf "$3" "$4")" "$5"; }

printf "%-6s  %-26s  %8s  %9s  %7s\n" clip encoder kbps VMAF time
printf -- "------------------------------------------------------------------------\n"

i=0
for SRC in "$@"; do
  [ -f "$SRC" ] || { echo "missing: $SRC" >&2; continue; }
  i=$((i+1)); n="clip$i"
  REF="$WORK/$n.mkv"
  $FF -v error -ss 2 -t "$SECONDS_PER_CLIP" -i "$SRC" -an -vf "$TONEMAP,$GEOM" -c:v ffv1 -y "$REF" \
    || { echo "$n: could not build a reference from $SRC" >&2; continue; }

  # If the reference does not score ~100 against itself, the framesync is
  # broken and nothing below this line means anything.
  SELF=$(vmaf "$REF" "$REF")
  if ! awk -v v="${SELF:-0}" 'BEGIN{exit !(v>99)}'; then
    echo "HARNESS BROKEN: reference scored ${SELF:-nothing} against itself, expected >99" >&2
    exit 1
  fi

  # What the app ships today.
  X="$WORK/$n-x264.mp4"
  t=$(secs $FF -v error -i "$REF" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -y "$X")
  BX=$(kbps "$X"); row "$n" "x264 veryfast crf20" "$X" "$REF" "$t"

  # Route C, hardware and software, given exactly the bitrate x264 chose.
  if has h264_videotoolbox "$ENCODERS"; then
    for mode in "hw:" "sw:-require_sw 1"; do
      label=${mode%%:*}; extra=${mode#*:}
      O="$WORK/$n-vt-$label.mp4"
      # shellcheck disable=SC2086
      t=$(secs $FF -v error -i "$REF" -c:v h264_videotoolbox $extra -b:v "${BX}k" \
             -profile:v high -coder cabac -pix_fmt yuv420p -y "$O")
      row "$n" "videotoolbox $label @${BX}k" "$O" "$REF" "$t"
    done
    # Constant quality, to calibrate the replacement for -crf 20.
    for q in 55 65 75; do
      O="$WORK/$n-vt-q$q.mp4"
      t=$(secs $FF -v error -i "$REF" -c:v h264_videotoolbox -q:v "$q" \
             -profile:v high -coder cabac -pix_fmt yuv420p -y "$O")
      row "$n" "videotoolbox q=$q" "$O" "$REF" "$t"
    done
  fi

  # Route A, when an ffmpeg that has it is pointed at this script.
  if has libopenh264 "$ENCODERS"; then
    O="$WORK/$n-openh264.mp4"
    t=$(secs $FF -v error -i "$REF" -c:v libopenh264 -b:v "${BX}k" -profile:v high -y "$O")
    row "$n" "openh264 @${BX}k" "$O" "$REF" "$t"
  fi

  # Windows, for whoever runs this there. Untested as of writing.
  if has h264_mf "$ENCODERS"; then
    O="$WORK/$n-mf.mp4"
    t=$(secs $FF -v error -i "$REF" -c:v h264_mf -b:v "${BX}k" -y "$O")
    row "$n" "h264_mf @${BX}k" "$O" "$REF" "$t"
  fi
done
