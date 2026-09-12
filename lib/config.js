/**
 * Plugin identity plus the configuration shape, its defaults, and the one
 * explicit "resolve" step from raw config to validated connection facts.
 *
 * The adapter never reads raw config: every operation re-resolves through
 * {@link resolveOptions}, so a configuration change reaches the next request
 * without a restart, while an in-flight request keeps the snapshot it started
 * with.
 *
 * `SUPPORTED_PROTOCOLS` and `FALLBACK_PROTOCOL` live in `vocab.js` (which has
 * no host imports) and are re-exported here so the configuration surface stays
 * the one place a reader has to look for "what can this plugin be told to do".
 *
 * @module dsh-opencodego/config
 */

import z from '@deepseek-ai/schemastery'
import { normalizeModelOverlay } from './models.js'
import { normalizeSessionHeaderMode, normalizeSessionHeaderName } from './session.js'
import {
  FALLBACK_PROTOCOL,
  HOST_THINKING_LEVELS,
  PKG,
  SESSION_HEADER_MODES,
  SUPPORTED_PROTOCOLS,
} from './vocab.js'

export {
  FALLBACK_PROTOCOL,
  HOST_THINKING_LEVELS,
  PKG,
  SESSION_HEADER_MODES,
  SUPPORTED_PROTOCOLS,
}

// The model-set vocabulary lives in `models.js` (host-free, unit-tested) and is
// re-exported here so a reader looking for "what can this plugin be told to do"
// still has one entry point.
export {
  CONFIGURABLE_INPUT_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS,
  effectiveModelIds,
  EMPTY_OVERLAY,
  MODEL_EXTRA_KEYS,
  MODEL_OVERRIDE_KEYS,
  MODEL_SET_KEYS,
  modelSource,
  normalizeModelOverlay,
} from './models.js'

/** The one provider route this plugin owns. Deliberately NOT `opencode-go`. */
export const PROVIDER = 'opencode-go-native'

/** User-settings namespace. Reserved for the phase-4 settings page. */
export const NS = 'opencode-go-native'

/** Default OpenCode Go gateway base, including the `/v1` prefix. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Default credential reference: the environment-variable-name style. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/**
 * Default session header name. ACTIVE by default, not merely accepted:
 * the design notes §2.4 measured that the relay refuses any request without a
 * recognised session header (`400 MissingSessionID`), so a plugin that did not
 * send it could never complete a real streaming request.
 */
export const DEFAULT_SESSION_HEADER = 'x-opencode-session'

/** Conservative output cap used when a model carries no exact fact. */
export const DEFAULT_MAX_TOKENS = 131_072

/** Conservative context capacity used when a model carries no exact fact. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Default idle ceiling while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Default cap on how many candidate protocols one request may try. */
export const DEFAULT_MAX_PROTOCOL_ATTEMPTS = 3

/** Default tries per protocol for a transient (5xx/network) failure. */
export const DEFAULT_TRANSIENT_ATTEMPTS_PER_PROTOCOL = 2

/** Default lifetime of a learned "this endpoint refuses that protocol" note. */
export const DEFAULT_PROTOCOL_MEMO_TTL_MS = 900_000

/**
 * Default request-image policy, mirroring the official `dsh-llm-pi-ai`
 * profile defaults: the pixel budget and encoded-byte target the attachment
 * service uses to derive one request version per image.
 */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304

