/**
 * Browser-trust fence for this plugin's read-only HTTP surface.
 *
 * Phase 4a exposes the diagnostics payload (`adapter.logged` + `adapter.health`)
 * and the model-discovery draft over one prefix route so the phase-4b settings
 * page can fetch them. A route on the GUI's origin is reachable by the browser,
 * so it needs the same fence the `/api` gateway and the other Web plugins apply:
 * the `Host` header must name a loopback (or deployed) authority, and the
 * browser's cross-site markers must be absent.
 *
 * This is a **DNS-rebinding / cross-site defense, not authentication** — stated
 * plainly because a route that describes a provider (its base URL, its model
 * ids, its last 200 log lines) must not be readable by a random page the user
 * happens to open. It is deliberately described as the weaker of the two claims.
 *
 * Host-free and pure, so `tests/http.test.mjs` covers every branch without a
 * server.
 *
 * @module dsh-opencodego/http
 */

/**
 * Normalize a `Host`/`Origin` authority.
 * @param {string} authority - raw authority text.
 * @returns {URL | undefined} the parsed URL, or `undefined` when unparsable.
 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a hostname names the local loopback authority.
 * @param {string} hostname - a URL hostname.
 * @returns {boolean} true for `localhost`, `[::1]`, or any `127.x.y.z`.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach the plugin's HTTP surface.
 * @param {{ headers: Record<string, string | string[] | undefined> }} request - HTTP request facts.
 * @param {readonly string[]} [trustedHosts] - non-loopback authorities this deployment serves.
 * @returns {boolean} true when the request carries this origin's browser markers.
 */
export function isTrustedApiRequest(request, trustedHosts = []) {
  const header = (name) => {
    const value = request?.headers?.[name]
    return typeof value === 'string' ? value : undefined
  }
  const host = header('host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header('sec-fetch-site') === 'cross-site') return false
  // The Origin fence binds only when the browser attached one: a same-hostname
  // Origin passes (some Chromium builds serialize a non-default-port loopback
  // Origin without the port), an absent Origin passes (the Host fence already
  // bound the authority), and the literal "null" — a sandboxed iframe or a
  // file: page — is an opaque origin and is refused.
  const origin = header('origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
