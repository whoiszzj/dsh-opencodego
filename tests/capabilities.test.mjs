/**
 * Unit tests for the capability interpretation layer.
 *
 * These run with a bare `node --test tests/` — no profile install, no host
 * packages — because `capabilities.js` and its neighbours import only
 * `./vocab.js`. That is the point of keeping the decision logic host-free.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  catalogueModelView,
  compatFor,
  imageRequestSupport,
  mapCost,
  mapInputModalities,
  mapReasoning,
  modelCapabilities,
  selectableThinkingLevels,
  supportedThinkingLevels,
} from '../src/capabilities.js'

const DEFAULTS = { defaultContextWindow: 200_000, defaultMaxTokens: 131_072 }

test('modality filtering drops what the host cannot carry', () => {
  const { input, dropped } = mapInputModalities(['text', 'image', 'video', 'pdf', 'audio'])
  assert.deepEqual(input, ['text', 'image'])
  assert.deepEqual(dropped, ['video', 'pdf', 'audio'])
})

test('an empty modality list still claims text, because no usable model accepts nothing', () => {
  assert.deepEqual(mapInputModalities([]), { input: ['text'], dropped: [] })
  assert.deepEqual(mapInputModalities(undefined), { input: ['text'], dropped: [] })
  assert.deepEqual(mapInputModalities(['video']), { input: ['text'], dropped: ['video'] })
})

test('declared effort values become pinned host levels', () => {
  const reasoning = mapReasoning({
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  })
  assert.equal(reasoning.reasoning, true)
  assert.deepEqual(reasoning.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  })
  // The acceptance criterion: glm-5.3-flash offers exactly models.dev's levels.
  assert.deepEqual(selectableThinkingLevels(reasoning.reasoning, reasoning.thinkingLevelMap), ['low', 'high', 'max'])
  assert.deepEqual(reasoning.unmappedLevels, [])
})

test('`none` is mapped to the host off level and keeps its wire spelling', () => {
  const reasoning = mapReasoning({
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high'] }],
  })
  assert.equal(reasoning.thinkingLevelMap.off, 'none')
  assert.deepEqual(supportedThinkingLevels(reasoning.reasoning, reasoning.thinkingLevelMap), ['off', 'low', 'high'])
  assert.deepEqual(selectableThinkingLevels(reasoning.reasoning, reasoning.thinkingLevelMap), ['low', 'high'])
})

test('an effort value no host level matches is dropped and recorded', () => {
  const reasoning = mapReasoning({
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'turbo'] }],
  })
  assert.equal(reasoning.thinkingLevelMap.turbo, undefined)
  assert.deepEqual(reasoning.unmappedLevels, ['turbo'])
  assert.deepEqual(selectableThinkingLevels(reasoning.reasoning, reasoning.thinkingLevelMap), ['low'])
})

test('a toggle or a token budget alone yields no selectable level and no reasoning claim', () => {
  for (const options of [
    [{ type: 'toggle' }],
    [{ type: 'toggle' }, { type: 'budget_tokens', max: 262_144 }],
    [],
  ]) {
    const reasoning = mapReasoning({ reasoning: true, reasoningOptions: options })
    assert.equal(reasoning.declared, true)
    assert.equal(reasoning.reasoning, false, JSON.stringify(options))
    assert.equal(reasoning.thinkingLevelMap, undefined)
    assert.deepEqual(selectableThinkingLevels(reasoning.reasoning, reasoning.thinkingLevelMap), [])
  }
})

test('xhigh and max are only claimed when the catalog declares them', () => {
  const declared = mapReasoning({ reasoning: true, reasoningOptions: [{ type: 'effort', values: ['low', 'xhigh'] }] })
  assert.equal(declared.thinkingLevelMap.xhigh, 'xhigh')
  assert.equal(declared.thinkingLevelMap.max, null)
  // Undeclared levels are pinned to null, so only the declared ones (and `off`
  // when the catalog named a wire value for it) survive.
  assert.deepEqual(supportedThinkingLevels(true, declared.thinkingLevelMap), ['low', 'xhigh'])
})

test('two spellings for one host level keep the first and report the conflict', () => {
  const reasoning = mapReasoning({
    reasoning: true,
    reasoningOptions: [
      { type: 'effort', values: ['low'] },
      { type: 'effort', values: ['Low'] },
    ],
  })
  assert.equal(reasoning.thinkingLevelMap.low, 'low')
  assert.deepEqual(reasoning.conflictingLevels, ['low'])
})

test('an interleaved field is accepted only when pi-ai can name it', () => {
  assert.equal(mapReasoning({ reasoning: true, interleavedField: 'reasoning_content' }).thinkingField, 'reasoning_content')
  assert.equal(mapReasoning({ reasoning: true, interleavedField: 'reasoning' }).thinkingField, 'reasoning')
  assert.equal(mapReasoning({ reasoning: true, interleavedField: 'thinking' }).thinkingField, undefined)
  assert.equal(mapReasoning({ reasoning: true, interleavedField: 'thinking' }).unmappableField, 'thinking')
})

test('the compat block derives from the interleaved field only', () => {
  assert.deepEqual(compatFor({ thinkingField: 'reasoning_content' }), { requiresReasoningContentOnAssistantMessages: true })
  assert.equal(compatFor({ thinkingField: 'reasoning' }), undefined)
  assert.equal(compatFor({}), undefined)
})

test('cost maps models.dev rates, including context tiers', () => {
  const cost = mapCost({
    input: 2,
    output: 6,
    cache_read: 0.5,
    tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: 'context', size: 200_000 } }],
  })
  assert.deepEqual(cost, {
    input: 2,
    output: 6,
    cacheRead: 0.5,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
  })
  assert.deepEqual(mapCost(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('an unknown model degrades to the conservative defaults and says so', () => {
  const facts = modelCapabilities(undefined, DEFAULTS)
  assert.equal(facts.source, 'defaults')
  assert.equal(facts.contextWindow, 200_000)
  assert.equal(facts.maxTokens, 131_072)
  assert.deepEqual(facts.input, ['text'])
  assert.equal(facts.reasoning, false)
  assert.equal(facts.thinkingLevelMap, undefined)
})

test('a catalogued model reports its own facts and provenance', () => {
  const facts = modelCapabilities({
    name: 'GLM-5.3-Flash',
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    interleavedField: 'reasoning_content',
    inputModalities: ['text', 'image', 'video', 'pdf'],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  }, DEFAULTS)
  assert.equal(facts.source, 'snapshot')
  assert.equal(facts.contextWindow, 1_000_000)
  assert.equal(facts.maxTokens, 131_072)
  assert.deepEqual(facts.input, ['text', 'image'])
  assert.deepEqual(facts.droppedModalities, ['video', 'pdf'])
  assert.deepEqual(selectableThinkingLevels(facts.reasoning, facts.thinkingLevelMap), ['low', 'high', 'max'])
  assert.equal(facts.thinkingField, 'reasoning_content')
})

/* ── the image gate ───────────────────────────────────────────────────────── */

