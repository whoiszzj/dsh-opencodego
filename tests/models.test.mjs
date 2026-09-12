/**
 * Unit tests for the phase-4a model-set overlay.
 *
 * These run with a bare `node --test tests/` — no profile install — because
 * `models.js` imports only `vocab.js`. That is the point: the layer that decides
 * which models a route serves, and every rejection message it produces, is
 * judged here rather than in a live instance.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  CONFIGURABLE_INPUT_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS,
  describe,
  effectiveModelIds,
  EMPTY_OVERLAY,
  MODEL_EXTRA_KEYS,
  MODEL_OVERRIDE_KEYS,
  MODEL_SET_KEYS,
  modelSource,
  normalizeModelOverlay,
  requireInputModalities,
  requireModelId,
  requirePositiveInteger,
  requireProtocol,
  requireReasoningEfforts,
} from '../src/models.js'
import { HOST_THINKING_LEVELS, SUPPORTED_PROTOCOLS } from '../src/vocab.js'
import {
  modelCapabilities,
  modelCapabilitiesWithOverrides,
  pinThinkingLevels,
} from '../src/capabilities.js'

const DEFAULTS = { defaultContextWindow: 200_000, defaultMaxTokens: 131_072 }

/** The error message one call throws, or `undefined` when it does not throw. */
function messageOf(run) {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// ── the vocabulary ─────────────────────────────────────────────────────────

test('the configurable vocabularies are the host vocabularies, minus what pi-ai cannot send', () => {
  assert.deepEqual([...CONFIGURABLE_INPUT_MODALITIES], ['text', 'image'])
  assert.deepEqual(
    [...CONFIGURABLE_THINKING_LEVELS],
    HOST_THINKING_LEVELS.filter((level) => level !== 'off'),
  )
  assert.deepEqual([...SUPPORTED_PROTOCOLS], ['openai-completions', 'openai-responses', 'anthropic-messages'])
  // `name` is the one attribute only an `extra` entry may set: a model the
  // endpoint already names must not be renamed by a correction.
  assert.equal(MODEL_EXTRA_KEYS.includes('name'), true)
  assert.equal(MODEL_OVERRIDE_KEYS.includes('name'), false)
  assert.equal(MODEL_OVERRIDE_KEYS.includes('id'), false)
  assert.deepEqual([...MODEL_SET_KEYS], ['disabled', 'extra', 'overrides', 'replaceDiscovered'])
})

// ── the overlay is additive, never a replacement ───────────────────────────

test('the effective set is discovered ∪ extra \\ disabled', () => {
  const overlay = normalizeModelOverlay({
    models: {
      disabled: ['stale-model'],
      extra: [{ id: 'brand-new' }, { id: 'also-new', name: 'Also New' }],
    },
  })
  assert.deepEqual(
    effectiveModelIds(['alpha', 'stale-model', 'beta'], overlay),
    ['alpha', 'beta', 'brand-new', 'also-new'],
  )
})

test('a model the endpoint starts advertising is available with no configuration change', () => {
  // The whole point of the additive rule: the operator excluded ONE model
  // yesterday; a model that appears today must not be frozen out by that.
  const overlay = normalizeModelOverlay({ models: { disabled: ['retired-model'] } })
  assert.deepEqual(
    effectiveModelIds(['alpha', 'retired-model'], overlay),
    ['alpha'],
  )
  assert.deepEqual(
    effectiveModelIds(['alpha', 'retired-model', 'tomorrows-model'], overlay),
    ['alpha', 'tomorrows-model'],
  )
})

test('`replaceDiscovered` is the one deliberate freeze, and it is opt-in', () => {
  const frozen = normalizeModelOverlay({
    models: { extra: [{ id: 'only-this' }], replaceDiscovered: true },
  })
  assert.deepEqual(effectiveModelIds(['alpha', 'beta'], frozen), ['only-this'])
  // Default is off: the same overlay without the flag keeps everything.
  const layered = normalizeModelOverlay({ models: { extra: [{ id: 'only-this' }] } })
  assert.deepEqual(effectiveModelIds(['alpha', 'beta'], layered), ['alpha', 'beta', 'only-this'])
})

test('an extra id is not duplicated when the endpoint also advertises it', () => {
  const overlay = normalizeModelOverlay({ models: { extra: [{ id: 'alpha', contextWindow: 4096 }] } })
  assert.deepEqual(effectiveModelIds(['alpha', 'beta'], overlay), ['alpha', 'beta'])
  assert.equal(modelSource('alpha', new Set(['alpha', 'beta']), overlay), 'endpoint+extra')
  assert.equal(modelSource('beta', new Set(['alpha', 'beta']), overlay), 'endpoint')
  const extraOnly = normalizeModelOverlay({ models: { extra: [{ id: 'gamma' }] } })
  assert.equal(modelSource('gamma', new Set(['alpha']), extraOnly), 'extra')
})

test('the empty overlay serves exactly what was discovered', () => {
  assert.deepEqual(effectiveModelIds(['b', 'a'], EMPTY_OVERLAY), ['b', 'a'])
  assert.deepEqual(EMPTY_OVERLAY.disabled, [])
  assert.deepEqual(EMPTY_OVERLAY.extra, {})
  assert.deepEqual(EMPTY_OVERLAY.overrides, {})
  assert.equal(EMPTY_OVERLAY.replaceDiscovered, false)
})

// ── the legacy alias ───────────────────────────────────────────────────────

test('the legacy protocolOverrides alias becomes an override entry', () => {
  const overlay = normalizeModelOverlay({ protocolOverrides: { 'minimax-m2.7': 'anthropic-messages' } })
  assert.deepEqual(overlay.overrides['minimax-m2.7'], { api: 'anthropic-messages' })
  assert.deepEqual([...overlay.protocolOverridesApplied], ['minimax-m2.7'])
  assert.deepEqual([...overlay.protocolOverridesShadowed], [])
})

test('models.overrides[id].api wins over the alias, and the shadowed alias is reported', () => {
  const overlay = normalizeModelOverlay({
    models: { overrides: { alpha: { api: 'openai-responses' } } },
    protocolOverrides: { alpha: 'anthropic-messages' },
  })
  assert.deepEqual(overlay.overrides.alpha, { api: 'openai-responses' })
  assert.deepEqual([...overlay.protocolOverridesShadowed], ['alpha'])
  assert.deepEqual([...overlay.protocolOverridesApplied], [])
})

test('the alias still contributes the protocol when the newer entry names no api', () => {
  const overlay = normalizeModelOverlay({
    models: { overrides: { alpha: { contextWindow: 4096 } } },
    protocolOverrides: { alpha: 'openai-responses' },
  })
  assert.deepEqual(overlay.overrides.alpha, { contextWindow: 4096, api: 'openai-responses' })
  assert.deepEqual([...overlay.protocolOverridesApplied], ['alpha'])
})

// ── rejection messages name the field and the model ────────────────────────

test('an unknown key is refused by name, with the supported keys listed', () => {
  const message = messageOf(() => normalizeModelOverlay({
    models: { extra: [{ id: 'alpha', contextwindow: 4096 }] },
  }))
  assert.equal(
    message,
    'opencode-go-native: models.extra[0] has unknown key "contextwindow"; '
    + 'supported keys are id, name, api, contextWindow, maxTokens, input, reasoning, reasoningEfforts',
  )
})

test('an unsupported protocol is refused by name and by model id', () => {
  const extra = messageOf(() => normalizeModelOverlay({
    models: { extra: [{ id: 'alpha', api: 'openai-chat' }] },
  }))
  assert.equal(
    extra,
    'opencode-go-native: models.extra["alpha"].api must be one of openai-completions, '
    + 'openai-responses, anthropic-messages (got: "openai-chat")',
  )
  const override = messageOf(() => normalizeModelOverlay({
    models: { overrides: { beta: { api: 'grpc' } } },
  }))
  assert.equal(
    override,
    'opencode-go-native: models.overrides["beta"].api must be one of openai-completions, '
    + 'openai-responses, anthropic-messages (got: "grpc")',
  )
})

test('a negative or fractional cap is refused by name and by model id', () => {
  const negative = messageOf(() => normalizeModelOverlay({
    models: { extra: [{ id: 'alpha', contextWindow: -1 }] },
  }))
  assert.equal(
    negative,
    'opencode-go-native: models.extra["alpha"].contextWindow must be a positive integer (got: -1)',
  )
  const fractional = messageOf(() => normalizeModelOverlay({
    models: { overrides: { beta: { maxTokens: 1.5 } } },
  }))
  assert.equal(
    fractional,
    'opencode-go-native: models.overrides["beta"].maxTokens must be a positive integer (got: 1.5)',
  )
})

test('a modality the host cannot carry is refused, not silently filtered', () => {
  const message = messageOf(() => normalizeModelOverlay({
    models: { overrides: { alpha: { input: ['text', 'video'] } } },
  }))
  assert.match(message ?? '', /^opencode-go-native: models\.overrides\["alpha"\]\.input\[1\] must be one of text, image \(got: "video"\)/)
  assert.match(message ?? '', /harness message content can only carry text and image blocks/)
})

test('`off` is refused as a selectable effort, with the reason', () => {
  const message = messageOf(() => normalizeModelOverlay({
    models: { overrides: { alpha: { reasoningEfforts: ['low', 'off'] } } },
  }))
  assert.match(message ?? '', /^opencode-go-native: models\.overrides\["alpha"\]\.reasoningEfforts\[1\] must not be "off"/)
  assert.match(message ?? '', /pi-ai expresses "do not reason" by omitting the reasoning option/)
})

test('a non-host thinking level is refused by name', () => {
  const message = messageOf(() => normalizeModelOverlay({
    models: { extra: [{ id: 'alpha', reasoningEfforts: ['low', 'turbo'] }] },
  }))
  assert.equal(
    message,
    'opencode-go-native: models.extra["alpha"].reasoningEfforts[1] "turbo" is not a host thinking level; '
    + 'expected one of minimal, low, medium, high, xhigh, max',
  )
})

test('an empty model id is refused wherever it appears', () => {
  assert.equal(
    messageOf(() => normalizeModelOverlay({ models: { disabled: ['  '] } })),
    'opencode-go-native: models.disabled[0] must be a non-empty model id (got: "  ")',
  )
  assert.equal(
    messageOf(() => normalizeModelOverlay({ models: { extra: [{ id: 7 }] } })),
    'opencode-go-native: models.extra[0].id must be a model id string (got: 7)',
  )
  assert.equal(
    messageOf(() => normalizeModelOverlay({ models: { overrides: { '': { contextWindow: 1 } } } })),
    'opencode-go-native: models.overrides (as a key) must be a non-empty model id (got: "")',
  )
})

test('the contradictions between the three lists are refused, not resolved silently', () => {
  assert.match(
    messageOf(() => normalizeModelOverlay({
      models: { extra: [{ id: 'alpha' }, { id: 'alpha' }] },
    })) ?? '',
    /^opencode-go-native: models\.extra\[1\] repeats the model id "alpha"/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({
      models: { disabled: ['alpha'], extra: [{ id: 'alpha' }] },
    })) ?? '',
    /appears in both models\.extra and models\.disabled/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({
      models: { disabled: ['alpha'], overrides: { alpha: { contextWindow: 1 } } },
    })) ?? '',
    /is in models\.disabled and also has a models\.overrides entry/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({ models: { disabled: ['alpha', 'alpha'] } })) ?? '',
    /^opencode-go-native: models\.disabled\[1\] repeats "alpha"/,
  )
})

