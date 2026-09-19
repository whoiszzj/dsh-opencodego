/**
 * The per-subscription USAGE/BALANCE layer.
 *
 * The live gateway measurement this module is built around
 * (`scripts/probe-quota.mjs`, 2026-09): `GET {baseURL}/usage` with the
 * subscription's own bearer answers
 *
 *   { "usage": {
 *       "rolling": { "status": "ok", "percent": 0,  "resetsAt": ISO },
 *       "weekly":  { "status": "ok", "percent": 83, resetsAt": ISO },
 *       "monthly": { "status": "ok", "percent": 53, "resetsAt": ISO } } }
 *
 * — one view PER KEY. That is the only trustworthy balance fact there is, so
 * this plugin does not keep a local token ledger: the gateway's own words are
 * polled, cached, and persisted.
 *
 * Since 0.8.2 this layer is DISPLAY-ONLY. The pool that used caps, cooldowns and
 * a `429` fallback to decide who pays is gone: exactly one subscription is
 * active, switching is an operator act, and the balance bars are the page's
 * picture of what the gateway last said. Nothing in the request path reads these
 * numbers any more, which is also why a failed probe can never break a request —
 * it keeps the last good windows and surfaces the error on the row.
 *
 * Host-free on purpose: the probe takes `fetchImpl` and `headers` thunks like
 * `sync.js` does (thunks, never expanded objects — invariant #4), so parse,
 * caching, and persistence all run under bare `node --test`.
 *
 * @module dsh-opencodego/usage
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './synced.js'
import { PKG } from './vocab.js'
import { USAGE_WINDOW_KEYS } from './subs.js'

export const USAGE_LAYER_KIND = 'dsh-opencodego/usage-layer'
export const USAGE_LAYER_VERSION = 1

/** The file the last-known usage survives a restart in. */
export const USAGE_LAYER_FILE = 'opencode-go.usage.json'

/** Default location, next to the synced layer. */
export function defaultUsageLayerPath() {
  return join(dshHome(), USAGE_LAYER_FILE)
}

/**
 * Parse one `/usage` envelope into `{ windows }`.
 *
 * Defensive in both directions: an unknown window name is ignored (a gateway
 * that adds one must not break the three this plugin reads), and a window whose
 * `percent` is missing stays present with just its `status`/`resetsAt` (a
 * status the page must still show). The RAW status string is kept — the page
 * decides how to render it, so parsing must not pre-judge it.
 *
 * @param {unknown} payload - parsed JSON from `GET {base}/usage`.
 * @returns {object | undefined} `{ rolling?, weekly?, monthly? }` or `undefined`
 *   when the body is not an usage envelope at all.
 */
export function parseUsageEnvelope(payload) {
  const usage = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.usage
    : undefined
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const windows = {}
  let sawKnown = false
  for (const name of USAGE_WINDOW_KEYS) {
    const entry = usage[name]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    sawKnown = true
    const percent = typeof entry.percent === 'number' && Number.isFinite(entry.percent)
      ? Math.max(0, Math.min(100, entry.percent))
      : undefined
    windows[name] = {
      status: typeof entry.status === 'string' && entry.status.length > 0 ? entry.status : undefined,
      percent,
      resetsAt: typeof entry.resetsAt === 'string' && entry.resetsAt.length > 0 ? entry.resetsAt : undefined,
    }
  }
  return sawKnown ? windows : undefined
}

/**
 * One `GET {baseURL}/usage` probe. Never throws: a transport failure, a
 * timeout, and a non-usage body all come back as `{ ok: false, error }`,
 * because the page must keep showing the LAST good numbers rather than lose
 * them to this probe's mood (invariant #3: every request carries its own
 * timeout).
 *
 * @param {object} args - probe inputs.
 * @param {string} args.baseURL - the route's normalized base (…/v1).
 * @param {string} args.apiKey - that subscription's bearer token.
 * @param {() => Record<string, string>} args.baseHeaders - attribution+session
 *   headers as a THUNK (the one merge point lives in the wiring, `index.js`).
 * @param {(url: string, init: object) => Promise<object>} args.fetchImpl - fetch.
 * @param {number} args.timeoutMs - ceiling for this one request.
 * @param {AbortSignal} [args.signal] - caller cancellation.
 * @returns {Promise<{ ok: true, windows: object, checkedAt: number } | { ok: false, error: string }>}
 */
