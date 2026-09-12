/**
 * Unit tests for protocol resolution and the candidate chain.
 *
 * The npm rule is the authority (the design notes §2.2 as revised in phase 2); the
 * built-in table is only a bootstrap for ids the snapshot does not know; the
 * chain adds measured alternates AFTER the primary and never replaces it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALTERNATE_PROTOCOL_HINTS,
  BUILTIN_MODEL_PROTOCOLS,
  PROTOCOL_NPM_RULE,
  protocolChainForModel,
  protocolForModel,
  protocolForNpm,
  resolveProtocol,
} from '../src/protocol-map.js'

test('the npm rule maps models.dev packages onto pi-ai protocols', () => {
  assert.equal(protocolForNpm('@ai-sdk/anthropic'), 'anthropic-messages')
  assert.equal(protocolForNpm('@ai-sdk/openai'), 'openai-responses')
  // Absent means "inherit the provider package"; the provider's own package is
  // `@ai-sdk/openai-compatible`.
  assert.equal(protocolForNpm(undefined), 'openai-completions')
  assert.equal(protocolForNpm(null), 'openai-completions')
  assert.equal(protocolForNpm('@ai-sdk/openai-compatible'), 'openai-completions')
  // An unknown package degrades to the provider default rather than throwing:
  // a wrong-but-supported protocol can still fall back, a failed route cannot.
  assert.equal(protocolForNpm('@ai-sdk/google'), 'openai-completions')
  assert.deepEqual(PROTOCOL_NPM_RULE, {
    '@ai-sdk/anthropic': 'anthropic-messages',
    '@ai-sdk/openai': 'openai-responses',
  })
})

test('configuration wins, then the snapshot npm fact, then the bootstrap table', () => {
  const overrides = { 'glm-5.3-flash': 'openai-responses' }
  assert.deepEqual(
    resolveProtocol('glm-5.3-flash', { overrides, snapshotNpm: null }),
    { primary: 'openai-responses', source: 'config-override' },
  )
  assert.deepEqual(
    resolveProtocol('grok-4.6', { overrides, snapshotNpm: '@ai-sdk/openai' }),
    { primary: 'openai-responses', source: 'models.dev-npm' },
  )
  // A catalogued model that inherits the provider package is NOT "unknown".
  assert.deepEqual(
    resolveProtocol('glm-5.3-flash', { overrides, snapshotNpm: null }),
    { primary: 'openai-responses', source: 'config-override' },
  )
  assert.deepEqual(
    resolveProtocol('glm-5.3-flash', { snapshotNpm: null }),
    { primary: 'openai-completions', source: 'models.dev-npm' },
  )
  // The bootstrap table only answers for ids the snapshot does not know.
  assert.deepEqual(
    resolveProtocol('grok-4.6', { snapshotNpm: undefined }),
    { primary: 'openai-responses', source: 'builtin-bootstrap' },
  )
  assert.deepEqual(
    resolveProtocol('some-brand-new-id', {}),
    { primary: 'openai-completions', source: 'provider-default' },
  )
})

test('deepseek-v4.1-flash resolves to openai-completions, not the phase-1 over-correction', () => {
  // Phase 1 pinned this id to `openai-responses` because both protocols answer.
  // The audit corrected that: the npm rule (absent -> provider package ->
  // completions) is the primary, and `responses` is a measured alternate.
  assert.equal(protocolForModel('deepseek-v4.1-flash', {}, null), 'openai-completions')
  assert.equal(BUILTIN_MODEL_PROTOCOLS['deepseek-v4.1-flash'], undefined)
  assert.deepEqual(
    protocolChainForModel('deepseek-v4.1-flash', { snapshotNpm: null }),
    ['openai-completions', 'openai-responses'],
  )
  for (const id of ['deepseek-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(protocolForModel(id, {}, null), 'openai-completions', id)
    assert.equal(BUILTIN_MODEL_PROTOCOLS[id], undefined, id)
  }
})

test('an override naming an unsupported protocol is refused loudly', () => {
  assert.throws(
    () => protocolForModel('glm-5.3-flash', { 'glm-5.3-flash': 'grpc' }, null),
    /cannot serve/,
  )
})

test('the chain is primary, then measured alternates, then the provider default', () => {
  assert.deepEqual(
    protocolChainForModel('grok-4.6', { snapshotNpm: '@ai-sdk/openai' }),
    ['openai-responses', 'openai-completions'],
  )
  // A primary forced by a bad override can still recover to the rule's answer.
  assert.deepEqual(
    protocolChainForModel('glm-5.3-flash', {
      overrides: { 'glm-5.3-flash': 'openai-responses' },
      snapshotNpm: null,
    }),
    ['openai-responses', 'openai-completions'],
  )
  // A model with no evidence and no rule difference has a single candidate.
  assert.deepEqual(protocolChainForModel('glm-5.3-flash', { snapshotNpm: null }), ['openai-completions'])
  // The npm rule's own answer is appended for an anthropic-primary model, whose
  // gateway serves no anthropic path at all (measured HTML 404).
  assert.deepEqual(
    protocolChainForModel('qwen3.8-flash', { snapshotNpm: '@ai-sdk/anthropic' }),
    ['anthropic-messages', 'openai-completions'],
  )
})

test('the chain is capped and duplicate-free', () => {
  const chain = protocolChainForModel('deepseek-v4.1-flash', { snapshotNpm: null, maxAttempts: 1 })
  assert.deepEqual(chain, ['openai-completions'])
  const wide = protocolChainForModel('deepseek-v4.1-flash', {
    snapshotNpm: null,
    maxAttempts: 8,
  })
  assert.deepEqual(wide, [...new Set(wide)])
  assert.ok(wide.length <= 3)
})

test('the last-resort candidate is opted out of, never smuggled in', () => {
  assert.deepEqual(
    protocolChainForModel('qwen3.8-flash', { snapshotNpm: '@ai-sdk/anthropic', includeFallback: false }),
    // The rule protocol is still appended: opting out removes only the generic
    // provider default, not the model's own rule answer.
    ['anthropic-messages', 'openai-completions'],
  )
  // `grok-4.6` has no measured alternate (completions answers 401 for it), so
  // opting out of the generic fallback leaves the single rule answer.
  assert.deepEqual(
    protocolChainForModel('grok-4.6', { snapshotNpm: '@ai-sdk/openai', includeFallback: false }),
    ['openai-responses'],
  )
  assert.deepEqual(
    protocolChainForModel('glm-5.3-flash', { snapshotNpm: null, includeFallback: false }),
    ['openai-completions'],
  )
})

/** The four models the npm rule places on the protocol this gateway does not serve. */
const ANTHROPIC_PRIMARY = new Set(['minimax-m2.5', 'minimax-m2.7', 'minimax-m3', 'qwen3.8-flash'])

test('a measured alternate is never the primary', () => {
  for (const [modelId, hints] of Object.entries(ALTERNATE_PROTOCOL_HINTS)) {
    const snapshotNpm = ANTHROPIC_PRIMARY.has(modelId) ? '@ai-sdk/anthropic' : null
    const chain = protocolChainForModel(modelId, { snapshotNpm })
    const primary = resolveProtocol(modelId, { snapshotNpm }).primary
    for (const hint of hints) {
      assert.ok(chain.includes(hint), `${modelId} chain should include ${hint}`)
      assert.notEqual(hint, primary, `${modelId}: ${hint} is an alternate, not the primary`)
      assert.equal(chain[0], primary, `${modelId}: the chain must start at the primary`)
    }
  }
})
