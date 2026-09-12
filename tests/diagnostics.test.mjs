/**
 * Unit tests for the diagnostics payload a settings page reads (phase 4a).
 *
 * `buildDiagnosticsView` is pure and host-free, so the shape a phase-4b page
 * depends on is pinned here: JSON-serializable, bounded, and derived only from
 * state the runtime already keeps.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  buildDiagnosticsView,
  DIAGNOSTICS_KIND,
  healthRows,
  logLines,
} from '../src/diagnostics.js'
import { EndpointHealthLog } from '../src/health.js'
import { normalizeModelOverlay } from '../src/models.js'

const OPTIONS = {
  baseURL: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  sessionHeader: 'x-opencode-session',
  sessionHeaderEnabled: true,
  sessionHeaderMode: 'session-id',
  snapshotEnabled: true,
  protocolFallback: true,
  honorProtocolOverrides: true,
  maxProtocolAttempts: 3,
  transientAttemptsPerProtocol: 2,
  protocolMemoTtlMs: 900_000,
  sync: true,
  syncTtlMs: 60_000,
  defaultContextWindow: 200_000,
  defaultMaxTokens: 131_072,
  streamIdleTimeoutMs: 300_000,
  debug: false,
  models: normalizeModelOverlay({
    models: {
      disabled: ['retired-model'],
      extra: [{ id: 'hand-declared', name: 'Hand Declared' }],
      overrides: { 'glm-5.3-flash': { contextWindow: 4096 } },
    },
  }),
}

/** A stand-in for the catalog's diagnostics counter block. */
const CATALOG_DIAGNOSTICS = {
  successes: 2,
  failures: 1,
  consecutiveFailures: 0,
  lastError: undefined,
  lastSuccessAt: 1_760_000_000_000,
  lastAttemptAt: 1_760_000_001_000,
  status: 'fresh',
  snapshotOnly: ['ox-alpha-free'],
  unknownModels: ['deepseek-flash'],
}

function makeHealth() {
  const health = new EndpointHealthLog({ now: () => 1_760_000_000_000 })
  health.record('glm-5.3-flash', 'openai-completions', undefined)
  health.record('deepseek-v4-pro', 'openai-responses', 'HTTP 403: RegionError: hosted in China')
  return health
}

test('the payload is JSON-serializable and self-identifying', () => {
  const view = buildDiagnosticsView({
    options: OPTIONS,
    discovered: [{ id: 'alpha' }, { id: 'retired-model' }],
    logged: [{ at: 1, level: 'warn', message: 'careful' }],
    health: makeHealth(),
    catalogDiagnostics: CATALOG_DIAGNOSTICS,
    adapterSnapshot: { idsKey: 'alpha\u0000hand-declared' },
  }, { now: 1_760_000_002_000 })
  assert.equal(view.kind, DIAGNOSTICS_KIND)
  assert.equal(view.at, 1_760_000_002_000)
  assert.equal(typeof JSON.parse(JSON.stringify(view)), 'object')
  for (const key of ['configuration', 'catalogue', 'health', 'log']) {
    assert.equal(Object.hasOwn(view, key), true, `the payload must carry ${key}`)
  }
})

test('the model set in effect is the additive one, with provenance', () => {
  const view = buildDiagnosticsView({
    options: OPTIONS,
    discovered: [{ id: 'alpha' }, { id: 'retired-model' }],
    catalogDiagnostics: CATALOG_DIAGNOSTICS,
    adapterSnapshot: { idsKey: 'alpha\u0000hand-declared' },
  })
  assert.deepEqual(view.catalogue.effectiveIds, ['alpha', 'hand-declared'])
  assert.equal(view.catalogue.effective, 2)
  assert.equal(view.catalogue.discovered, 2)
  assert.equal(view.catalogue.snapshotIds, 2)
  assert.deepEqual(view.catalogue.sources, [
    { id: 'alpha', source: 'endpoint' },
    { id: 'hand-declared', source: 'extra' },
  ])
  assert.equal(view.catalogue.snapshotOnly.includes('ox-alpha-free'), true)
  assert.deepEqual(view.configuration.models.disabled, ['retired-model'])
  assert.deepEqual(view.configuration.models.extra, ['hand-declared'])
  assert.deepEqual(view.configuration.models.overrides, ['glm-5.3-flash'])
})

test('an id the endpoint and the configuration both name reads as endpoint+extra', () => {
  const options = {
    ...OPTIONS,
    models: normalizeModelOverlay({ models: { extra: [{ id: 'alpha', maxTokens: 4096 }] } }),
  }
  const view = buildDiagnosticsView({ options, discovered: [{ id: 'alpha' }] })
  assert.deepEqual(view.catalogue.sources, [{ id: 'alpha', source: 'endpoint+extra' }])
})

