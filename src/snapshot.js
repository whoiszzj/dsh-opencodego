/**
 * The plugin's model-state file: bundled data, read-only at runtime, NEVER
 * fetched.
 *
 * DESIGN.md §2.6 (revised at 0.6.5): the model truth is TWO layers — the
 * gateway's /models list and this file plus the settings overlay. The file was
 * seeded from models.dev (opencode's catalog) and `scripts/fetch-models-dev.mjs`
 * regenerates it only when an operator runs it on purpose.
 * The file keeps the upstream facts VERBATIM (raw modality lists, raw effort
 * spellings, raw npm package) and every interpretation lives in
 * `capabilities.js` / `protocol-map.js`, so a rule change needs no re-fetch.
 *
 * The file is optional: a missing or malformed snapshot disables prefill and
 * falls back to the conservative defaults instead of taking the route down.
 *
 * @module dsh-opencodego/snapshot
 */

import { readFileSync } from 'node:fs'

/** Where the committed snapshot lives, relative to this module (works from src/ and lib/). */
export const SNAPSHOT_URL = new URL('../data/opencode-go.models.json', import.meta.url)

/** Snapshot document kind, so a wrong file is detected rather than partly read. */
export const SNAPSHOT_KIND = 'dsh-opencodego/models-snapshot'

/** The provider key inside models.dev this plugin consumes. */
export const SNAPSHOT_PROVIDER = 'opencode-go'

/** Keep a string, or nothing. */
function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Keep a positive integer, or nothing. */
function optionalInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Keep a list of strings, or nothing. */
function optionalStringList(value) {
  const listed = Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.length > 0) : []
  return listed.length === 0 ? undefined : listed
}

/**
 * Reduce one catalog record to the facts this plugin uses.
 *
 * Reads BOTH vocabularies on purpose: the upstream models.dev spelling
 * (`limit.context`, `modalities.input`, `interleaved.field`,
 * `reasoning_options`, `provider.npm`) and this plugin's own snapshot spelling
 * (`contextWindow`, `inputModalities`, `interleavedField`, `reasoningOptions`,
 * `npm`). That makes the function idempotent — `trim(trim(record))` equals
 * `trim(record)` — which is what lets the fetch script and the runtime loader
 * share one implementation instead of drifting apart. `tests/snapshot.test.mjs`
 * pins that property.
 *
 * Everything is optional: an upstream record that omits a fact simply leaves
 * the default in force.
 *
 * @param {object} raw - one `models.dev` model record, or one snapshot record.
 * @returns {object | undefined} the trimmed record, or `undefined` when unusable.
 */
export function trimModelRecord(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const limit = typeof raw.limit === 'object' && raw.limit !== null ? raw.limit : {}
  const modalities = typeof raw.modalities === 'object' && raw.modalities !== null ? raw.modalities : {}
  const interleaved = typeof raw.interleaved === 'object' && raw.interleaved !== null ? raw.interleaved : {}
  const provider = typeof raw.provider === 'object' && raw.provider !== null ? raw.provider : {}
  const npm = optionalString(raw.npm) ?? optionalString(provider.npm)
  const input = optionalStringList(raw.inputModalities) ?? optionalStringList(modalities.input) ?? []
  const reasoningOptions = Array.isArray(raw.reasoningOptions)
    ? raw.reasoningOptions
    : Array.isArray(raw.reasoning_options) ? raw.reasoning_options : []
  const cost = typeof raw.cost === 'object' && raw.cost !== null
    ? raw.cost
    : typeof raw.pricing === 'object' && raw.pricing !== null ? raw.pricing : undefined
  const record = {
    ...optionalString(raw.name) === undefined ? {} : { name: raw.name },
    // `npm` is omitted when the model inherits the provider package, which is a
    // fact distinct from "the snapshot does not know this model".
    ...npm === undefined ? {} : { npm },
    ...raw.reasoning === true ? { reasoning: true } : {},
    ...reasoningOptions.length === 0 ? {} : { reasoningOptions },
    ...(optionalString(raw.interleavedField) ?? optionalString(interleaved.field)) === undefined
      ? {}
      : { interleavedField: raw.interleavedField ?? interleaved.field },
    ...input.length === 0 ? {} : { inputModalities: input },
    ...(optionalInteger(raw.contextWindow) ?? optionalInteger(limit.context)) === undefined
      ? {}
      : { contextWindow: raw.contextWindow ?? limit.context },
    ...(optionalInteger(raw.maxTokens) ?? optionalInteger(limit.output)) === undefined
      ? {}
      : { maxTokens: raw.maxTokens ?? limit.output },
    ...cost === undefined ? {} : { cost },
    ...(optionalString(raw.catalogStatus) ?? optionalString(raw.status)) === undefined
      ? {}
      : { catalogStatus: raw.catalogStatus ?? raw.status },
  }
  return Object.keys(record).length === 0 ? undefined : record
}

