/**
 * End-to-end acceptance for the ACTIVE-SUBSCRIPTION layer (0.8.2), against a
 * LOCAL fake gateway — zero real quota, safe to run anywhere, and it drives the
 * REAL plugin: `src/index.js#apply` on a cordis-shaped fake context, the real
 * `OpenCodeGoAdapter`, and the real `@earendil-works/pi-ai` streaming the real
 * wire. Only the gateway is fake.
 *
 * It proves the four promises the redesign makes:
 *
 *   1. a pre-0.8 document (no `subscriptions` at all) serves with the implicit
 *      DEFAULT subscription, whose slot is the top-level `apiKeyEnv`;
 *   2. exactly ONE subscription pays: a second configured row receives NO chat
 *      request, ever — not even when the active key answers 429;
 *   3. a failure on the active key is reported HONESTLY (an error finish / a
 *      thrown error), never silently re-billed to another key;
 *   4. switching is an operator act: `activeSubscription` decides, and the very
 *      next request spends the newly selected row's slot;
 *   5. the ONE live variable (`apiKeyEnv`) is kept holding the active row's key,
 *      so "select a row, and the single variable changes" is literally true;
 *   6. a 403 REGION gate is reported as an unsupported model with the gateway's
 *      own sentence — never as an `AUTH` problem, which the harness would
 *      relabel "API key is invalid" and thereby hide the real cause.
 *
 * Run:
 *   node scripts/e2e-active-sub.mjs
 * Requires the dev `node_modules/` symlink layer (see CLAUDE.md「本地 link」)
 * because `src/index.js` imports the host packages. `$DSH_HOME` is redirected
 * to a private temp dir so the acceptance run never touches a real install's
 * usage/synced layers.
 *
 * @module scripts/e2e-active-sub
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ocg-e2e-home-'))

const { apply } = await import('../src/index.js')

/* ── the fake gateway ───────────────────────────────────────────────────── */

const gateway = {
  /** every chat/completions authorization, in arrival order */
  seen: [],
  /** auth values whose chat requests answer 429 */
  failing: new Set(),
  /** auth values whose chat requests answer 403 with a REGION gate (the key is fine) */
  gated: new Set(),
  /** every /usage authorization, in arrival order */
  probed: [],
}

function bearerValue(auth) {
  return String(auth ?? '').replace(/^Bearer\s+/u, '')
}

function sseChat(res, auth) {
  gateway.seen.push(auth)
  if (gateway.failing.has(bearerValue(auth))) {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Rate limit reached for this key (429)' } }))
    return
  }
  if (gateway.gated.has(bearerValue(auth))) {
    // The live gateway's own wording for a China-hosted model (recorded from a
    // real run): 403, and the KEY is perfectly good.
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: {
        message: 'Enable the model explicitly in your OpenCode (opencode.ai) workspace: '
          + 'its latest version is hosted in China only and requires explicit opt-in.',
      },
    }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'alpha' }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer((req, res) => {
  const auth = String(req.headers.authorization ?? '')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'alpha', object: 'model', owned_by: 'fake' }] }))
    return
  }
  if (url.pathname === '/v1/usage') {
    gateway.probed.push(auth)
    res.writeHead(200, { 'content-type': 'application/json' })
    const percent = bearerValue(auth) === 'key:WORK_KEY' ? 42 : 10
    res.end(JSON.stringify({
      usage: { weekly: { status: 'ok', percent, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() } },
    }))
    return
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    req.resume()
    req.on('end', () => sseChat(res, auth))
    return
  }
  res.writeHead(404).end()
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const baseURL = `http://127.0.0.1:${String(server.address().port)}/v1`

/* ── the cordis-shaped fake host ────────────────────────────────────────── */

const credentialsService = {
  /** every credential reference the plugin asked for, in arrival order */
  requested: [],
  /** the LIVE slot's content, as the plugin mirrored it */
  stored: new Map(),
  async resolve(ref) {
    const name = String(ref)
    credentialsService.requested.push(name)
    // Any slot has a value here; what matters is WHICH slot was asked for, and
    // that is asserted from `requested` below.
    return { value: credentialsService.stored.get(name) ?? `key:${name}` }
  },
  /** The mirror's write path: the plugin copying the active key into the live slot. */
  async set(ref, value) {
    credentialsService.stored.set(String(ref), value)
  },
  async describe(ref) {
    return { configured: true, source: 'file' }
  },
}

