/**
 * Lazy, failure-tolerant model catalog for one gateway base.
 *
 * The model SET comes from `GET {baseURL}/models` (DESIGN.md §2.5: the endpoint
 * discloses ids and nothing else). Discovery is deliberately forgiving of the
 * ENDPOINT: a failed refresh never empties the list — the last successful
 * snapshot keeps serving and the failure is reported through `diagnostics` and
 * the host logger. Only a cold start with no snapshot at all yields an empty
 * list, which is still a *serving* route (the harness treats a catalog as
 * advisory).
 *
 * The one failure that is NOT tolerated is a credential misconfiguration: no
 * retry fixes it, it breaks every request on the route, and hiding it behind a
 * still-present model list is how a run-time-ignored setting survives
 * unnoticed. `MISSING_CREDENTIAL` therefore propagates out of `refresh()` (see
 * the catch in `refresh`).
 *
 * The catalog's second job (phase 2) is the endpoint/snapshot reconciliation
 * the audit asked for:
 *
 *   - an id the endpoint advertises and the snapshot does not know runs on the
 *     conservative configuration defaults plus the bootstrap protocol table
 *     (`snapshotEntryFor` returns `undefined`);
 *   - an id the snapshot catalogues but the endpoint does not advertise is NOT
 *     enabled — the endpoint is the source of truth for what exists — and is
 *     reported through `snapshotOnly()` for diagnostics.
 *
 * @module dsh-opencodego/catalog
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { describeTransportError, effectiveModelIds } from './models.js'
import { mergeSyncedEntry } from './synced.js'

// Kept exported from here as well: this module was its historical home, and a
// consumer outside this repository may import it from the catalog. One
// implementation, two doors.
export { describeTransportError }

/**
 * Diagnostic counters recorded by one catalog's refresh operations.
 * @typedef {object} CatalogDiagnostics
 * @property {number} successes
 * @property {number} failures
 * @property {number} consecutiveFailures
 * @property {string | undefined} lastError
 * @property {number | undefined} lastSuccessAt
 * @property {number | undefined} lastAttemptAt
 * @property {'cold' | 'fresh' | 'stale' | 'failed-cold'} status
 * @property {string[]} snapshotOnly - catalogued ids this endpoint does not advertise.
 * @property {string[]} unknownModels - advertised ids this snapshot does not know.
 */

/**
 * One model entry the gateway advertised.
 * @typedef {object} CatalogModel
 * @property {string} id
 * @property {string} name
 */

export class ModelCatalog {
  /**
   * @param {object} hooks - injected platform seams.
   * @param {() => { baseURL: string, apiKeyEnv: string, syncTtlMs: number, debug: boolean, snapshotEnabled: boolean }} hooks.options
   *   Current connection facts, re-read at each operation.
   * @param {() => Promise<string>} hooks.resolveApiKey - Current bearer token.
   * @param {import('./snapshot.js').ModelSnapshot | undefined} [hooks.snapshot] - the versioned models.dev view.
   * @param {(level: 'info' | 'warn' | 'error', message: string) => void} hooks.log
   */
  constructor(hooks) {
    this.hooks = hooks
    /** @type {readonly CatalogModel[] | undefined} */
    this.catalog = undefined
    /** @type {CatalogDiagnostics} */
    this.diagnostics = {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastError: undefined,
      lastSuccessAt: undefined,
      lastAttemptAt: undefined,
      status: 'cold',
      snapshotOnly: [],
      unknownModels: [],
    }
    /** @type {Promise<readonly CatalogModel[]> | undefined} */
    this.inFlight = undefined
    this.generation = 0
    /**
     * The endpoint target (`baseURL` + `apiKeyEnv`) the cached catalogue is
     * about. Part of the freshness decision: a settings change that moves the
     * target invalidates the cache even while the TTL is still running.
     * @type {string | undefined}
     */
    this.targetKey = undefined
  }

  /** The last successfully discovered models; empty while none has succeeded. */
  models() {
    return this.catalog ?? []
  }

  /** The endpoint's own last answer, never synthesized from configuration. */
  endpointModels() {
    return this.catalog
  }

  /**
   * Every model this route currently serves, after the configuration overlay
   * (phase 4a) is applied: discovered models the operator did not exclude, plus
   * the models declared in `models.extra`.
   *
   * The overlay is a layer, never a replacement: as long as
   * `models.replaceDiscovered` is off, an id the endpoint starts advertising is
   * in this list on the very next call with no configuration change, which is
   * exactly what DESIGN.md §2.5 requires of an authoritative endpoint.
   *
   * A cold catalogue (nothing discovered yet, e.g. the very first request of a
   * process, or an endpoint outage with no prior success) still serves the
   * configured `models.extra` ids. That is not a contradiction of "the endpoint
   * is authoritative": an extra is an explicit operator declaration, and
   * withholding it until a network call happened would make a hand-declared
   * model unusable exactly when the endpoint is unreachable — the situation a
   * declared model exists for. Endpoint ids still come from the endpoint only.
   *
   * @param {object} [options] - a resolved connection snapshot; re-read when omitted.
   * @returns {readonly CatalogModel[]} the effective catalogue.
   */
  effectiveModels(options = this.hooks.options()) {
    const discovered = this.catalog ?? []
    const ids = effectiveModelIds(discovered.map((model) => model.id), options.models)
    return ids.map((id) => {
      const declared = options.models.extra[id]
      const name = declared?.name ?? this.find(id)?.name ?? id
      return { id, name }
    })
  }