test('a request with no image needs no decision', () => {
  assert.equal(imageRequestSupport({ carriesImage: false, input: ['text'], attachmentsAvailable: false, modelId: 'm' }), undefined)
})

test('an image this route cannot represent is refused, never dropped', () => {
  // The model's own modalities exclude image.
  const unsupported = imageRequestSupport({
    carriesImage: true, input: ['text'], attachmentsAvailable: true, modelId: 'hy3',
  })
  assert.equal(unsupported.code, 'UNSUPPORTED_CONTENT')
  assert.match(unsupported.message, /hy3/)
  assert.match(unsupported.message, /does not support image input/)

  // The model accepts images but the durable attachment service is absent.
  const noService = imageRequestSupport({
    carriesImage: true, input: ['text', 'image'], attachmentsAvailable: false, modelId: 'glm-5.3-flash',
  })
  assert.equal(noService.code, 'UNSUPPORTED_CONTENT')
  assert.match(noService.message, /durable attachment service/)
})

test('an image-capable model with the attachment service present proceeds', () => {
  assert.equal(imageRequestSupport({
    carriesImage: true, input: ['text', 'image'], attachmentsAvailable: true, modelId: 'glm-5.3-flash',
  }), undefined)
})

// ── the settings page's payload ────────────────────────────────────────────

