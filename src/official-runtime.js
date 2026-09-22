/**
 * The RUNTIME official layer: the same models.dev declarations the bundled
 * baseline holds, fetched live for the models the bundle cannot answer for.
 *
 * Why this exists (0.9.0): the gateway's `/models` list and models.dev move at
 * different speeds. A model can be served for days before the next plugin
 * release refreshes `data/opencode-go.official.json`, and until then every
 * consumer — the catalogue, the sync contract, the settings page — runs it on
 * the conservative defaults (`DEFAULT_CONTEXT_WINDOW`, i.e. the "200K bug",
 * except that this time nobody bundled a wrong number: the number is simply
 * missing). Waiting for a release to learn a fact that is one HTTP GET away is
 * the wrong trade, so the declaration face is now TWO layers:
 *
 *   - the BUNDLED baseline: always present, read from disk, the offline floor;
 *   - this layer: fetched from `models.dev` (raw GitHub) for the ids the bundle
 *     does not know, and re-read on a TTL for the ones it does.
 *
 * Precedence: a runtime record REPLACES the bundled record for that id (it is
 * the same source, read later). Everything downstream is unchanged, because the
 * runtime writes into the very document `officialRecordFor` already reads — the
 * single merge point stays `ModelCatalog#snapshotEntryFor` →
 * `composeEntryFaces`, and the operator's own `models.overrides` still sits
 * above both.
 *
 * What it will NOT do:
 *
 *   - it never guesses: an id whose OpenCode Go entry has no `base_model`
 *     resolves to nothing and keeps the bundled answer (a wrong lab would
 *     attach another vendor's numbers);
 *   - it never blocks the route on a broken network: every request is bounded,
 *     a failed pass is remembered for a cooldown, and a transport failure on
 *     the FIRST file marks the whole base unreachable for the rest of the pass
 *     instead of paying the timeout once per model;
 *   - it never throws into the caller: a fetch failure is a log line and a
 *     diagnostics counter, and the bundled record keeps serving.
 *
 * The cache lives where the installation can own it (`$DSH_HOME`), next to the
 * synced layer: what the upstream repository said on a given day is a fact
 * about that day, and shipping it in the package would be a lie about every
 * other installation. The bundled file remains the release-time snapshot
 * (`npm run official:fetch`).
 *
 * @module dsh-opencodego/official-runtime
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  buildOfficialRecord,
  OFFICIAL_RAW_BASE,
  officialFetchPlan,
  resolveOfficialSources,
} from './official-baseline.js'
import { parseToml } from './official-toml.js'
import { dshHome } from './synced.js'

export const OFFICIAL_CACHE_KIND = 'dsh-opencodego/official-cache'
export const OFFICIAL_CACHE_VERSION = 1

/**
 * Where the runtime layer reads models.dev from by default: the same raw base the
 * build-time refresh uses, so a fetched record and a bundled one are the same
 * data read at two moments.
 */
export const DEFAULT_OFFICIAL_BASE_URL = OFFICIAL_RAW_BASE

/** The file name the runtime layer is stored under, inside the harness home. */
export const OFFICIAL_CACHE_FILE = 'opencode-go.official-cache.json'

/**
 * How long a runtime record stays fresh before it is re-read upstream.
 *
 * A day, not a minute: the data is a declaration that changes when a vendor
 * edits a TOML file, and the point of the layer is "a model that appeared today
 * is answered today", not "every start costs a hundred requests". `0` disables
 * the TTL and re-reads on every pass.
 */
export const DEFAULT_OFFICIAL_SYNC_TTL_MS = 86_400_000

/** Ceiling on ONE upstream file read. */
export const DEFAULT_OFFICIAL_SYNC_TIMEOUT_MS = 10_000

/**
 * How long a failure (a transport error, or "upstream has no file for this id")
 * is trusted before the id is tried again. Without it, a catalogue refresh every
 * 60s would re-pay the timeout for a model models.dev simply does not know.
 */