test('a shape that is not an object is refused at its own path', () => {
  assert.match(
    messageOf(() => normalizeModelOverlay({ models: [] })) ?? '',
    /^opencode-go-native: models must be an object with disabled\/extra\/overrides\/replaceDiscovered \(got: an array of 0\)/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({ models: { extra: { id: 'a' } } })) ?? '',
    /^opencode-go-native: models\.extra must be an array of \{ id, … \} entries \(got: an object\)/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({ models: { disabled: 'alpha' } })) ?? '',
    /^opencode-go-native: models\.disabled must be an array of model ids \(got: "alpha"\)/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({ models: { overrides: [] } })) ?? '',
    /^opencode-go-native: models\.overrides must be an object keyed by model id \(got: an array of 0\)/,
  )
  assert.match(
    messageOf(() => normalizeModelOverlay({ models: { extra: [{ id: 'a', reasoning: 'yes' }] } })) ?? '',
    /^opencode-go-native: models\.extra\["a"\]\.reasoning must be a boolean \(got: "yes"\)/,
  )
})

test('an override that sets nothing is refused instead of being stored as a no-op', () => {
  assert.equal(
    messageOf(() => normalizeModelOverlay({ models: { overrides: { alpha: {} } } })),
    'opencode-go-native: models.overrides["alpha"] sets nothing; remove the entry, '
    + 'or name one of api, contextWindow, maxTokens, input, reasoning, reasoningEfforts',
  )
})

