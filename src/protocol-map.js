/**
 * Per-model wire-protocol resolution: which pi-ai API implementation one
 * gateway model id speaks, and — because this endpoint's behaviour is dynamic —
 * which protocols to fall back to when the primary one is refused.
 *
 * Precedence (DESIGN.md §2.2, phase-2 revision):
 *
 *   1. `protocolOverrides` from configuration — an operator decision always wins;
 *   2. the models.dev snapshot's `provider.npm` fact, through
 *      {@link PROTOCOL_NPM_RULE};
 *   3. the built-in bootstrap table, consulted only for a model the snapshot
 *      does not know at all (a brand-new id on a stale snapshot);
 *   4. {@link FALLBACK_PROTOCOL}, the provider's own default.
 *
 * Phase 1 folded a *live measurement* ("`deepseek-v4.1-flash` answers on both
 * `completions` and `responses`, so pin the stricter one") into this table.
 * That was wrong for two reasons: it contradicted the rule the audit made
 * authoritative, and it made the primary decision depend on a moment-in-time
 * probe. Phase 2 keeps the rule as the primary and records measured
 * alternatives separately, in {@link ALTERNATE_PROTOCOL_HINTS}, which the
 * ordered candidate chain consults *after* the primary.
 *
 * @module dsh-opencodego/protocol-map
 */

import { FALLBACK_PROTOCOL, SUPPORTED_PROTOCOLS } from './vocab.js'

export { FALLBACK_PROTOCOL }

/**
 * The models.dev `provider.npm` → pi-ai protocol rule (DESIGN.md §2.2).
 *
 * A model without its own `provider.npm` inherits the provider-level package,
 * which for `opencode-go` is `@ai-sdk/openai-compatible` → `openai-completions`.
 * @type {Readonly<Record<string, string>>}
 */
export const PROTOCOL_NPM_RULE = Object.freeze({
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/openai': 'openai-responses',
})

/** The npm package the `opencode-go` provider itself declares. */
export const PROVIDER_NPM_DEFAULT = '@ai-sdk/openai-compatible'

/**
 * Built-in bootstrap table: model id → protocol, for ids the versioned
 * models.dev snapshot does not contain.
 *
 * This exists so a brand-new endpoint model whose npm fact is not yet published
 * still gets a protocol better than "guess". It is deliberately tiny and only
 * lists ids whose OpenAI-Responses-only nature has been measured stable. The
 * three `deepseek-*` entries phase 1 pinned to `openai-responses` are gone:
 * the npm rule places them on `openai-completions` and the live endpoint
 * accepts both (see `data/protocol-matrix.*.json`), so they now carry
 * `openai-completions` as primary with `openai-responses` as a measured
 * alternate.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const BUILTIN_MODEL_PROTOCOLS = Object.freeze({
  'gpt-5.6-luna': 'openai-responses',
  'grok-4.5': 'openai-responses',
  'grok-4.6': 'openai-responses',
})

/**
 * Measured alternates, never primaries.
 *
 * Keyed by model id, each entry lists protocols this endpoint has been observed
 * to ACCEPT for that id besides the primary one. They exist so a primary that
 * happens to be refused right now — an overloaded route, a rule the gateway has
 * not caught up with, a bad `protocolOverrides` entry — still completes the
 * call. Evidence: `data/protocol-matrix.<date>.json` (regenerate with
 * `scripts/probe-protocols.mjs`).
 *
 * * the three `deepseek-*` entries answer on BOTH `openai-completions` and
 *   `openai-responses`;
 * * `minimax-m2.5`, `minimax-m3` and `qwen3.8-flash` are `@ai-sdk/anthropic` by
 *   the npm rule (now confirmed to work — see `baseUrlForProtocol`), and each
 *   also answers on `openai-completions`, which is the recovery candidate if the
 *   anthropic route is unavailable.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ALTERNATE_PROTOCOL_HINTS = Object.freeze({
  'deepseek-flash': Object.freeze(['openai-responses']),
  'deepseek-v4-flash-vision-exp': Object.freeze(['openai-responses']),
  'deepseek-v4.1-flash': Object.freeze(['openai-responses']),
  'minimax-m2.5': Object.freeze(['openai-completions']),
  'minimax-m3': Object.freeze(['openai-completions']),
  'qwen3.8-flash': Object.freeze(['openai-completions']),
})

/**
 * The protocol a `provider.npm` value implies.
 *
 * An absent value means "inherit the provider package" and an unrecognized one
 * means the snapshot knows a package this build has no rule for; both resolve to
 * the provider default instead of throwing, because a wrong-but-supported
 * protocol can still fall back at request time while a failed route cannot.
 * @param {unknown} npm - the model's `provider.npm` (or `null` for "inherited").
 * @returns {string} one of {@link SUPPORTED_PROTOCOLS}.
 */
