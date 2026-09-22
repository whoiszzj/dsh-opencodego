/**
 * Unit tests for the RUNTIME official layer (0.9.0).
 *
 * The layer exists because the bundled baseline is a release-time snapshot: a
 * model the gateway starts serving between two releases used to run on
 * `DEFAULT_CONTEXT_WINDOW` (200K) until somebody published a new plugin. What
 * these tests pin:
 *
 *   1. a model the bundle does not know gets its REAL numbers from the same
 *      models.dev files the build-time refresh reads, and those numbers reach
 *      the facts chain (`modelCapabilities`) — the 200K fallback must not win;
 *   2. the fetch costs exactly the files the rules say, and a cached record
 *      costs nothing at all until its TTL runs out;
 *   3. every failure mode is a DEGRADATION, never a fault: upstream 404, a
 *      transport error, an unreachable base, a cancelled caller — each one
 *      leaves the bundled record serving and is remembered so a 60s catalogue
 *      TTL cannot turn into a request storm;
 *   4. what was fetched survives a restart (the `$DSH_HOME` cache round-trips).
 *
 * The transport is injected: these tests never touch the network.
 *
 * @module tests/official-runtime
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { modelCapabilities } from '../src/capabilities.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../src/config.js'
import { officialCapabilityFragment, officialRecordFor } from '../src/official-baseline.js'
import {
  DEFAULT_OFFICIAL_SYNC_TIMEOUT_MS,
  OFFICIAL_CACHE_KIND,
  OfficialRuntime,
  loadOfficialCache,
} from '../src/official-runtime.js'
import { composeEntryFaces } from '../src/synced.js'

const BASE = 'https://raw.example/models.dev/dev'

/** The three files upstream really has for `mimo-v2.6-pro`, trimmed to what matters. */
const UPSTREAM = {
  'providers/opencode-go/models/mimo-v2.6-pro.toml': [
    'base_model = "xiaomi/mimo-v2.6-pro"',
    'reasoning_options = []',
    '',
    '[interleaved]',
    'field = "reasoning_content"',
    '',
    '[cost]',
    'input = 0.435',
    'output = 0.87',
    'cache_read = 0.003625',
    '',
  ].join('\n'),
  'providers/xiaomi/models/mimo-v2.6-pro.toml': [
    '# Toggle: thinking.type = enabled|disabled',
    'name = "MiMo-V2.6-Pro"',
    'reasoning = true',
    '',
    '[[reasoning_options]]',
    'type = "toggle"',
    '',
    '[limit]',
    'context = 1_048_576',
    'output = 131_072',
    '',
    '[modalities]',
    'input = ["text", "image", "audio", "video", "pdf"]',
    'output = ["text"]',
    '',
  ].join('\n'),
  'providers/xiaomi/provider.toml': 'name = "Xiaomi"\napi = "https://api.xiaomimimo.com/v1"\n',
  'models/xiaomi/mimo-v2.6-pro.toml': [
    'name = "MiMo-V2.6-Pro"',
    'reasoning = true',
    '',
    '[limit]',
    'context = 1_048_576',
    'output = 131_072',
    '',
    '[modalities]',
    'input = ["text", "image", "audio", "video", "pdf"]',
    'output = ["text"]',
    '',
  ].join('\n'),
}

/** One bundled record, shaped like `data/opencode-go.official.json`. */
function bundledDocument() {
  return {
    kind: 'dsh-opencodego/official-baseline',
    version: 1,
    modelCount: 1,
    models: {
      'glm-5.3-flash': {
        id: 'glm-5.3-flash',
        lab: 'zai',
        slug: 'glm-5.3-flash',
        resolution: 'base_model',
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        input: ['text'],
        reasoning: true,
        reasoningOptions: [],
        sources: { ocg: 'providers/opencode-go/models/glm-5.3-flash.toml' },
      },
    },
  }
}

/**
 * A transport over a `{ path: text }` map, recording every request.
 * @param {object} files - path → text (a missing path is a 404).
 * @param {object} [options] - `fail` throws for every request, `missing` lists paths answered 404.
 * @returns {{ fetchImpl: typeof fetch, urls: string[] }} the seam and its log.
 */
function transport(files, options = {}) {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (options.fail !== undefined) throw options.fail
    const path = String(url).slice(`${BASE}/`.length)
    if (options.missing?.includes(path) === true) return new Response('not found', { status: 404 })
    const text = files[path]
    if (text === undefined) return new Response('not found', { status: 404 })
    return new Response(text, { status: 200 })
  }
  return { fetchImpl, urls }
}