test('the low-level validators carry the same voice as the overlay', () => {
  assert.equal(requireModelId('a ', 'somewhere'), 'a')
  assert.equal(messageOf(() => requireModelId('', 'somewhere')), 'opencode-go-native: somewhere must be a non-empty model id (got: "")')
  assert.equal(requirePositiveInteger(1, 'somewhere'), 1)
  assert.equal(messageOf(() => requirePositiveInteger(0, 'somewhere')), 'opencode-go-native: somewhere must be a positive integer (got: 0)')
  assert.equal(requireProtocol('openai-responses', 'somewhere'), 'openai-responses')
  assert.match(requireInputModalities(['image', 'text'], 'somewhere').join(','), /^image,text$/)
  assert.deepEqual(requireReasoningEfforts(['low', 'max'], 'somewhere'), ['low', 'max'])
  assert.deepEqual(requireReasoningEfforts([], 'somewhere'), [])
  assert.equal(describe(undefined), 'undefined')
  assert.equal(describe(null), 'null')
  assert.equal(describe([1, 2]), 'an array of 2')
  assert.equal(describe({}), 'an object')
})

// ── the capability layer the overlay feeds ─────────────────────────────────

test('a model with no snapshot record still gets the conservative defaults', () => {
  const facts = modelCapabilities(undefined, DEFAULTS)
  assert.equal(facts.source, 'defaults')
  assert.equal(facts.contextWindow, 200_000)
  assert.equal(facts.maxTokens, 131_072)
  assert.deepEqual(facts.input, ['text'])
  assert.equal(facts.reasoning, false)
})