/** Default encoded-byte target for one request image. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576

/** Default accumulated request-image byte budget before the oldest are offloaded. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20_971_520

/**
 * @typedef {object} Config
 * @property {string} [baseURL] Gateway base including `/v1`.
 * @property {string} [apiKey] LEGACY inline bearer token. Still READ so a settings document written before 0.6.0 keeps working and can be migrated, but this plugin never writes it: the token belongs in the credential store, and its presence here is reported as a migration warning. Resolution prefers the `apiKeyEnv` reference and only falls back to this value, loudly.
 * @property {string} [apiKeyEnv] Credential reference resolved through ctx.credentials. The only supported credential source.
 * @property {string} [sessionHeader] Session header name.
 * @property {boolean} [sessionHeaderEnabled] Whether that header is sent at all.
 * @property {'session-id' | 'uuid'} [sessionHeaderMode] Forward the host session id, or an opaque per-process UUID.
 * @property {Record<string, string>} [protocolOverrides] Legacy alias of `models.overrides[id].api`; still honoured, still second to it.
 * @property {object} [models] The additive model-set overlay: `{ disabled, extra, overrides, replaceDiscovered }`.
 * @property {boolean} [snapshotEnabled] Use the plugin's bundled model-state file for capabilities and protocol rules. Read locally, never fetched at runtime; refresh it deliberately with `npm run models:fetch`.
 * @property {boolean} [protocolFallback] Keep `openai-completions` as the last candidate for every model.
 * @property {boolean} [honorProtocolOverrides] An explicit pin is never reordered by the learned-refusal memo.
 * @property {number} [requestImagePixelBudget] Pixel budget for one request image.
 * @property {number} [requestImageMaxBytes] Encoded-byte target for one request image.
 * @property {number} [maxRequestImageBytes] Accumulated image-byte budget before the oldest are offloaded.
 * @property {number} [maxProtocolAttempts] Cap on the candidate protocol chain length.
 * @property {number} [transientAttemptsPerProtocol] Tries per protocol for a transient failure.
 * @property {number} [protocolMemoTtlMs] How long a learned protocol refusal is honoured; 0 disables the memo.
 * @property {boolean} [sync] Discover the model list at startup. OFF by default since 0.6.8: every consumer (the settings page, the host's model list, the first request) refreshes on demand through the catalog's TTL, so a boot-time fetch only adds a network call nobody waits for.
 * @property {number} [syncTtlMs] How long a successful discovery stays fresh.
 * @property {number} [defaultContextWindow] Fallback context capacity.
 * @property {number} [defaultMaxTokens] Fallback per-request output cap.
 * @property {number} [streamIdleTimeoutMs] Idle ceiling per outstanding stream read.
 * @property {boolean} [debug] Verbose discovery diagnostics.
 */

/**
 * Configuration schema. Every field is optional in yml. `apiKeyEnv` is a
 * credential *reference*, never the secret: the value lives in the credentials
 * plane and the plugin only ever names the variable. It carries
 * `role('credential-ref')`, exactly like the official
 * `dsh-llm-pi-ai` / `dsh-llm-deepseek` profiles, so a settings surface can
 * recognize the field as a reference rather than a value.
 *
 * `apiKey` is DECLARED but deprecated, and only so a document written before
 * 0.6.0 can still be read and migrated. It holds the token itself, so it is
 * plain text on disk (`~/.dsh/settings.yaml`) and any process that can read that
 * file can read the token — which is exactly why this plugin no longer writes
 * it. It stays `role('secret')` so the host's `redactSecrets` walker strips it
 * from every wire response (`@deepseek-ai/dsh-settings`,
 * `redactSecrets`); a `credential-ref` field holding a value would ride the
 * settings read back to the browser as plain text (see PROGRESS「凭据优先级」).
 *
 * Resolution order is decided once, in `src/credential.js`: the `apiKeyEnv`
 * reference first, then the legacy inline value with a loud warning. A load-time
 * migration (`src/migration.js`) moves the legacy value into the credential
 * store and unsets the settings field, so plain text does not stay behind.
 * See README「配置」.
 *
 * The three `sessionHeader*` fields deliberately keep no second source of
 * truth: `sessionHeaderMode`'s union is built from `SESSION_HEADER_MODES`, and
 * the runtime checks are `session.js`'s `normalizeSessionHeaderName` /
 * `normalizeSessionHeaderMode` — the same functions the unit tests exercise
 * without a host install.
 *
 * `protocolOverrides` ships EMPTY. Phase 1 seeded it with
 * `{ "minimax-m2.7": "openai-completions" }` because the installed pi-ai
 * catalog disagreed with the models.dev npm rule about that one model; phase 2
 * measured that the disagreement is moot — this gateway serves no
 * `anthropic-messages` path at all (HTML 404) — and made the primary decision
 * data-driven (versioned snapshot + `ALTERNATE_PROTOCOL_HINTS` + runtime
 * fallback). A seeded override would therefore be a second, invisible source of
 * truth that silently beats the snapshot. Operators can still pin any model
 * here; the field is the documented first-priority input.
 */
