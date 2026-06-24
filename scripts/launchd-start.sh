#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOST="${BILAL_DEMO_HOST:-localhost}"
APP_PORT="${BILAL_DEMO_PORT:-3000}"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NEXT_TELEMETRY_DISABLED="1"

cd "$APP_DIR"

if [ ! -d "node_modules" ]; then
  npm ci
fi

exec npm run dev -- --hostname "$APP_HOST" --port "$APP_PORT"
