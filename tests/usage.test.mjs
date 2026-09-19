/**
 * Unit tests for the usage/balance layer: the REAL gateway envelope (recorded
 * by `scripts/probe-quota.mjs` against `GET {base}/usage`), a probe that is a
 * result and never a throw, and the cached layer's staleness rules.
 *
 * @module tests/usage
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  defaultUsageLayerPath,
  parseUsageEnvelope,
  probeUsage,
  UsageLayer,
  UsageProbeCache,
  USAGE_LAYER_FILE,
} from '../src/usage.js'

/** The body the live gateway answered with (2026-09, one key, mid-week). */
const GATEWAY_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-19T10:41:44.383Z' },
    weekly: { status: 'ok', percent: 83, resetsAt: '2026-09-21T00:00:00.383Z' },
    monthly: { status: 'ok', percent: 53, resetsAt: '2026-10-10T02:39:34.383Z' },
  },
}

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ocg-usage-'))
  return join(dir, USAGE_LAYER_FILE)
}

/* ── the envelope ─────────────────────────────────────────────────────── */

test('the live gateway envelope parses verbatim into three windows', () => {
  const windows = parseUsageEnvelope(GATEWAY_BODY)
  assert.deepEqual(Object.keys(windows), ['rolling', 'weekly', 'monthly'])
  assert.equal(windows.weekly.percent, 83)
  assert.equal(windows.weekly.resetsAt, '2026-09-21T00:00:00.383Z')
  assert.equal(windows.rolling.status, 'ok')
})

test('a body that is not an usage envelope parses to nothing (a 404 page stays a 404)', () => {
  assert.equal(parseUsageEnvelope(undefined), undefined)
  assert.equal(parseUsageEnvelope({ models: [] }), undefined)
  assert.equal(parseUsageEnvelope('usage'), undefined)
  assert.equal(parseUsageEnvelope({ usage: 'ok' }), undefined)
  assert.equal(parseUsageEnvelope({ usage: { yearly: { percent: 5 } } }), undefined)
})

test('unknown windows are ignored, and a percent-less window still carries its status', () => {
  const windows = parseUsageEnvelope({ usage: { weekly: { status: 'limited', yearly: {} , lifetime: { percent: 3 } } } })
  assert.deepEqual(Object.keys(windows), ['weekly'])
  assert.equal(windows.weekly.status, 'limited')
  assert.equal(windows.weekly.percent, undefined)
})

test('percent clamps into 0..100 (a gateway overshoot cannot fake a cap crossing)', () => {
  const windows = parseUsageEnvelope({ usage: { weekly: { percent: 143 }, rolling: { percent: -8 } } })
  assert.equal(windows.weekly.percent, 100)
  assert.equal(windows.rolling.percent, 0)
})

/* ── the probe ────────────────────────────────────────────────────────── */

test('a successful probe reports windows, checkedAt, and the exact request shape', async () => {
  const seen = []
  const result = await probeUsage({
    baseURL: 'https://gw.example/v1',
    apiKey: 'sk-test',
    baseHeaders: () => ({ 'x-opencode-session': 'v1', 'x-product': 'dsh' }),
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return { status: 200, json: async () => GATEWAY_BODY }
    },
    timeoutMs: 5000,
  })
  assert.equal(result.ok, true)
  assert.equal(result.windows.weekly.percent, 83)
  assert.equal(seen[0].url, 'https://gw.example/v1/usage')
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test')
  // The attribution/session headers ride along (merged by the CALLER — the
  // one merge point stays in the wiring, invariant #1).
  assert.equal(seen[0].init.headers['x-opencode-session'], 'v1')
})

test('every probe failure is a result, never a throw (the gate must keep the last good number)', async () => {
  const http404 = await probeUsage({
    baseURL: 'https://gw/v1',
    apiKey: 'k',
    baseHeaders: () => ({}),
    fetchImpl: async () => ({ status: 404, json: async () => ({}) }),
    timeoutMs: 1000,
  })
  assert.equal(http404.ok, false)
  assert.match(http404.error, /HTTP 404/u)

  const html = await probeUsage({
    baseURL: 'https://gw/v1',
    apiKey: 'k',
    baseHeaders: () => ({}),
    fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('<html>') } }),
    timeoutMs: 1000,
  })
  assert.equal(html.ok, false)
  assert.match(html.error, /non-JSON/u)

  const thrown = await probeUsage({
    baseURL: 'https://gw/v1',
    apiKey: 'k',
    baseHeaders: () => { throw new Error('headers exploded') },
    fetchImpl: async () => ({ status: 200, json: async () => GATEWAY_BODY }),
    timeoutMs: 1000,
  })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /headers exploded/u)
})