export async function probeUsage({ baseURL, apiKey, baseHeaders, fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('usage probe timeout'), Math.max(1, timeoutMs))
  const onCallerAbort = () => controller.abort(signal?.reason ?? 'caller aborted')
  if (signal !== undefined) {
    if (signal.aborted === true) {
      clearTimeout(timer)
      return { ok: false, error: 'usage probe aborted before send' }
    }
    signal.addEventListener?.('abort', onCallerAbort, { once: true })
  }
  try {
    const response = await fetchImpl(`${baseURL}/usage`, {
      method: 'GET',
      headers: {
        ...baseHeaders(),
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
    const status = typeof response?.status === 'number' ? response.status : 0
    if (status < 200 || status >= 300) {
      return { ok: false, error: `GET ${baseURL}/usage -> HTTP ${String(status)}` }
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      return { ok: false, error: `GET ${baseURL}/usage answered non-JSON (HTTP ${String(status)})` }
    }
    const windows = parseUsageEnvelope(payload)
    if (windows === undefined) {
      return { ok: false, error: `GET ${baseURL}/usage answered without a usage envelope` }
    }
    return { ok: true, windows, checkedAt: Date.now() }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' || controller.signal.aborted
      ? `GET ${baseURL}/usage timed out after ${String(timeoutMs)}ms`
      : `GET ${baseURL}/usage failed: ${error?.message ?? String(error)}` }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener?.('abort', onCallerAbort)
  }
}

/**
 * The last-known usage per subscription, stored under the harness home —
 * same placement rule as the synced layer (`$DSH_HOME`, never the package):
 * it is a measurement about THIS account, and a corrupt or absent file is
 * "nothing known yet", never a fault.
 */
export class UsageLayer {
  /** @param {object} [document] - a parsed layer document. */
  constructor(document) {
    this.kind = document?.kind ?? USAGE_LAYER_KIND
    this.version = document?.version ?? USAGE_LAYER_VERSION
    /** @type {Record<string, object>} */
    this.subs = document?.subs !== null && typeof document?.subs === 'object' && !Array.isArray(document.subs)
      ? document.subs
      : {}
    this.path = document?.path
  }

  /** @returns {string | undefined} the stored entry for one subscription. */
  entryFor(subId) {
    const entry = this.subs[subId]
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : undefined
  }

  /** Record one probe result (success or the error text — both are facts). */
  put(subId, entry) {
    if (typeof subId !== 'string' || subId.length === 0) return
    this.subs[subId] = entry
  }

  /** Forget one subscription (it left the configuration). */
  drop(subId) {
    delete this.subs[subId]
  }

  /** A plain object for the HTTP face. */
  toDocument() {
    return { kind: this.kind, version: this.version, subs: this.subs }
  }

  /** Load the layer from `path` (absent/corrupt → empty layer). */
  static load(path = defaultUsageLayerPath()) {
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const empty = new UsageLayer(undefined)
        empty.path = path
        return empty
      }
      const layer = new UsageLayer(parsed)
      layer.path = path
      return layer
    } catch {
      const empty = new UsageLayer(undefined)
      empty.path = path
      return empty
    }
  }

  /**
   * Atomic write, same discipline as `synced.js`: temp file then rename, so a
   * crash can never leave a half-written layer where a stale one was fine.
   * @returns {boolean} whether the write landed.
   */
  save() {
    const path = this.path ?? defaultUsageLayerPath()
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.tmp-${String(process.pid)}`
      writeFileSync(temp, `${JSON.stringify(this.toDocument(), null, 2)}\n`, 'utf8')
      renameSync(temp, path)
      this.path = path
      return true
    } catch (error) {
      // The layer is a cache; losing it must not take the route down. Say it
      // once in the returned truth: callers read `save()`'s boolean.
      this.lastSaveError = `${PKG}: usage layer not saved (${error?.message ?? error})`
      return false
    }
  }
}

/**
 * The runtime usage cache: last probe per subscription, TTL-gated refresh,
 * single-flight, and write-through persistence.
 *
 * `peek()` is SYNCHRONOUS — the page renders the last-known numbers without
 * triggering a network round-trip — and `refresh()` is awaited only by the
 * page's 刷新余额 (and the background refresh a successful request used to
 * schedule). A probe failure keeps the previous windows (staleness beats
 * amnesia) but records the error for the row.
 */
export class UsageProbeCache {
  /**
   * @param {object} deps -
   * @param {UsageLayer} deps.layer - the persistence layer.
   * @param {(sub: object) => Promise<string>} deps.resolveKey - the subscription's bearer.
   * @param {(sub: object) => Record<string, string>} deps.baseHeaders - headers thunk per sub.
   * @param {(sub: object) => string} [deps.baseURL] - the route's gateway address. Injected
   *   because the base is a ROUTE fact, not a subscription one: since 0.8.2 a
   *   subscription carries only a name and a credential slot, so `sub.baseURL` no
   *   longer exists. Falls back to `sub.baseURL` for a bare caller that still has one.
   * @param {(...args: unknown[]) => Promise<object>} deps.fetchImpl - fetch.
   * @param {() => number} [deps.now] - clock.
   * @param {() => number} deps.ttlMs - freshness window (read per call: settings move).
   * @param {() => number} deps.timeoutMs - probe ceiling (read per call).
   * @param {(level: string, message: string) => void} [deps.log] - plugin log.
   */
  constructor(deps) {
    this.deps = deps
    /** @type {Map<string, Promise<object>>} */
    this.inFlight = new Map()
  }

  /** The last-known state, synchronously. Never triggers a probe. */
  peek(subId) {
    const entry = this.deps.layer.entryFor(subId)
    if (entry === undefined) return { windows: undefined, checkedAt: undefined, error: undefined, age: undefined }
    const checkedAt = typeof entry.checkedAt === 'number' ? entry.checkedAt : undefined
    return {
      windows: entry.windows,
      checkedAt,
      error: entry.error,
      age: checkedAt === undefined ? undefined : this.deps.now() - checkedAt,
    }
  }

  /** Whether the cached view is fresh enough to act on without re-probing. */
  isFresh(subId) {
    const { checkedAt } = this.peek(subId)
    return checkedAt !== undefined && this.deps.now() - checkedAt < this.deps.ttlMs()
  }

  /**
   * Probe one subscription now (or join the probe already running for it).
   * Resolves with the stored entry either way; never rejects.
   */
  refresh(sub) {
    const existing = this.inFlight.get(sub.id)
    if (existing !== undefined) return existing
    const run = (async () => {
      const result = await probeUsage({
        baseURL: this.deps.baseURL === undefined ? sub.baseURL : this.deps.baseURL(sub),
        apiKey: await this.deps.resolveKey(sub),
        baseHeaders: () => this.deps.baseHeaders(sub),
        fetchImpl: this.deps.fetchImpl ?? globalThis.fetch,
        timeoutMs: this.deps.timeoutMs(),
      })
      const entry = result.ok === true
        ? { windows: result.windows, checkedAt: result.checkedAt, error: undefined }
        : { windows: this.deps.layer.entryFor(sub.id)?.windows, checkedAt: undefined, error: result.error }
      // A failed probe must not move `checkedAt` — freshness means "the last
      // SUCCESS", so stale-but-known keeps retrying on the next TTL expiry.
      this.deps.layer.put(sub.id, entry)
      this.deps.layer.save()
      if (result.ok !== true) this.deps.log?.('warn', `usage probe for "${sub.id}" failed: ${result.error}`)
      return { subId: sub.id, ...entry }
    })().finally(() => this.inFlight.delete(sub.id))
    this.inFlight.set(sub.id, run)
    return run
  }

  /** Forget one subscription's cache (configuration removed it). */
  drop(subId) {
    this.deps.layer.drop(subId)
  }

  /**
   * Forget every cached entry whose id is not in `ids` (a settings write that
   * removed a subscription). One save for the whole prune.
   * @param {readonly string[]} ids - the surviving subscription ids.
   * @returns {string[]} the ids dropped.
   */
  dropAllMissing(ids) {
    const keep = new Set(ids)
    const dropped = Object.keys(this.deps.layer.subs).filter((id) => !keep.has(id))
    if (dropped.length === 0) return dropped
    for (const id of dropped) this.deps.layer.drop(id)
    this.deps.layer.save()
    return dropped
  }
}