export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  // Legacy, migration-only (see the schema note above). Never written by this
  // plugin's settings page; kept declared so a pre-0.6.0 document still resolves
  // and can be migrated instead of silently losing its credential.
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  sessionHeader: z.string().default(DEFAULT_SESSION_HEADER),
  sessionHeaderEnabled: z.boolean().default(true),
  sessionHeaderMode: z.union([...SESSION_HEADER_MODES]).default('session-id'),
  // The phase-2 spelling of a per-model protocol pin, kept as an alias of
  // `models.overrides[id].api` (which wins when both are present). See
  // `models.js` for the precedence and the shadowing diagnostic.
  protocolOverrides: z.dict(z.string()).default({}),
  // The phase-4a model-set overlay. Declared as a passthrough on purpose: its
  // schema is three shapes of its own (`models.js`'s key allowlists) and a
  // schemastery rendering of it would be a second, weaker copy of those rules —
  // one that the settings form would render while `resolveOptions` judged
  // differently. `validate` rejects with the precise field path instead, and
  // `resolveOptions` re-judges every value at request time. The settings page
  // renders this field with the shapes documented in README「模型集合」.
  // `replaceDiscovered: true` is the SHIPPED default: a fresh install loads NO
  // models, and the operator activates what they want from "获取可用模型". The
  // alternative (an empty set meaning "everything the gateway advertises") is a
  // list nobody chose, growing every time the provider adds a model.
  models: z.any().default({ disabled: [], extra: [], overrides: {}, replaceDiscovered: true }),
  // The plugin's bundled model-state file (`data/opencode-go.models.json`):
  // capabilities + the npm protocol rule, read at load from disk ONLY. The
  // runtime never fetches models.dev or any other third party (two sources of
  // truth by design: this file, and the gateway's /models list); an operator
  // resyncs the file deliberately with `npm run models:fetch`. Off ⇒
  // conservative defaults + the bootstrap protocol table.
  snapshotEnabled: z.boolean().default(true),
  protocolFallback: z.boolean().default(true),
  honorProtocolOverrides: z.boolean().default(true),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxProtocolAttempts: z.number().step(1).min(1).max(8).default(DEFAULT_MAX_PROTOCOL_ATTEMPTS),
  transientAttemptsPerProtocol: z.number().step(1).min(1).max(3).default(DEFAULT_TRANSIENT_ATTEMPTS_PER_PROTOCOL),
  protocolMemoTtlMs: z.number().step(1).min(0).default(DEFAULT_PROTOCOL_MEMO_TTL_MS),
  sync: z.boolean().default(false),
  syncTtlMs: z.number().step(1).min(0).default(60_000),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  debug: z.boolean().default(false),
})

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

