#!/usr/bin/env bash
#
# Phase-4b isolated acceptance runner (the Web settings page's two data faces).
#
# NOT a runtime dependency: this is the reproducible harness behind
# `data/acceptance-phase4b-<date>.json`. It:
#
#   1. copies this machine's `~/.dsh` profile + credentials into a fresh
#      ISOLATED `DSH_HOME` under /tmp (never touches `~/.dsh`);
#   2. builds and packs the plugin from THIS checkout and installs the tarball
#      into that isolated profile (`dsh plugin add`, never a symlink);
#   3. composes an isolated `cordis.patch.yml` that turns startup sync off and
#      mounts `scripts/acceptance/phase4b-probe.mjs`;
#   4. starts `dsh web` on a loopback port;
#   5. proves the HOST SERVES THE CLIENT HALF: the boot graph in the served HTML
#      names `dsh-opencodego`, and the `./client` bundle is fetched over HTTP and
#      checked to be the ModuleLoader registration for this package;
#   6. curls the three seam routes the page consumes;
#   7. curls the probe's own route, which runs the settings round trip (the same
#      `describe`/`get`/`mutate` calls the Remote namespace mirrors) and answers
#      its assertions — it must run AFTER the plugin's namespace registers, which
#      is why the round trip lives behind a route instead of at mount time;
#   8. kills ONLY the PID it started.
#
# Usage: bash scripts/acceptance/phase4b-run.sh [port]
#
# No credential value is ever printed: the only credential fact on the wire is
# the reference NAME (`apiKeyEnv`).

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PORT="${1:-39423}"
ISO="$(mktemp -d /tmp/dsh-ocg-p4b-XXXXXX)"
WORK="$(mktemp -d /tmp/ocg-p4b-XXXXXX)"
PACK="$WORK/pack"
OUT="$WORK/probe-evidence.json"
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
# Start from an EMPTY settings document: the round trip writes the overlay it
# then reads back, and a leftover section would mask a failure.
rm -f "$ISO/settings.yaml"
rm -f "$ISO/profiles/web/cordis.patch.yml.bak"*

echo "== building and packing from $REPO"
( cd "$REPO" && npm run build && npm pack --pack-destination "$PACK" >/dev/null )
TARBALL="$(ls "$PACK"/dsh-opencodego-*.tgz | head -1)"
echo "== installing $(basename "$TARBALL")"
DSH_HOME="$ISO" dsh plugin --profile web add "$TARBALL" >/dev/null

cat >> "$PATCH" <<YAML

# ── phase-4b acceptance composition (isolated instance only) ──
- id: opencode-go-native
  config:
    sync: false
- insert:
    - id: ocg-verify-phase4b
      name: $REPO/scripts/acceptance/phase4b-probe.mjs
YAML

echo "== starting dsh web on 127.0.0.1:$PORT"
DSH_HOME="$ISO" OCG_P4B_LOG="$WORK/iso.log" \
  setsid nohup dsh web --host 127.0.0.1 --port "$PORT" --no-open > "$WORK/web.log" 2>&1 &
PID=$!

# Wait for the plugin's own route to answer (it registers as the plugin loads),
# then for the probe to see the settings namespace.
for i in $(seq 1 120); do
  if curl -s -o /dev/null -m 2 -H "host: 127.0.0.1:$PORT" \
      "http://127.0.0.1:$PORT/opencode-go-native/diagnostics"; then
    echo "== listener up after ${i}s"
    break
  fi
  kill -0 "$PID" 2>/dev/null || { echo "== process exited early after ${i}s"; break; }
  sleep 1
done
for i in $(seq 1 90); do
  grep -q "settings namespace registered" "$WORK/iso.log" 2>/dev/null && { echo "== settings namespace registered after ${i}s"; break; }
  sleep 1
done

echo "--- probe log ---"
cat "$WORK/iso.log" 2>/dev/null || true

echo "--- client half + routes (curl) ---"
python3 "$HERE/phase4b-curl.py" "$PORT" "$OUT" "$WORK/client.json"

echo "--- probe evidence summary ---"
if [ -f "$OUT" ]; then
  python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"probe assertions: {len(d['assertions'])}  failures: {len(d['failures'])}")
for a in d["assertions"]:
    print(("PASS " if a["pass"] else "FAIL "), a["name"])
PY
else
  echo "NO PROBE EVIDENCE — see $WORK/web.log"
  tail -30 "$WORK/web.log" 2>/dev/null || true
fi

python3 "$HERE/phase4b-combine.py" "$OUT" "$WORK/client.json" "$REPO"
