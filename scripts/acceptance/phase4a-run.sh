#!/usr/bin/env bash
#
# Phase-4a isolated acceptance runner (the host settings surface).
#
# NOT a runtime dependency: this is the reproducible harness behind
# `data/acceptance-phase4a-2026-09-11.json`. It:
#
#   1. copies this machine's `~/.dsh` profile + credentials into a fresh
#      ISOLATED `DSH_HOME` under /tmp (never touches `~/.dsh`);
#   2. builds and packs the plugin from THIS checkout and installs the tarball
#      into that isolated profile (`dsh plugin add`, never a symlink — see
#      README「依赖解析」);
#   3. composes an isolated `cordis.patch.yml` that turns startup sync off and
#      mounts `scripts/acceptance/phase4a-probe.mjs`;
#   4. starts `dsh web` on a loopback port with a sentinel key in its
#      environment, waits for the probe's evidence file, and then kills ONLY the
#      PID it started.
#
# Usage: bash scripts/acceptance/phase4a-run.sh [port]
# Requires: a resolvable `dsh` on PATH, and `~/.dsh/.credentials.yaml` holding a
# usable OPENCODE_GO_API_KEY (the probe's final assertion is one real relay
# stream). No credential value is ever printed.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PORT="${1:-39411}"
ISO="$(mktemp -d /tmp/dsh-ocg-p4a-XXXXXX)"
WORK="$(mktemp -d /tmp/ocg-p4a-XXXXXX)"
PACK="$WORK/pack"
OUT="$WORK/evidence.json"
PATCH="$ISO/profiles/web/cordis.patch.yml"

cleanup() {
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  # Reap ONLY instances whose DSH_HOME is this run's isolated directory. Never
  # `pkill dsh`: the developer's own instance may be running on 3080.
  for pid in $(pgrep -f "dsh web" || true); do
    if [ -r "/proc/$pid/environ" ] && tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q "^DSH_HOME=$ISO$"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

echo "== isolated DSH_HOME: $ISO"
mkdir -p "$ISO/profiles" "$PACK"
cp -a "$HOME/.dsh/profiles/web" "$ISO/profiles/web"
cp -a "$HOME/.dsh/profiles/node_modules" "$ISO/profiles/node_modules"
cp -a "$HOME/.dsh/.credentials.yaml" "$ISO/.credentials.yaml"
cp "$ISO/profiles/web/cordis.patch.yml" "$WORK/cordis.patch.base.yml"

echo "== building and packing from $REPO"
( cd "$REPO" && npm run build >/dev/null && npm pack --pack-destination "$PACK" >/dev/null )
TARBALL="$(ls "$PACK"/dsh-opencodego-*.tgz | head -1)"
echo "== installing $(basename "$TARBALL")"
DSH_HOME="$ISO" dsh plugin --profile web add "$TARBALL" >/dev/null

cp "$WORK/cordis.patch.base.yml" "$PATCH"
cat >> "$PATCH" <<YAML

# ── phase-4a acceptance composition (isolated instance only) ──
- id: opencode-go-native
  config:
    sync: false
- insert:
    - id: ocg-verify-phase4a
      name: $REPO/scripts/acceptance/phase4a-probe.mjs
YAML

rm -f "$ISO/settings.yaml"
echo "== starting dsh web on 127.0.0.1:$PORT"
DSH_HOME="$ISO" OCG_P4_OUT="$OUT" OCG_P4_LOG="$WORK/iso.log" \
  setsid nohup dsh web --host 127.0.0.1 --port "$PORT" --no-open > "$WORK/web.log" 2>&1 &
PID=$!

for i in $(seq 1 180); do
  [ -f "$OUT" ] && { echo "== evidence after ${i}s"; break; }
  kill -0 "$PID" 2>/dev/null || { echo "== process exited early after ${i}s"; break; }
  sleep 1
done

echo "--- probe log ---"
cat "$WORK/iso.log" 2>/dev/null || true
echo "--- evidence: $OUT ---"
if [ -f "$OUT" ]; then
  cp "$OUT" "$REPO/data/acceptance-phase4a-$(date -u +%F).json"
  echo "copied to data/acceptance-phase4a-$(date -u +%F).json"
  python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"assertions: {len(d['assertions'])}  failures: {len(d['failures'])}")
for a in d["assertions"]:
    print(("PASS " if a["pass"] else "FAIL "), a["name"])
PY
else
  echo "NO EVIDENCE — see $WORK/web.log"
  tail -30 "$WORK/web.log" 2>/dev/null || true
fi