/** One runtime layer over a temp cache file. */
function makeRuntime({ files = UPSTREAM, options = {}, deps = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocg-official-'))
  const { fetchImpl, urls } = transport(files, options)
  const logs = []
  const runtime = OfficialRuntime.load({
    document: bundledDocument(),
    base: BASE,
    fetchImpl,
    path: join(dir, 'opencode-go.official-cache.json'),
    log: (level, message) => logs.push({ level, message }),
    ...deps,
  })
  return { runtime, urls, logs, dir }
}

test('a model the bundle does not know gets its real numbers, and they reach the facts chain', async () => {
  const { runtime } = makeRuntime()
  assert.equal(runtime.declared('mimo-v2.6-pro'), false)

  const outcome = await runtime.ensure('mimo-v2.6-pro')
  assert.equal(outcome, 'fetched')
  assert.equal(runtime.declared('mimo-v2.6-pro'), true)

  const record = runtime.recordFor('mimo-v2.6-pro')
  assert.equal(record.contextWindow, 1_048_576)
  assert.equal(record.maxTokens, 131_072)
  assert.deepEqual(record.input, ['text', 'image', 'audio', 'video', 'pdf'])
  assert.equal(record.lab, 'xiaomi')
  assert.equal(record.sources.canonicalModel, 'models/xiaomi/mimo-v2.6-pro.toml')
  // The human name upstream declares, which the catalogue uses for the row.
  assert.equal(runtime.nameFor('mimo-v2.6-pro'), 'MiMo-V2.6-Pro')

  // The point of the whole layer: the 200K fallback must not win any more.
  const entry = composeEntryFaces({
    snapshotEnabled: true,
    snapshotEntry: undefined,
    officialFragment: officialCapabilityFragment(officialRecordFor(runtime.document, 'mimo-v2.6-pro')),
    syncedEntry: { reasoning: true, interleavedField: 'reasoning_content' },
  })
  const facts = modelCapabilities(entry, {
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
  })
  assert.equal(facts.contextWindow, 1_048_576)
  assert.equal(facts.maxTokens, 131_072)
  // The record keeps upstream's raw list; the mapper narrows it to what the
  // host can actually carry (audio/video/pdf are declared, not sendable).
  assert.deepEqual(facts.input, ['text', 'image'])
})

test('the fetch costs exactly the files the rules name — and a cached record costs nothing', async () => {
  const { runtime, urls } = makeRuntime()
  await runtime.ensure('mimo-v2.6-pro')
  // The direct rules: the OpenCode Go entry, the lab's provider directory
  // (`xiaomi`, plus the `<lab>-cn` spelling the rule allows), the canonical
  // model file, and the lab's provider file. Nothing else is asked for.
  assert.deepEqual([...urls].sort(), [
    `${BASE}/providers/opencode-go/models/mimo-v2.6-pro.toml`,
    `${BASE}/providers/xiaomi/models/mimo-v2.6-pro.toml`,
    `${BASE}/providers/xiaomi-cn/models/mimo-v2.6-pro.toml`,
    `${BASE}/providers/xiaomi/provider.toml`,
    `${BASE}/models/xiaomi/mimo-v2.6-pro.toml`,
  ].sort())

  const before = urls.length
  assert.equal(await runtime.ensure('mimo-v2.6-pro'), 'cached')
  assert.equal(urls.length, before, 'a record inside its TTL is not re-read')
})

test('a stale record is re-read, and the re-read reuses the recorded sources', async () => {
  let clock = 1_000_000
  const { runtime, urls } = makeRuntime({
    deps: { now: () => clock, ttlMs: 1_000 },
  })
  await runtime.ensure('mimo-v2.6-pro')
  assert.equal(await runtime.ensure('mimo-v2.6-pro'), 'cached')

  clock += 1_001
  const before = urls.length
  assert.equal(await runtime.ensure('mimo-v2.6-pro'), 'fetched')
  // The recorded `sources` are the plan: one request per file the last
  // resolution read, and nothing derived by trial.
  assert.deepEqual(urls.slice(before).sort(), [
    `${BASE}/providers/opencode-go/models/mimo-v2.6-pro.toml`,
    `${BASE}/providers/xiaomi/models/mimo-v2.6-pro.toml`,
    `${BASE}/providers/xiaomi/provider.toml`,
    `${BASE}/models/xiaomi/mimo-v2.6-pro.toml`,
  ].sort())
})

test('upstream has no entry: the id is remembered as absent and the bundled answer stands', async () => {
  const { runtime, urls, logs } = makeRuntime({
    files: { ...UPSTREAM },
    options: { missing: ['providers/opencode-go/models/omen-alpha.toml'] },
  })
  assert.equal(await runtime.ensure('omen-alpha'), 'absent')
  assert.equal(runtime.recordFor('omen-alpha'), undefined)
  assert.ok(logs.some((line) => line.message.includes('no official reference')))

  const before = urls.length
  assert.equal(await runtime.ensure('omen-alpha'), 'absent')
  assert.equal(urls.length, before, '"absent" is a fact, not something to re-ask every 60s')

  // A bundled record is never touched by a failed upstream read.
  assert.equal(await runtime.ensure('glm-5.3-flash'), 'absent')
  assert.equal(officialRecordFor(runtime.document, 'glm-5.3-flash').contextWindow, 1_000_000)
})

test('a transport failure degrades to the bundled data and stops the rest of the pass', async () => {
  const { runtime, urls, logs } = makeRuntime({
    options: { fail: new Error('ENOTFOUND raw.example') },
    // Concurrency 1 is what makes the second id observable: the FIRST failure
    // says the BASE is unreachable, so the next id must cost no second timeout.
    deps: { concurrency: 1 },
  })
  const result = await runtime.ensureMany(['mimo-v2.6-pro', 'mimo-v2.6-flash'], { budgetMs: 60_000 })
  assert.deepEqual(result.fetched, [])
  assert.deepEqual(result.failed, ['mimo-v2.6-pro'])
  // The second id was never ATTEMPTED (the base is known down), which is what
  // `pending` means — and it is why it costs no second timeout.
  assert.deepEqual(result.pending, ['mimo-v2.6-flash'])
  // One retry for the first file (the layer retries once before giving up), and
  // then the base is known down: the second id costs no request at all.
  assert.equal(urls.length, 2, 'one retried attempt, then the rest of the pass is skipped')
  assert.ok(logs.some((line) => line.level === 'warn' && line.message.includes('bundled baseline keeps serving')))
  // And the bundled record still answers.
  assert.equal(runtime.declared('glm-5.3-flash'), true)
  assert.equal(runtime.snapshot().baseDownUntil !== undefined, true)
})

test('ids the bundled baseline already answers are not fetched by the pass', async () => {
  const { runtime, urls } = makeRuntime()
  const result = await runtime.ensureMany(['glm-5.3-flash', 'mimo-v2.6-pro'], { budgetMs: 60_000 })
  assert.deepEqual(result.fetched, ['mimo-v2.6-pro'])
  assert.ok(!urls.some((url) => url.includes('glm-5.3-flash')))
})

test('a flaky link is retried once, and a candidate file that will not load is not fatal', async () => {
  // Measured on a real route: raw.githubusercontent answers two files and times
  // out on the third. Neither symptom may cost the model its numbers.
  let calls = 0
  const { fetchImpl } = transport(UPSTREAM)
  const flaky = async (url, init) => {
    calls += 1
    if (calls === 1) throw new Error('ECONNRESET') // the ocg entry, first try
    if (String(url).includes('xiaomi-cn')) throw new Error('ETIMEDOUT') // an optional candidate
    return fetchImpl(url, init)
  }
  const dir = mkdtempSync(join(tmpdir(), 'ocg-official-'))
  const runtime = OfficialRuntime.load({
    document: bundledDocument(),
    base: BASE,
    fetchImpl: flaky,
    path: join(dir, 'opencode-go.official-cache.json'),
  })
  assert.equal(await runtime.ensure('mimo-v2.6-pro'), 'fetched')
  assert.equal(runtime.recordFor('mimo-v2.6-pro').contextWindow, 1_048_576)
  // The base was never declared down: the pass had already read files.
  assert.equal(runtime.snapshot().baseDownUntil, undefined)
})

test('a cancelled caller does not poison the cooldown', async () => {
  const controller = new AbortController()
  const { runtime } = makeRuntime({
    deps: { fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      void url
    }) },
  })
  const pending = runtime.ensure('mimo-v2.6-pro', { signal: controller.signal })
  controller.abort('client went away')
  assert.equal(await pending, 'failed')
  assert.equal(runtime.cooling('mimo-v2.6-pro'), false, 'a closed page must not suppress the next attempt')
})

