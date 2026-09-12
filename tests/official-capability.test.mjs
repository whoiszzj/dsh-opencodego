/**
 * The official baseline's DECLARED numbers reaching the runtime facts chain.
 *
 * This is the regression guard for the "everything runs on 200K" bug: the
 * baseline loaded fine at boot but nothing bridged it into the entry the
 * capability mapper reads, so every model without an operator override fell to
 * `DEFAULT_CONTEXT_WINDOW` while the sync route happily displayed the official
 * 1M. The bridge is `officialCapabilityFragment` composed at the single merge
 * point (`synced.js#composeEntryFaces`, called by
 * `ModelCatalog#snapshotEntryFor`), and these tests pin its precedence:
 *
 *   operator overrides/extra  >  synced measurement  >  official declared
 *   numbers  >  conservative defaults
 *
 * The composition lives in `synced.js` precisely so this file can import it:
 * `catalog.js` imports host packages a repository test cannot resolve.
 *
 * @module tests/official-capability
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { modelCapabilities, modelCapabilitiesWithOverrides } from '../src/capabilities.js'
import { officialCapabilityFragment, officialRecordFor } from '../src/official-baseline.js'
import { composeEntryFaces } from '../src/synced.js'

/** The conservative fallbacks the route uses when nothing declares a number. */
const DEFAULTS = { defaultContextWindow: 200_000, defaultMaxTokens: 131_072 }

/** One official baseline record, shaped like `data/opencode-go.official.json`. */
const RECORD = {
  id: 'glm-5.3-flash',
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  input: ['text', 'image', 'video', 'pdf'],
  interleavedField: 'reasoning_content',
  lab: 'zhipuai',
  notes: ['always reasons'],
  sources: ['models/zhipuai/glm-5.3-flash.toml'],
  reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
}

/** One baseline document wrapping the record. */
const BASELINE = { models: { 'glm-5.3-flash': RECORD } }

/**
 * Compose the faces the way `ModelCatalog#snapshotEntryFor` does, with the
 * official fragment resolved from the baseline document.
 */
function entryFor({ id = 'glm-5.3-flash', snapshotEntry, syncedEntry, official = BASELINE, snapshotEnabled = true } = {}) {
  return composeEntryFaces({
    snapshotEnabled,
    snapshotEntry,
    officialFragment: officialCapabilityFragment(officialRecordFor(official, id)),
    syncedEntry,
  })
}

test('the official numbers join a name-only snapshot entry and reach the facts', () => {
  const entry = entryFor({ snapshotEntry: { name: 'GLM-5.3-Flash' } })
  assert.equal(entry.contextWindow, 1_000_000)
  assert.equal(entry.maxTokens, 131_072)
  assert.deepEqual(entry.inputModalities, ['text', 'image', 'video', 'pdf'])
  assert.equal(entry.name, 'GLM-5.3-Flash')

  const facts = modelCapabilities(entry, DEFAULTS)
  assert.equal(facts.contextWindow, 1_000_000, 'the harness must see the official window, not the 200K fallback')
  assert.ok(facts.input.includes('text') && facts.input.includes('image'))
})

test('the projection carries ONLY the three declared capability fields', () => {
  const fragment = officialCapabilityFragment(RECORD)
  assert.deepEqual(Object.keys(fragment).sort(), ['contextWindow', 'inputModalities', 'maxTokens'])

  const entry = entryFor({ snapshotEntry: { name: 'GLM-5.3-Flash' } })
  for (const key of ['notes', 'sources', 'lab', 'id', 'reasoningOptions', 'interleavedField', 'input']) {
    assert.ok(!(key in entry), `the entry must not leak the official record's "${key}"`)
  }
  assert.equal(officialCapabilityFragment(undefined), undefined)
  assert.equal(officialCapabilityFragment({ notes: ['nothing usable'] }), undefined)
})

test('an operator override still wins over the official number', () => {
  const entry = entryFor({ snapshotEntry: { name: 'GLM-5.3-Flash' } })
  const facts = modelCapabilitiesWithOverrides(entry, DEFAULTS, [{ contextWindow: 4096 }])
  assert.equal(facts.contextWindow, 4096)
})

test('the synced measurement still sits on top and keeps its own fields', () => {
  const synced = {
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    interleavedField: 'reasoning_content',
    protocol: 'openai-completions',
  }
  const entry = entryFor({ snapshotEntry: { name: 'GLM-5.3-Flash' }, syncedEntry: synced })
  assert.equal(entry.contextWindow, 1_000_000, 'declared numbers survive beside the measurement')
  assert.equal(entry.interleavedField, 'reasoning_content')
  assert.equal(entry.protocol, 'openai-completions')
  assert.deepEqual(entry.reasoningOptions, [{ type: 'effort', values: ['low', 'high'] }])
})

test('an id the official baseline does not know still falls to the defaults', () => {
  const entry = entryFor({ id: 'omen-alpha', snapshotEntry: { name: 'omen-alpha' } })
  assert.deepEqual(entry, { name: 'omen-alpha' }, 'the snapshot entry stands alone')
  const facts = modelCapabilities(entry, DEFAULTS)
  assert.equal(facts.contextWindow, DEFAULTS.defaultContextWindow)
})

test('disabling the snapshot face disables the official numbers with it', () => {
  const bare = entryFor({ snapshotEntry: { name: 'GLM-5.3-Flash' }, snapshotEnabled: false })
  assert.equal(bare, undefined, 'with the declaration face off only measured facts remain')
  const withSynced = entryFor({
    snapshotEntry: { name: 'GLM-5.3-Flash' },
    syncedEntry: { reasoning: true },
    snapshotEnabled: false,
  })
  assert.deepEqual(withSynced, { reasoning: true }, 'no official number rides along')
})

test('a synced-only model gains an entry from the official numbers alone', () => {
  const entry = entryFor({})
  assert.deepEqual(entry, {
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    inputModalities: ['text', 'image', 'video', 'pdf'],
  })
})