export const DEFAULT_OFFICIAL_FAILURE_COOLDOWN_MS = 600_000

/** How many ids one pass may resolve at the same time. */
export const DEFAULT_OFFICIAL_SYNC_CONCURRENCY = 4

/**
 * Attempts per upstream file. One retry, not a retry loop: the failure this
 * exists for is a flaky route that answers on the second try, and a base that is
 * genuinely down must not cost three timeouts per model.
 */
export const DEFAULT_OFFICIAL_SYNC_ATTEMPTS = 2

/** Backoff before the retry of one file. */
const RETRY_BACKOFF_MS = 400

/** Wait, without holding the process open. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** The default location of the runtime layer for this installation. */
export function defaultOfficialCachePath() {
  return join(dshHome(), OFFICIAL_CACHE_FILE)
}

/**
 * Read the stored runtime layer.
 *
 * Never throws: a missing or malformed file means "nothing fetched yet", which
 * is the state of every fresh installation and must not take the route down.
 *
 * @param {string} [path] - the file to read.
 * @returns {{ ok: true, document: object } | { ok: false, error: string }} the loader outcome.
 */
export function loadOfficialCache(path = defaultOfficialCachePath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, error: `cannot read ${path} (${error instanceof Error ? error.message : String(error)})` }
  }
  try {
    const document = JSON.parse(text)
    if (document?.kind !== OFFICIAL_CACHE_KIND) {
      return { ok: false, error: `${path} is not a ${OFFICIAL_CACHE_KIND} document` }
    }
    return { ok: true, document }
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** One positive integer from a stored document, or `undefined`. */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * The runtime official layer for one installation.
 *
 * The object is deliberately small and synchronous to READ (`recordFor`,
 * `nameFor`, `declared`, `snapshot`): the catalogue and the request path call
 * those on every request, and a read must never wait for a network. Only
 * `ensure` / `ensureMany` / `refreshStale` are async, and only they fetch.
 */
export class OfficialRuntime {
  /**
   * @param {object} deps - injected seams.
   * @param {object | undefined} deps.document - the document to write records INTO (the merged baseline the
   *   catalogue reads). Created empty when the bundled file was unavailable, so a runtime record still lands.
   * @param {string} [deps.base] - raw upstream base (no trailing slash).
   * @param {number} [deps.ttlMs] - how long a record stays fresh.
   * @param {number} [deps.timeoutMs] - per-request ceiling.
   * @param {number} [deps.cooldownMs] - how long a failure is remembered.
   * @param {number} [deps.concurrency] - ids resolved at once.
   * @param {typeof fetch} [deps.fetchImpl] - the transport (injected for tests).
   * @param {() => object} [deps.options] - the live connection facts. When present, `officialBaseUrl` /
   *   `officialSyncTtlMs` / `officialSyncTimeoutMs` are re-read per use, so a settings write reaches the
   *   next fetch instead of the next restart (the same rule the rest of this plugin follows).
   * @param {() => number} [deps.now] - clock (injected for tests).
   * @param {(level: 'info' | 'warn' | 'error', message: string) => void} [deps.log] - host log seam.
   * @param {string} [deps.path] - where the layer is persisted.
   * @param {object | undefined} [deps.stored] - a document already read by {@link loadOfficialCache}.
   */
  constructor(deps = {}) {
    this.base = String(deps.base ?? DEFAULT_OFFICIAL_BASE_URL).replace(/\/+$/u, '')
    this.ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : DEFAULT_OFFICIAL_SYNC_TTL_MS
    this.timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_OFFICIAL_SYNC_TIMEOUT_MS
    this.cooldownMs = Number.isFinite(deps.cooldownMs) ? deps.cooldownMs : DEFAULT_OFFICIAL_FAILURE_COOLDOWN_MS
    this.concurrency = Math.max(1, Number.isSafeInteger(deps.concurrency) ? deps.concurrency : DEFAULT_OFFICIAL_SYNC_CONCURRENCY)
    this.attempts = Math.max(1, Number.isSafeInteger(deps.attempts) ? deps.attempts : DEFAULT_OFFICIAL_SYNC_ATTEMPTS)
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? (() => {})
    this.path = deps.path ?? defaultOfficialCachePath()
    /** Live connection facts, when the caller has them (see the constructor note). */
    this.optionsOf = typeof deps.options === 'function' ? deps.options : undefined

    /**
     * The document every consumer reads. The runtime MUTATES `models` in place:
     * `catalog.hooks.official` holds this very object, so a record that arrives
     * after the catalogue was built is visible on the next read with no
     * re-wiring (the same reason `snapshotEntryFor` is computed per call).
     */
    this.document = deps.document ?? {
      kind: 'dsh-opencodego/official-baseline',
      version: 1,
      modelCount: 0,
      models: {},
    }
    if (this.document.models === undefined || this.document.models === null) this.document.models = {}

    /** Ids the BUNDLED file already answers for — a runtime record still replaces one. */
    this.bundled = new Set(Object.keys(this.document.models))

    /** @type {Map<string, object>} records fetched this process (mirrors `document.models`). */
    this.records = new Map()
    /** @type {Map<string, number>} when each runtime record was read. */
    this.stamps = new Map()
    /** @type {Map<string, string>} the display name each runtime record carried, when it had one. */
    this.names = new Map()
    /** @type {Map<string, number>} "upstream has no file for this id", and when we learned it. */
    this.absent = new Map()
    /** @type {Map<string, { at: number, error: string }>} the last failure per id. */
    this.failures = new Map()
    /** When the whole base looked unreachable, until. */
    this.baseDownUntil = 0
    /** @type {string | undefined} */
    this.baseError = undefined

    this.stats = {
      fetched: 0,
      failed: 0,
      absent: 0,
      cached: 0,
      skipped: 0,
      lastAttemptAt: undefined,
      lastSuccessAt: undefined,
      lastError: undefined,
    }
    this.inFlight = new Map()

    if (deps.stored !== undefined) this.#adopt(deps.stored)
  }

  /**
   * Build one runtime layer, reading its cache from disk.
   * @param {object} deps - see the constructor; `document` is the merged baseline to write into.
   * @returns {OfficialRuntime} the layer.
   */
  static load(deps = {}) {
    const loaded = deps.stored !== undefined
      ? { ok: true, document: deps.stored }
      : loadOfficialCache(deps.path)
    const runtime = new OfficialRuntime({
      ...deps,
      stored: loaded.ok ? loaded.document : undefined,
    })
    if (!loaded.ok) runtime.loadError = loaded.error
    return runtime
  }

  /** Take one stored document into memory and into the merged view. */
  #adopt(stored) {
    const models = stored?.models
    if (models === null || typeof models !== 'object') return
    for (const [id, record] of Object.entries(models)) {
      if (record === null || typeof record !== 'object') continue
      this.#put(id, record, {
        at: Date.parse(stored.stamps?.[id] ?? stored.updatedAt ?? '') || this.now(),
        name: typeof stored.names?.[id] === 'string' ? stored.names[id] : undefined,
        save: false,
      })
    }
    for (const id of Object.keys(stored.absent ?? {})) {
      this.absent.set(id, Date.parse(stored.absent[id]) || this.now())
    }
  }

  /** Record one resolved record: memory, the merged document, and the TTL stamp. */
  #put(id, record, { at = this.now(), name, save = true } = {}) {
    this.records.set(id, record)
    this.stamps.set(id, at)
    if (typeof name === 'string' && name.length > 0) this.names.set(id, name)
    this.document.models[id] = record
    this.document.modelCount = Object.keys(this.document.models).length
    if (save) this.save()
  }

  /** The upstream base in force now (a settings write reaches the next fetch). */
  get upstreamBase() {
    const value = this.optionsOf?.()?.officialBaseUrl
    return typeof value === 'string' && value.length > 0 ? String(value).replace(/\/+$/u, '') : this.base
  }

  /** The record TTL in force now. */
  get ttl() {
    const value = this.optionsOf?.()?.officialSyncTtlMs
    return Number.isFinite(value) ? value : this.ttlMs
  }

  /** The per-request ceiling in force now. */
  get timeout() {
    const value = this.optionsOf?.()?.officialSyncTimeoutMs
    return Number.isFinite(value) ? value : this.timeoutMs
  }

  /** The runtime record for one id, when this layer has one. */
  recordFor(id) {
    return this.records.get(id)
  }

  /** The upstream display name for one id, when a fetched record carried one. */
  nameFor(id) {
    return this.names.get(id)
  }

  /** Whether ANY declaration face answers for this id (bundled or runtime). */
  declared(id) {
    return this.records.has(id) || this.bundled.has(id)
  }

  /** Whether the record for this id is still inside its TTL. */
  fresh(id) {
    if (this.absent.has(id)) return this.now() - this.absent.get(id) < this.ttl
    const stamp = this.stamps.get(id)
    if (stamp === undefined) return false
    return this.ttl <= 0 ? false : this.now() - stamp < this.ttl
  }

  /** Whether this id is inside a failure cooldown (a known-bad fetch is not retried). */
  cooling(id) {
    if (this.now() < this.baseDownUntil) return true
    const failure = this.failures.get(id)
    return failure !== undefined && this.now() - failure.at < this.cooldownMs
  }

  /**
   * Make sure one id's declaration is known, fetching it when needed.
   *
   * The returned string is the OUTCOME, not a boolean, because the three ways
   * of not fetching mean different things to an operator: `cached` (nothing to
   * do), `absent` (upstream genuinely has no file — the bundled answer, if any,
   * stands), `failed`/`cooldown` (we could not ask).
   *
   * @param {string} id - the model id.
   * @param {{ force?: boolean, signal?: AbortSignal }} [request] - fetch intent.
   * @returns {Promise<'fetched' | 'cached' | 'absent' | 'failed' | 'cooldown' | 'skipped'>} the outcome.
   */
  async ensure(id, request = {}) {
    const modelId = typeof id === 'string' ? id.trim() : ''
    if (modelId.length === 0) return 'skipped'
    if (this.upstreamBase.length === 0) {
      this.stats.skipped += 1
      return 'skipped'
    }
    if (request.force !== true) {
      // A known-absent id is not "cached": the outcome has to keep saying that
      // upstream has no file, or an operator reading the diagnostics would think
      // a record exists.
      if (this.fresh(modelId)) {
        if (!this.absent.has(modelId)) this.stats.cached += 1
        return this.absent.has(modelId) ? 'absent' : 'cached'
      }
      if (this.cooling(modelId)) return this.absent.has(modelId) ? 'absent' : 'cooldown'
    }

    const running = this.inFlight.get(modelId)
    if (running !== undefined) return running

    const run = this.#resolve(modelId, request.signal, {
      save: request.save !== false,
      pass: request.pass ?? { readOk: false },
    })
      .catch((error) => {
        // A fetch is best-effort BY CONTRACT: the bundled record keeps serving
        // and the failure is a counter plus a line, never an exception the
        // catalogue (or a chat request) would have to handle.
        this.stats.failed += 1
        this.stats.lastError = error instanceof Error ? error.message : String(error)
        // A CALLER's cancellation is not a fact about the model: remembering it
        // as a failure would suppress the next ten minutes of fetches because
        // somebody closed a page.
        if (request.signal?.aborted === true) {
          this.log('info', `official data for "${modelId}" was cancelled before it arrived`)
          return 'failed'
        }
        this.failures.set(modelId, { at: this.now(), error: this.stats.lastError })
        this.log('warn', `official data for "${modelId}" could not be read from ${this.upstreamBase}: ${this.stats.lastError}`)
        return 'failed'
      })
      .finally(() => {
        if (this.inFlight.get(modelId) === run) this.inFlight.delete(modelId)
      })
    this.inFlight.set(modelId, run)
    return run
  }

  /** One resolution: plan → fetch exactly those files → build the same record the build-time refresh would. */
  async #resolve(id, signal, { save = true, pass = { readOk: false } } = {}) {
    this.stats.lastAttemptAt = this.now()
    const previous = this.#previousFor(id)
    const ocgPath = `providers/opencode-go/models/${id}.toml`
    const cache = new Map()

    /**
     * One file of the plan.
     *
     * `required` is what separates "upstream says nothing here" from "we could
     * not ask": the OpenCode Go entry and every RECORDED source of a known
     * record are required (a half-refreshed record is worse than the old one),
     * while the paths a rule merely *derives* — the provider directories, the
     * `<lab>-cn` spelling, the canonical file — are candidates. A candidate that
     * cannot be read is treated as absent, because the alternative is that one
     * flaky request on a path that may not even exist discards a whole model's
     * numbers.
     */
    const read = async (path, { required = false } = {}) => {
      if (cache.has(path)) return cache.get(path)
      try {
        const text = await this.#fetchText(path, signal, pass)
        cache.set(path, text)
        return text
      } catch (error) {
        if (required) throw error
        cache.set(path, undefined)
        return undefined
      }
    }

    // 1. the OpenCode Go entry: it holds `base_model`, which is what the plan
    //    needs. Without it there is nothing to derive, and a transport failure
    //    here IS the id's failure.
    const ocgText = await read(ocgPath, { required: true })
    const plan = officialFetchPlan({ id, ocgText, previous })
    // 2. the plan's remaining files. A recorded plan re-reads exactly what the
    //    last resolution used (required: it is a refresh of a record that is
    //    already serving); a derived one reads the direct candidates.
    const recorded = plan.how === 'recorded-sources'
    const others = plan.paths.filter((path) => path !== ocgPath)
    await Promise.all(others.map((path) => read(path, { required: recorded })))

    const source = { read: (path) => cache.get(path) }
    const resolution = resolveOfficialSources({ id, previous, source })
    if (resolution.how === 'unresolved') {
      // Upstream has no reference for this id at all (no entry, or one without a
      // `base_model`). That is a FACT about models.dev, remembered with the same
      // cooldown as a failure so a 60s catalogue TTL does not re-ask forever.
      this.absent.set(id, this.now())
      this.stats.absent += 1
      if (save) this.save()
      this.log('info', `models.dev has no official reference for "${id}" (${resolution.problems.join('; ')})`)
      return 'absent'
    }

    const record = buildOfficialRecord({ id, resolution, read: (path) => cache.get(path) })
    // A derived plan can end up with a record that declares no capacity at all
    // (every candidate file was unreadable). Storing it would be worse than
    // storing nothing: it would LOOK like an answer and silently keep the
    // conservative defaults, which is the exact confusion this layer exists to
    // remove. A recorded plan is allowed to be thin — it is the refresh of a
    // record that was already accepted.
    if (!recorded && record.contextWindow === undefined && record.maxTokens === undefined) {
      throw new Error(`models.dev has files for "${id}" but none of them declared a usable capacity `
        + `(read: ${Object.values(resolution.files).join(', ') || 'nothing'})`)
    }
    const name = nameOf(cache, resolution)
    this.#put(id, record, { name, save })
    this.absent.delete(id)
    this.failures.delete(id)
    this.stats.fetched += 1
    this.stats.lastSuccessAt = this.now()
    this.stats.lastError = undefined
    this.log('info', `official data for "${id}" read from models.dev (${record.lab}/${record.slug}, `
      + `context ${record.contextWindow ?? '?'}, output ${record.maxTokens ?? '?'})`)
    return 'fetched'
  }

  /**
   * The record a previous resolution left for this id, if any.
   *
   * A runtime record wins (it is the newer read). A BUNDLED record is the next
   * best thing and is what makes a TTL refresh cheap: its `sources` are the
   * exact files the build-time refresh read, so the re-read costs those files
   * and nothing else — the same rule the network refresh uses.
   */
  #previousFor(id) {
    const runtime = this.records.get(id)
    if (runtime !== undefined) return runtime
    return this.bundled.has(id) ? this.document.models[id] : undefined
  }

  /**
   * Resolve every id in `ids` that no declaration face answers for yet.
   *
   * This is the "a new model appeared" path: it is AWAITED by the catalogue
   * refresh, because the numbers the operator is about to look at are exactly
   * what it fetches. `budgetMs` bounds the whole pass — a slow upstream must
   * delay a page read, never wedge it.
   *
   * @param {readonly string[]} ids - the ids to consider (usually the advertised list).
   * @param {{ signal?: AbortSignal, budgetMs?: number }} [request] - pass intent.
   * @returns {Promise<{ fetched: string[], absent: string[], failed: string[], pending: string[] }>} the outcomes.
   */
  async ensureMany(ids, request = {}) {
    const wanted = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id.length > 0))]
      .filter((id) => !this.declared(id))
    const result = { fetched: [], absent: [], failed: [], pending: [] }
    if (wanted.length === 0 || this.upstreamBase.length === 0) return result

    // The budget is a real ceiling, not a "stop starting new work": the in-flight
    // reads are aborted with it, because the caller is a page read and a slow
    // upstream may delay it but must never wedge it. An aborted read is not a
    // failure (nothing is remembered against the id), so the next pass — the
    // background one below, or the next catalogue refresh — simply tries again.
    const budget = budgetSignal(request.budgetMs)
    const linked = linkSignals(request.signal, budget.signal)
    const pass = { readOk: false }
    const queue = [...wanted]
    try {
      const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
        for (;;) {
          if (budget.expired()) break
          const id = queue.shift()
          if (id === undefined) return
          const outcome = await this.ensure(id, { signal: linked.signal, pass, save: false })
          if (outcome === 'fetched') result.fetched.push(id)
          else if (outcome === 'absent') result.absent.push(id)
          else if (outcome === 'failed') {
            // The budget running out is not a fact about the model.
            if (budget.expired() || linked.signal.aborted === true) result.pending.push(id)
            else result.failed.push(id)
          } else if (outcome !== 'cached') result.pending.push(id)
        }
      })
      await Promise.all(workers)
    } finally {
      linked.done()
      budget.done()
    }
    result.pending.push(...queue)
    if (result.fetched.length > 0 || result.absent.length > 0) this.save()
    if (result.fetched.length > 0) {
      this.log('info', `official data fetched from models.dev for: ${result.fetched.join(', ')}`)
    }
    if (result.failed.length > 0) {
      this.log('warn', `official data unavailable for ${result.failed.length} model(s) `
        + `(${result.failed.join(', ')}); the bundled baseline keeps serving them`)
    }
    return result
  }

  /**
   * Re-read the ids whose record has gone stale, WITHOUT blocking the caller.
   *
   * Called after a catalogue refresh: the numbers a stale record holds are
   * already serving, so a re-read is an improvement, not a prerequisite. The
   * pass is bounded twice — by `budgetMs` and by the unreachable-base memo — so
   * a first run against a bundle that is days old cannot turn into a hundred
   * requests nobody is waiting for; whatever is left is picked up by the next
   * pass.
   *
   * @param {readonly string[]} ids - candidate ids.
   * @param {{ signal?: AbortSignal, budgetMs?: number }} [request] - pass intent.
   * @returns {Promise<{ fetched: string[], failed: string[], pending: string[] }>} the outcomes.
   */
  async refreshStale(ids, request = {}) {
    const result = { fetched: [], failed: [], pending: [] }
    if (this.upstreamBase.length === 0 || this.now() < this.baseDownUntil) return result
    const stale = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id.length > 0))]
      .filter((id) => this.declared(id) && !this.fresh(id) && !this.cooling(id))
    if (stale.length === 0) return result
    const budget = budgetSignal(request.budgetMs)
    const linked = linkSignals(request.signal, budget.signal)
    const pass = { readOk: false }
    const queue = [...stale]
    try {
      const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
        for (;;) {
          if (budget.expired() || this.now() < this.baseDownUntil) return
          const id = queue.shift()
          if (id === undefined) return
          const outcome = await this.ensure(id, { signal: linked.signal, pass, save: false })
          if (outcome === 'fetched') result.fetched.push(id)
          else if (outcome === 'failed') result.failed.push(id)
        }
      })
      await Promise.all(workers)
    } finally {
      linked.done()
      budget.done()
    }
    result.pending.push(...queue)
    if (result.fetched.length > 0) this.save()
    return result
  }

  /**
   * One upstream file: text, `undefined` for 404, throw for anything else.
   *
   * Two things make this survive a bad link, both measured on a real one:
   *
   *   - a retry per file. `raw.githubusercontent.com` behind a flaky route
   *     answers two files and times out on the third; a single retry is the
   *     difference between "no numbers" and "the numbers".
   *   - the unreachable-base memo is set only while the pass has NOT read
   *     anything yet (`pass.readOk`). A host that answered three files and
   *     stumbled on a fourth is slow, not down — and treating it as down would
   *     abandon every remaining model in the pass.
   */
  async #fetchText(path, signal, pass) {
    if (this.now() < this.baseDownUntil) {
      throw new Error(this.baseError ?? 'the models.dev base is unreachable')
    }
    const url = `${this.upstreamBase}/${path}`
    let lastError
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const bound = boundSignal(signal, this.timeout)
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          // No provider attribution here on purpose: this is a public data file
          // on a third-party host, not a model request, and the host's
          // attribution contract is about provider traffic.
          headers: { accept: 'text/plain', 'user-agent': 'dsh-opencodego' },
          signal: bound.signal,
        })
        if (response.status === 404) {
          // A 404 is an ANSWER ("this file does not exist"), not a failure: it
          // also proves the base is reachable.
          this.#reachable(pass)
          return undefined
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        this.#reachable(pass)
        return text
      } catch (error) {
        lastError = error
        if (signal?.aborted === true) break
        if (attempt < this.attempts) await delay(RETRY_BACKOFF_MS * attempt)
      } finally {
        bound.done()
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    // Only a pass that has never reached the host may conclude the host is down.
    if (signal?.aborted !== true && pass?.readOk !== true) {
      this.baseDownUntil = this.now() + this.cooldownMs
      this.baseError = message
    }
    throw new Error(`GET ${url} failed (${message})`, { cause: lastError })
  }

  /** Record one successful read: the base is reachable, so drop the down memo. */
  #reachable(pass) {
    if (pass !== undefined) pass.readOk = true
    this.baseDownUntil = 0
    this.baseError = undefined
  }

  /** Persist the layer (best-effort: a failed write is a log line, never a throw). */
  save() {
    const document = {
      kind: OFFICIAL_CACHE_KIND,
      version: OFFICIAL_CACHE_VERSION,
      base: this.upstreamBase,
      updatedAt: new Date(this.now()).toISOString(),
      stamps: Object.fromEntries([...this.stamps].map(([id, at]) => [id, new Date(at).toISOString()])),
      names: Object.fromEntries(this.names),
      absent: Object.fromEntries([...this.absent].map(([id, at]) => [id, new Date(at).toISOString()])),
      models: Object.fromEntries(this.records),
    }
    const text = `${JSON.stringify(document, undefined, 1)}\n`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, text, 'utf8')
      renameSync(temporary, this.path)
      this.writeError = undefined
      return this.path
    } catch (error) {
      this.writeError = error instanceof Error ? error.message : String(error)
      this.log('warn', `could not persist the runtime official data at ${this.path}: ${this.writeError}`)
      return undefined
    }
  }

  /**
   * The JSON-serializable state a diagnostics surface shows.
   *
   * Names and counts only: this is about WHERE a number came from, and the
   * numbers themselves already ride the catalogue.
   */
  snapshot() {
    return {
      base: this.upstreamBase,
      path: this.path,
      bundled: this.bundled.size,
      runtime: this.records.size,
      absent: [...this.absent.keys()].sort(),
      failed: [...this.failures.entries()]
        .filter(([, failure]) => this.now() - failure.at < this.cooldownMs)
        .map(([id, failure]) => ({ id, error: failure.error, at: new Date(failure.at).toISOString() }))
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
      fetched: this.stats.fetched,
      cached: this.stats.cached,
      skipped: this.stats.skipped,
      lastAttemptAt: this.stats.lastAttemptAt === undefined ? undefined : new Date(this.stats.lastAttemptAt).toISOString(),
      lastSuccessAt: this.stats.lastSuccessAt === undefined ? undefined : new Date(this.stats.lastSuccessAt).toISOString(),
      lastError: this.stats.lastError,
      writeError: this.writeError,
      loadError: this.loadError,
      baseDownUntil: this.baseDownUntil > this.now() ? new Date(this.baseDownUntil).toISOString() : undefined,
      names: Object.fromEntries(this.names),
    }
  }
}

