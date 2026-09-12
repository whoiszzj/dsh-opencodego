/**
 * Learned protocol demotion: remember which (model, protocol) pairs this
 * endpoint has already refused *by format*, so the next request for that model
 * goes straight to a protocol that works instead of paying for the refusal
 * again.
 *
 * This is not a second decision table. The primary protocol still comes from
 * {@link import('./protocol-map.js').resolveProtocol} — configuration, then the
 * models.dev npm rule; this memo only reorders the *candidate chain* after the
 * endpoint has spoken, and only for failures that are a statement about the
 * protocol itself (a `401 … is not supported for format …` or the HTML 404 of a
 * path this gateway does not serve). Transient 5xx/network failures are never
 * remembered: they say nothing about the protocol.
 *
 * Entries expire, so a gateway that catches up with the npm rule is picked up
 * without a restart.
 *
 * @module dsh-opencodego/protocol-memo
 */

/** Default lifetime of one learned rejection. */
export const DEFAULT_PROTOCOL_MEMO_TTL_MS = 900_000

export class ProtocolRejectionMemo {
  /**
   * @param {object} [options] - the memo.
   * @param {number} [options.ttlMs] - how long a learned rejection lasts (default 15 min).
   * @param {() => number} [options.now] - clock seam for tests.
   */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_PROTOCOL_MEMO_TTL_MS
    this.now = typeof options.now === 'function' ? options.now : Date.now
    /** @type {Map<string, { protocol: string, expiresAt: number, reason: string }>} */
    this.entries = new Map()
  }

  /** The memo key for one model/protocol pair. */
  #key(modelId, protocol) {
    return `${modelId}\u0000${protocol}`
  }

  /**
   * Record an endpoint refusal.
   * @param {string} modelId - the gateway model id.
   * @param {string} protocol - the refused protocol.
   * @param {string} [reason] - the endpoint's own words, for diagnostics.
   */
  remember(modelId, protocol, reason = '') {
    this.entries.set(this.#key(modelId, protocol), {
      protocol,
      expiresAt: this.now() + this.ttlMs,
      reason,
    })
  }

  /**
   * Whether this pair is known to be refused and the knowledge is still fresh.
   * @param {string} modelId - the gateway model id.
   * @param {string} protocol - the protocol to test.
   * @returns {boolean} true when a fresh rejection is on record.
   */
  rejected(modelId, protocol) {
    const entry = this.entries.get(this.#key(modelId, protocol))
    if (entry === undefined) return false
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(this.#key(modelId, protocol))
      return false
    }
    return true
  }

  /**
   * Reorder a chain so learned-refused protocols come last, preserving the
   * relative order of everything else. The refused protocol stays in the chain:
   * if every alternative also fails, the request still ends with the endpoint's
   * true refusal instead of an empty attempt list.
   * @param {string} modelId - the gateway model id.
   * @param {readonly string[]} chain - the candidate chain.
   * @returns {string[]} the reordered chain.
   */
  demote(modelId, chain) {
    const fresh = []
    const refused = []
    for (const protocol of chain) {
      (this.rejected(modelId, protocol) ? refused : fresh).push(protocol)
    }
    return [...fresh, ...refused]
  }

  /** Learned refusals still in force, for diagnostics. */
  snapshot() {
    const now = this.now()
    return [...this.entries.values()]
      .filter((entry) => entry.expiresAt > now)
      .map(({ protocol, expiresAt, reason }) => ({ protocol, expiresAt, reason }))
  }

  /** Forget everything (used by configuration changes and tests). */
  clear() {
    this.entries.clear()
  }
}
