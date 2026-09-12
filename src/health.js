/**
 * Endpoint health: what this gateway said about a model, in a form the operator
 * can act on.
 *
 * DESIGN.md §2.5: the endpoint's `/models` listing discloses no capability or
 * availability metadata, yet the listing mixes in models this account or this
 * machine cannot use at all — a Region gate, a data-policy gate, a country
 * block. That fact has to live somewhere. It lives HERE, beside the adapter,
 * as plugin-owned diagnostics: the harness's own model-information structures
 * are not guessed at, and the model list keeps only the fields the host
 * genuinely defines (provider / id / name / inputModalities).
 *
 * Categories are named after the endpoint's own error types where one exists
 * (`RegionError`, `DataPolicyError`) so a reader can match them to the wire.
 *
 * @module dsh-opencodego/health
 */

import { failureText, httpStatusOf, protocolFailureKind } from './protocol-chain.js'

/** Stable health categories. */
export const ENDPOINT_HEALTH = Object.freeze({
  OK: 'ok',
  /** `RegionError` for a China-hosted model — the workspace opt-in fixes it. */
  REGION: 'region',
  /** `DataPolicyError` — the model needs explicit data-policy consent. */
  DATA_POLICY: 'data-policy',
  /** `RegionError` / `unsupported_country_region_territory` — no local fix. */
  COUNTRY_BLOCK: 'country-block',
  /** The relay refuses this protocol format for this model. */
  FORMAT_UNSUPPORTED: 'format-unsupported',
  /** The relay serves no such protocol path (its web app's HTML 404). */
  PROTOCOL_PATH_MISSING: 'protocol-path-missing',
  /** The model is not (currently) served: unavailable / not supported. */
  MODEL_UNAVAILABLE: 'model-unavailable',
  /** Upstream or relay-side failure, worth retrying later. */
  UPSTREAM: 'upstream',
  /** Credential rejected. */
  AUTH: 'auth',
  /** The request itself was refused by validation. */
  BAD_REQUEST: 'bad-request',
  /** Anything unrecognized. */
  UNKNOWN: 'unknown',
})

/**
 * What the operator can do about a category, when anything can be done.
 * `undefined` means "nothing to do — retry, or pick another model".
 * @type {Readonly<Record<string, string | undefined>>}
 */
export const HEALTH_ACTION = Object.freeze({
  [ENDPOINT_HEALTH.REGION]: 'Enable the model explicitly in your OpenCode (opencode.ai) workspace: its latest version is hosted in China only and requires explicit opt-in.',
  [ENDPOINT_HEALTH.DATA_POLICY]: 'Accept the model\'s data-use policy in your OpenCode (opencode.ai) workspace; the endpoint answers 403 DataPolicyError until then.',
  [ENDPOINT_HEALTH.COUNTRY_BLOCK]: 'Nothing local can fix this: the endpoint reports the model as unsupported in this country/region.',
  [ENDPOINT_HEALTH.MODEL_UNAVAILABLE]: 'The gateway currently marks this model unavailable; pick another model until it returns.',
})

/**
 * Classify one failure into a health category plus the operator action.
 * @param {unknown} failure - any failure shape (Error, `{ message, code }`, string).
 * @returns {{ category: string, status: number | undefined, kind: string, action: string | undefined, message: string }}
 */