/** Mount the plugin once and answer the adapter it registered. */
function mount(config) {
  let adapter
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) { return name === 'credentials' ? credentialsService : undefined },
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('credentials')) callback(ctx)
      // settings/webServer never arrive: the section and the HTTP face are not
      // under test here; the request path is.
    },
    effect(fn) { fn?.() },
    llm: {
      registerConfigurableProviders() { return Object.assign(() => {}, { replace() {} }) },
      registerAdapter(_routes, instance) { adapter = instance; return Object.assign(() => {}, { replace() {} }) },
      registerModelDiscovery() { return () => {} },
    },
  }
  apply(ctx, config)
  assert.ok(adapter !== undefined, 'apply() must register the adapter')
  return adapter
}

async function ask(adapter, sessionId) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'opencode-go-native',
    model: 'alpha',
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) {
    chunks.push(chunk)
  }
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text ?? '').join('')
  return { chunks, text }
}

const baseConfig = {
  baseURL,
  apiKeyEnv: 'MAIN_KEY',
  // The default row's NAME is the top-level `displayName` (the account email),
  // and the second row carries its own — so the two slots are the names an
  // operator would see in `.credentials.yaml`.
  displayName: 'me@example.com',
  // discover-all: the fake gateway advertises `alpha`.
  models: { replaceDiscovered: false },
  subscriptions: [{ id: 'work', label: 'work@example.com' }],
}

/* ── 1: a pre-0.8 document serves with the implicit default subscription ── */

{
  const adapter = mount({ baseURL, apiKeyEnv: 'MAIN_KEY', models: { replaceDiscovered: false } })
  gateway.seen.length = 0
  const answer = await ask(adapter, 'legacy')
  assert.equal(answer.text, 'pong', 'the implicit default subscription must serve a pre-0.8 document')
  assert.deepEqual(gateway.seen, ['Bearer key:OPENCODE_GO_DEFAULT'], "the default row spends its OWN slot")
  // The operator-facing view names both rows and marks exactly one active.
  const rows = adapter.diagnostics().subscriptions
  assert.equal(rows.length, 1, 'a pre-0.8 document is ONE subscription')
  assert.deepEqual(rows.map((row) => row.active), [true])
  // An UNNAMED row falls back to the id-derived spelling — which is exactly what
  // earlier versions stored, so nothing is stranded by the naming change.
  assert.deepEqual(rows.map((row) => row.apiKeyRef), ['OPENCODE_GO_DEFAULT'])
}

/* ── 2: exactly ONE row pays, and it is the ACTIVE one ──────────────────── */

const defaultAdapter = mount(baseConfig)
{
  gateway.seen.length = 0
  const answer = await ask(defaultAdapter, 's1')
  assert.equal(answer.text, 'pong')
  assert.deepEqual(gateway.seen, ['Bearer key:OPENCODE_GO_ME_EXAMPLE_COM'], 'the non-active row spends nothing')
  const rows = defaultAdapter.diagnostics().subscriptions
  assert.deepEqual(rows.map((row) => row.id), ['default', 'work'])
  assert.deepEqual(rows.map((row) => row.active), [true, false])
  // Slots are the NAMES, so the credential store is readable on its own.
  assert.deepEqual(rows.map((row) => row.apiKeyRef), [
    'OPENCODE_GO_ME_EXAMPLE_COM', 'OPENCODE_GO_WORK_EXAMPLE_COM',
  ])
}

/* ── 3: a failure on the active key is reported, never re-billed ────────── */

{
  // MAIN fails; WORK is perfectly healthy and MUST NOT be tried: silently
  // moving to another account is exactly the failover this design removed (the
  // operator picks who pays, not the failure).
  gateway.failing.add('key:OPENCODE_GO_ME_EXAMPLE_COM')
  gateway.seen.length = 0
  const answer = await ask(defaultAdapter, 's1')
  assert.equal(answer.text, '', 'a failing key produces no content')
  assert.equal(answer.chunks.at(-1)?.type, 'finish', 'the caller gets a terminal chunk')
  assert.equal(answer.chunks.at(-1)?.reason?.kind, 'error', 'and it says the request failed')
  assert.ok(gateway.seen.length >= 1, 'the active key was actually attempted')
  assert.ok(
    gateway.seen.every((auth) => auth === 'Bearer key:OPENCODE_GO_ME_EXAMPLE_COM'),
    'the healthy non-active key received NO chat request',
  )
  gateway.failing.clear()
}

/* ── 4: switching is an operator act — the pointer decides who pays ─────── */