  /** The ids of {@link effectiveModels}, in the same order. */
  effectiveIds(options = this.hooks.options()) {
    return this.effectiveModels(options).map((model) => model.id)
  }

  /** True once at least one discovery succeeded and its result is still held. */
  hasSnapshot() {
    return this.catalog !== undefined
  }

  /** One model by exact id from the last successful snapshot. */
  find(modelId) {
    return this.catalog?.find((model) => model.id === modelId)
  }

  /**
   * The models.dev record for one id, or `undefined` when the catalog is
   * disabled, this build has no snapshot, or the snapshot does not know the id.
   *
   * The three-way distinction matters to {@link import('./protocol-map.js').resolveProtocol}:
   * "unknown id" must fall through to the bootstrap table while "known id that
   * inherits the provider package" must not.
   * @param {string} modelId - the gateway model id.
   * @returns {object | undefined} the raw snapshot record.
   */
  snapshotEntryFor(modelId) {
    if (this.hooks.options().snapshotEnabled !== true) {
      // A synced measurement is evidence, not a catalogued fact, so it survives
      // disabling the models.dev snapshot: turning that off must not throw away
      // what the gateway itself told us.
      return this.hooks.synced?.entryFor(modelId)
    }
    return mergeSyncedEntry(this.hooks.snapshot?.entryFor(modelId), this.hooks.synced?.entryFor(modelId))
  }

  /**
   * The `provider.npm` fact for one id: a string, `null` (catalogued, inheriting
   * the provider package), or `undefined` (not catalogued / snapshot disabled).
   * @param {string} modelId - the gateway model id.
   * @returns {string | null | undefined} the fact.
   */
  snapshotNpmFor(modelId) {
    if (this.hooks.options().snapshotEnabled !== true) return undefined
    return this.hooks.snapshot?.npmFor(modelId)
  }

  /** The catalogued display name, when one was published and the snapshot is enabled. */
  snapshotNameFor(modelId) {
    if (this.hooks.options().snapshotEnabled !== true) return undefined
    return this.hooks.snapshot?.nameFor(modelId)
  }

  /** Catalogued ids this endpoint does not advertise (diagnostics only; never enabled). */
  snapshotOnly() {
    return this.diagnostics.snapshotOnly
  }

  /** Advertised ids the snapshot does not know (they run on conservative defaults). */
  unknownModels() {
    return this.diagnostics.unknownModels
  }

