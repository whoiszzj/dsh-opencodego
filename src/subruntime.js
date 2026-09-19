/**
 * The SUBSCRIPTION RUNTIME: what one request consults to know WHO PAYS, plus the
 * per-key balance view the settings page renders.
 *
 * Since 0.8.3 (the live-slot redesign) this object is deliberately small. There
 * is NO pool: `active()` IS the request's payer, and `activeKey()` the one
 * credential the request path resolves. No rotation, no cooldown, no sticky
 * session, no gate — switching subscriptions is an operator act performed by
 * writing `activeSubscription` (see `subs.js`), never something a failed request
 * decides on its own.
 *
 * TWO KINDS OF SLOT, and the distinction is the whole design:
 *
 *   - every subscription OWNS one storage slot, NAMED AFTER THE SUBSCRIPTION
 *     (`me@example.com` → `OPENCODE_GO_ME_EXAMPLE_COM`; an unnamed
 *     row keeps the stable id-derived spelling). That is where a key lives and
 *     stays, whichever row is active;
 *   - the LIVE slot is the top-level `apiKeyEnv` (`OPENCODE_GO_API_KEY` by
 *     default) — the ONE variable the rest of the harness can see. Whenever the
 *     active row changes, `reconcile()`/`activeKey()` copy that row's value into
 *     it, so "I have N keys and the UI switches which one is in
 *     OPENCODE_GO_API_KEY" is literally true.
 *
 * The request path resolves the ACTIVE row's own slot (so a refused or
 * env-shadowed mirror can never send a stale key), and the mirror is a
 * best-effort projection whose failure is logged, not fatal. A missing key is a
 * hard stop naming its own slot — there is no second subscription to fall back
 * to by design.
 *
 * What remains per key is the balance: the probe, its TTL cache, its
 * single-flight behaviour and its persistence all live in `usage.js`; this module
 * only decides which key to probe with and shapes the rows for the page.
 *
 * Deliberately host-free like `subs.js`/`usage.js`: the host seams (the
 * credential resolver, the credential WRITER, and the credential-store
 * DESCRIPTION the page shows as "key stored / not stored") are injected as
 * factories, so the whole flow is unit-testable with a bare `node --test`.
 *
 * @module dsh-opencodego/subruntime
 */

import { activeSubscriptionOf } from './subs.js'
import { UsageLayer, UsageProbeCache } from './usage.js'

/** The one-line text of any thrown value (kept local: this module imports no host code). */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @param {object} deps -
 * @param {() => object} deps.options - live resolved connection facts (carries `subscriptions`/`activeSubscription`/`apiKeyEnv`).
 * @param {(sub: object) => () => Promise<string>} deps.createKeyResolver - per-subscription bearer resolver.
 * @param {(sub: object) => Record<string, string>} deps.baseHeaders - attribution+session headers for `{base}/usage`.
 * @param {(reference: string) => Promise<string | undefined>} [deps.resolveCredential]
 *   - resolve ONE slot by name, `undefined` when it holds no value (never throws for a miss).
 * @param {(reference: string, value: string) => Promise<void>} [deps.setCredential]
 *   - write ONE slot (the live-slot mirror). Absent means "this composition cannot write credentials", and the mirror is simply skipped.
 * @param {(reference: string) => Promise<{ configured?: boolean, source?: string } | undefined>} [deps.describeCredential]
 *   - presence-only credential facts for the page (never the value).
 * @param {new (message: string, code: string) => Error} deps.LlmError - the host error class (injected: this module must load under bare `node --test`).
 * @param {(path?: string) => string} [deps.usageLayerPath] - where last-known usage persists.
 * @param {(...args: unknown[]) => Promise<object>} [deps.fetchImpl] - fetch.
 * @param {(level: string, message: string) => void} deps.log - the plugin log ring.
 * @param {() => number} [deps.now] - the clock.
 */
