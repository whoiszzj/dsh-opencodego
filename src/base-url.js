/**
 * Base-URL normalization, host-free so `subs.js` can validate a per-
 * subscription override without importing `config.js` (which carries the
 * schemastery schema). `config.js` re-exports it — one implementation, one
 * address.
 *
 * @module dsh-opencodego/base-url
 */

import { PKG } from './vocab.js'

/**
 * Normalize a gateway base: trim, drop trailing slashes, and require an
 * absolute http(s) URL. Failing here names the setting to fix instead of
 * surfacing later as an opaque fetch failure.
 * @param {string} raw - the configured base.
 * @returns {string} the normalized base with no trailing slash.
 */
export function normalizeBaseUrl(raw) {
  const base = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`${PKG}: baseURL must be an absolute http(s) URL including the /v1 prefix, e.g. https://opencode.ai/zen/go/v1 (got: ${String(raw ?? '').trim()})`)
  }
  return base
}