test('catalogueModelView shows the official default and the effective facts separately', () => {
  const connection = {
    ...DEFAULTS,
    protocolOverrides: {},
    models: { extra: {}, overrides: { 'glm-5.3-flash': { maxTokens: 4096 } } },
  }
  const entry = {
    name: 'GLM 5.3 Flash',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    npm: '@ai-sdk/openai',
  }
  const view = catalogueModelView({
    model: { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    entry,
    snapshotNpm: '@ai-sdk/openai',
    connection,
    resolveProtocol: (id, facts) => ({ primary: facts.snapshotNpm === '@ai-sdk/openai' ? 'openai-responses' : 'openai-completions', source: 'models.dev-npm' }),
  })
  assert.equal(view.id, 'glm-5.3-flash')
  // The DEFAULT is the snapshot's own number, with no configuration applied —
  // that is what an empty form field means.
  assert.equal(view.defaults.maxTokens, 131_072)
  // The EFFECTIVE value carries the operator's override.
  assert.equal(view.effective.maxTokens, 4096)
  assert.equal(view.protocol, 'openai-responses')
  assert.equal(view.protocolSource, 'models.dev-npm')
  assert.equal(view.snapshotKnown, true)
  assert.deepEqual(view.defaults.input, ['text', 'image'])
  assert.deepEqual(view.defaults.reasoningEfforts, ['low', 'high'])
})

test('catalogueModelView degrades to the conservative defaults for an uncatalogued id', () => {
  const view = catalogueModelView({
    model: { id: 'brand-new', name: 'brand-new' },
    entry: undefined,
    snapshotNpm: undefined,
    connection: { ...DEFAULTS, protocolOverrides: {}, models: { extra: {}, overrides: {} } },
    resolveProtocol: () => ({ primary: 'openai-completions', source: 'provider-default' }),
  })
  assert.equal(view.snapshotKnown, false)
  assert.equal(view.defaults.contextWindow, DEFAULTS.defaultContextWindow)
  assert.equal(view.defaults.maxTokens, DEFAULTS.defaultMaxTokens)
  assert.deepEqual(view.defaults.input, ['text'])
})

// ── the synced layer (phase C/D) ─────────────────────────────────────────────

test('a synced layer reaches thinkingLevelMap, wire spellings and all', async () => {
  const { snapshotFragmentOf, mergeSyncedEntry } = await import('../src/synced.js')
  // What the live sync measured for kimi-k3: the official contract, all levels
  // accepted, and the reply field it actually used.
  const stored = {
    id: 'kimi-k3',
    reasoning: { levels: { low: 'low', high: 'high', max: 'max' }, hasOff: true },
    interleavedField: 'reasoning',
  }
  const fragment = snapshotFragmentOf(stored)
  assert.deepEqual(fragment.reasoningOptions, [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }])

  // The bundled snapshot disagrees about the reply field; the measurement wins.
  const merged = mergeSyncedEntry({ interleavedField: 'reasoning_content', limit: { context: 1 } }, fragment)
  assert.equal(merged.interleavedField, 'reasoning')
  assert.equal(merged.limit.context, 1, 'unrelated snapshot facts survive the merge')

  // …and the levels come out as pi-ai expects them: every other level pinned
  // to null, so the model cannot be offered a level nobody declared.
  const caps = modelCapabilities(merged, DEFAULTS)
  assert.equal(caps.reasoning, true)
  assert.equal(caps.thinkingLevelMap.low, 'low')
  assert.equal(caps.thinkingLevelMap.max, 'max')
  assert.equal(caps.thinkingLevelMap.medium, null)
  assert.equal(caps.thinkingLevelMap.xhigh, null)
  assert.equal(caps.thinkingLevelMap.off, null, 'off is not a level; it is the absence of the parameter')

  // A model the snapshot does not know still gets an entry from a measurement.
  const unknown = mergeSyncedEntry(undefined, snapshotFragmentOf({
    id: 'omen-alpha',
    reasoning: { levels: { low: 'low' }, hasOff: false },
    interleavedField: 'reasoning_content',
  }))
  assert.equal(modelCapabilities(unknown, DEFAULTS).thinkingLevelMap.low, 'low')
})

test('the gateway spelling "minimum" maps to the host level "minimal"', () => {
  // Measured: `qwen3.6-plus` answers 200 to `minimum` and 400 to `minimal`,
  // while `qwen3.7-*` do the exact opposite. Without the alias a synced
  // `minimum` is unmappable and the level silently disappears from the ladder.
  const reasoning = mapReasoning({ reasoningOptions: [{ type: 'effort', values: ['minimum', 'high'] }] })
  assert.deepEqual(reasoning.unmappedLevels, [])
  assert.equal(reasoning.thinkingLevelMap.minimal, 'minimum', 'the WIRE spelling is preserved')
  assert.equal(reasoning.thinkingLevelMap.high, 'high')
})

test('the synced layer follows the model set, so a re-added model is not stale', async () => {
  const { SyncedLayer } = await import('../src/synced.js')
  const layer = new SyncedLayer({ models: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } } })
  assert.deepEqual(layer.prune(['a', 'b']), ['c'], 'a model that left the set loses its measurement')
  assert.deepEqual(layer.ids().sort(), ['a', 'b'])
  // Re-adding it must therefore show NO capability facts until it is synced again.
  assert.equal(layer.has('c'), false)
  // An EMPTY set is far more likely to be a settings read that failed than
  // every model having been removed; wiping everything would be unrecoverable.
  assert.deepEqual(layer.prune([]), [])
  assert.equal(layer.ids().length, 2)
  assert.deepEqual(layer.prune(undefined), [])
  assert.equal(layer.ids().length, 2)
})