export function createSubRuntime(deps) {
  const now = deps.now ?? (() => Date.now())
  const layer = UsageLayer.load(deps.usageLayerPath?.())
  const usage = new UsageProbeCache({
    layer,
    now,
    fetchImpl: deps.fetchImpl,
    log: deps.log,
    ttlMs: () => deps.options().usagePollTtlMs,
    timeoutMs: () => deps.options().usageProbeTimeoutMs,
    resolveKey: (sub) => runtime.keyFor(sub),
    baseHeaders: (sub) => deps.baseHeaders(sub),
    // The gateway address is a ROUTE fact: every subscription probes the same
    // endpoint, only the bearer differs.
    baseURL: () => deps.options().baseURL,
  })

  /** @type {Map<string, { reference: string, resolve: () => Promise<string> }>} resolvers keyed by id */
  const resolvers = new Map()
  let lastSubs
  let lastSubsIdentity
  /**
   * What the live slot was last written with. The mirror is skipped when the
   * same active row's same value is already there, so a chat request does not
   * rewrite `.credentials.yaml`; a FAILED write is never remembered as done.
   */
  let projection = { liveRef: undefined, activeId: undefined, value: undefined, at: undefined, error: undefined }

  /**
   * Resolve one slot by name, or `undefined` when it holds nothing. The
   * credential seam throws on a miss (`MISSING_CREDENTIAL`); a miss is a normal
   * state here, so it is folded into `undefined` and everything else propagates.
   */
  async function slotValue(reference) {
    if (deps.resolveCredential === undefined) return undefined
    return await deps.resolveCredential(reference)
  }

  /** The LIVE slot's name, or `undefined` when the document names none. */
  function liveRef() {
    const ref = deps.options().apiKeyEnv
    return typeof ref === 'string' && ref.trim().length > 0 ? ref.trim() : undefined
  }

  const runtime = {
    usage,

    /** The resolved subscriptions, with stale per-sub runtime state dropped on change. */
    subs() {
      const list = deps.options().subscriptions
      if (list !== lastSubsIdentity) {
        lastSubsIdentity = list
        lastSubs = list
        // A resolver bound to a credential slot the configuration no longer
        // names must not linger: after a rename the next call has to build a
        // fresh one against the new slot.
        const live = new Set(list.map((sub) => sub.id))
        for (const id of [...resolvers.keys()]) if (!live.has(id)) resolvers.delete(id)
        // Orphaned balance measurements are stale by definition (the
        // `synced.prune` rule, applied to the usage layer).
        usage.dropAllMissing(list.map((sub) => sub.id))
      }
      return lastSubs
    },

    /** The ONE subscription that pays for every request right now. */
    active() {
      return activeSubscriptionOf(this.subs(), deps.options().activeSubscription)
    },

    /**
     * The bearer token for one subscription, resolved through its own slot.
     *
     * The row's CURRENT slot is the source of truth; when it holds nothing, the
     * spellings that row used to have are tried before the row is declared
     * keyless. That is what makes a RENAME harmless (the stable id-derived slot
     * still holds the key) and what keeps a key stored by an earlier version
     * reachable while `reconcile()` moves it across.
     */
    async keyFor(sub) {
      const reference = String(sub.apiKeyRef)
      const bound = resolvers.get(sub.id)
      let entry = bound
      if (entry === undefined || entry.reference !== reference) {
        entry = { reference, resolve: deps.createKeyResolver(sub) }
        resolvers.set(sub.id, entry)
      }
      try {
        return await entry.resolve()
      } catch (error) {
        if (error?.code !== 'MISSING_CREDENTIAL') throw error
        for (const fallback of sub.fallbackRefs ?? []) {
          const value = await slotValue(fallback)
          if (value !== undefined) return value
        }
        throw error
      }
    },

    /**
     * The LIVE slot's name — the single variable this plugin mirrors the active
     * key into. `undefined` only for a document that names no reference at all.
     */
    liveRef,

    /**
     * What the live slot currently holds, as far as this runtime knows: its
     * name, which row it was last pointed at, and the failure that stopped the
     * mirror. Read by the HTTP face.
     *
     * The VALUE never crosses this boundary. It is kept here only to skip a
     * redundant write, and the page has no use for it: a plugin whose whole
     * credential story is "the secret goes to the store and never rides back"
     * cannot also ship the active key to the browser in a payload.
     */
    projection() {
      const { pending, value, ...rest } = projection
      void pending
      void value
      return { liveRef: liveRef(), ...rest }
    },

    /**
     * Copy one value into the live slot, unless it is already there.
     *
     * Best-effort ON PURPOSE: a launcher that exports the live variable makes
     * the write impossible (the provider reports the slot `writable: false`),
     * and that must not take the route down — the request path reads the row's
     * OWN slot, so the mirror is an interoperability nicety, not the source of
     * truth. Such a slot is reported as "read-only, not mirrored" instead of
     * being hammered with a doomed write on every request.
     *
     * `alreadyLive` says the value CAME from the live slot (the pre-0.8.3
     * default-row fallback), so there is nothing to copy — only to record.
     */
    async syncLive(value, sub, { alreadyLive = false } = {}) {
      const reference = liveRef()
      if (deps.setCredential === undefined || reference === undefined) return
      const same = projection.liveRef === reference
        && projection.value === value
        && projection.activeId === sub?.id
      // `pending` marks a write that FAILED and therefore deserves a retry next
      // time; anything else (a settled write, a read-only slot) is sticky.
      if (same && projection.pending !== true) return
      if (alreadyLive) {
        projection = { liveRef: reference, activeId: sub?.id, value, at: now(), error: undefined }
        return
      }
      if (deps.describeCredential !== undefined) {
        const info = await deps.describeCredential(reference).catch(() => undefined)
        if (info !== undefined && info.writable === false) {
          projection = {
            liveRef: reference,
            activeId: sub?.id,
            value,
            at: now(),
            error: 'the launching environment supplies this slot, so it cannot be overwritten',
          }
          return
        }
      }
      try {
        await deps.setCredential(reference, value)
        projection = { liveRef: reference, activeId: sub?.id, value, at: now(), error: undefined }
      } catch (error) {
        const message = errorMessage(error)
        projection = { liveRef: reference, activeId: sub?.id, value, at: now(), error: message, pending: true }
        deps.log?.('warn', `could not mirror the active subscription into the live slot "${reference}": ${message}`)
      }
    },

    /**
     * Make the live slot agree with the ACTIVE subscription. Run at load and on
     * every settings change (a switch is a settings write), so the one visible
     * variable follows the pointer without waiting for a request.
     *
     * It also ADOPTS a value that only exists in the live slot into the default
     * row's own slot. That is the one-time upgrade of a document written by the
     * older design, where the live slot WAS the default row's key — without it,
     * switching away from `default` and back would report "no key for this row"
     * for a key the operator can plainly see in the page.
     *
     * And it MOVES a key found under a row's older spelling into its current
     * slot (`migrateSlots`), so a slot rename — or an upgrade from the
     * id-derived spelling — converges instead of leaving the page saying "no key
     * stored" about a row that works.
     *
     * @returns {Promise<object>} the resulting projection facts.
     */
    async reconcile() {
      const facts = deps.options()
      const list = this.subs()
      const active = activeSubscriptionOf(list, facts.activeSubscription)
      const reference = liveRef()
      if (reference === undefined) return this.projection()
      await migrateSlots(list)
      const live = await slotValue(reference)

      if (live !== undefined && await liveIsWritable(reference)) {
        // ONE row still benefits: the operator's key ends up in the row's own
        // slot, which is where the page says it is, and where switching will
        // look for it later. A slot the launching environment supplies
        // (`writable: false`) is skipped instead: that environment IS the store
        // for this row, and copying it to disk would be a surprise.
        const defaultSub = list.find((sub) => sub.isDefault === true)
        const ownsLive = defaultSub === undefined || active?.id === defaultSub.id
          ? true
          // Nothing but the active-default case claims the live value outright,
          // so ask whether some OTHER row already stores exactly it — that is
          // what a projection of that row looks like.
          : !(await hasSiblingWithValue(list, defaultSub, live))
        if (defaultSub !== undefined && ownsLive) {
          const own = await slotValue(defaultSub.apiKeyRef)
          if (own === undefined) await adoptInto(defaultSub, live)
        }
      }

      if (active !== undefined) {
        const own = await ownValueOf(active)
        if (own !== undefined) await this.syncLive(own, active)
      }
      return this.projection()
    },

    /**
     * The credential the request path uses, and the ONLY one it ever asks for.
     *
     * The active row's OWN slot first: that is the stored key and it cannot be
     * stale, whatever the live mirror did. The live slot is consulted only when
     * the row stores nothing — and only for the DEFAULT row, which is where a
     * pre-0.8.3 document kept its key. `reconcile()` is what moves such a value
     * into the row's own slot; the request path itself never writes.
     */
    async activeKey() {
      const sub = this.active()
      if (sub === undefined) {
        throw new deps.LlmError('opencode-go-native: no subscription is configured to serve this request', 'INVALID_CONFIG')
      }
      const own = await ownValueOf(sub)
      if (own !== undefined) {
        await this.syncLive(own, sub)
        return own
      }
      const reference = liveRef()
      if (sub.isDefault === true && reference !== undefined) {
        const live = await slotValue(reference)
        if (live !== undefined) {
          await this.syncLive(live, sub, { alreadyLive: true })
          return live
        }
      }
      // A hard stop with the resolver's own message, which names the ROW's slot:
      // there is no second subscription to fall back to by design, and silently
      // spending somebody else's key would be the failover this design removed.
      return await this.keyFor(sub)
    },

    /** Probe one subscription's balance now (never throws; the cache keeps the last good number). */
    refreshUsage(sub) {
      return usage.refresh(sub)
    },

    /**
     * Probe every configured subscription back-to-back (the page's 刷新余额).
     *
     * The TTL is deliberately ignored — an explicit act means "do not trust the
     * cache" — but a row with NO key is skipped in this mode too: there is no
     * balance behind an empty slot, and `Bearer undefined` would answer 401 and
     * read as a gateway failure on a row that only lacks a key.
     */
    async refreshAll() {
      for (const sub of this.subs()) {
        if (!(await this.hasKey(sub))) continue
        await usage.refresh(sub)
      }
      return this.rows()
    },

    /**
     * Probe only what is worth probing: the rows whose last GOOD reading is
     * older than the operator's `usagePollTtlMs`, and only those that actually
     * have a key to ask with. This is what the settings panel asks for when it
     * OPENS.
     *
     * The gate lives here rather than in the page on purpose: the TTL is an
     * operator setting, so the page must not carry a second copy of it, and "the
     * numbers on screen are stale" is a fact the host already knows. A keyless
     * row is skipped rather than probed with `Bearer undefined` — it has nothing
     * to report that the page's "no key" pill does not already say.
     */
    async refreshStale() {
      for (const sub of this.subs()) {
        if (usage.isFresh(sub.id)) continue
        if (!(await this.hasKey(sub))) continue
        await usage.refresh(sub)
      }
      return this.rows()
    },

    /**
     * Whether one subscription can be probed at all: a slot with a value in it.
     * A miss is a normal state (the row is simply unfilled), never an error.
     */
    async hasKey(sub) {
      try {
        const key = await this.keyFor(sub)
        return typeof key === 'string' && key.length > 0
      } catch {
        return false
      }
    },

    /**
     * The rows the page and the diagnostics surface read, SYNCHRONOUSLY: the
     * last-known balance, which row is active, and nothing that needs a probe.
     */
    rows({ nowMs = now() } = {}) {
      const activeId = this.active()?.id
      return this.subs().map((sub) => {
        const peeked = usage.peek(sub.id)
        return {
          id: sub.id,
          label: sub.label,
          apiKeyRef: sub.apiKeyRef,
          ...(sub.fallbackRefs === undefined ? {} : { fallbackRefs: sub.fallbackRefs }),
          isDefault: sub.isDefault === true,
          active: sub.id === activeId,
          usage: {
            windows: peeked.windows,
            checkedAt: peeked.checkedAt,
            ageMs: peeked.checkedAt === undefined ? undefined : nowMs - peeked.checkedAt,
            error: peeked.error,
          },
        }
      })
    },

    /**
     * The rows with credential PRESENCE folded in (one `describe` per slot, never
     * a value). Async because the credential seam is: the page wants "this row
     * has no key stored" before it can promise anything about that row.
     */
    async view() {
      const rows = this.rows()
      if (deps.describeCredential === undefined) return rows
      return await Promise.all(rows.map(async (row) => {
        const info = await deps.describeCredential(row.apiKeyRef).catch(() => undefined)
        if (info === undefined) return row
        if (info.configured === true || (row.fallbackRefs ?? []).length === 0) {
          return { ...row, configured: info.configured === true, source: typeof info.source === 'string' ? info.source : undefined }
        }
        // Not in its own slot — but the row may still hold a key under the
        // spelling it used to have (a rename, or an upgrade `reconcile()` has not
        // converged yet). Reporting "no key stored" then would be a lie the
        // operator cannot act on.
        for (const fallback of row.fallbackRefs) {
          const older = await deps.describeCredential(fallback).catch(() => undefined)
          if (older?.configured === true) {
            return { ...row, configured: true, source: typeof older.source === 'string' ? older.source : undefined }
          }
        }
        return { ...row, configured: false, source: undefined }
      }))
    },
  }

  /**
   * Move a key stored under a row's older spelling into its CURRENT slot.
   *
   * Slots are named after the subscription, so two events leave a key behind: a
   * rename (the new name-slug is empty, the stable id-derived spelling still has
   * it) and an upgrade from a version that spelled the slot differently. Reading
   * falls back either way, so nothing breaks if this is refused — it just makes
   * the page's "key stored" pill tell the truth again.
   */
  async function migrateSlots(list) {
    if (deps.setCredential === undefined) return
    for (const sub of list) {
      const fallbacks = sub.fallbackRefs ?? []
      if (fallbacks.length === 0) continue
      if (await slotValue(sub.apiKeyRef) !== undefined) continue
      for (const fallback of fallbacks) {
        const value = await slotValue(fallback)
        if (value === undefined) continue
        try {
          await deps.setCredential(sub.apiKeyRef, value)
          deps.log?.('info', `moved the stored key of "${sub.label}" into its slot "${sub.apiKeyRef}"`)
        } catch (error) {
          deps.log?.('warn', `could not move the stored key of "${sub.label}" into "${sub.apiKeyRef}": ${errorMessage(error)}`)
        }
        break
      }
    }
  }

  /**
   * Whether the live slot can be written at all. A slot the launching
   * environment supplies reports `writable: false`; an unanswerable seam stays
   * optimistic (the write itself will say so).
   */
  async function liveIsWritable(reference) {
    if (deps.describeCredential === undefined) return true
    const info = await deps.describeCredential(reference).catch(() => undefined)
    return info === undefined || info.writable !== false
  }

  /**
   * Resolve one row's OWN value, or `undefined` when that row stores nothing.
   * A missing credential is a normal state on this path (the live slot may still
   * carry the key, and the page shows "no key stored"); anything else — a
   * malformed slot name, an unusable value — propagates.
   */
  async function ownValueOf(sub) {
    try {
      return await runtime.keyFor(sub)
    } catch (error) {
      if (error?.code === 'MISSING_CREDENTIAL') return undefined
      throw error
    }
  }

  /**
   * Persist a live-slot value into one row's OWN slot, so the fallback is paid
   * for once. Only used for the DEFAULT row's one-time upgrade: a non-default
   * row with no stored key is "no key", never a reason to hand it the live one.
   */
  async function adoptInto(sub, value) {
    if (deps.setCredential === undefined) return
    if (await slotValue(sub.apiKeyRef) !== undefined) return
    try {
      await deps.setCredential(sub.apiKeyRef, value)
    } catch (error) {
      deps.log?.('warn', `could not adopt the live key into "${sub.apiKeyRef}": ${errorMessage(error)}`)
    }
  }

  /** Whether any row other than `except` stores exactly `value` in its own slot. */
  async function hasSiblingWithValue(list, except, value) {
    if (deps.resolveCredential === undefined) return false
    for (const sub of list) {
      if (sub.id === except.id) continue
      const own = await slotValue(sub.apiKeyRef)
      if (own !== undefined && own === value) return true
    }
    return false
  }

  return runtime
}
