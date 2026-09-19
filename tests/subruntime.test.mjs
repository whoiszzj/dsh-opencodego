/**
 * Unit tests for the subscription RUNTIME: which key a request spends (exactly
 * one — the ACTIVE subscription), the per-slot credential resolution, and the
 * rows the settings page and the balance bars read.
 *
 * There is no pool to test any more: the 0.8.2 redesign made switching an
 * operator act (a settings write), so the runtime's whole request-side job is
 * "resolve the one active slot, or fail loudly".
 *
 * The host stays out of this: `createSubRuntime` takes the credential resolver
 * factory and the LlmError class as injections (exactly the seam `index.js`
 * fills in), so everything runs under a bare `node --test`.
 *
 * @module tests/subrealtime
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { normalizeSubscriptions } from '../src/subs.js'
import { createSubRuntime } from '../src/subruntime.js'

class FakeLlmError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

const base = {
  apiKeyEnv: 'MAIN_KEY',
  displayName: undefined,
}

/** The live gateway envelope, as `scripts/probe-quota.mjs` recorded it. */
const USAGE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-19T20:00:00.000Z' },
    weekly: { status: 'ok', percent: 83, resetsAt: '2026-09-24T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 53, resetsAt: '2026-10-01T00:00:00.000Z' },
  },
}

function makeRuntime(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocg-sub-'))
  // `probeUsage` stamps `checkedAt` from the wall clock, so the runtime's
  // injected clock defaults to it too — otherwise every row would report a
  // nonsensical age.
  let clock = options.now ?? Date.now()
  const subscriptions = normalizeSubscriptions(options.entries ?? [], {
    ...base,
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
  })
  const failures = new Set(options.keyFails ?? [])
  const probes = []
  // The fake credential STORE, keyed by slot name. Seeded through `store`, and
  // every slot not named there answers `key:<slot>` — the same convention the
  // row resolver uses, so a test can name exactly the one slot it cares about.
  const store = new Map(Object.entries(options.store ?? {}))
  const empty = new Set(options.empty ?? [])
  const writes = []
  const readSlot = (reference) => {
    if (empty.has(reference)) return undefined
    return store.has(reference) ? store.get(reference) : `key:${reference}`
  }
  const runtime = createSubRuntime({
    options: () => ({
      subscriptions,
      activeSubscription: options.active,
      apiKeyEnv: options.liveRef ?? 'MAIN_KEY',
      baseURL: 'https://opencode.ai/zen/go/v1',
      usagePollTtlMs: options.ttlMs ?? 60_000,
      usageProbeTimeoutMs: 1000,
    }),
    LlmError: FakeLlmError,
    log: options.log ?? (() => {}),
    now: () => clock,
    usageLayerPath: () => join(dir, 'usage.json'),
    createKeyResolver: (sub) => async () => {
      if (failures.has(sub.id)) throw new FakeLlmError(`no key for ${sub.apiKeyRef}`, 'MISSING_CREDENTIAL')
      if (empty.has(sub.apiKeyRef)) throw new FakeLlmError(`no key for ${sub.apiKeyRef}`, 'MISSING_CREDENTIAL')
      return readSlot(sub.apiKeyRef)
    },
    resolveCredential: async (reference) => readSlot(reference),
    setCredential: options.setCredential ?? (async (reference, value) => {
      writes.push({ reference, value })
      if (options.refuseWrite === true) throw new Error('credentials-local: supplied read-only by the launching environment')
      store.set(reference, value)
    }),
    describeCredential: options.describe,
    baseHeaders: () => ({ 'x-opencode-session': 's' }),
    fetchImpl: options.fetchImpl ?? (async (url, init) => {
      probes.push({ url, authorization: init?.headers?.authorization })
      return { status: 200, json: async () => USAGE_BODY }
    }),
  })
  runtime.__setClock = (value) => { clock = value }
  runtime.__dir = dir
  runtime.__probes = probes
  runtime.__store = store
  runtime.__writes = writes
  return runtime
}

/* ── who pays ─────────────────────────────────────────────────────────── */

test('active() follows the pointer, and falls back to the default row', () => {
  const runtime = makeRuntime({ entries: [{ id: 'work' }] })
  assert.equal(runtime.active().id, 'default')
  const switched = makeRuntime({ entries: [{ id: 'work' }], active: 'work' })
  assert.equal(switched.active().id, 'work')
  // A pointer naming a row somebody deleted resolves to the default rather than
  // leaving the route with nothing to bill.
  const ghost = makeRuntime({ entries: [{ id: 'work' }], active: 'gone' })
  assert.equal(ghost.active().id, 'default')
})

