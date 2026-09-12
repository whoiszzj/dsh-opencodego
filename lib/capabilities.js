/**
 * The interpretation layer between a models.dev catalog record and the
 * capability facts this plugin hands to pi-ai and to the host.
 *
 * Two rules shape every function here:
 *
 *  1. **The snapshot stores upstream facts verbatim; this module interprets
 *     them.** A models.dev record keeps the raw `modalities.input` list (which
 *     may name `video`, `pdf`, `audio`) and the raw effort strings (which may
 *     say `none`, `xhigh`, or something no host level matches). Filtering and
 *     mapping happen here, in versioned code with unit tests, so improving a
 *     rule does not require re-fetching the catalog.
 *  2. **Nothing is invented.** A capability the host cannot express is dropped
 *     and *recorded* (see the `dropped*` / `unmapped*` fields), never guessed at.
 *     `toggle` and `budget_tokens` reasoning options therefore do not become
 *     selectable levels: models.dev gives them no wire value to send.
 *
 * @module dsh-opencodego/capabilities
 */

import {
  HOST_INPUT_MODALITIES,
  HOST_THINKING_LEVELS,
  PI_AI_REASONING_FIELDS,
} from './vocab.js'
import { claimLayersFor } from './models.js'

/**
 * Every host input modality except `text`, as a lookup set. Used to validate a
 * configured modality list (phase 4a) against the SAME vocabulary the snapshot
 * path filters with, so the two cannot drift.
 */
export const IMAGE_MODALITIES = Object.freeze(
  HOST_INPUT_MODALITIES.filter((modality) => modality !== 'text'),
)

/**
 * Free-string effort values that name a host level under another spelling.
 *
 * `none` is the one alias models.dev actually uses for "do not reason" (seen on
 * `hy3` / `hy4-preview` / `gpt-5.6-luna`). Mapping it to the host's `off` keeps
 * the provider's own spelling on the wire — pi-ai's plain OpenAI-shaped
 * reasoning dispatch sends `thinkingLevelMap.off` as `reasoning_effort` when the
 * caller asks for `off` (see `openai-completions.js`, the final
 * `!options?.reasoningEffort` branch) — instead of silently warning that a
 * declared level was unmappable. Matching is case-insensitive.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const EFFORT_LEVEL_ALIASES = Object.freeze({
  none: 'off',
  // `minimum` is the spelling the Alibaba gateway actually accepts for the host
  // level `minimal` — measured: `qwen3.6-plus` answers 200 to `minimum` and 400
  // to `minimal`, while its siblings `qwen3.7-*` do the exact opposite. Without
  // this alias a synced `minimum` is reported unmappable and the level silently
  // disappears from that model's ladder.
  minimum: 'minimal',
})

/** A positive integer, or `undefined` for anything that is not one. */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Normalize one freely-spelled effort value to a host thinking level.
 * @param {unknown} value - one `reasoning_options[].values[]` entry.
 * @returns {string | undefined} the host level, or `undefined` when unmappable.
 */
export function effortLevelOf(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return undefined
  const aliased = EFFORT_LEVEL_ALIASES[normalized] ?? normalized
  return HOST_THINKING_LEVELS.includes(aliased) ? aliased : undefined
}

/**
 * Derive the reasoning capability from one catalog record.
 *
 * Every host level the catalog does not declare is pinned to `null`, which is
 * pi-ai's way of saying "this level is unsupported" (`getSupportedThinkingLevels`
 * filters `null` out, while an *absent* key counts as supported for the five
 * base levels and unsupported for `xhigh`/`max` — an asymmetry this plugin
 * decides explicitly rather than leaving to a default).
 *
 * @param {object | undefined} entry - one snapshot record (`reasoning`,
 *   `reasoningOptions`, `interleavedField` …).
 * @returns {{
 *   declared: boolean,
 *   reasoning: boolean,
 *   thinkingLevelMap: Record<string, string | null> | undefined,
 *   unmappedLevels: string[],
 *   conflictingLevels: string[],
 *   thinkingField: string | undefined,
 *   unmappableField: string | undefined,
 *   options: string[],
 * }} the reasoning facts.
 */