  /**
   * Refresh the catalog if it is missing, stale, or `force`d.
   *
   * Concurrent callers share one in-flight request. A failed refresh keeps the
   * previous snapshot and returns it, so a transient gateway outage can never
   * empty the model list.
   *
   * @param {{ force?: boolean, signal?: AbortSignal }} [request] - refresh intent.
   * @returns {Promise<readonly CatalogModel[]>} the models now in effect.
   */
  async refresh(request = {}) {
    const options = this.hooks.options()
    const age = this.diagnostics.lastSuccessAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() - this.diagnostics.lastSuccessAt
    // The TTL answers "has this answer gone stale". It does not answer "is this
    // answer about the endpoint we are configured to use NOW", and a settings
    // change of `baseURL` or `apiKeyEnv` moves the target while the TTL is still
    // running. Measured in the phase-4a isolated run: after a settings write
    // pointing the route at a local stub, `listModels()` kept answering with the
    // previous endpoint's catalogue for the rest of the TTL. The target is part
    // of the cache key, exactly like the model-set overlay is part of the
    // adapter snapshot's identity.
    //
    // The legacy inline `apiKey` is part of the identity too: while a
    // pre-0.6.0 document is still being migrated it is the source in force, and
    // an answer taken under it must not stay "fresh" for a different one. Only
    // the source actually in force is named, so editing an unused reference
    // cannot invalidate a live catalogue. The token itself never leaves this
    // process — it is only ever part of an in-memory comparison key.
    const credential = options.apiKey === undefined ? `ref:${options.apiKeyEnv}` : `inline:${options.apiKey}`
    const target = `${options.baseURL}\u0000${credential}`
    const sameTarget = this.targetKey === target
    const fresh = this.catalog !== undefined && sameTarget && age < options.syncTtlMs
    if (!request.force && fresh) return this.catalog
    if (this.inFlight !== undefined && sameTarget) return this.inFlight
    if (request.signal?.aborted === true) return this.models()
    if (this.catalog !== undefined && !sameTarget) {
      this.hooks.log('info', `endpoint changed to ${options.baseURL}; the previous catalogue is no longer valid`)
    }

    const generation = ++this.generation
    // The target is recorded for the ATTEMPT, not for the success: after a
    // failure against the new endpoint, the next call must not treat the
    // previous endpoint's catalogue as "fresh for this target" — it re-resolves
    // through the TTL instead, and the TTL is measured from the last success.
    this.targetKey = target
    const run = this.#load(options, request.signal)
      .then((models) => {
        if (generation !== this.generation) return this.models()
        this.catalog = models
        const advertised = models.map((model) => model.id)
        const snapshot = this.hooks.snapshot
        const snapshotOnly = options.snapshotEnabled === true && snapshot !== undefined
          ? snapshot.snapshotOnlyIds(advertised)
          : []
        const unknownModels = options.snapshotEnabled === true && snapshot !== undefined
          ? snapshot.unknownIds(advertised)
          : []
        this.diagnostics = {
          successes: this.diagnostics.successes + 1,
          failures: this.diagnostics.failures,
          consecutiveFailures: 0,
          lastError: undefined,
          lastSuccessAt: Date.now(),
          lastAttemptAt: Date.now(),
          status: 'fresh',
          snapshotOnly,
          unknownModels,
        }
        this.hooks.log('info', `${models.length} models discovered from ${options.baseURL}`)
        if (snapshotOnly.length > 0) {
          this.hooks.log('info', `catalogued but not advertised (not enabled): ${snapshotOnly.join(', ')}`)
        }
        if (unknownModels.length > 0) {
          this.hooks.log('info', `advertised but not catalogued (conservative defaults): ${unknownModels.join(', ')}`)
        }
        return models
      })
      .catch((error) => {
        if (generation !== this.generation) return this.models()
        const message = describeTransportError(error)
        this.diagnostics = {
          ...this.diagnostics,
          failures: this.diagnostics.failures + 1,
          consecutiveFailures: this.diagnostics.consecutiveFailures + 1,
          lastError: message,
          lastAttemptAt: Date.now(),
          status: this.catalog === undefined ? 'failed-cold' : 'stale',
        }
        // The failure tolerance below is for the ENDPOINT being unreachable or
        // unhappy: keeping the last success keeps the route serving through an
        // outage, and the failure is visible in the log rather than in an empty
        // model list.
        //
        // A CREDENTIAL failure is not that. It is configuration-shaped, no
        // retry can fix it, and it makes EVERY request on the route fail — so
        // swallowing it would leave `listModels` answering with the previous
        // endpoint's catalogue while every call built from it fails, which is
        // precisely the "schema-valid, stored, and silently ignored" class of
        // bug phase 3 paid for. Measured in the phase-4a isolated run: after a
        // settings write naming an unset `apiKeyEnv`, `listModels()` still
        // returned the old list and the diagnostic said only `stale`.
        if (error?.code === 'MISSING_CREDENTIAL') throw error
        this.hooks.log(
          'warn',
          `${this.catalog === undefined
            ? 'model discovery failed and no previous result is held'
            : `model discovery failed; keeping the previous ${this.catalog.length} models`}`
          + ` (${message})`,
        )
        return this.models()
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = undefined
      })
    this.inFlight = run
    return run
  }

  /**
   * One `GET {baseURL}/models`, tolerating both the OpenAI listing envelope
   * and a bare array.
   *
   * A name the endpoint supplies wins; otherwise the catalogued name is used
   * (the endpoint usually repeats the id, which is not a name), and only then
   * the id itself.
   * @param {{ baseURL: string, snapshotEnabled: boolean }} options - connection facts of this attempt.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<readonly CatalogModel[]>} deduplicated, id-sorted models.
   */
  async #load(options, signal) {
    const apiKey = await this.hooks.resolveApiKey()
    let response
    try {
      response = await fetch(`${options.baseURL}/models`, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'accept': 'application/json',
          // Host hard constraint: every provider HTTP request carries the
          // mandatory attribution. Nothing else identifies the caller.
          ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new Error(`GET ${options.baseURL}/models failed: ${describeTransportError(error)}`, { cause: error })
    }
    if (!response.ok) {
      throw new Error(`GET ${options.baseURL}/models answered HTTP ${response.status}`)
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new Error(`GET ${options.baseURL}/models returned a non-JSON body`, { cause: error })
    }
    const entries = Array.isArray(body)
      ? body
      : Array.isArray(body?.data) ? body.data : []
    const seen = new Set()
    const models = []
    for (const entry of entries) {
      const id = typeof entry?.id === 'string' ? entry.id : undefined
      if (id === undefined || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      const listed = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : undefined
      const catalogued = options.snapshotEnabled === true ? this.hooks.snapshot?.entryFor(id)?.name : undefined
      models.push({ id, name: listed ?? catalogued ?? id })
    }
    models.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return models
  }
}
