/**
 * The user-facing model SET: endpoint discovery as one input, configuration as
 * an ADDITIVE layer over it (phase 4a).
 *
 * DESIGN.md §2.5 makes the endpoint the source of truth for *which* models
 * exist. That rule does not mean the operator may not have an opinion; it means
 * configuration must not be able to freeze the catalogue. So the model set in
 * effect is
 *
 * ```text
 *   { ids the endpoint advertises } ∪ { ids declared in models.extra }
 *   \ { ids listed in models.disabled }
 * ```
 *
 * and a model the endpoint starts advertising tomorrow is therefore available
 * with no configuration change at all. The one thing that DOES freeze the set is
 * `models.replaceDiscovered: true`, which exists only so an operator who truly
 * wants a hand-written list can say so out loud — its name is the warning.
 *
 * Attribute precedence for one model, lowest first:
 *
 * ```text
 *   conservative connection defaults (`defaultContextWindow` / `defaultMaxTokens`)
 *     ← the models.dev snapshot record, when the id is catalogued
 *       ← an `extra` declaration, when the id has one
 *         ← `models.overrides[id]`  (and its legacy alias `protocolOverrides`)
 * ```
 *
 * Every function here is host-free on purpose: `node --test` — no profile
 * install — exercises the overlay semantics and every rejection message
 * (`tests/models.test.mjs`), because `config.js` builds its schemastery schema
 * from the SAME primitives, so the form a settings page renders and the judge
 * that runs at request time cannot disagree.
 *
 * @module dsh-opencodego/models
 */

import { HOST_THINKING_LEVELS, PKG, SUPPORTED_PROTOCOLS } from './vocab.js'

/**
 * The `input` spellings a configuration may name.
 *
 * Deliberately only the modalities the harness message content can carry
 * (DESIGN.md §2.11): a configured `video`/`pdf`/`audio` would declare a
 * capability the request path cannot express, so it is refused **by name**
 * rather than silently filtered out of the operator's own configuration.
 */
export const CONFIGURABLE_INPUT_MODALITIES = Object.freeze(['text', 'image'])

/**
 * Keys accepted in `models.extra[]`. `id` is the one key an override cannot
 * have (the override is keyed by it), and `name` is the one attribute only an
 * `extra` entry may set: renaming a model the endpoint itself names is not a
 * correction, it is a lie, and the endpoint's name is what the model picker
 * shows.
 */
export const MODEL_EXTRA_KEYS = Object.freeze([
  'id',
  'name',
  'api',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoning',
  'reasoningEfforts',
])

/** Keys accepted in `models.overrides[id]`. */
export const MODEL_OVERRIDE_KEYS = Object.freeze(MODEL_EXTRA_KEYS.filter((key) => key !== 'id' && key !== 'name'))

/** The `models` block's own keys. */
export const MODEL_SET_KEYS = Object.freeze(['disabled', 'extra', 'overrides', 'replaceDiscovered'])

/** Host thinking levels minus `off`, the only efforts a configuration may name. */
export const CONFIGURABLE_THINKING_LEVELS = Object.freeze(
  HOST_THINKING_LEVELS.filter((level) => level !== 'off'),
)

/**
 * A non-empty model id, or the caller's field-named error.
 * @param {unknown} value - the raw id.
 * @param {string} where - the config path to name in the error.
 * @returns {string} the trimmed id.
 */
export function requireModelId(value, where) {
  if (typeof value !== 'string') {
    throw new Error(`${PKG}: ${where} must be a model id string (got: ${describe(value)})`)
  }
  const id = value.trim()
  if (id.length === 0) {
    throw new Error(`${PKG}: ${where} must be a non-empty model id (got: ${describe(value)})`)
  }
  return id
}

/**
 * The error text of a failed fetch, with the actionable `cause` chain Node hides
 * behind its bare `TypeError: fetch failed`.
 *
 * It lives here, in the host-free half, because BOTH host-importing modules that
 * talk to the gateway need it (`catalog.js` for its refresh, `discovery.js` for
 * a draft) and neither should keep its own copy: a transport diagnosis that
 * differs between the two paths is a bug report waiting to happen.
 * @param {unknown} error - the thrown value.
 * @returns {string} a one-line diagnosis.
 */
export function describeTransportError(error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (cause instanceof Error && cause.message.length > 0) return `${error.message}: ${cause.message}`
  return error.message
}

/** A one-line rendering of an arbitrary configured value, for an error message. */
export function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of ${value.length}`
  if (typeof value === 'object') return 'an object'
  return String(value)
}

/**
 * A positive integer, or the caller's field-named error.
 * @param {unknown} value - the raw value.
 * @param {string} where - the config path to name in the error.
 * @returns {number} the validated value.
 */
export function requirePositiveInteger(value, where) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${PKG}: ${where} must be a positive integer (got: ${describe(value)})`)
  }
  return value
}