test('an extra declaration replaces only the attributes it names', () => {
  const entry = { contextWindow: 1_000_000, maxTokens: 65_536, inputModalities: ['text', 'image'], npm: null }
  const facts = modelCapabilitiesWithOverrides(entry, DEFAULTS, [
    { contextWindow: 4096, name: 'ignored-by-capabilities' },
  ])
  assert.equal(facts.source, 'snapshot')
  assert.equal(facts.contextWindow, 4096)
  assert.equal(facts.maxTokens, 65_536)
  assert.deepEqual(facts.input, ['text', 'image'])
})

test('an override beats an extra declaration for the same attribute', () => {
  const layers = [{ contextWindow: 4096 }, { contextWindow: 8192 }]
  assert.equal(modelCapabilitiesWithOverrides(undefined, DEFAULTS, layers).contextWindow, 8192)
})

test('a configured effort list pins every other level to null', () => {
  const facts = modelCapabilitiesWithOverrides(undefined, DEFAULTS, [{ reasoningEfforts: ['low', 'max'] }])
  assert.equal(facts.reasoning, true)
  assert.deepEqual(facts.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: null, high: null, xhigh: null, max: 'max',
  })
  assert.deepEqual(facts.unmappedLevels, [])
})

test('a snapshot wire spelling survives an effort list naming the same level', () => {
  // `none` → `off` is the alias the snapshot path establishes; an operator who
  // re-declares the level must not silently lose the provider spelling.
  const entry = {
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high'] }],
  }
  const facts = modelCapabilitiesWithOverrides(entry, DEFAULTS, [{ reasoningEfforts: ['low', 'high'] }])
  assert.deepEqual(facts.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null,
  })
  const declared = modelCapabilities(entry, DEFAULTS)
  const kept = modelCapabilitiesWithOverrides(entry, DEFAULTS, [{ reasoningEfforts: ['low', 'high'] }])
  assert.notEqual(declared.thinkingLevelMap, kept.thinkingLevelMap)
})

