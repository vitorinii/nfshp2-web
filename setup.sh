#!/bin/bash
# From your disc image to the game in the browser, once:
#   ./setup.sh "/path/to/SLUS-20362.iso"
#
# 1. wasi-sdk 34, the compiler for the browser module, into deps/ (if it is not there yet)
# 2. ZloiKILLER's nfshp2-port-win at the version this repository is made for, into upstream/, with patches/nfshp2-web.patch applied
# 3. the game's folder from your disc, into game/ (NFSHP2/ and data/SLUS_203.62), checked against the supported release
# 4. the game's program and its sound driver translated to C++ (upstream/work/recomp/gen)
# 5. the browser module, build/web/hp2.wasm
# Then ./start.sh and open http://localhost:8080/
#
# Run it again after pulling a new version of this repository: it brings each step up to date.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
ISO="${1:-}"
GAME="${GAME:-$ROOT/game}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/ZloiKILLER/nfshp2-port-win.git}"
UPSTREAM_PIN=8ae05937be6865dde1e45c108cecd79f247d6b7a      # nfshp2-port-win 0.13
WASI_VERSION=34

[ -f "$ISO" ] || { echo "usage: ./setup.sh <your disc image (.iso)>"; exit 1; }
need() { command -v "$1" >/dev/null || { echo "$1 is needed: $2"; exit 1; }; }
need git "https://git-scm.com"
need python3 "https://www.python.org"
need bsdtar "it comes with macOS; on Linux: libarchive-tools (apt) or bsdtar (dnf, pacman)"
need make "Xcode's command line tools on macOS (xcode-select --install); build-essential on Linux"
need curl "it comes with macOS; on Linux: curl"

echo "== the compiler (wasi-sdk $WASI_VERSION)"
if [ -z "${WASI:-}" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) SDK=arm64-macos ;; Darwin-x86_64) SDK=x86_64-macos ;;
    Linux-x86_64) SDK=x86_64-linux ;; Linux-aarch64|Linux-arm64) SDK=arm64-linux ;;
    *) echo "no wasi-sdk build for $(uname -s) $(uname -m): build it yourself and set WASI=<its folder>"; exit 1 ;;
  esac
  WASI="$ROOT/deps/wasi-sdk-$WASI_VERSION.0-$SDK"
  if [ ! -x "$WASI/bin/clang" ]; then
    mkdir -p deps
    curl -fL --progress-bar -o "deps/wasi-sdk.tar.gz" \
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_VERSION/wasi-sdk-$WASI_VERSION.0-$SDK.tar.gz"
    tar -xzf deps/wasi-sdk.tar.gz -C deps && rm deps/wasi-sdk.tar.gz
  fi
fi
[ -x "$WASI/bin/clang" ] || { echo "no clang in $WASI"; exit 1; }
echo "   $WASI"

echo "== ZloiKILLER's port, at the version this repository is made for"
if [ ! -d upstream/.git ]; then git clone -q "$UPSTREAM_URL" upstream; fi
PATCH="$ROOT/patches/nfshp2-web.patch"
if [ "$(git -C upstream rev-parse HEAD)" = "$UPSTREAM_PIN" ] && git -C upstream apply -R --check "$PATCH" 2>/dev/null; then
  :                                                     # as it should be already (and its files keep their times: no rebuild)
else
  git -C upstream cat-file -e "$UPSTREAM_PIN^{commit}" 2>/dev/null || git -C upstream fetch -q origin
  git -C upstream checkout -q -f "$UPSTREAM_PIN"        # its own files as they were, then this repository's changes on top
  rm -f upstream/recomp/runtime/window_host.cpp upstream/recomp/runtime/pad_host.cpp
  git -C upstream apply --whitespace=nowarn "$PATCH"
fi
echo "   $(git -C upstream log -1 --format='%h %s') + patches/nfshp2-web.patch"

echo "== the game's folder from your disc"
mkdir -p "$GAME/data"
BOOT=$(bsdtar -xOf "$ISO" SYSTEM.CNF | sed -n 's/.*cdrom0:\\\([A-Z0-9_.]*\);1.*/\1/p')
[ -n "$BOOT" ] || { echo "   $ISO has no SYSTEM.CNF: is it a PlayStation 2 disc image?"; exit 1; }
rm -f "$GAME/data/$BOOT"                         # a disc's files come out read-only: made anew
bsdtar -xOf "$ISO" "$BOOT" > "$GAME/data/SLUS_203.62.new"
SHA=$(shasum -a 1 "$GAME/data/SLUS_203.62.new" 2>/dev/null || sha1sum "$GAME/data/SLUS_203.62.new")
case "${SHA%% *}" in
  6397d4425d55056678ed5a405cc81542f7d4d2ee) echo "   USA SLUS-20362 (or Europe v1.00): supported" ;;
  *) rm -f "$GAME/data/SLUS_203.62.new"
     echo "   this disc's program ($BOOT, ${SHA%% *}) is not the one the browser build is made for: USA SLUS-20362"; exit 1 ;;
esac
rm -f "$GAME/data/SLUS_203.62"; mv "$GAME/data/SLUS_203.62.new" "$GAME/data/SLUS_203.62"
if [ ! -f "$GAME/NFSHP2/.complete" ]; then
  echo "   copying NFSHP2/ (2.9 GB)"
  chmod -R u+w "$GAME/NFSHP2" 2>/dev/null || true
  bsdtar -xf "$ISO" -C "$GAME" NFSHP2
  chmod -R u+w "$GAME/NFSHP2"
  touch "$GAME/NFSHP2/.complete"
fi
cp -R upstream/recomp/data/. "$GAME/data/"

echo "== the game's code as C++"
python3 -I upstream/tools/recomp/gen.py --elf "$GAME/data/SLUS_203.62"
python3 -I upstream/tools/recomp/gen_iop.py --irx "$GAME/NFSHP2/IRX253/STREAM.IRX"

echo "== the browser module"
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" web WASI="$WASI"
echo
echo "Done. Start it with ./start.sh and open http://localhost:8080/"