test('activeKey() resolves the ACTIVE row’s OWN slot and mirrors it into the live one', async () => {
  const runtime = makeRuntime({ entries: [{ id: 'work' }, { id: 'home' }], active: 'home' })
  assert.equal(await runtime.activeKey(), 'key:OPENCODE_GO_HOME')
  // The row's own slot is the source of truth; the live slot is the projection
  // that makes "one variable, switched by the UI" true.
  assert.deepEqual(runtime.__writes, [{ reference: 'MAIN_KEY', value: 'key:OPENCODE_GO_HOME' }])
  assert.equal(runtime.projection().liveRef, 'MAIN_KEY')
  assert.equal(runtime.projection().activeId, 'home')
  assert.equal(runtime.projection().error, undefined)
  // The value never crosses into the projection: the store is the only place it
  // can be observed.
  assert.equal(runtime.__store.get('MAIN_KEY'), 'key:OPENCODE_GO_HOME')
  // The same value again writes nothing: a chat request must not rewrite the
  // credential store on every turn.
  assert.equal(await runtime.activeKey(), 'key:OPENCODE_GO_HOME')
  assert.equal(runtime.__writes.length, 1)
})

test('a missing credential is a hard stop, never a silent switch to another key', async () => {
  const runtime = makeRuntime({ entries: [{ id: 'work' }], active: 'work', keyFails: ['work'] })
  await assert.rejects(runtime.activeKey(), (error) => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /no key for OPENCODE_GO_WORK/)
    return true
  })
  // A row that stores nothing never inherits the live slot's value: that would
  // be the failover this design removed, dressed up as an upgrade.
  assert.deepEqual(runtime.__writes, [])
})

test('the default row falls back to the live slot when its own slot is empty', async () => {
  const runtime = makeRuntime({
    entries: [{ id: 'work' }],
    active: 'default',
    store: { MAIN_KEY: 'legacy-live-key' },
    empty: ['OPENCODE_GO_DEFAULT', 'OPENCODE_GO_WORK'],
  })
  // The request is served from the live slot — the pre-0.8.3 shape — without the
  // request path writing anything: `reconcile()` is what adopts.
  assert.equal(await runtime.activeKey(), 'legacy-live-key')
  assert.deepEqual(runtime.__writes, [])
})

test('a refused mirror is reported, and never breaks the request', async () => {
  const runtime = makeRuntime({ entries: [{ id: 'work' }], active: 'work', refuseWrite: true })
  assert.equal(await runtime.activeKey(), 'key:OPENCODE_GO_WORK', 'the key comes from the row, not the mirror')
  assert.match(runtime.projection().error, /read-only/)
  const logged = []
  const noisy = makeRuntime({ entries: [{ id: 'work' }], active: 'work', refuseWrite: true, log: (level, message) => logged.push(`${level}:${message}`) })
  await noisy.activeKey()
  assert.equal(logged.length, 1)
  assert.match(logged[0], /^warn:.*MAIN_KEY/)
})

test('a live slot the launching environment supplies is neither mirrored nor adopted', async () => {
  const describe = async (reference) => (reference === 'MAIN_KEY'
    ? { configured: true, source: 'env', writable: false }
    : { configured: true, source: 'file', writable: true })
  const runtime = makeRuntime({
    entries: [{ id: 'work' }],
    active: 'work',
    store: { MAIN_KEY: 'env-key', OPENCODE_GO_WORK: 'gmail-key' },
    empty: ['OPENCODE_GO_DEFAULT'],
    describe,
  })
  // The request is served from the row's own slot…
  assert.equal(await runtime.activeKey(), 'gmail-key')
  // …no doomed write is attempted, the page is told why, and nothing was copied
  // to disk behind the operator's back.
  assert.deepEqual(runtime.__writes, [])
  assert.deepEqual(await runtime.reconcile(), runtime.projection())
  assert.deepEqual(runtime.__writes, [])
  assert.match(runtime.projection().error, /launching environment/)
  assert.equal(runtime.__store.has('OPENCODE_GO_DEFAULT'), false)
  // A rendered projection never leaks the internal retry flag — and never the
  // secret value it tracks: the page has no use for it, and a payload that
  // carries the key would undo the plugin's whole credential story.
  assert.equal('pending' in runtime.projection(), false)
  assert.equal('value' in runtime.projection(), false)
})

