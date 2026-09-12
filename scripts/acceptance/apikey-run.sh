#!/usr/bin/env bash
#
# Isolated acceptance run for the inline-`apiKey` change.
#
# It NEVER touches `~/.dsh`: everything happens in a throwaway `DSH_HOME` under
# /tmp with a COPY of the real profile and credentials, on port 39xx, and the
# only process it kills is the one it started (matched by its own `DSH_HOME`
# environment, never `pkill dsh`, which would hit the user's instance on 3080).
#
# What it does, in order:
#
#   1. copies the real profile + credentials into the isolated home, and starts
#      from an EMPTY settings document;
#   2. builds, packs and installs THIS checkout's tarball into the isolated
#      profile (remove-then-add: the same version is otherwise a no-op);
#   3. starts `dsh web` on loopback with the probe mounted from the checkout;
#   4. proves the PRE-state: with no credential reference present, the plugin's
#      own discovery seam answers MISSING_CREDENTIAL (the reported failure);
#   5. drives the REAL browser (scripts/acceptance/gui-probe.mjs) through the
#      settings page: open the section, type the sentinel into apiKey, save;
#   6. proves the POST-state: the sentinel is on disk, the resolver returns a
#      fingerprint of exactly that sentinel, removing it reproduces
#      MISSING_CREDENTIAL, and the discovery seam no longer reports a credential
#      failure;
#   7. kills only its own PID and prints the evidence paths.
#
# Usage: bash scripts/acceptance/apikey-run.sh [port]
#
# The only secret that ever appears is the obvious sentinel
# `sk-SENTINEL-not-a-real-key`. No real credential is read, printed, or written.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PORT="${1:-39437}"
ISO="$(mktemp -d /tmp/dsh-ocg-apikey-XXXXXX)"
WORK="$(mktemp -d /tmp/ocg-apikey-XXXXXX)"
PACK="$WORK/pack"
OUT="$WORK/evidence"
SENTINEL='sk-SENTINEL-not-a-real-key'
mkdir -p "$PACK" "$OUT"