export function mapReasoning(entry) {
  const declared = entry?.reasoning === true
  const options = Array.isArray(entry?.reasoningOptions) ? entry.reasoningOptions : []
  const shapes = []
  /** @type {Record<string, string>} */
  const declaredLevels = {}
  /** @type {string[]} */
  const unmappedLevels = []
  /** @type {string[]} */
  const conflictingLevels = []
  for (const option of options) {
    if (typeof option !== 'object' || option === null) continue
    const type = typeof option.type === 'string' ? option.type : 'unknown'
    if (!shapes.includes(type)) shapes.push(type)
    if (type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      const level = effortLevelOf(value)
      if (level === undefined) {
        const spelling = typeof value === 'string' ? value : String(value)
        if (!unmappedLevels.includes(spelling)) unmappedLevels.push(spelling)
        continue
      }
      const wire = /** @type {string} */ (value)
      if (declaredLevels[level] === undefined) declaredLevels[level] = wire
      else if (declaredLevels[level] !== wire && !conflictingLevels.includes(level)) {
        // Two spellings for one host level: the first declaration wins so the
        // mapping stays a function, and the conflict is reported instead of
        // being silently dropped.
        conflictingLevels.push(level)
      }
    }
  }
  const levels = Object.keys(declaredLevels)
  const thinkingLevelMap = levels.length === 0
    ? undefined
    : Object.fromEntries(HOST_THINKING_LEVELS.map((level) => [
      level,
      declaredLevels[level] ?? null,
    ]))

  const interleaved = entry?.interleavedField
  const knownField = typeof interleaved === 'string' && PI_AI_REASONING_FIELDS.includes(interleaved)

  return {
    declared,
    // pi-ai's `reasoning` flag means "this model can be told to think". A model
    // whose only declared option is a `toggle`/`budget_tokens` (no wire value to
    // send) or whose levels are all unmappable therefore reports `false`: every
    // reasoning parameter would be a guess, and pi-ai would send none anyway.
    reasoning: declared && levels.length > 0,
    thinkingLevelMap,
    unmappedLevels,
    conflictingLevels,
    thinkingField: knownField ? interleaved : undefined,
    unmappableField: interleaved !== undefined && !knownField ? String(interleaved) : undefined,
    options: shapes,
  }
}

/**
 * The capability facts one settings page shows for one model, in one
 * JSON-serializable shape.
 *
 * Two different numbers exist for the same model, and conflating them is how a
 * settings form turns "inherit" into an accidental pin:
 *
 *   - `defaults` — the OFFICIAL fact with no configuration applied: the
 *     models.dev snapshot record, or the conservative connection defaults for an
 *     id the snapshot does not know. This is what an empty form field means, so
 *     it is what the field's placeholder shows.
 *   - `effective` — the same facts with `models.extra` / `models.overrides`
 *     applied, i.e. what this route would actually serve right now.
 *
 * The function is host-free — the caller hands it the snapshot record, the npm
 * fact, and the resolved connection facts — so the payload a settings page reads
 * is pinned by `node --test` without a profile install, and the wire shape
 * cannot drift from the interpretation that produced it.
 *
 * @param {object} args - the facts.
 * @param {{ id: string, name: string }} args.model - the catalogue entry.
 * @param {object | undefined} args.entry - the snapshot record, when one exists.
 * @param {string | null | undefined} args.snapshotNpm - the snapshot's `provider.npm` fact.
 * @param {object} args.connection - resolved connection facts (defaults + overlay).
 * @param {{ overrides?: Record<string, string> }} [args.connection.models] - the normalized overlay.
 * @param {(id: string, facts: object) => { primary: string, source: string }} [args.resolveProtocol] - the protocol decision, injected so this module keeps no second copy of the rule.
 * @returns {object} the JSON-serializable description.
 */
