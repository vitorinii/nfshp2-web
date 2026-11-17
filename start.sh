#!/bin/bash
# Serves the game: ./start.sh [--port 8080] [--host 127.0.0.1] [--data <game folder>]
# Then open http://localhost:8080/ in Chrome or Edge and press Play.
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
[ -f build/web/hp2.wasm ] || { echo "build/web/hp2.wasm is missing: run ./setup.sh <your disc image> first"; exit 1; }
command -v node >/dev/null || { echo "Node.js 20 or newer is needed: https://nodejs.org"; exit 1; }
exec node web/server.mjs "$@"