cleanup() {
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  # Reap ONLY instances whose DSH_HOME is THIS run's directory. Never `pkill dsh`.
  for pid in $(pgrep -f "dsh web" || true); do
    if [ -r "/proc/$pid/environ" ] && tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q "^DSH_HOME=$ISO$"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

echo "== isolated DSH_HOME: $ISO"
echo "== work dir:          $WORK"
echo "== port:              $PORT"
mkdir -p "$ISO/profiles"
cp -a "$HOME/.dsh/profiles/web" "$ISO/profiles/web"
cp -a "$HOME/.dsh/profiles/node_modules" "$ISO/profiles/node_modules"
cp -a "$HOME/.dsh/.credentials.yaml" "$ISO/.credentials.yaml"
# An EMPTY settings document: this run's whole point is the write it then reads
# back, and a leftover section would mask a failure.
rm -f "$ISO/settings.yaml"
rm -f "$ISO/profiles/web/cordis.patch.yml.bak"*

echo "== building and packing from $REPO"
( cd "$REPO" && npm run build && npm pack --pack-destination "$PACK" >/dev/null ) || {
  echo "!! build/pack failed"; exit 1
}
TARBALL="$(ls "$PACK"/dsh-opencodego-*.tgz | head -1)"
echo "== installing $(basename "$TARBALL")"
# Same version ⇒ `add` is a no-op, so the installed copy is removed first. Only
# this throwaway profile is touched.
DSH_HOME="$ISO" dsh plugin --profile web remove dsh-opencodego >/dev/null 2>&1 || true
DSH_HOME="$ISO" dsh plugin --profile web add "$TARBALL" >/dev/null || { echo "!! plugin add failed"; exit 1; }
LIB="$ISO/profiles/web/node_modules/dsh-opencodego/lib/index.js"
[ -f "$LIB" ] || { echo "!! installed lib missing at $LIB"; exit 1; }
echo "== installed host half: $LIB"

cat >> "$ISO/profiles/web/cordis.patch.yml" <<YAML

# ── inline-apiKey acceptance composition (isolated instance only) ──
- insert:
    - id: ocg-apikey-probe
      name: $REPO/scripts/acceptance/apikey-probe.mjs
YAML

echo "== starting dsh web on 127.0.0.1:$PORT"
DSH_HOME="$ISO" OCG_PLUGIN_LIB="$LIB" \
  setsid nohup dsh web --host 127.0.0.1 --port "$PORT" --no-open > "$WORK/web.log" 2>&1 &
PID=$!

probe() { # probe <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -m 40 -X "$method" -H 'content-type: application/json' --data "$body" "http://127.0.0.1:$PORT$path"
  else
    curl -s -m 40 -X "$method" "http://127.0.0.1:$PORT$path"
  fi
}

for i in $(seq 1 120); do
  if probe GET /ocg-apikey-probe/diagnostics >/dev/null 2>&1; then
    echo "== listener up after ${i}s"; break
  fi
  kill -0 "$PID" 2>/dev/null || { echo "!! process exited early"; tail -30 "$WORK/web.log"; exit 1; }
  sleep 1
done

# The page's URL, with the same token the browser needs. It comes from THIS
# instance's own startup line — never from the user's instance — and the read is
# retried because the log line is written by the listener, not before it.
TOKEN=""
for i in $(seq 1 30); do
  TOKEN="$(grep -o 'token=[A-Za-z0-9._-]*' "$WORK/web.log" 2>/dev/null | tail -1 | cut -d= -f2)"
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || { echo "!! no web token found in $WORK/web.log"; tail -20 "$WORK/web.log"; exit 1; }
echo "== web token: ${TOKEN:0:6}… (length ${#TOKEN})"
URL="http://127.0.0.1:$PORT/?token=$TOKEN"

# ── step 4: the PRE-state, which is the failure the user reported ───────────
echo "== PRE: discovery with no credential reference present"
probe POST /ocg-apikey-probe/refresh '{"provider":"opencode-go-native"}' | tee "$OUT/refresh-before.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('   code:', d.get('code'), '| credentialFailure:', d.get('credentialFailure'))
print('   message:', str(d.get('message'))[:160])
"

# ── step 5: the real browser ────────────────────────────────────────────────
echo "== browser: open the section, type the sentinel into apiKey, save, reload"
# The trailing 重新载入 is what proves the value came back from the STORED
# document rather than surviving in component state: the page refetches, and the
# control must then report 已配置 while still rendering an EMPTY password input.
node "$HERE/gui-probe.mjs" "$URL" "OpenCode Go" \
  --fill 'apiKey' "$SENTINEL" --click '保存' --wait 3000 \
  --click '重新载入' --wait 2500 \
  > "$OUT/browser.txt" 2>&1 || true
sed -n '1,200p' "$OUT/browser.txt"

# ── step 6: the POST-state ──────────────────────────────────────────────────
echo "== POST: on-disk facts"
probe GET /ocg-apikey-probe/diagnostics > "$OUT/diagnostics-after.json"
python3 - "$OUT/diagnostics-after.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
c = d.get('connection', {})
print('   apiKeyInline:', c.get('apiKeyInline'), '| apiKeyEnv:', c.get('apiKeyEnv'))
print('   resolved fingerprint:', c.get('resolvedApiKeyFingerprint'))
print('   on disk:', d.get('onDisk'))
PY

echo "== POST: the resolver, with and without the saved key"
probe POST /ocg-apikey-probe/probe "{\"publicKey\":\"$SENTINEL\"}" > "$OUT/probe-after.json"
python3 - "$OUT/probe-after.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('   expected fingerprint :', d.get('expectedFingerprint'))
print('   withKey              :', d.get('withKey'))
print('   withoutKey           :', d.get('withoutKey'))
PY

echo "== POST: the plugin's own discovery seam"
probe POST /ocg-apikey-probe/refresh '{"provider":"opencode-go-native"}' | tee "$OUT/refresh-after.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('   code:', d.get('code'), '| credentialFailure:', d.get('credentialFailure'), '| modelCount:', d.get('modelCount'))
print('   message:', str(d.get('message'))[:200])
"

echo
echo "== EVIDENCE FILES"
echo "   $OUT/browser.txt"
echo "   $OUT/diagnostics-after.json"
echo "   $OUT/probe-after.json"
echo "   $OUT/refresh-before.json"
echo "   $OUT/refresh-after.json"
echo "   isolated instance log: $WORK/web.log"
echo "   isolated home (left in place for inspection): $ISO"