test('reconcile() adopts a pre-0.8.3 live value into the default row and mirrors the active row', async () => {
  // The upgrade: the live slot held the DEFAULT account's key (the older design
  // stored it there), and the operator has since selected `work`.
  const runtime = makeRuntime({
    entries: [{ id: 'work' }],
    active: 'work',
    store: { MAIN_KEY: 'first-key', OPENCODE_GO_WORK: 'gmail-key' },
    empty: ['OPENCODE_GO_DEFAULT'],
  })
  const projection = await runtime.reconcile()
  assert.equal(projection.activeId, 'work')
  assert.equal(projection.error, undefined)
  assert.equal(runtime.__store.get('MAIN_KEY'), 'gmail-key')
  assert.deepEqual(runtime.__writes, [
    { reference: 'OPENCODE_GO_DEFAULT', value: 'first-key' },
    { reference: 'MAIN_KEY', value: 'gmail-key' },
  ])
  // Both keys survive the round trip: selecting `work` did not eat the default
  // row's key.
  assert.equal(runtime.__store.get('OPENCODE_GO_DEFAULT'), 'first-key')
  assert.equal(runtime.__store.get('OPENCODE_GO_WORK'), 'gmail-key')
  assert.equal(runtime.__store.get('MAIN_KEY'), 'gmail-key')
})

test('a row is named by its NAME, and its key is moved out of the old spelling', async () => {
  // The default row's slot follows its name (`displayName`), so the key that
  // 0.8.3 stored under `OPENCODE_GO_DEFAULT` has to move — and the stable
  // id-derived spelling stays behind as the fallback that makes it findable.
  const runtime = makeRuntime({
    displayName: 'me@example.com',
    active: 'default',
    store: { MAIN_KEY: 'first-key', OPENCODE_GO_DEFAULT: 'first-key' },
    empty: ['OPENCODE_GO_ME_EXAMPLE_COM'],
  })
  const [row] = runtime.rows()
  assert.equal(row.apiKeyRef, 'OPENCODE_GO_ME_EXAMPLE_COM')
  assert.deepEqual(row.fallbackRefs, ['OPENCODE_GO_DEFAULT'])
  // Reading works even before the move (the fallback answers)…
  assert.equal(await runtime.activeKey(), 'first-key')
  // …and `reconcile()` then makes the row's own slot the place it lives.
  await runtime.reconcile()
  assert.equal(runtime.__store.get('OPENCODE_GO_ME_EXAMPLE_COM'), 'first-key')
})

test('a RENAME keeps the key: the stable id-derived slot still holds it', async () => {
  const runtime = makeRuntime({
    entries: [{ id: 'sub-2', label: 'Work号' }],
    active: 'sub-2',
    store: { MAIN_KEY: 'k', OPENCODE_GO_SUB_2: 'renamed-key' },
    empty: ['OPENCODE_GO_WORK'],
  })
  const row = runtime.rows()[1]
  assert.equal(row.apiKeyRef, 'OPENCODE_GO_WORK', 'the slot follows the new name')
  assert.deepEqual(row.fallbackRefs, ['OPENCODE_GO_SUB_2'])
  assert.equal(await runtime.activeKey(), 'renamed-key', 'the old spelling is still read')
  await runtime.reconcile()
  assert.equal(runtime.__store.get('OPENCODE_GO_WORK'), 'renamed-key', 'and then moved across')
})

test('reconcile() does NOT adopt a live value another row already stores', async () => {
  // A document written by THIS design: the live slot is a projection of the
  // active row, so the same value is already stored under that row. Adopting it
  // into the default row would clone one account's key onto another's row.
  const runtime = makeRuntime({
    entries: [{ id: 'work' }],
    active: 'work',
    store: { MAIN_KEY: 'gmail-key', OPENCODE_GO_WORK: 'gmail-key' },
    empty: ['OPENCODE_GO_DEFAULT'],
  })
  await runtime.reconcile()
  // The mirror still runs (the active row is who pays); what must NOT happen is
  // a write into the default row's slot.
  assert.deepEqual(runtime.__writes, [{ reference: 'MAIN_KEY', value: 'gmail-key' }])
  assert.equal(runtime.__store.has('OPENCODE_GO_DEFAULT'), false)
})

