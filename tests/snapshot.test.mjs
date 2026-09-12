/**
 * Unit tests for the versioned models.dev snapshot: its trimming rules, its
 * validation, the three-way npm answer protocol resolution depends on, and the
 * reconcile-with-the-endpoint helpers the audit asked to be testable.
 *
 * The last test group reads the COMMITTED data file, so a stale or badly
 * regenerated `data/opencode-go.models.json` fails the suite instead of quietly
 * degrading capability prefill at runtime.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  loadSnapshot,
  ModelSnapshot,
  parseSnapshot,
  SNAPSHOT_KIND,
  trimModelRecord,
} from '../src/snapshot.js'

/* ── trimming ─────────────────────────────────────────────────────────────── */

/** One upstream models.dev record, as `https://models.dev/api.json` serves it. */
const UPSTREAM = {
  id: 'glm-5.3-flash',
  name: 'GLM-5.3-Flash',
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  tool_call: true,
  interleaved: { field: 'reasoning_content' },
  temperature: true,
  modalities: { input: ['text', 'image', 'video', 'pdf'], output: ['text'] },
  limit: { context: 1_000_000, output: 131_072 },
  cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
}

test('an upstream record is reduced to the facts this plugin uses', () => {
  const record = trimModelRecord(UPSTREAM)
  assert.deepEqual(record, {
    name: 'GLM-5.3-Flash',
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    interleavedField: 'reasoning_content',
    inputModalities: ['text', 'image', 'video', 'pdf'],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
  })
  // Raw modality values are kept: filtering is the runtime's job, so a rule
  // change does not need a re-fetch.
  assert.ok(record.inputModalities.includes('pdf'))
})

test('trimming is idempotent, which is what lets one function serve both shapes', () => {
  const once = trimModelRecord(UPSTREAM)
  assert.deepEqual(trimModelRecord(once), once)
})

test('a per-model npm override survives and stays distinguishable from absence', () => {
  const overridden = trimModelRecord({ ...UPSTREAM, provider: { npm: '@ai-sdk/openai' } })
  assert.equal(overridden.npm, '@ai-sdk/openai')
  const inherited = trimModelRecord(UPSTREAM)
  assert.equal(Object.hasOwn(inherited, 'npm'), false)
})

test('a record with nothing usable is dropped instead of stored empty', () => {
  assert.equal(trimModelRecord({ id: 'x', foo: 1 }), undefined)
  assert.equal(trimModelRecord(null), undefined)
  assert.equal(trimModelRecord([]), undefined)
})

test('models.dev `status` is preserved as a catalogue note', () => {
  assert.equal(trimModelRecord({ ...UPSTREAM, status: 'deprecated' }).catalogStatus, 'deprecated')
})

/* ── document validation ──────────────────────────────────────────────────── */

/** A minimal valid document. */
function document(models) {
  return JSON.stringify({
    kind: SNAPSHOT_KIND,
    version: 1,
    source: 'https://models.dev/api.json',
    provider: 'opencode-go',
    providerNpm: '@ai-sdk/openai-compatible',
    fetchedAt: '2026-09-11T00:00:00.000Z',
    models,
  })
}

test('a wrong kind, provider, or models shape is refused', () => {
  assert.equal(parseSnapshot('not json').ok, false)
  assert.match(parseSnapshot('[]').error, /root must be an object/)
  assert.match(parseSnapshot('{"kind":"other","provider":"opencode-go","models":{}}').error, /kind/)
  assert.match(parseSnapshot('{"kind":"dsh-opencodego/models-snapshot","provider":"x","models":{}}').error, /provider/)
  assert.match(parseSnapshot('{"kind":"dsh-opencodego/models-snapshot","provider":"opencode-go","models":[]}').error, /models/)
})