test('`reasoning: false` clears the levels the snapshot declared', () => {
  const entry = {
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
  }
  const facts = modelCapabilitiesWithOverrides(entry, DEFAULTS, [{ reasoning: false }])
  assert.equal(facts.reasoning, false)
  assert.equal(facts.thinkingLevelMap, undefined)
})

test('`reasoning: true` with no levels reuses the snapshot levels instead of inventing any', () => {
  const entry = {
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
  }
  const facts = modelCapabilitiesWithOverrides(entry, DEFAULTS, [{ reasoning: true }])
  assert.equal(facts.reasoning, true)
  assert.deepEqual(facts.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null,
  })
})

test('an input override still drops what the host cannot carry, and records it', () => {
  // `models.js` refuses such a value up front, so this is defence in depth: the
  // runtime must never declare a modality it cannot send.
  const facts = modelCapabilitiesWithOverrides(undefined, DEFAULTS, [{ input: ['text', 'video', 'image'] }])
  assert.deepEqual(facts.input, ['text', 'image'])
  assert.deepEqual(facts.droppedModalities, ['video'])
})

test('pinThinkingLevels names a host level by itself when the snapshot has no spelling', () => {
  assert.deepEqual(pinThinkingLevels(['medium'], undefined), {
    off: null, minimal: null, low: null, medium: 'medium', high: null, xhigh: null, max: null,
  })
})

// ── the settings schema is judged by the same code ─────────────────────────