test('the runtime record survives a restart through the harness-home cache', async () => {
  const { runtime, dir } = makeRuntime()
  await runtime.ensure('mimo-v2.6-pro')
  const path = join(dir, 'opencode-go.official-cache.json')
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(stored.kind, OFFICIAL_CACHE_KIND)
  assert.equal(stored.models['mimo-v2.6-pro'].contextWindow, 1_048_576)
  assert.equal(stored.names['mimo-v2.6-pro'], 'MiMo-V2.6-Pro')

  const loaded = loadOfficialCache(path)
  assert.equal(loaded.ok, true)
  const { runtime: restarted, urls } = makeRuntime({ deps: { stored: loaded.document, fetchImpl: undefined } })
  assert.equal(restarted.recordFor('mimo-v2.6-pro').contextWindow, 1_048_576)
  assert.equal(restarted.nameFor('mimo-v2.6-pro'), 'MiMo-V2.6-Pro')
  assert.equal(await restarted.ensure('mimo-v2.6-pro'), 'cached')
  assert.equal(urls.length, 0)
})

test('an unreadable cache is not a fault: the layer starts empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocg-official-'))
  const missing = loadOfficialCache(join(dir, 'nope.json'))
  assert.equal(missing.ok, false)
  const runtime = OfficialRuntime.load({
    document: bundledDocument(),
    base: BASE,
    fetchImpl: transport(UPSTREAM).fetchImpl,
    path: join(dir, 'opencode-go.official-cache.json'),
  })
  assert.match(runtime.loadError ?? '', /cannot read/)
  assert.equal(runtime.declared('glm-5.3-flash'), true, 'the bundled face is untouched')
})