test('no subscription at all is a configuration error, not an empty bearer', async () => {
  const runtime = createSubRuntime({
    options: () => ({ subscriptions: [], usagePollTtlMs: 1, usageProbeTimeoutMs: 1000, baseURL: 'https://x/v1' }),
    LlmError: FakeLlmError,
    log: () => {},
    createKeyResolver: () => async () => 'k',
    baseHeaders: () => ({}),
  })
  await assert.rejects(runtime.activeKey(), (error) => error.code === 'INVALID_CONFIG')
})

test('keyFor() caches its resolver per row, and re-resolves after the row comes back', async () => {
  let list = normalizeSubscriptions([{ id: 'work' }], base)
  let built = 0
  const runtime = createSubRuntime({
    options: () => ({ subscriptions: list, activeSubscription: 'work', baseURL: 'https://x/v1', usagePollTtlMs: 1, usageProbeTimeoutMs: 1000 }),
    LlmError: FakeLlmError,
    log: () => {},
    createKeyResolver: (sub) => {
      built += 1
      return async () => `key:${sub.id}:${sub.apiKeyRef}`
    },
    baseHeaders: () => ({}),
  })
  assert.equal(await runtime.keyFor(runtime.subs()[1]), 'key:work:OPENCODE_GO_WORK')
  assert.equal(await runtime.keyFor(runtime.subs()[1]), 'key:work:OPENCODE_GO_WORK')
  assert.equal(built, 1, 'the resolver is built once per row, not once per request')
  // A rename keeps the id — and therefore the derived slot — where it was, so
  // the stored key is still found.
  list = normalizeSubscriptions([{ id: 'work', label: '公司号' }], base)
  assert.equal(await runtime.keyFor(runtime.subs()[1]), 'key:work:OPENCODE_GO_WORK')
  assert.equal(built, 1, 'a rename must not strand the stored key behind a new slot')
  // A row that left the configuration drops its resolver; adding it back builds
  // a fresh one rather than reusing a binding nobody owns.
  list = normalizeSubscriptions([], base)
  runtime.subs()
  list = normalizeSubscriptions([{ id: 'work' }], base)
  assert.equal(await runtime.keyFor(runtime.subs()[1]), 'key:work:OPENCODE_GO_WORK')
  assert.equal(built, 2)
})

/* ── the page's rows ──────────────────────────────────────────────────── */

test('rows() carries the label, the slot, the active flag and the last-known windows', async () => {
  const runtime = makeRuntime({ entries: [{ id: 'work', label: '公司号' }], active: 'work' })
  await runtime.refreshAll()
  const rows = runtime.rows()
  assert.deepEqual(rows.map((row) => row.id), ['default', 'work'])
  assert.deepEqual(rows.map((row) => row.label), ['默认', '公司号'])
  assert.deepEqual(rows.map((row) => row.apiKeyRef), ['OPENCODE_GO_DEFAULT', 'OPENCODE_GO_WORK'])
  assert.deepEqual(rows.map((row) => row.isDefault), [true, false])
  assert.deepEqual(rows.map((row) => row.active), [false, true])
  assert.equal(rows[1].usage.windows.weekly.percent, 83)
  assert.equal(rows[1].usage.error, undefined)
  assert.ok(Math.abs(rows[1].usage.ageMs) < 5_000, 'the row reports how old its measurement is')
})

test('every probe rides the ROUTE base and that subscription’s own bearer', async () => {
  const runtime = makeRuntime({ entries: [{ id: 'work' }] })
  await runtime.refreshAll()
  assert.deepEqual(runtime.__probes.map((probe) => probe.url), [
    'https://opencode.ai/zen/go/v1/usage',
    'https://opencode.ai/zen/go/v1/usage',
  ])
  assert.deepEqual(runtime.__probes.map((probe) => probe.authorization), [
    'Bearer key:OPENCODE_GO_DEFAULT',
    'Bearer key:OPENCODE_GO_WORK',
  ])
})

test('a failed probe keeps the last good windows and reports the error on the row', async () => {
  let fail = false
  const runtime = makeRuntime({
    entries: [{ id: 'work' }],
    fetchImpl: async () => (fail
      ? { status: 429, json: async () => ({}) }
      : { status: 200, json: async () => USAGE_BODY }),
  })
  await runtime.refreshAll()
  assert.equal(runtime.rows()[1].usage.windows.weekly.percent, 83)
  fail = true
  runtime.__setClock(2_000_000)
  await runtime.refreshAll()
  const row = runtime.rows()[1]
  assert.equal(row.usage.windows.weekly.percent, 83, 'staleness beats amnesia')
  assert.match(row.usage.error, /HTTP 429/)
})

