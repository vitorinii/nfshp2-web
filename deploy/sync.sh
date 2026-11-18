#!/bin/bash
# Copies what the server needs from this computer to the one that serves the game (over SSH), and only that: the server, the page,
# the module and the game folder. Nothing is built there.
#   deploy/sync.sh root@my-lxc:/opt/nfshp2-web
# Run it again after a new build: only what changed is copied.
set -euo pipefail
DEST="${1:-}"
[ -n "$DEST" ] || { echo "usage: deploy/sync.sh <user@host:/opt/nfshp2-web>"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
[ -f build/web/hp2.wasm ] || { echo "build/web/hp2.wasm is missing: run ./setup.sh <your disc image> first"; exit 1; }
[ -d game/NFSHP2 ] || { echo "game/ is missing: run ./setup.sh <your disc image> first"; exit 1; }
case "$DEST" in
  *:*) ssh "${DEST%%:*}" mkdir -p "${DEST#*:}" ;;
  *)   mkdir -p "$DEST" ;;
esac
rsync -a --relative --delete --progress --exclude '.complete' start.sh deploy/nfshp2-web.service web/server.mjs web/stats.mjs web/src build/web/hp2.wasm game "$DEST/"
echo "Copied. On that machine: sudo systemctl restart nfshp2-web (the first time: deploy/nfshp2-web.service). Open pages take the new"
echo "version after the restart: the server tells it apart then (/version)."