export function catalogueModelView({ model, entry, snapshotNpm, connection, resolveProtocol }) {
  const facts = modelCapabilitiesWithOverrides(
    entry,
    connection,
    claimLayersFor(connection.models, model.id),
  )
  const defaults = modelCapabilities(entry, connection)
  const protocol = resolveProtocol === undefined
    ? undefined
    : resolveProtocol(model.id, { overrides: connection.protocolOverrides, snapshotNpm })
  return {
    id: model.id,
    name: model.name,
    ...protocol === undefined ? {} : { protocol: protocol.primary, protocolSource: protocol.source },
    snapshotKnown: entry !== undefined,
    effective: {
      contextWindow: facts.contextWindow,
      maxTokens: facts.maxTokens,
      input: facts.input,
      reasoning: facts.reasoning === true,
      reasoningEfforts: selectableThinkingLevels(facts.reasoning, facts.thinkingLevelMap),
    },
    defaults: {
      contextWindow: defaults.contextWindow,
      maxTokens: defaults.maxTokens,
      input: defaults.input,
      reasoning: defaults.reasoning === true,
      reasoningEfforts: selectableThinkingLevels(defaults.reasoning, defaults.thinkingLevelMap),
    },
  }
}

/**
 * The pi-ai `compat` block one model's facts imply.
 *
 * Only one switch is derived, and only from a fact the catalog publishes:
 * `interleaved.field`. When a model interleaves its reasoning into a dedicated
 * assistant field, pi-ai's replayed assistant turns must carry that field even
 * when this turn produced no reasoning — otherwise the field vanishes from the
 * middle of a conversation and a provider that keys on it (the DeepSeek family
 * is the one pi-ai's own `detectCompat` special-cases) rejects the history.
 *
 * `thinkingFormat` is deliberately NOT set. The formats pi-ai offers
 * (`deepseek` sends `thinking: { type }`, `zai`, `qwen`, `together`, …) are
 * request-side dialects this catalog says nothing about: models.dev `effort`
 * values are `reasoning_effort` values, which is exactly pi-ai's default
 * (`openai`) handling, and no field of the catalog says the relay speaks a
 * different dialect. Recorded in README「能力预填规则」.
 *
 * @param {{ thinkingField?: string }} facts - mapped capability facts.
 * @returns {{ requiresReasoningContentOnAssistantMessages: boolean } | undefined}
 *   the compat block, or `undefined` when nothing is implied.
 */
export function compatFor(facts) {
  if (facts?.thinkingField !== 'reasoning_content') return undefined
  return { requiresReasoningContentOnAssistantMessages: true }
}

/**
 * The thinking levels a model exposes, mirroring pi-ai's own
 * `getSupportedThinkingLevels` so this plugin can describe a model without
 * importing pi-ai at that moment.
 * @param {boolean} reasoning - the pi-ai `reasoning` flag.
 * @param {Record<string, string | null> | undefined} thinkingLevelMap - the pinning map.
 * @returns {string[]} supported levels in escalation order.
 */