/** The `name` one resolved model file declares, when it declares one. */
function nameOf(cache, resolution) {
  for (const role of ['canonicalModel', 'providerModel']) {
    const path = resolution.files?.[role]
    const text = path === undefined ? undefined : cache.get(path)
    if (text === undefined) continue
    const name = parseToml(text)?.data?.name
    if (typeof name === 'string' && name.trim().length > 0) return name.trim()
  }
  return undefined
}

/**
 * Combine a caller's cancellation with this layer's own per-request ceiling.
 *
 * `AbortSignal.any` would be the one-liner, but it is Node 20.3+ and this
 * package supports 20.x: the combination is done by hand so the ceiling holds
 * on every supported runtime (a fetch with no ceiling is how one unreachable
 * host wedges a whole page read).
 *
 * @param {AbortSignal | undefined} signal - the caller's signal, when there is one.
 * @param {number} timeoutMs - the ceiling.
 * @returns {{ signal: AbortSignal, done: () => void }} the bound signal and its cleanup.
 */
function boundSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`models.dev read timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted === true) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

/**
 * A whole-pass deadline, as a signal plus a question.
 *
 * @param {number | undefined} budgetMs - the ceiling, when the caller gave one.
 * @returns {{ signal: AbortSignal, expired: () => boolean, done: () => void }} the budget.
 */
function budgetSignal(budgetMs) {
  const controller = new AbortController()
  let expired = false
  const timer = Number.isFinite(budgetMs)
    ? setTimeout(() => {
      expired = true
      controller.abort(new Error('the models.dev pass budget ran out'))
    }, budgetMs)
    : undefined
  timer?.unref?.()
  return {
    signal: controller.signal,
    expired: () => expired,
    done: () => clearTimeout(timer),
  }
}

/**
 * One signal that follows several others (a caller's cancellation and a pass
 * budget, in practice).
 * @param {...(AbortSignal | undefined)} signals - the signals to follow.
 * @returns {{ signal: AbortSignal, done: () => void }} the linked signal and its cleanup.
 */
function linkSignals(...signals) {
  const controller = new AbortController()
  const listeners = []
  for (const signal of signals) {
    if (signal === undefined) continue
    if (signal.aborted === true) {
      controller.abort(signal.reason)
      break
    }
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push([signal, onAbort])
  }
  return {
    signal: controller.signal,
    done: () => {
      for (const [signal, onAbort] of listeners) signal.removeEventListener?.('abort', onAbort)
    },
  }
}
