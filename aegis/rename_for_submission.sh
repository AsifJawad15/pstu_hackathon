#!/usr/bin/env bash
# Rename the submission deliverables to your registration ID.
#
#   bash rename_for_submission.sh PSTU-HACK-2026-000 [path/to/video.mp4]
#
# Produces <ID>.pdf (and <ID>.mp4 if a video is given) in ./submission/,
# strips PDF metadata that could identify you, and re-checks every hard limit
# from the question set.

set -euo pipefail

ID="${1:-}"
VIDEO="${2:-}"

if [[ -z "$ID" ]]; then
  echo "usage: bash rename_for_submission.sh PSTU-HACK-2026-000 [video.mp4]" >&2
  exit 1
fi

if [[ ! "$ID" =~ ^PSTU-HACK-2026-[0-9]+$ ]]; then
  echo "warning: '$ID' does not look like PSTU-HACK-2026-NNN — continuing anyway" >&2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/docs/abstract.pdf"
OUT="$HERE/submission"
mkdir -p "$OUT"

[[ -f "$SRC" ]] || { echo "error: $SRC not found. Build it with: cd docs && pdflatex abstract.tex" >&2; exit 1; }

# --- abstract -------------------------------------------------------------
cp "$SRC" "$OUT/$ID.pdf"

# Strip identifying metadata if qpdf is available; harmless if it isn't.
if command -v qpdf >/dev/null 2>&1; then
  qpdf --empty --pages "$OUT/$ID.pdf" 1-z -- "$OUT/.tmp.pdf" 2>/dev/null \
    && mv "$OUT/.tmp.pdf" "$OUT/$ID.pdf" \
    && echo "  metadata stripped"
fi

SIZE=$(stat -c%s "$OUT/$ID.pdf" 2>/dev/null || stat -f%z "$OUT/$ID.pdf")
echo "abstract -> submission/$ID.pdf  ($((SIZE/1024)) KB)"
if (( SIZE > 10*1024*1024 )); then
  echo "  FAIL: exceeds the 10 MB limit" >&2; exit 1
fi
echo "  OK: under the 10 MB limit"

if command -v pdftotext >/dev/null 2>&1; then
  WORDS=$(pdftotext "$OUT/$ID.pdf" - | wc -w)
  echo "  raw word count (incl. title + footer): $WORDS  [abstract body is 237]"
fi

# --- video ----------------------------------------------------------------
if [[ -n "$VIDEO" ]]; then
  [[ -f "$VIDEO" ]] || { echo "error: video '$VIDEO' not found" >&2; exit 1; }
  [[ "$VIDEO" == *.mp4 ]] || echo "  WARNING: '$VIDEO' is not .mp4 — the rules require MP4" >&2

  cp "$VIDEO" "$OUT/$ID.mp4"
  VSIZE=$(stat -c%s "$OUT/$ID.mp4" 2>/dev/null || stat -f%z "$OUT/$ID.mp4")
  echo "video    -> submission/$ID.mp4  ($((VSIZE/1024/1024)) MB)"
  if (( VSIZE > 400*1024*1024 )); then
    echo "  FAIL: exceeds the 400 MB limit — re-encode at a lower bitrate" >&2; exit 1
  fi
  echo "  OK: under the 400 MB limit"

  if command -v ffprobe >/dev/null 2>&1; then
    DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$ID.mp4" | cut -d. -f1)
    printf '  duration: %d:%02d\n' $((DUR/60)) $((DUR%60))
    if (( DUR > 240 )); then
      echo "  FAIL: exceeds 4 minutes" >&2; exit 1
    fi
    echo "  OK: within 4 minutes"
  else
    echo "  (ffprobe not available — check the duration is under 4:00 yourself)"
  fi
else
  echo "video    -> not supplied yet; re-run with the .mp4 path once recorded"
fi

echo
echo "Still yours to verify by eye: no team name, no member names, no"
echo "institution name anywhere in the abstract or the video."
