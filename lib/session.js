/**
 * Session-header resolution for the OpenCode relay.
 *
 * the design notes §2.4/§2.4.1 record the measured relay behaviour: a request WITHOUT
 * a recognised session header answers `400 MissingSessionID`, and the relay
 * accepts only a short whitelist of names (`x-opencode-session`,
 * `x-deepseek-harness-session-id`) — it is NOT "any header will do". §2.3
 * records that pi-ai cannot emit `x-opencode-session` through any
 * `compat.sessionAffinityFormat`, so the header reaches the wire through the
 * adapter's own request headers (`requestHeaders` below).
 *
 * PHASE NOTE (read this before "fixing" it): the phase-1 brief allowed the
 * header to be accepted as configuration without being sent. Live acceptance
 * proved that impossible — every streaming request against the real endpoint is
 * refused with `400 MissingSessionID` — so the header is ACTIVE by default
 * here. Phase 3 hardened it: the accepted-name list is measured and frozen
 * (`scripts/probe-session-headers.mjs`, the design notes §2.4.1), the 400 gate is a
 * re-runnable live regression, and the value policy is documented (§2.4.2:
 * `uuid` is deliberately process-stable, NOT persisted across restarts).
 *
 * This module is host-import-free on purpose: name/mode validation, the value
 * policy and the header merge are unit-tested with a bare `node --test`.
 *
 * @module dsh-opencodego/session
 */

import { PKG, SESSION_HEADER_MODES } from './vocab.js'

/** The value policy used when configuration says nothing. */
export const DEFAULT_SESSION_HEADER_MODE = 'session-id'

/**
 * The characters RFC 7230 permits in an HTTP header FIELD NAME (`token`).
 *
 * A configured name that falls outside this set is refused with a named error
 * instead of being handed to `fetch`, where the failure would surface as an
 * opaque transport error (or, worse, be folded into a different header).
 */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/

/**
 * Validate and normalize a session-header value policy.
 *
 * The one implementation used by BOTH the settings schema (`config.js` builds
 * its `z.union` from `SESSION_HEADER_MODES`) and the runtime resolve step, so
 * the two cannot drift.
 * @param {unknown} raw - the configured mode.
 * @returns {'session-id' | 'uuid'} the normalized mode.
 */
export function normalizeSessionHeaderMode(raw) {
  if (raw === undefined || raw === null) return DEFAULT_SESSION_HEADER_MODE
  if (typeof raw !== 'string' || !SESSION_HEADER_MODES.includes(raw)) {
    throw new Error(
      `${PKG}: sessionHeaderMode must be one of ${SESSION_HEADER_MODES.map((mode) => `"${mode}"`).join(' or ')} `
      + `(got: ${typeof raw === 'string' ? `"${raw}"` : String(raw)})`,
    )
  }
  return raw
}

/**
 * Validate and normalize a session-header name.
 *
 * Header names are case-insensitive on the wire, so the configured name is
 * lower-cased once here and every later comparison is against lower case.
 * @param {unknown} raw - the configured header name.
 * @returns {string} the lower-cased, trimmed, syntactically valid name.
 */
export function normalizeSessionHeaderName(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  if (name.length === 0) {
    throw new Error(`${PKG}: sessionHeader must be a non-empty header name (or set sessionHeaderEnabled: false)`)
  }
  if (!HEADER_NAME_TOKEN.test(name)) {
    throw new Error(
      `${PKG}: sessionHeader "${name}" is not a valid HTTP header name `
      + '(only RFC 7230 token characters are allowed)',
    )
  }
  return name
}

/**
 * Resolve the session header value for one request.
 *
 * Preference order:
 *  1. `session-id` mode with a host `GenerateOptions.sessionId`: that id is
 *     forwarded verbatim (stable across the turns of one conversation AND
 *     across restarts);
 *  2. `uuid` mode: an opaque, process-stable UUID minted once per conversation
 *     (see the design notes §2.4.2 — deliberately NOT persisted across restarts);
 *  3. no host id at all: a UUID minted once per process, so a hand-built
 *     one-shot call is still routable and every such call shares one opaque
 *     value rather than inventing a new one per request.
 *
 * Entries are keyed by `mode \u0000 hostId`, so:
 *  * an unrelated settings change never re-mints a value (the conversation's
 *    relay affinity survives it);
 *  * switching `sessionHeaderMode` DOES take effect on the next request,
 *    without disturbing the values already handed out under the other mode.
 */
export class SessionHeaderMap {
  /**
   * @param {'session-id' | 'uuid'} [mode] - the initial value policy; a per-call
   *   mode overrides it.
   */
  constructor(mode = DEFAULT_SESSION_HEADER_MODE) {
    this.mode = normalizeSessionHeaderMode(mode)
    /** @type {Map<string, string>} */
    this.values = new Map()
  }

  /** Mint an opaque, process-stable value. */
  #mint() {
    return globalThis.crypto.randomUUID()
  }

  /**
   * The header value for one request.
   * @param {unknown} sessionId - the host's `GenerateOptions.sessionId`, when present.
   * @param {'session-id' | 'uuid'} [mode] - the current value policy.
   * @returns {string} a non-empty opaque token.
   */
  valueFor(sessionId, mode = this.mode) {
    const resolvedMode = normalizeSessionHeaderMode(mode)
    const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId)
    const key = `${resolvedMode}\u0000${raw}`
    const existing = this.values.get(key)
    if (existing !== undefined) return existing
    const value = resolvedMode === 'uuid' || raw.length === 0 ? this.#mint() : raw
    this.values.set(key, value)
    return value
  }
}

/**
 * Merge the mandatory attribution headers with the configured session header.
 *
 * Invariants (unit-tested in `tests/session.test.mjs`):
 *  * attribution is ALWAYS present — a misconfigured `sessionHeader` can never
 *    strip the product identity the host requires on every request;
 *  * a name collision is decided case-insensitively in attribution's favour;
 *  * an absent, empty or syntactically unusable name, and an empty value, all
 *    mean "no session header" rather than a malformed request;
 *  * the input object is never mutated.
 *
 * @param {Record<string, string>} attribution - `attributionHeaders()`.
 * @param {string | undefined} headerName - configured header name; empty/`undefined` disables it.
 * @param {string} value - the resolved session value.
 * @returns {Record<string, string>} the wire headers.
 */
export function requestHeaders(attribution, headerName, value) {
  const headers = { ...attribution }
  if (headerName === undefined || headerName === null) return headers
  const name = String(headerName).trim().toLowerCase()
  if (name.length === 0) return headers
  // An empty value cannot route: the relay's gate is about a non-empty id.
  // Omitting the header keeps the failure legible (`MissingSessionID`) instead
  // of sending a header the relay will reject on its value.
  if (value === undefined || value === null || String(value).length === 0) return headers
  const reserved = new Set(Object.keys(attribution).map((key) => key.toLowerCase()))
  if (reserved.has(name)) return headers
  return { ...headers, [name]: String(value) }
}