test('parsing yields a usable index with the three-way npm answer', () => {
  const parsed = parseSnapshot(document({
    'grok-4.6': { name: 'Grok 4.6', npm: '@ai-sdk/openai', reasoning: true },
    'glm-5.3-flash': { name: 'GLM-5.3-Flash', reasoning: true },
  }))
  assert.equal(parsed.ok, true)
  const snapshot = parsed.snapshot
  assert.equal(snapshot.size, 2)
  assert.equal(snapshot.npmFor('grok-4.6'), '@ai-sdk/openai')
  // Catalogued but inheriting the provider package.
  assert.equal(snapshot.npmFor('glm-5.3-flash'), null)
  // Not catalogued at all — a different answer, and the one that sends
  // resolution to the bootstrap table.
  assert.equal(snapshot.npmFor('unknown-id'), undefined)
  assert.equal(snapshot.nameFor('glm-5.3-flash'), 'GLM-5.3-Flash')
})

test('snapshot-only ids are diagnostics and endpoint-only ids degrade to defaults', () => {
  const snapshot = new ModelSnapshot({
    models: {
      'ox-alpha-free': { reasoning: true },
      'glm-5.3-flash': { reasoning: true },
    },
  })
  const advertised = ['glm-5.3-flash', 'deepseek-flash', 'hy3-preview']
  assert.deepEqual(snapshot.snapshotOnlyIds(advertised), ['ox-alpha-free'])
  assert.deepEqual(snapshot.unknownIds(advertised), ['deepseek-flash', 'hy3-preview'])
})

/* ── the committed data file ──────────────────────────────────────────────── */

const committed = loadSnapshot()

test('the committed snapshot is present, valid, and versioned', () => {
  assert.equal(committed.ok, true, committed.ok ? '' : committed.error)
  const snapshot = committed.snapshot
  assert.ok(snapshot.size >= 30, `expected the whole provider catalog, got ${snapshot.size}`)
  assert.equal(snapshot.source, 'https://models.dev/api.json')
  assert.match(snapshot.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(snapshot.providerNpm, '@ai-sdk/openai-compatible')
})

test('the committed snapshot carries ONLY the facts still read', () => {
  // Capability numbers used to live here as the page's prefill. They are now
  // supplied by a measured sync and nothing else, so the snapshot keeps exactly
  // two things: the per-model `provider.npm` the protocol rule reads, and the
  // display name. A second source for one number is what the sync replaced.
  const snapshot = committed.snapshot

  // The npm fact decides the protocol, and it must survive the trim for the
  // models whose answer is NOT the provider default.
  assert.equal(snapshot.entryFor('grok-4.6').npm, '@ai-sdk/openai')
  assert.equal(snapshot.entryFor('gpt-5.6-luna').npm, '@ai-sdk/openai')
  assert.equal(snapshot.entryFor('minimax-m3').npm, '@ai-sdk/anthropic')
  assert.equal(snapshot.entryFor('qwen3.8-flash').npm, '@ai-sdk/anthropic')

  // No per-model npm: the provider package applies, i.e. openai-completions.
  const flash = snapshot.entryFor('deepseek-v4.1-flash')
  assert.equal(Object.hasOwn(flash, 'npm'), false)
  assert.equal(snapshot.npmFor('deepseek-v4.1-flash'), null, 'catalogued, inheriting the provider package')

  // The display name is the other half.
  assert.equal(snapshot.nameFor('kimi-k3'), 'Kimi K3')

  // …and the capability prefill is GONE from the file, not merely unread.
  const raw = JSON.parse(readFileSync(new URL('../data/opencode-go.models.json', import.meta.url), 'utf8'))
  for (const [id, record] of Object.entries(raw.models)) {
    const allowed = Object.keys(record).filter((key) => key !== 'name' && key !== 'npm')
    assert.deepEqual(allowed, [], `${id} still carries an unused fact: ${allowed.join(', ')}`)
  }
  assert.equal(raw.models['glm-5.3-flash'].contextWindow, undefined)
  assert.equal(raw.models['glm-5.3-flash'].reasoningOptions, undefined)
})


test('the raw api.json is never what gets committed', () => {
  const bytes = readFileSync(new URL('../data/opencode-go.models.json', import.meta.url))
  assert.ok(bytes.byteLength < 100_000, `snapshot should stay a trimmed extract, got ${bytes.byteLength} bytes`)
})