export function supportedThinkingLevels(reasoning, thinkingLevelMap) {
  if (reasoning !== true) return ['off']
  return HOST_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * The levels a user can actually select, i.e. everything but `off`.
 *
 * The host's reasoning surface is a list of *efforts*; `off` is pi-ai's
 * "omit the reasoning option" and is already the behaviour of an unconfigured
 * request. Exposing nothing here means the capability is reported as absent, so
 * the surface keeps the provider's own default instead of offering a control
 * that cannot change the request (the same judgement the official
 * `dsh-llm-pi-ai` adapter makes).
 * @param {boolean} reasoning - the pi-ai `reasoning` flag.
 * @param {Record<string, string | null> | undefined} thinkingLevelMap - the pinning map.
 * @returns {string[]} selectable levels.
 */
export function selectableThinkingLevels(reasoning, thinkingLevelMap) {
  return supportedThinkingLevels(reasoning, thinkingLevelMap).filter((level) => level !== 'off')
}

/**
 * Filter a catalog modality list down to what the host can carry.
 * @param {unknown} declared - `modalities.input` from the catalog record.
 * @returns {{ input: string[], dropped: string[] }} kept and filtered-out modalities.
 */
export function mapInputModalities(declared) {
  const listed = Array.isArray(declared) ? declared : []
  const input = []
  const dropped = []
  for (const modality of listed) {
    if (typeof modality !== 'string') continue
    if (HOST_INPUT_MODALITIES.includes(modality)) {
      if (!input.includes(modality)) input.push(modality)
    } else if (!dropped.includes(modality)) {
      dropped.push(modality)
    }
  }
  // An empty list would tell pi-ai the model accepts nothing at all, which no
  // usable model does — text is the one modality every chat endpoint takes.
  if (input.length === 0) input.push('text')
  return { input, dropped }
}

/**
 * Whether one request that carries image blocks can be served at all.
 *
 * This mirrors the official `dsh-llm-pi-ai` adapter's gate, and it exists
 * because dropping an image silently is data LOSS the user cannot see: the host
 * only refuses a request on capability grounds when a route declares no image
 * modality, so a route that *declares* image support and then discards the
 * block would answer "successfully" about a picture the model never received.
 *
 * The three outcomes are the official ones:
 *
 *   1. no image in the request → nothing to decide;
 *   2. the model's declared modalities exclude `image` → refuse (the host
 *      normally projects such a request to text placeholders before dispatch,
 *      so this is defence in depth);
 *   3. no durable attachment service → refuse: converting an image needs the
 *      provider that owns the normalized bytes, and they cannot be invented here.
 *
 * @param {object} request - the gate inputs.
 * @param {boolean} request.carriesImage - whether any message contains an image block.
 * @param {readonly string[] | undefined} request.input - the model's declared input modalities.
 * @param {boolean} request.attachmentsAvailable - whether the attachment service resolved.
 * @param {string} request.modelId - the model id, for the diagnostic.
 * @returns {{ code: string, message: string } | undefined} the refusal, or `undefined` to proceed.
 */
export function imageRequestSupport({ carriesImage, input, attachmentsAvailable, modelId }) {
  if (carriesImage !== true) return undefined
  if (!Array.isArray(input) || !input.includes('image')) {
    return {
      code: 'UNSUPPORTED_CONTENT',
      message: `opencode-go-native: model "${modelId}" does not support image input`,
    }
  }
  if (attachmentsAvailable !== true) {
    return {
      code: 'UNSUPPORTED_CONTENT',
      message: 'opencode-go-native: image input requires the durable attachment service',
    }
  }
  return undefined
}

/**
 * Map a catalog cost record onto pi-ai's `ModelCost`.
 *
 * Both vocabularies are per-million-token rates. Rows the catalog omits stay 0,
 * which is what this plugin shipped before the snapshot existed.
 * @param {unknown} declared - `cost` from the catalog record.
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, tiers?: object[] }}
 */
export function mapCost(declared) {
  const rates = typeof declared === 'object' && declared !== null ? declared : {}
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const tiers = Array.isArray(rates.tiers)
    ? rates.tiers.flatMap((tier) => {
      const size = positiveInteger(tier?.tier?.size ?? tier?.inputTokensAbove)
      if (size === undefined) return []
      return [{
        inputTokensAbove: size,
        input: number(tier.input),
        output: number(tier.output),
        cacheRead: number(tier.cache_read ?? tier.cacheRead),
        cacheWrite: number(tier.cache_write ?? tier.cacheWrite),
      }]
    })
    : []
  return {
    input: number(rates.input),
    output: number(rates.output),
    cacheRead: number(rates.cache_read ?? rates.cacheRead),
    cacheWrite: number(rates.cache_write ?? rates.cacheWrite),
    ...tiers.length === 0 ? {} : { tiers },
  }
}

/**
 * The complete capability fact set for one model.
 *
 * `source` records where the numbers came from, which is what makes the
 * snapshot/endpoint mismatch rule auditable: `snapshot` means the versioned
 * catalog knew this id, `defaults` means the endpoint advertised a model the
 * snapshot has not caught up with and the conservative configuration defaults
 * are in force.
 *
 * @param {object | undefined} entry - the snapshot record, when one exists.
 * @param {{ defaultContextWindow: number, defaultMaxTokens: number }} defaults - conservative fallbacks.
 * @returns {object} capability facts (see the return of {@link mapReasoning}).
 */
export function modelCapabilities(entry, defaults) {
  return modelCapabilitiesWithOverrides(entry, defaults, [])
}

/**
 * The capability facts for one model with configuration overrides applied, in
 * precedence order (phase 4a).
 *
 * Endpoint and snapshot remain the sources of truth for what a model IS; the
 * layers here are the operator's corrections, and each one replaces exactly the
 * attributes it names — an untouched attribute keeps its discovered value. The
 * layers are applied lowest-precedence first, which is why the caller passes
 * `[extraDeclaration, overrideDeclaration]`.
 *
 * Two invariants this function exists to hold:
 *
 *   1. `input` a configuration names is NOT silently filtered. The runtime
 *      value is still clamped to what the host can carry, and a dropped
 *      modality is recorded in `droppedModalities`; `models.js` refuses an
 *      unrepresentable modality at validation time, so the clamp here is
 *      defence in depth rather than the user interface.
 *   2. `reasoning: false` (or an empty `reasoningEfforts`) means "this model
 *      does not reason", reported as pi-ai `reasoning: false` with NO level map.
 *      A boolean `reasoning: true` with no levels declared reuses the
 *      snapshot's levels instead of inventing any.
 *
 * @param {object | undefined} entry - the snapshot record, when one exists.
 * @param {{ defaultContextWindow: number, defaultMaxTokens: number }} defaults - conservative fallbacks.
 * @param {readonly object[]} [layers] - validated claim layers, lowest precedence first.
 * @returns {object} capability facts.
 */
export function modelCapabilitiesWithOverrides(entry, defaults, layers = []) {
  const base = buildCapabilities(entry, defaults)
  let contextWindow = base.contextWindow
  let maxTokens = base.maxTokens
  let input = base.input
  let droppedModalities = base.droppedModalities
  let facts = base
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue
    if (layer.contextWindow !== undefined) contextWindow = layer.contextWindow
    if (layer.maxTokens !== undefined) maxTokens = layer.maxTokens
    if (layer.input !== undefined) {
      const mapped = mapInputModalities(layer.input)
      input = mapped.input
      droppedModalities = mapped.dropped
    }
    if (layer.reasoning === false) {
      facts = { ...facts, reasoning: false, thinkingLevelMap: undefined }
    } else if (layer.reasoningEfforts !== undefined) {
      const levels = layer.reasoningEfforts
      facts = {
        ...facts,
        reasoning: levels.length > 0,
        thinkingLevelMap: levels.length === 0
          ? undefined
          : pinThinkingLevels(levels, base.thinkingLevelMap),
        // A configured level goes through the same `effortLevelOf` mapper the
        // snapshot path uses, so nothing here is unmappable.
        unmappedLevels: [],
      }
    } else if (layer.reasoning === true) {
      // "This model can be told to think", with no opinion about WHICH levels.
      // The snapshot's levels (or its `false`) stay exactly as discovered: an
      // operator must not be able to promote the levels the catalogue pinned to
      // `null` merely by asserting that the model reasons.
      facts = { ...facts, reasoning: facts.reasoning || Object.keys(facts.thinkingLevelMap ?? {}).length > 0 }
    }
  }
  return { ...facts, contextWindow, maxTokens, input, droppedModalities }
}