test('a gateway that never answers cannot outlive the probe timeout', async () => {
  const started = Date.now()
  const result = await probeUsage({
    baseURL: 'https://gw/v1',
    apiKey: 'k',
    baseHeaders: () => ({}),
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
    timeoutMs: 150,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/u)
  assert.ok(Date.now() - started < 5000, 'bounded')
})

/* ── the layer + cache ────────────────────────────────────────────────── */

test('a corrupt or absent layer is "nothing known", never a fault', () => {
  const path = tempPath()
  assert.equal(UsageLayer.load(path).toDocument().subs.anything, undefined)
  writeFileSync(path, '{ not json', 'utf8')
  const corrupt = UsageLayer.load(path)
  assert.equal(corrupt.toDocument().subs.anything, undefined)
  assert.equal(corrupt.lastSaveError, undefined)
  rmSync(path, { force: true, recursive: true })
})

test('the cache keeps last-known windows through a failed probe, and a failed probe never advances checkedAt', async () => {
  const path = tempPath()
  const layer = new UsageLayer({ subs: {} })
  layer.path = path
  let response = { status: 200, json: async () => GATEWAY_BODY }
  const cache = new UsageProbeCache({
    layer,
    now: () => Date.now(),
    ttlMs: () => 60_000,
    timeoutMs: () => 1000,
    resolveKey: async () => 'k',
    baseHeaders: () => ({}),
    fetchImpl: async () => response,
    log: () => {},
  })
  const good = await cache.refresh({ id: 'work', baseURL: 'https://gw/v1' })
  assert.equal(good.windows.weekly.percent, 83)
  assert.ok(Number.isFinite(good.checkedAt))
  response = { status: 500, json: async () => ({}) }
  const bad = await cache.refresh({ id: 'work', baseURL: 'https://gw/v1' })
  assert.equal(bad.windows.weekly.percent, 83, 'windows survive a failed probe')
  assert.equal(bad.checkedAt, undefined, 'a failed probe does not refresh the clock')
  assert.match(bad.error, /HTTP 500/u)
  // It landed on disk, and a reload reads it back.
  const reloaded = UsageLayer.load(path)
  assert.equal(reloaded.entryFor('work').windows.weekly.percent, 83)
  rmSync(path, { force: true, recursive: true })
})

test('isFresh gates on the last SUCCESS age; peek never probes', async () => {
  let clock = 1000
  let probed = 0
  const cache = new UsageProbeCache({
    layer: new UsageLayer({ subs: { work: { windows: GATEWAY_BODY.usage, checkedAt: 1000 } } }),
    now: () => clock,
    ttlMs: () => 500,
    timeoutMs: () => 50,
    resolveKey: async () => 'k',
    baseHeaders: () => ({}),
    fetchImpl: async () => { probed += 1; return { status: 200, json: async () => GATEWAY_BODY } },
  })
  assert.equal(cache.isFresh('work'), true)
  clock = 1501
  assert.equal(cache.isFresh('work'), false)
  cache.peek('work')
  cache.peek('nobody')
  assert.equal(probed, 0, 'peek never asks the network')
})

test('concurrent refreshes of one subscription share ONE probe (single-flight)', async () => {
  let probed = 0
  const cache = new UsageProbeCache({
    layer: new UsageLayer({ subs: {} }),
    now: () => Date.now(),
    ttlMs: () => 60_000,
    timeoutMs: () => 50,
    resolveKey: async () => 'k',
    baseHeaders: () => ({}),
    fetchImpl: async () => { probed += 1; await new Promise((done) => setTimeout(done, 10)); return { status: 200, json: async () => GATEWAY_BODY } },
  })
  const sub = { id: 'work', baseURL: 'https://gw/v1' }
  await Promise.all([cache.refresh(sub), cache.refresh(sub), cache.refresh(sub)])
  assert.equal(probed, 1)
})

test('dropAllMissing prunes ids the configuration removed', () => {
  const layer = new UsageLayer({ subs: { a: { checkedAt: 1 }, b: { checkedAt: 1 } } })
  layer.path = tempPath()
  const cache = new UsageProbeCache({ layer, now: () => 1, ttlMs: () => 1, timeoutMs: () => 1, resolveKey: async () => 'k', baseHeaders: () => ({}) })
  assert.deepEqual(cache.dropAllMissing(['a']), ['b'])
  assert.equal(layer.entryFor('b'), undefined)
  assert.notEqual(layer.entryFor('a'), undefined)
})

test('the default layer path lives in the harness home, next to the synced file', () => {
  const path = defaultUsageLayerPath()
  assert.ok(path.endsWith(`/${USAGE_LAYER_FILE}`))
  assert.ok(!path.includes('node_modules'))
})