/** A bounded positive integer from config, or the caller's error. */
function boundedInteger(value, fallback, { min, max }, name) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${PKG}: ${name} must be an integer between ${min} and ${max} (got: ${String(resolved)})`)
  }
  return resolved
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here.
 * @param {Config} [config] - raw plugin config or a resolved settings snapshot.
 * @returns {object} validated, detached connection facts.
 */
export function resolveOptions(config = {}) {
  const baseURL = normalizeBaseUrl(config.baseURL ?? DEFAULT_BASE_URL)

  // The inline value, or `undefined` when absent/blank. It is LEGACY: the
  // migration reads it out of the stored document, and `credential.js` only
  // consults it when the reference resolves to nothing. Trimming here is what
  // makes that a *value* decision rather than a presence decision.
  const inlineKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  const apiKey = inlineKey.length > 0 ? inlineKey : undefined

  const apiKeyEnv = String(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV).trim()
  // A blank reference is an error unless a legacy inline token is still present:
  // that document predates this field and must keep resolving until the
  // migration has moved the token into the credential store. Demanding a
  // reference there would take a working route down over a field the operator
  // never touched.
  if (apiKeyEnv.length === 0 && apiKey === undefined) {
    throw new Error(`${PKG}: apiKeyEnv must name a credential reference (e.g. ${DEFAULT_API_KEY_ENV})`)
  }

  const sessionHeaderEnabled = config.sessionHeaderEnabled !== false
  // One implementation, shared with the settings schema (see `session.js`):
  // the name is trimmed, lower-cased and checked against the RFC 7230 token
  // charset, and the mode is checked against `SESSION_HEADER_MODES`. A
  // disabled header skips the name check entirely — nothing will be sent, so
  // an empty name is not an error in that state.
  const sessionHeader = sessionHeaderEnabled
    ? normalizeSessionHeaderName(config.sessionHeader ?? DEFAULT_SESSION_HEADER)
    : undefined
  const sessionHeaderMode = normalizeSessionHeaderMode(config.sessionHeaderMode)

  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error(`${PKG}: defaultContextWindow must be a positive integer`)
  }

  const defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0) {
    throw new Error(`${PKG}: defaultMaxTokens must be a positive safe integer`)
  }

  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${PKG}: streamIdleTimeoutMs must be a positive finite number`)
  }

  const syncTtlMs = config.syncTtlMs ?? 60_000
  if (!Number.isFinite(syncTtlMs) || syncTtlMs < 0) {
    throw new Error(`${PKG}: syncTtlMs must be a finite non-negative number`)
  }

  const maxProtocolAttempts = boundedInteger(
    config.maxProtocolAttempts,
    DEFAULT_MAX_PROTOCOL_ATTEMPTS,
    { min: 1, max: 8 },
    'maxProtocolAttempts',
  )
  const transientAttemptsPerProtocol = boundedInteger(
    config.transientAttemptsPerProtocol,
    DEFAULT_TRANSIENT_ATTEMPTS_PER_PROTOCOL,
    { min: 1, max: 3 },
    'transientAttemptsPerProtocol',
  )
  const protocolMemoTtlMs = config.protocolMemoTtlMs ?? DEFAULT_PROTOCOL_MEMO_TTL_MS
  if (!Number.isFinite(protocolMemoTtlMs) || protocolMemoTtlMs < 0) {
    throw new Error(`${PKG}: protocolMemoTtlMs must be a finite non-negative number (0 disables it)`)
  }

  const requestImagePixelBudget = config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) {
    throw new Error(`${PKG}: requestImagePixelBudget must be a positive safe integer`)
  }
  const requestImageMaxBytes = config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  if (!Number.isSafeInteger(requestImageMaxBytes) || requestImageMaxBytes <= 0) {
    throw new Error(`${PKG}: requestImageMaxBytes must be a positive safe integer`)
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error(`${PKG}: maxRequestImageBytes must be a positive safe integer`)
  }

  // The model-set overlay (phase 4a) and its legacy `protocolOverrides` alias
  // are normalized together, in one place, so the precedence between them is
  // decided once. Every rejection names the field path (`models.extra[1].api`),
  // which is what makes a settings write's error actionable.
  const models = normalizeModelOverlay(config)
  const protocolOverrides = Object.freeze(Object.fromEntries(
    Object.entries(models.overrides)
      .filter(([, claims]) => claims.api !== undefined)
      .map(([id, claims]) => [id, claims.api]),
  ))

  return {
    baseURL,
    apiKey,
    apiKeyEnv,
    sessionHeaderEnabled,
    sessionHeader: sessionHeaderEnabled ? sessionHeader : undefined,
    sessionHeaderMode,
    protocolOverrides,
    models,
    snapshotEnabled: config.snapshotEnabled !== false,
    protocolFallback: config.protocolFallback !== false,
    honorProtocolOverrides: config.honorProtocolOverrides !== false,
    requestImagePixelBudget,
    requestImageMaxBytes,
    maxRequestImageBytes,
    maxProtocolAttempts,
    transientAttemptsPerProtocol,
    protocolMemoTtlMs,
    sync: config.sync !== false,
    syncTtlMs,
    defaultContextWindow,
    defaultMaxTokens,
    streamIdleTimeoutMs,
    debug: config.debug === true,
  }
}