test('a shadowed protocolOverrides alias is visible, not silently dropped', () => {
  const options = {
    ...OPTIONS,
    models: normalizeModelOverlay({
      models: { overrides: { alpha: { api: 'openai-responses' } } },
      protocolOverrides: { alpha: 'anthropic-messages', beta: 'openai-responses' },
    }),
  }
  const view = buildDiagnosticsView({ options, discovered: [] })
  assert.deepEqual(view.configuration.models.protocolOverridesApplied, ['beta'])
  assert.deepEqual(view.configuration.models.protocolOverridesShadowed, ['alpha'])
})

test('health rows keep the operator action and a bounded history', () => {
  const view = buildDiagnosticsView({ options: OPTIONS, discovered: [], health: makeHealth() })
  const region = view.health.rows.find((row) => row.modelId === 'deepseek-v4-pro')
  assert.equal(region.category, 'region')
  assert.equal(region.status, 403)
  assert.match(region.action ?? '', /Enable the model explicitly/)
  assert.equal(region.history.length, 1)
  assert.deepEqual(view.health.unusable.map((row) => row.modelId), ['deepseek-v4-pro'])
  assert.equal(view.health.summaryLines.length, 1)
})

test('the log surface carries the ring and its warnings, newest last', () => {
  const logged = [
    { at: 1, level: 'info', message: 'first' },
    { at: 2, level: 'warn', message: 'second' },
    { at: 3, level: 'info', message: 'third' },
  ]
  const view = buildDiagnosticsView({ options: OPTIONS, discovered: [], logged }, { logLimit: 2 })
  assert.deepEqual(view.log.lines.map((line) => line.message), ['second', 'third'])
  assert.deepEqual(view.log.warnings.map((line) => line.message), ['second'])
})

test('lists are bounded by their limits rather than by trust in the input', () => {
  const discovered = Array.from({ length: 50 }, (_, index) => ({ id: `model-${String(index).padStart(2, '0')}` }))
  const view = buildDiagnosticsView({ options: OPTIONS, discovered }, { modelIdLimit: 10 })
  assert.equal(view.catalogue.effectiveIds.length, 10)
  assert.equal(view.catalogue.effective, 51)
  assert.equal(view.catalogue.effectiveTruncated, true)
  assert.equal(view.catalogue.sources.length, 10)
})

test('a missing health log or snapshot degrades instead of throwing', () => {
  const view = buildDiagnosticsView({ options: OPTIONS, discovered: [] })
  assert.deepEqual(view.health.rows, [])
  assert.deepEqual(view.health.unusable, [])
  assert.deepEqual(view.health.summaryLines, [])
  assert.deepEqual(view.log.lines, [])
  assert.equal(view.catalogue.status, 'cold')
  assert.equal(view.catalogue.snapshotIds, 0)
  // The configured `extra` id is still served from a cold catalogue: an
  // explicit declaration must not depend on a network call having happened.
  assert.deepEqual(view.catalogue.effectiveIds, ['hand-declared'])
})

test('the view builder does not mutate the state it is handed', () => {
  const logged = [{ at: 1, level: 'info', message: 'x' }]
  const health = makeHealth()
  const before = JSON.stringify({ logged, health: health.snapshot() })
  buildDiagnosticsView({
    options: OPTIONS,
    discovered: [{ id: 'alpha' }],
    logged,
    health,
    catalogDiagnostics: CATALOG_DIAGNOSTICS,
  })
  assert.equal(JSON.stringify({ logged, health: health.snapshot() }), before)
})

test('the pure builders tolerate shapes a test double might hand them', () => {
  assert.deepEqual(logLines(undefined), [])
  assert.deepEqual(logLines([{ level: 'info' }]), [{ at: undefined, level: 'info', message: '' }])
  assert.deepEqual(healthRows(undefined), [])
  assert.deepEqual(healthRows({}), [])
})

test('diagnostics.js opens no recording source of its own', () => {
  // The requirement this pins: the diagnostics surface READS `adapter.logged`
  // and `adapter.health`; it never starts a second log.
  const source = readFileSync(new URL('../src/diagnostics.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /export class \w*Log/)
  assert.doesNotMatch(source, /\.push\(/)
  // The phrase appears in the module's own rationale comment, so comments are
  // stripped before the logger check: a CALL is what must not exist.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  assert.doesNotMatch(code, /ctx\.logger/)
})