test('config.js judges models through models.js and adds no second vocabulary', () => {
  const source = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  // The overlay's rules must have exactly one home. If `config.js` ever grows
  // its own list of protocols, modalities or level names, the settings form and
  // the runtime judge can disagree — the failure this phase exists to remove.
  assert.match(source, /import \{ normalizeModelOverlay \} from '\.\/models\.js'/)
  assert.doesNotMatch(source, /CONFIGURABLE_THINKING_LEVELS\s*=\s*\[/)
  assert.doesNotMatch(source, /reasoningEfforts:\s*z\./)
  // `protocolOverrides` may not be validated by hand either: `models.js` owns
  // its precedence relative to `models.overrides[id].api`.
  assert.doesNotMatch(source, /for \(const \[id, api\] of Object\.entries\(config\.protocolOverrides/)
})

test('the config schema does not call schemastery methods that break JSON Schema rendering', () => {
  // Phase 4a adds `models` to the settings schema, and a 4b settings form
  // renders `schema.toJSON()`. These methods produce shapes that surface cannot
  // express (or, for `default(undefined)`, a schema whose own default is
  // rejected by its own validator). Pinned at the source, like the build's
  // named-export check, because importing schemastery needs the profile.
  const source = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  for (const forbidden of ['.empty(', '.default(undefined)']) {
    assert.equal(source.includes(forbidden), false, `config.js must not use ${forbidden}`)
  }
  // `role(...)` is allowed for exactly TWO spellings, each on the field it
  // describes:
  //
  //   - `credential-ref` on `apiKeyEnv`. That is the spelling the official
  //     provider plugins use for a REFERENCE NAME, and since 0.6.0 this schema
  //     treats `apiKeyEnv` the same way: it names a variable, it never holds a
  //     value.
  //   - `secret` on the LEGACY inline `apiKey`, which still exists so a
  //     pre-0.6.0 document can be read and migrated. This plugin never writes it.
  //
  // Every other role (a slider, a datetime) is a renderer hint this form does
  // not implement.
  //
  // Comments are stripped before the scan, because prose about a spelling is not
  // a declaration of it — and the scan is deliberately on the SOURCE (this file
  // cannot import schemastery: that needs the profile).
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  const roles = [...code.matchAll(/role\('([^']*)'\)/gu)].map((match) => match[1])
  assert.ok(roles.length > 0, 'the guard would be vacuous without a role to check')
  assert.deepEqual(
    [...new Set(roles)].sort(),
    ['credential-ref', 'secret'],
    'config.js may only declare role(\'credential-ref\') on apiKeyEnv and role(\'secret\') on the legacy apiKey',
  )
  assert.match(
    code,
    /apiKeyEnv: z\.string\(\)\.role\('credential-ref'\)/u,
    'apiKeyEnv must carry the reference role — it names a credential, it never holds one',
  )
  assert.match(
    code,
    /apiKey: z\.string\(\)\.role\('secret'\)/u,
    'the legacy inline apiKey must keep the secret role — it is what keeps a not-yet-migrated token out of every wire response',
  )
})

test('an empty effort list declares "this model does not reason"', () => {
  const entry = {
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
  }
  const facts = modelCapabilitiesWithOverrides(entry, DEFAULTS, [{ reasoningEfforts: [] }])
  assert.equal(facts.reasoning, false)
  assert.equal(facts.thinkingLevelMap, undefined)
  assert.deepEqual(facts.unmappedLevels, [])
})

test('the catalogue cache key includes the endpoint target, not only the TTL', () => {
  // Measured in the phase-4a isolated run: with only a TTL, a settings change of
  // `baseURL` kept answering from the previous endpoint's catalogue for the rest
  // of the TTL, so "the next request uses the new facts" was false for exactly
  // the field this phase adds to the settings surface. The endpoint target is
  // part of the freshness decision, pinned here at the source because
  // `catalog.js` imports the host package and cannot run under bare `node --test`.
  const source = readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8')
  // The credential half of the target names the source actually in force: a
  // reference when the token comes from the store, the inline value when it is
  // pasted into the plugin's own settings. Editing an unused reference must not
  // invalidate a live catalogue, and swapping the inline token must.
  assert.match(
    source,
    /const credential = options\.apiKey === undefined \? `ref:\$\{options\.apiKeyEnv\}` : `inline:\$\{options\.apiKey\}`/,
  )
  assert.match(source, /const target = `\$\{options\.baseURL\}\\u0000\$\{credential\}`/)
  assert.match(source, /const sameTarget = this\.targetKey === target/)
  assert.match(source, /this\.catalog !== undefined && sameTarget && age < options\.syncTtlMs/)
  // The target is recorded for the attempt, so a failed discovery against a new
  // endpoint cannot leave the old catalogue looking fresh for the new target.
  assert.match(source, /this\.targetKey = target[\s\S]{0,400}?this\.#load\(options, request\.signal\)/)
  assert.doesNotMatch(source, /this\.targetKey = target\n\s+const advertised/)
})

test('a credential misconfiguration is not swallowed by the catalogue\'s failure tolerance', () => {
  // The phase-4a isolated run measured this: after a settings write naming an
  // unset `apiKeyEnv`, `listModels()` still answered with the previous
  // endpoint's catalogue and the diagnostic said only `stale`, so the setting
  // was accepted, stored, and — from the user's point of view — ignored. An
  // unreachable endpoint is tolerated (the last good list keeps serving);
  // `MISSING_CREDENTIAL` is not, because no retry can fix it and it breaks every
  // request on the route.
  const source = readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8')
  assert.match(source, /if \(error\?\.code === 'MISSING_CREDENTIAL'\) throw error/)
  const catchBlock = source.slice(source.indexOf('.catch((error) => {'), source.indexOf('.finally('))
  assert.match(catchBlock, /throw error/)
  assert.match(catchBlock, /return this\.models\(\)/)
})