test('refreshStale() probes only what is worth probing: stale rows that HAVE a key', async () => {
  const t0 = Date.now()
  // `work` has no key in its slot: it can only answer 401, and the page already
  // says 「未存密钥」 — so it is never asked.
  const runtime = makeRuntime({ entries: [{ id: 'work' }], now: t0, empty: ['OPENCODE_GO_WORK'] })
  await runtime.refreshStale()
  assert.deepEqual(runtime.__probes.map((probe) => probe.authorization), ['Bearer key:OPENCODE_GO_DEFAULT'])
  // Re-opening the panel inside the TTL asks the gateway for NOTHING: the point
  // of the stale mode is that a fresh number is not worth a request.
  await runtime.refreshStale()
  assert.equal(runtime.__probes.length, 1, 'a fresh reading is not re-probed')
  // Once the reading is older than the TTL, the same row is asked again — and
  // only that row (the keyless one stays skipped however stale it is).
  runtime.__setClock(t0 + (runtime.usage.deps.ttlMs() + 1_000))
  await runtime.refreshStale()
  assert.deepEqual(runtime.__probes.map((probe) => probe.authorization), [
    'Bearer key:OPENCODE_GO_DEFAULT',
    'Bearer key:OPENCODE_GO_DEFAULT',
  ])
  // Back inside the TTL the reading is fresh again: opening the panel asks for
  // nothing, while the operator's forced mode still asks — that is the whole
  // difference between opening a panel and pressing 刷新余额.
  runtime.__setClock(t0)
  await runtime.refreshStale()
  assert.equal(runtime.__probes.length, 2, 'a fresh reading is never re-probed')
  await runtime.refreshAll()
  assert.deepEqual(runtime.__probes.map((probe) => probe.authorization), [
    'Bearer key:OPENCODE_GO_DEFAULT',
    'Bearer key:OPENCODE_GO_DEFAULT',
    'Bearer key:OPENCODE_GO_DEFAULT',
  ], 'an explicit 刷新余额 ignores the TTL — but still never probes an empty slot')
})

test('view() folds credential PRESENCE in, per slot, and never a value', async () => {
  const runtime = makeRuntime({
    entries: [{ id: 'work' }],
    describe: async (reference) => (reference === 'OPENCODE_GO_WORK'
      ? { configured: true, source: 'file' }
      : { configured: false }),
  })
  const rows = await runtime.view()
  assert.deepEqual(rows.map((row) => row.configured), [false, true])
  assert.equal(rows[1].source, 'file')
  // A credential seam that cannot answer leaves the row un-annotated rather than
  // claiming "not configured".
  const blind = makeRuntime({ entries: [{ id: 'work' }], describe: async () => { throw new Error('no credentials service') } })
  assert.deepEqual((await blind.view()).map((row) => row.configured), [undefined, undefined])
})

/* ── configuration churn ──────────────────────────────────────────────── */

test('a settings change prunes the usage layer and the resolvers of gone rows', async () => {
  const entries = [{ id: 'work' }, { id: 'home' }]
  let list = normalizeSubscriptions(entries, base)
  const dir = mkdtempSync(join(tmpdir(), 'ocg-sub-churn-'))
  const runtime = createSubRuntime({
    options: () => ({ subscriptions: list, activeSubscription: 'default', baseURL: 'https://x/v1', usagePollTtlMs: 60_000, usageProbeTimeoutMs: 1000 }),
    LlmError: FakeLlmError,
    log: () => {},
    usageLayerPath: () => join(dir, 'usage.json'),
    createKeyResolver: (sub) => async () => `key:${sub.apiKeyRef}`,
    baseHeaders: () => ({}),
    fetchImpl: async () => ({ status: 200, json: async () => USAGE_BODY }),
  })
  await runtime.refreshAll()
  assert.deepEqual(Object.keys(runtime.usage.deps.layer.subs).sort(), ['default', 'home', 'work'])
  list = normalizeSubscriptions([{ id: 'home' }], base)
  runtime.subs()
  assert.deepEqual(Object.keys(runtime.usage.deps.layer.subs).sort(), ['default', 'home'])
  rmSync(dir, { recursive: true, force: true })
})