/**
 * Validate a protocol name against what this build can dispatch.
 * @param {unknown} value - the raw value.
 * @param {string} where - the config path to name in the error.
 * @returns {string} the protocol.
 */
export function requireProtocol(value, where) {
  if (typeof value !== 'string' || !SUPPORTED_PROTOCOLS.includes(value)) {
    throw new Error(
      `${PKG}: ${where} must be one of ${SUPPORTED_PROTOCOLS.join(', ')} (got: ${describe(value)})`,
    )
  }
  return value
}

/**
 * Validate an input-modality list: a non-empty array of distinct
 * {@link CONFIGURABLE_INPUT_MODALITIES} entries.
 * @param {unknown} value - the raw value.
 * @param {string} where - the config path to name in the error.
 * @returns {string[]} the validated modalities, in the configured order.
 */
export function requireInputModalities(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${PKG}: ${where} must be a non-empty array of ${CONFIGURABLE_INPUT_MODALITIES.join('/')} `
      + `(got: ${describe(value)})`,
    )
  }
  const seen = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !CONFIGURABLE_INPUT_MODALITIES.includes(entry)) {
      throw new Error(
        `${PKG}: ${where}[${index}] must be one of ${CONFIGURABLE_INPUT_MODALITIES.join(', ')} `
        + `(got: ${describe(entry)}); the harness message content can only carry text and image blocks, `
        + 'so a wider modality would declare a capability the request path cannot express',
      )
    }
    if (seen.includes(entry)) {
      throw new Error(`${PKG}: ${where}[${index}] repeats "${entry}"; list each modality once`)
    }
    seen.push(entry)
  }
  return seen
}

/**
 * Validate a reasoning-effort list against the host's vocabulary.
 *
 * `off` is refused by name rather than accepted: pi-ai expresses "do not reason"
 * by omitting the reasoning option, so `off` is not a selectable effort on the
 * wire (DESIGN.md §2.11) — accepting it would create a control that cannot
 * change a request.
 * @param {unknown} value - the raw value.
 * @param {string} where - the config path to name in the error.
 * @returns {string[]} the validated levels.
 */
export function requireReasoningEfforts(value, where) {
  if (!Array.isArray(value)) {
    throw new Error(
      `${PKG}: ${where} must be an array of host thinking levels `
      + `(${CONFIGURABLE_THINKING_LEVELS.join(', ')}); got: ${describe(value)}`,
    )
  }
  const levels = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      throw new Error(`${PKG}: ${where}[${index}] must be a thinking level string (got: ${describe(entry)})`)
    }
    if (entry === 'off') {
      throw new Error(
        `${PKG}: ${where}[${index}] must not be "off": pi-ai expresses "do not reason" by omitting the `
        + 'reasoning option, so `off` is not a selectable effort. Drop the entry to leave the provider default, '
        + 'or set `reasoning: false` to declare the model does not reason at all.',
      )
    }
    if (!CONFIGURABLE_THINKING_LEVELS.includes(entry)) {
      throw new Error(
        `${PKG}: ${where}[${index}] "${entry}" is not a host thinking level; `
        + `expected one of ${CONFIGURABLE_THINKING_LEVELS.join(', ')}`,
      )
    }
    if (levels.includes(entry)) {
      throw new Error(`${PKG}: ${where}[${index}] repeats "${entry}"; list each effort once`)
    }
    levels.push(entry)
  }
  return levels
}

/**
 * Validate the attribute vocabulary shared by an `extra` entry and an override.
 *
 * Both shapes accept the same attributes on purpose: the only difference between
 * "declare a model that is missing" and "correct a model that exists" is which
 * side of the endpoint they default to, and a reader should not have to learn
 * two vocabularies to do either.
 *
 * @param {object} raw - the configured entry.
 * @param {string} where - the config path to name in errors.
 * @param {{ allowName: boolean }} options - shape switches.
 * @returns {{ name?: string, claims: object }} the detached claims.
 */
function normalizeDeclaration(raw, where, options) {
  /** @type {Record<string, unknown>} */
  const claims = {}
  let name
  if (options.allowName && raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      throw new Error(`${PKG}: ${where}.name must be a non-empty string (got: ${describe(raw.name)})`)
    }
    name = raw.name.trim()
  }
  if (raw.api !== undefined) claims.api = requireProtocol(raw.api, `${where}.api`)
  if (raw.contextWindow !== undefined) {
    claims.contextWindow = requirePositiveInteger(raw.contextWindow, `${where}.contextWindow`)
  }
  if (raw.maxTokens !== undefined) {
    claims.maxTokens = requirePositiveInteger(raw.maxTokens, `${where}.maxTokens`)
  }
  if (raw.input !== undefined) claims.input = requireInputModalities(raw.input, `${where}.input`)
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== 'boolean') {
      throw new Error(`${PKG}: ${where}.reasoning must be a boolean (got: ${describe(raw.reasoning)})`)
    }
    claims.reasoning = raw.reasoning
  }
  if (raw.reasoningEfforts !== undefined) {
    claims.reasoningEfforts = requireReasoningEfforts(raw.reasoningEfforts, `${where}.reasoningEfforts`)
  }
  return { ...name === undefined ? {} : { name }, claims }
}

/** Reject any key the shape does not define, naming the offending key and the alternatives. */
function assertKnownKeys(raw, where, allowed) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new Error(`${PKG}: ${where} has unknown key "${key}"; supported keys are ${allowed.join(', ')}`)
    }
  }
}

/**
 * Validate and detach one `extra` entry.
 * @param {unknown} raw - the configured entry.
 * @param {number} index - its position, for the error path.
 * @returns {{ id: string, declaration: { name?: string, claims: object } }} the entry.
 */
export function normalizeExtraEntry(raw, index) {
  const where = `models.extra[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${PKG}: ${where} must be an object with at least an "id" (got: ${describe(raw)})`)
  }
  assertKnownKeys(raw, where, MODEL_EXTRA_KEYS)
  const id = requireModelId(raw.id, `${where}.id`)
  // A bare `{ id }` is legal and useful — it enables an id the endpoint does not
  // advertise with the snapshot's attributes, or the conservative defaults.
  return { id, declaration: normalizeDeclaration(raw, `models.extra["${id}"]`, { allowName: true }) }
}

/**
 * Validate and detach one `models.overrides[id]` entry.
 * @param {unknown} raw - the configured entry.
 * @param {string} id - the model id the entry is keyed by.
 * @returns {object} the attribute claims.
 */
export function normalizeOverrideEntry(raw, id) {
  const where = `models.overrides["${id}"]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${PKG}: ${where} must be an object of attribute overrides (got: ${describe(raw)})`)
  }
  assertKnownKeys(raw, where, MODEL_OVERRIDE_KEYS)
  const { claims } = normalizeDeclaration(raw, where, { allowName: false })
  if (Object.keys(claims).length === 0) {
    throw new Error(
      `${PKG}: ${where} sets nothing; remove the entry, or name one of ${MODEL_OVERRIDE_KEYS.join(', ')}`,
    )
  }
  return claims
}

/**
 * Normalize the whole `models` block, plus the legacy `protocolOverrides`
 * alias, into the overlay the runtime consumes.
 *
 * The alias is kept working and kept **second** to the newer address: an
 * operator's phase-2 pin is still the chain head, and `models.overrides[id].api`
 * wins when both name the same model. Which entries were applied and which were
 * shadowed is reported on the result, so a surface can show a dead alias instead
 * of leaving the operator to guess why the pin did not move.
 *
 * @param {object} [config] - the raw configuration (or a resolved settings section).
 * @returns {object} the validated, frozen overlay.
 */
export function normalizeModelOverlay(config = {}) {
  const raw = config?.models
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error(
      `${PKG}: models must be an object with ${MODEL_SET_KEYS.join('/')} (got: ${describe(raw)})`,
    )
  }
  const block = raw ?? {}
  assertKnownKeys(block, 'models', MODEL_SET_KEYS)

  // disabled ---------------------------------------------------------------
  const disabledSource = block.disabled ?? []
  if (!Array.isArray(disabledSource)) {
    throw new Error(`${PKG}: models.disabled must be an array of model ids (got: ${describe(disabledSource)})`)
  }
  const disabled = []
  for (const [index, entry] of disabledSource.entries()) {
    const id = requireModelId(entry, `models.disabled[${index}]`)
    if (disabled.includes(id)) throw new Error(`${PKG}: models.disabled[${index}] repeats "${id}"`)
    disabled.push(id)
  }

  // extra ------------------------------------------------------------------
  const extraSource = block.extra ?? []
  if (!Array.isArray(extraSource)) {
    throw new Error(`${PKG}: models.extra must be an array of { id, … } entries (got: ${describe(extraSource)})`)
  }
  /** @type {Record<string, object>} */
  const extra = {}
  for (const [index, entry] of extraSource.entries()) {
    const { id, declaration } = normalizeExtraEntry(entry, index)
    if (Object.hasOwn(extra, id)) {
      throw new Error(`${PKG}: models.extra[${index}] repeats the model id "${id}"; merge the two entries into one`)
    }
    if (disabled.includes(id)) {
      throw new Error(
        `${PKG}: model "${id}" appears in both models.extra and models.disabled; `
        + 'remove it from one of them (extra adds a model, disabled removes one)',
      )
    }
    extra[id] = Object.freeze(declaration)
  }

  // overrides --------------------------------------------------------------
  const overridesSource = block.overrides ?? {}
  if (typeof overridesSource !== 'object' || overridesSource === null || Array.isArray(overridesSource)) {
    throw new Error(`${PKG}: models.overrides must be an object keyed by model id (got: ${describe(overridesSource)})`)
  }
  /** @type {Record<string, object>} */
  const overrides = {}
  for (const [rawId, entry] of Object.entries(overridesSource)) {
    const id = requireModelId(rawId, 'models.overrides (as a key)')
    if (disabled.includes(id)) {
      throw new Error(
        `${PKG}: model "${id}" is in models.disabled and also has a models.overrides entry; `
        + 'a disabled model is never served, so that override would be dead configuration',
      )
    }
    overrides[id] = Object.freeze(normalizeOverrideEntry(entry, id))
  }

  // the legacy alias -------------------------------------------------------
  const alias = config?.protocolOverrides ?? {}
  if (typeof alias !== 'object' || alias === null || Array.isArray(alias)) {
    throw new Error(`${PKG}: protocolOverrides must be an object keyed by model id (got: ${describe(alias)})`)
  }
  const applied = []
  const shadowed = []
  for (const [rawId, protocol] of Object.entries(alias)) {
    const id = requireModelId(rawId, 'protocolOverrides (as a key)')
    const validated = requireProtocol(protocol, `protocolOverrides["${id}"]`)
    if (overrides[id]?.api !== undefined) {
      // `models.overrides[id].api` is the same fact at a more specific address;
      // report the shadowed alias rather than silently dropping it.
      shadowed.push(id)
      continue
    }
    overrides[id] = Object.freeze({ ...overrides[id], api: validated })
    applied.push(id)
  }

  const replaceDiscovered = block.replaceDiscovered
  if (replaceDiscovered !== undefined && typeof replaceDiscovered !== 'boolean') {
    throw new Error(`${PKG}: models.replaceDiscovered must be a boolean (got: ${describe(replaceDiscovered)})`)
  }

  return Object.freeze({
    disabled: Object.freeze(disabled),
    extra: Object.freeze(extra),
    overrides: Object.freeze(overrides),
    replaceDiscovered: replaceDiscovered === true,
    /** Transport-level facts for `protocolOverrides`, kept for compatibility. */
    protocolOverridesApplied: Object.freeze(applied),
    protocolOverridesShadowed: Object.freeze(shadowed),
  })
}

/** The overlay with nothing configured, for a caller that has no configuration. */
export const EMPTY_OVERLAY = normalizeModelOverlay({})

/**
 * The ids this route serves: the discovered set, plus configured extras, minus
 * configured exclusions.
 *
 * `replaceDiscovered` is the one deliberate exception (see the module header):
 * with it on, the base is exactly the configured extra ids.
 *
 * @param {readonly string[]} discovered - ids the endpoint advertised, in its order.
 * @param {object} overlay - a normalized overlay.
 * @returns {string[]} the effective ids: discovered order first, then extras.
 */
export function effectiveModelIds(discovered, overlay) {
  const disabled = new Set(overlay.disabled)
  const base = overlay.replaceDiscovered === true ? [] : discovered
  const out = []
  const seen = new Set()
  for (const id of [...base, ...Object.keys(overlay.extra)]) {
    if (disabled.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Where one currently-served model came from, so a diagnostics surface can label
 * a row without guessing.
 * @param {string} id - the model id.
 * @param {Set<string> | readonly string[]} discovered - the advertised ids.
 * @param {object} overlay - a normalized overlay.
 * @returns {'endpoint' | 'extra' | 'endpoint+extra'} the provenance.
 */
export function modelSource(id, discovered, overlay) {
  const fromEndpoint = discovered instanceof Set ? discovered.has(id) : discovered.includes(id)
  const fromExtra = Object.hasOwn(overlay.extra, id)
  if (fromEndpoint && fromExtra) return 'endpoint+extra'
  if (fromExtra) return 'extra'
  return 'endpoint'
}

/**
 * The claim layers for one model, lowest precedence first.
 *
 * An `extra` declaration is a claim like an override — it is simply applied
 * first, so a correction keyed at `models.overrides[id]` wins, which is what an
 * operator addressing one exact model would expect. `name` is deliberately not
 * in a layer: naming is the catalogue's business (`catalog.js`), not a
 * capability, and a layer carrying a field no consumer reads is a trap for the
 * next reader.
 * @param {object} overlay - a normalized overlay.
 * @param {string} id - the model id.
 * @returns {object[]} the layers to apply, in order.
 */
export function claimLayersFor(overlay, id) {
  const layers = []
  if (overlay.extra[id] !== undefined) layers.push(overlay.extra[id].claims)
  if (overlay.overrides[id] !== undefined) layers.push(overlay.overrides[id])
  return layers
}