/**
 * Parse and validate a snapshot document.
 * @param {string} text - the file's contents.
 * @returns {{ ok: true, snapshot: ModelSnapshot } | { ok: false, error: string }} the outcome.
 */
export function parseSnapshot(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `snapshot is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ok: false, error: 'snapshot root must be an object' }
  }
  if (document.kind !== SNAPSHOT_KIND) {
    return { ok: false, error: `snapshot kind is "${String(document.kind)}", expected "${SNAPSHOT_KIND}"` }
  }
  if (document.provider !== SNAPSHOT_PROVIDER) {
    return { ok: false, error: `snapshot provider is "${String(document.provider)}", expected "${SNAPSHOT_PROVIDER}"` }
  }
  if (typeof document.models !== 'object' || document.models === null || Array.isArray(document.models)) {
    return { ok: false, error: 'snapshot "models" must be an object keyed by model id' }
  }
  const models = {}
  for (const [id, raw] of Object.entries(document.models)) {
    if (typeof id !== 'string' || id.length === 0) continue
    const trimmed = trimModelRecord(raw)
    if (trimmed === undefined) continue
    models[id] = trimmed
  }
  return {
    ok: true,
    snapshot: new ModelSnapshot({ ...document, models }),
  }
}

/** An indexed, read-only view of one snapshot document. */
export class ModelSnapshot {
  /**
   * @param {object} document - a parsed snapshot document.
   */
  constructor(document) {
    /** @type {Readonly<Record<string, object>>} */
    this.models = Object.freeze(document.models ?? {})
    this.version = document.version
    this.source = document.source
    this.fetchedAt = document.fetchedAt
    this.providerNpm = document.providerNpm
    this.providerApi = document.providerApi
  }

  /** Number of catalogued models. */
  get size() {
    return Object.keys(this.models).length
  }

  /** Every catalogued model id. */
  ids() {
    return Object.keys(this.models)
  }

  /** One raw (trimmed) record, or `undefined` when this snapshot does not know the id. */
  entryFor(modelId) {
    return this.models[modelId]
  }

  /**
   * The `provider.npm` fact for one model: a string when the catalog overrides
   * the provider package, `null` when the model is catalogued but inherits it,
   * and `undefined` when the snapshot does not know the model at all. Protocol
   * resolution needs that three-way distinction.
   * @param {string} modelId - the gateway model id.
   * @returns {string | null | undefined} the fact.
   */
  npmFor(modelId) {
    const entry = this.models[modelId]
    if (entry === undefined) return undefined
    return entry.npm ?? null
  }

  /** The catalogued display name, when one was published. */
  nameFor(modelId) {
    return this.models[modelId]?.name
  }

  /**
   * Catalogued ids the endpoint did not advertise. The endpoint is the source of
   * truth for what exists (DESIGN.md §2.5), so these are diagnostics only —
   * they are never enabled.
   * @param {Iterable<string>} endpointIds - ids the endpoint advertised.
   * @returns {string[]} snapshot-only ids, sorted.
   */
  snapshotOnlyIds(endpointIds) {
    const advertised = new Set(endpointIds)
    return this.ids().filter((id) => !advertised.has(id)).sort()
  }

  /** Endpoint ids absent from the snapshot — the models running on defaults. */
  unknownIds(endpointIds) {
    return [...endpointIds].filter((id) => this.models[id] === undefined).sort()
  }
}

/**
 * Load the committed snapshot from disk.
 *
 * Never throws: prefill is an enhancement, and a broken data file must not cost
 * the operator the whole route.
 * @param {URL} [url] - the snapshot location (a seam for tests).
 * @returns {{ ok: true, snapshot: ModelSnapshot } | { ok: false, error: string }} the outcome.
 */
export function loadSnapshot(url = SNAPSHOT_URL) {
  let text
  try {
    text = readFileSync(url, 'utf8')
  } catch (error) {
    return { ok: false, error: `cannot read snapshot at ${String(url)} (${error instanceof Error ? error.message : String(error)})` }
  }
  return parseSnapshot(text)
}
