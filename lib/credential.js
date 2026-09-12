/**
 * The one place the bearer token's precedence is decided.
 *
 * One supported source, and one legacy value this plugin is in the middle of
 * removing:
 *
 *   1. `apiKeyEnv` — a credential REFERENCE resolved through the host's
 *      `ctx.credentials` seam (the inherited process environment wins, then
 *      `$DSH_HOME/.credentials.yaml`). The value never enters this plugin's
 *      settings document, which is the whole point: a settings file is a
 *      configuration file, not a secret store, and it is readable by anything
 *      that can read the harness home.
 *   2. `apiKey` — a LEGACY inline token. It exists only so a settings document
 *      written before 0.6.0 keeps working while the load-time migration
 *      (`migration.js`) moves it into the credential store and unsets it. It is
 *      consulted only when the reference resolves to nothing, and the caller is
 *      told through `onLegacy` so the fallback is logged rather than silent.
 *      Resolution does NOT prefer it: preferring a plain-text copy over the
 *      store is how a stale token keeps winning after the operator rotates the
 *      stored one.
 *
 * This module has **no host imports**, for the same reason `discovery.js` has
 * none: the repository carries no `node_modules` of its own, so anything that
 * statically imports `@deepseek-ai/dsh-*` cannot run under bare `node --test`.
 * The two host calls it needs are therefore injected as async factories — and
 * the real composition supplies them by re-exporting the very functions the
 * official plugins use, so there is no second implementation to drift:
 *
 *   - `credentialRefOf`: `credentialRef` (`@deepseek-ai/dsh-credentials`)
 *   - `usableApiKeyOf`: `assertUsableApiKey` (`@deepseek-ai/dsh-llm`)
 *
 * @module dsh-opencodego/credential
 */

import { PKG } from './vocab.js'

/**
 * The message the credential dead end carries.
 *
 * It names the one supported way out — put a value where the reference points —
 * and deliberately does NOT suggest pasting the token into the settings
 * document: that is the behaviour this plugin removed. The legacy field is
 * mentioned only as the state the operator is in, not as a recommendation.
 *
 * @param {string} reference - the configured reference name.
 * @returns {string} the error text.
 */
export function missingCredentialMessage(reference) {
  return `${PKG}: no API key for this route: the credential reference "${reference}" resolves to nothing. `
    + 'Store it through the credentials service (the web settings page writes it), export it in the '
    + 'environment, or put it in $DSH_HOME/.credentials.yaml, or point "apiKeyEnv" at a reference that '
    + 'exists. This plugin does not read a key out of the settings document any more. See README「配置」.'
}

/**
 * Resolve the bearer token for one connection snapshot.
 *
 * @param {object} args - the operation.
 * @param {{ apiKey?: string, apiKeyEnv: string }} args.options - resolved connection facts.
 * @param {object|undefined} args.credentials - the host `ctx.credentials` service, when present.
 * @param {new (message: string, code: string) => Error} args.LlmError - the host error class to throw.
 * @param {() => Promise<(value: string) => unknown>} args.credentialRefOf - brands a reference name; throws on a malformed one.
 * @param {() => Promise<(raw: unknown, pkg: string, ref: string) => string>} args.usableApiKeyOf - the host's own token check.
 * @param {() => void} [args.onLegacy] - called when the legacy inline `apiKey` is what supplied the token.
 * @returns {Promise<string>} the usable token.
 * @throws {Error} `LlmError` with code `MISSING_CREDENTIAL` when neither source supplies one.
 */
export async function resolveConnectionApiKey({
  options,
  credentials,
  LlmError,
  credentialRefOf,
  usableApiKeyOf,
  onLegacy,
}) {
  const { apiKey, apiKeyEnv: rawReference } = options
  const reference = typeof rawReference === 'string' ? rawReference.trim() : ''
  const usable = await usableApiKeyOf()

  // The reference first, and the only source that is allowed to be silent.
  // `credentialRefOf` both brands and validates the name, so a malformed
  // reference is a configuration error that surfaces even when a legacy token
  // is present — a fallback must not hide a typo. A blank reference is the one
  // case skipped outright: a pre-0.6.0 document may name none at all, and there
  // is nothing to resolve (or to report as malformed) in an empty name.
  if (reference.length > 0 && credentials !== undefined) {
    const named = await credentialRefOf()
    const hit = await credentials.resolve(named(reference))
    if (hit !== undefined) return usable(hit.value, PKG, reference)
  }

  // The legacy inline value. Consulted only after the reference missed, and
  // announced: silently using plain text on disk is the failure mode this whole
  // change exists to end.
  const inline = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (inline.length > 0) {
    onLegacy?.()
    return usable(inline, PKG, 'the legacy inline "apiKey" setting')
  }

  throw new LlmError(missingCredentialMessage(reference), 'MISSING_CREDENTIAL')
}

/**
 * Bind {@link resolveConnectionApiKey} to the live host functions.
 *
 * The host packages are imported **lazily inside an async factory**, so the
 * functions above are loadable (and testable) without a profile install; the
 * error class still has to be passed in, because the caller owns the codes.
 *
 * @param {object} deps - the host seams.
 * @param {() => object|undefined} deps.credentialsOf - reads `ctx.get('credentials')` on every call.
 * @param {() => object} deps.options - the current resolved connection facts.
 * @param {new (message: string, code: string) => Error} deps.LlmError - the host error class.
 * @param {() => void} [deps.onLegacy] - called when the legacy inline token was used.
 * @returns {() => Promise<string>} the resolver the adapter/catalog/discovery hooks call.
 */
export function createApiKeyResolver({ credentialsOf, options, LlmError, onLegacy }) {
  return () => resolveConnectionApiKey({
    options: options(),
    credentials: credentialsOf(),
    LlmError,
    credentialRefOf: async () => (await import('@deepseek-ai/dsh-credentials')).credentialRef,
    usableApiKeyOf: async () => (await import('@deepseek-ai/dsh-llm')).assertUsableApiKey,
    onLegacy,
  })
}