/** The un-overridden fact set, shared by both entry points. */
function buildCapabilities(entry, defaults) {
  const reasoning = mapReasoning(entry)
  const modalities = mapInputModalities(entry?.inputModalities)
  return {
    source: entry === undefined ? 'defaults' : 'snapshot',
    contextWindow: positiveInteger(entry?.contextWindow) ?? defaults.defaultContextWindow,
    maxTokens: positiveInteger(entry?.maxTokens) ?? defaults.defaultMaxTokens,
    input: modalities.input,
    droppedModalities: modalities.dropped,
    ...reasoning,
    cost: mapCost(entry?.cost),
  }
}

/**
 * Pin a host-level list into pi-ai's `thinkingLevelMap`.
 *
 * Every level the list does not name is pinned to `null` ("unsupported"), which
 * is the same convention {@link mapReasoning} uses for a catalogued model: an
 * absent key would count as supported for the five base levels and unsupported
 * for `xhigh`/`max`, an asymmetry an operator's explicit list must not inherit.
 * A level that appears in both the override and the snapshot keeps the
 * snapshot's wire spelling (so a `none`→`off` alias survives) and otherwise
 * sends the host level name itself.
 *
 * @param {readonly string[]} levels - validated host levels.
 * @param {Record<string, string | null> | undefined} declared - the snapshot's map, when any.
 * @returns {Record<string, string | null>} the pinned map.
 */
export function pinThinkingLevels(levels, declared) {
  const set = new Set(levels)
  return Object.fromEntries(HOST_THINKING_LEVELS.map((level) => [
    level,
    set.has(level) ? declared?.[level] ?? level : null,
  ]))
}

