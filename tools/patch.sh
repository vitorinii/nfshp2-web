#!/bin/bash
# After changing ZloiKILLER's files in upstream/ (or this repository's copies there, window_host.cpp and pad_host.cpp): writes the changes
# back into patches/nfshp2-web.patch, the only form in which this repository keeps them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT/upstream"
PIN=$(sed -n 's/^UPSTREAM_PIN=\([0-9a-f]*\).*/\1/p' "$ROOT/setup.sh")
git add -N recomp/runtime/window_host.cpp recomp/runtime/pad_host.cpp
git diff -C30% --find-copies-harder "$PIN" -- recomp tools > "$ROOT/patches/nfshp2-web.patch"
git reset -q recomp/runtime/window_host.cpp recomp/runtime/pad_host.cpp
echo "patches/nfshp2-web.patch: $(grep -c '^diff --git' "$ROOT/patches/nfshp2-web.patch") files"