export function protocolForNpm(npm) {
  if (npm === undefined || npm === null || npm === PROVIDER_NPM_DEFAULT) return FALLBACK_PROTOCOL
  return PROTOCOL_NPM_RULE[npm] ?? FALLBACK_PROTOCOL
}

/** True when an npm name is one this build has a rule for (or the provider default). */
export function hasNpmRule(npm) {
  return npm === undefined || npm === null || npm === PROVIDER_NPM_DEFAULT || Object.hasOwn(PROTOCOL_NPM_RULE, npm)
}

/** Reject an override naming a protocol this build cannot dispatch. */
function assertSupported(modelId, protocol, source) {
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    throw new Error(
      `opencode-go-native: ${source}["${modelId}"] names "${protocol}", `
      + `which this build cannot serve; supported protocols are ${SUPPORTED_PROTOCOLS.join(', ')}`,
    )
  }
}

/**
 * Resolve the primary wire protocol for one model id.
 *
 * @param {string} modelId - the gateway model id.
 * @param {object} [facts] - everything the decision may read.
 * @param {Record<string, string>} [facts.overrides] - resolved `protocolOverrides`.
 * @param {string | null | undefined} [facts.snapshotNpm] - the snapshot's
 *   per-model `provider.npm`: a string when the catalog overrides the provider
 *   package, `null` when the model is in the snapshot but inherits it, and
 *   `undefined` when the snapshot does not know the model.
 * @returns {{ primary: string, source: string }} the decision and its provenance.
 */
export function resolveProtocol(modelId, facts = {}) {
  const override = facts.overrides?.[modelId]
  if (override !== undefined) {
    assertSupported(modelId, override, 'protocolOverrides')
    return { primary: override, source: 'config-override' }
  }
  if (facts.snapshotNpm !== undefined) {
    return { primary: protocolForNpm(facts.snapshotNpm), source: 'models.dev-npm' }
  }
  const builtin = BUILTIN_MODEL_PROTOCOLS[modelId]
  if (builtin !== undefined) return { primary: builtin, source: 'builtin-bootstrap' }
  return { primary: FALLBACK_PROTOCOL, source: 'provider-default' }
}

/**
 * The primary protocol for one model id (phase-1 compatible entry point).
 * @param {string} modelId - the gateway model id.
 * @param {Record<string, string>} [overrides] - resolved `protocolOverrides`.
 * @param {string | null | undefined} [snapshotNpm] - the snapshot's npm fact.
 * @returns {string} one of {@link SUPPORTED_PROTOCOLS}.
 */
export function protocolForModel(modelId, overrides, snapshotNpm) {
  return resolveProtocol(modelId, { overrides, snapshotNpm }).primary
}

/**
 * The ordered candidate protocol chain for one model id: the primary first,
 * then every protocol worth trying if the primary is refused before it has
 * produced any output.
 *
 * Order: primary → measured alternates ({@link ALTERNATE_PROTOCOL_HINTS}) → the
 * npm rule's own answer (so a primary forced by a bad override can still
 * recover) → {@link FALLBACK_PROTOCOL}. Duplicates are removed and the chain is
 * capped by `maxAttempts`, so a request can never fan out unboundedly.
 *
 * @param {string} modelId - the gateway model id.
 * @param {object} [facts] - as {@link resolveProtocol}, plus:
 * @param {number} [facts.maxAttempts] - cap on the chain length (default 3).
 * @param {boolean} [facts.includeFallback] - append {@link FALLBACK_PROTOCOL} (default true).
 * @returns {string[]} a non-empty, duplicate-free chain of supported protocols.
 */
export function protocolChainForModel(modelId, facts = {}) {
  const { primary } = resolveProtocol(modelId, facts)
  const chain = [primary]
  for (const hint of ALTERNATE_PROTOCOL_HINTS[modelId] ?? []) {
    if (SUPPORTED_PROTOCOLS.includes(hint)) chain.push(hint)
  }
  if (facts.snapshotNpm !== undefined) {
    const rule = protocolForNpm(facts.snapshotNpm)
    if (rule !== primary) chain.push(rule)
  }
  if (facts.includeFallback !== false) chain.push(FALLBACK_PROTOCOL)
  const ordered = [...new Set(chain)].filter((protocol) => SUPPORTED_PROTOCOLS.includes(protocol))
  const cap = Number.isSafeInteger(facts.maxAttempts) && facts.maxAttempts > 0 ? facts.maxAttempts : 3
  return ordered.slice(0, cap)
}