export function classifyEndpointHealth(failure) {
  const text = failureText(failure)
  const status = httpStatusOf(failure)
  const kind = protocolFailureKind(failure)
  const category = (() => {
    if (text.length === 0) return ENDPOINT_HEALTH.UNKNOWN
    if (/DataPolicyError|collects data used to improve its quality/iu.test(text)) return ENDPOINT_HEALTH.DATA_POLICY
    // `RegionError` covers two different situations and the ACTION differs, so
    // the wording decides: a China-hosted model can be opted into from the
    // workspace, a country block cannot be fixed locally at all.
    if (/hosted in China|requires explicit opt[- ]?in/iu.test(text)) return ENDPOINT_HEALTH.REGION
    if (/RegionError|unsupported_country_region_territory|Country, region, or territory not supported|not available in your country/iu.test(text)) {
      return ENDPOINT_HEALTH.COUNTRY_BLOCK
    }
    if (/not supported for format|format oa-compat/iu.test(text)) return ENDPOINT_HEALTH.FORMAT_UNSUPPORTED
    if (status === 404 && /<!doctype html|<html/iu.test(text)) return ENDPOINT_HEALTH.PROTOCOL_PATH_MISSING
    if (/Model is unavailable|is not supported/iu.test(text)) return ENDPOINT_HEALTH.MODEL_UNAVAILABLE
    if (status !== undefined && status >= 500) return ENDPOINT_HEALTH.UPSTREAM
    if (/upstream request failed|internal server error|overloaded|service unavailable/iu.test(text)) return ENDPOINT_HEALTH.UPSTREAM
    if (status === 401) return ENDPOINT_HEALTH.AUTH
    if (status === 400 || status === 422) return ENDPOINT_HEALTH.BAD_REQUEST
    return ENDPOINT_HEALTH.UNKNOWN
  })()
  return { category, status, kind, action: HEALTH_ACTION[category], message: text }
}

/**
 * A bounded record of what this route learned about each model.
 *
 * Deliberately in-memory and per-process: it describes THIS machine's reach at
 * THIS moment (a country block is a property of the deployment, not of the
 * model), and it is regenerated by simply using the route.
 */
export class EndpointHealthLog {
  /**
   * @param {object} [options] - the log.
   * @param {number} [options.maxPerModel] - most recent entries kept per model (default 4).
   * @param {() => number} [options.now] - clock seam for tests.
   */
  constructor(options = {}) {
    this.maxPerModel = Number.isSafeInteger(options.maxPerModel) && options.maxPerModel > 0 ? options.maxPerModel : 4
    this.now = typeof options.now === 'function' ? options.now : Date.now
    /** @type {Map<string, object[]>} */
    this.records = new Map()
  }

  /**
   * Record one observed failure (or success) for a model on one protocol.
   * @param {string} modelId - the gateway model id.
   * @param {string} protocol - the protocol that was attempted.
   * @param {unknown} failure - the failure; `undefined` records a success.
   * @returns {object} the record that was stored.
   */
  record(modelId, protocol, failure) {
    const classification = failure === undefined
      ? { category: ENDPOINT_HEALTH.OK, status: undefined, kind: 'ok', action: undefined, message: '' }
      : classifyEndpointHealth(failure)
    const entry = { at: this.now(), protocol, ...classification }
    const existing = this.records.get(modelId) ?? []
    const kept = [...existing, entry].slice(-this.maxPerModel)
    this.records.set(modelId, kept)
    return entry
  }

  /** The most recent record for one model, if any. */
  latest(modelId) {
    const entries = this.records.get(modelId)
    return entries === undefined || entries.length === 0 ? undefined : entries[entries.length - 1]
  }

  /** Every recorded model with its latest record and, for an unusable one, the action. */
  snapshot() {
    return [...this.records.entries()].map(([modelId, entries]) => ({
      modelId,
      latest: entries[entries.length - 1],
      history: entries,
    }))
  }

  /**
   * The models currently recorded as unusable by something other than a
   * transient upstream problem — the list an operator should read as "the
   * endpoint advertises these, but they cannot be used from here".
   */
  unusable() {
    return this.snapshot().filter(({ latest }) => (
      latest.category !== ENDPOINT_HEALTH.OK
      && latest.category !== ENDPOINT_HEALTH.UPSTREAM
      && latest.category !== ENDPOINT_HEALTH.UNKNOWN
    ))
  }

  /** One log line per unusable model, for the `debug` startup/summary path. */
  summaryLines() {
    return this.unusable().map(({ modelId, latest }) => (
      `${modelId}: ${latest.category}${latest.status === undefined ? '' : ` (HTTP ${latest.status})`}`
      + `${latest.action === undefined ? '' : ` — ${latest.action}`}`
    ))
  }

  /** Forget everything. */
  clear() {
    this.records.clear()
  }
}