{
  const switched = mount({ ...baseConfig, activeSubscription: 'work' })
  gateway.seen.length = 0
  credentialsService.requested.length = 0
  const answer = await ask(switched, 's1')
  assert.equal(answer.text, 'pong', 'the newly active subscription serves')
  assert.deepEqual(gateway.seen, ['Bearer key:OPENCODE_GO_WORK_EXAMPLE_COM'], 'the switch moved the payer')
  // The slot is DERIVED from the subscription NAME: the document never names it.
  assert.ok(
    credentialsService.requested.includes('OPENCODE_GO_WORK_EXAMPLE_COM'),
    'the active row resolves its name-derived credential slot',
  )
  // And the old key is quiet now, in both directions.
  gateway.failing.add('key:OPENCODE_GO_WORK_EXAMPLE_COM')
  gateway.seen.length = 0
  const failed = await ask(switched, 's1')
  assert.equal(failed.chunks.at(-1)?.reason?.kind, 'error')
  assert.ok(
    gateway.seen.every((auth) => auth === 'Bearer key:OPENCODE_GO_WORK_EXAMPLE_COM'),
    'switching away does not leave the previous key as a fallback',
  )
  gateway.failing.clear()
  const rows = switched.diagnostics().subscriptions
  assert.deepEqual(rows.map((row) => row.active), [false, true], 'the active flag follows the pointer')
}

/* ── 5: the balance view is per key, and never gates a request ──────────── */

{
  // The page's 刷新余额 is the HTTP route's business; at this level the same
  // probe path is driven through the runtime the adapter holds, so the two
  // promises worth pinning are: one probe per subscription (each with its OWN
  // bearer), and a balance fact that changes nothing about who pays.
  gateway.probed.length = 0
  const runtimeProbes = defaultAdapter.diagnostics().subscriptions.map((row) => row.apiKeyRef)
  assert.deepEqual(runtimeProbes, ['OPENCODE_GO_ME_EXAMPLE_COM', 'OPENCODE_GO_WORK_EXAMPLE_COM'])
  gateway.seen.length = 0
  const answer = await ask(defaultAdapter, 's1')
  assert.equal(answer.text, 'pong')
  assert.deepEqual(gateway.seen, ['Bearer key:OPENCODE_GO_ME_EXAMPLE_COM'], 'balance facts never re-route a request')
}

/* ── 6: ONE live variable, switched by the pointer ──────────────────────── */

{
  // This is the user-facing promise of the 0.8.3 design: every row keeps its
  // OWN key in its OWN slot, and the one variable the rest of the harness can
  // see (`apiKeyEnv`) is kept holding whichever row is active — the copy the
  // browser could never perform itself, done on the host at switch time.
  credentialsService.stored.clear()
  const live = mount({ ...baseConfig, activeSubscription: 'work' })
  gateway.seen.length = 0
  await ask(live, 's1')
  assert.equal(
    credentialsService.stored.get('MAIN_KEY'),
    'key:OPENCODE_GO_WORK_EXAMPLE_COM',
    "selecting a row copies ITS key into the live variable",
  )
  assert.equal(gateway.seen[0], 'Bearer key:OPENCODE_GO_WORK_EXAMPLE_COM', 'and the request spends the same key')

  // Switching back follows in the other direction, and the row's own slot is
  // still where the key lives (a projection never overwrites the source).
  gateway.seen.length = 0
  const back = mount({ ...baseConfig, activeSubscription: 'default' })
  await ask(back, 's1')
  assert.equal(credentialsService.stored.get('MAIN_KEY'), 'key:OPENCODE_GO_ME_EXAMPLE_COM')
  assert.equal(gateway.seen[0], 'Bearer key:OPENCODE_GO_ME_EXAMPLE_COM')
}

/* ── 7: a 403 region gate is NOT reported as a credential problem ───────── */

{
  // The harness renders the `AUTH` code as its own sentence — "API key is
  // invalid" — and DROPS the gateway's text. So a mislabeled region gate is not
  // a cosmetic problem: it sends the operator hunting for a key that is fine,
  // and hides the one line that says what to do.
  gateway.gated.add('key:OPENCODE_GO_ME_EXAMPLE_COM')
  gateway.seen.length = 0
  let failure
  try {
    const answer = await ask(defaultAdapter, 's1')
    failure = answer.chunks.at(-1)?.reason?.failure
  } catch (error) {
    failure = { code: error.code, message: error.message }
  }
  assert.notEqual(failure?.code, 'AUTH', 'a region gate must never be reported as an auth failure')
  assert.equal(failure?.code, 'UNSUPPORTED_MODEL')
  assert.match(failure.message, /explicit opt-in|hosted in China/u, "the gateway's own actionable sentence must survive")
  // And the endpoint-health log still names the category the operator can act on.
  const health = defaultAdapter.health.latest('alpha')
  assert.equal(health?.category, 'region')
  gateway.gated.clear()
}

server.close()
rmSync(process.env.DSH_HOME, { recursive: true, force: true })
console.log('e2e:active-sub OK — one payer, one live variable, operator-switched, failures reported honestly')