test('officialSync off means no base: every ensure is a no-op', async () => {
  const { runtime, urls } = makeRuntime({ deps: { base: '' } })
  assert.equal(await runtime.ensure('mimo-v2.6-pro'), 'skipped')
  assert.deepEqual(await runtime.ensureMany(['mimo-v2.6-pro'], { budgetMs: 1_000 }), {
    fetched: [], absent: [], failed: [], pending: [],
  })
  assert.equal(urls.length, 0)
})

test('the per-request ceiling is what bounds one read', async () => {
  const { runtime } = makeRuntime({
    deps: {
      timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
      }),
    },
  })
  assert.equal(await runtime.ensure('mimo-v2.6-pro'), 'failed')
  assert.match(runtime.snapshot().lastError ?? '', /timed out|failed/)
})

test('the default timeout is the documented one', () => {
  const { runtime } = makeRuntime()
  assert.equal(runtime.timeout, DEFAULT_OFFICIAL_SYNC_TIMEOUT_MS)
})

// ── the wiring ─────────────────────────────────────────────────────────────
// A layer that is unit-tested but never reached is the failure mode invariant #5
// describes (a re-export with no local binding, a route that reads the old
// document). These two guards read the sources, like `subscriptions-wiring`.

const readSource = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

test('the entry point wires the runtime layer into the catalogue, the sync route and diagnostics', () => {
  const index = readSource('src/index.js')
  assert.match(index, /import \{ defaultOfficialCachePath, OfficialRuntime \} from '\.\/official-runtime\.js'/)
  assert.match(index, /const official = officialRuntime\.document/)
  // The catalogue reads the MERGED document and can ask for upstream names.
  assert.match(index, /\n    official,\n/)
  assert.match(index, /officialRuntime,\n    officialNameFor: \(id\) => officialRuntime\.nameFor\(id\)/)
  // 信息同步 completes the declaration face BEFORE probing the contract.
  assert.match(index, /await officialRuntime\.ensure\(modelId\)/)
  assert.match(index, /const officialRecord = officialRecordFor\(official, modelId\)/)
  assert.match(index, /official: officialRecord,/)
  // The adapter carries the layer for the diagnostics payload.
  assert.match(index, /\n    officialRuntime,\n    log,/)
})

test('the declaration pass is gated by the declaration-face switches, awaited once and budgeted', () => {
  const catalog = readSource('src/catalog.js')
  // `snapshotEnabled` governs BOTH declaration layers (invariant #11).
  assert.match(catalog, /if \(options\.snapshotEnabled !== true \|\| options\.officialSync !== true\) return/)
  assert.match(catalog, /const missing = await runtime\.ensureMany\(advertised, \{ signal, budgetMs \}\)/)
  assert.match(catalog, /void runtime\.refreshStale\(this\.effectiveIds\(options\), \{ budgetMs: backgroundMs \}\)/)
  // The pass runs on a FRESH catalogue too: a model enabled seconds ago must not
  // wait out the discovery TTL for its numbers.
  assert.match(catalog, /if \(!request\.force && fresh\) \{[\s\S]{0,400}?await this\.#ensureOfficialDeclarations\(options, request\.signal\)/)
})
