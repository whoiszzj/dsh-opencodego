/**
 * Vocabulary shared by every module of this plugin, deliberately free of host
 * imports so the decision logic (protocol rules, capability mapping, fallback
 * classification) can be unit-tested with a bare `node --test` instead of a
 * full profile install.
 *
 * The values here are not invented: each one is copied from the surface the
 * host package actually exposes, with the source named in the comment. A drift
 * between this file and the host is a bug this plugin must fail on rather than
 * silently absorb.
 *
 * @module dsh-opencodego/vocab
 */

/** Diagnostics prefix for every message this plugin raises. */
export const PKG = 'opencode-go-native'

/**
 * The wire protocols this plugin can dispatch to in pi-ai.
 *
 * Source: `@earendil-works/pi-ai`'s `Api` union plus the three lazy entry
 * points this plugin imports (`api/openai-completions.lazy`,
 * `api/openai-responses.lazy`, `api/anthropic-messages.lazy`).
 */
export const SUPPORTED_PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/** The pi-ai protocol used when nothing more specific is known. */
export const FALLBACK_PROTOCOL = 'openai-completions'

/**
 * Every pi-ai thinking level, in pi-ai's own escalation order.
 *
 * Source: `@earendil-works/pi-ai/dist/models.js` (`EXTENDED_THINKING_LEVELS`)
 * and `dist/types.d.ts` (`ThinkingLevel` / `ModelThinkingLevel`). `off` is the
 * one level in this list that pi-ai's *request* options cannot carry — it is
 * expressed by omitting the reasoning option — which is why {@link
 * HOST_THINKING_LEVELS} includes it but `StreamOptions.reasoning` does not.
 */
export const HOST_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/**
 * The request modalities the host's model vocabulary can carry.
 *
 * Source: `@deepseek-ai/dsh-llm` `ModelModalityMap` (`text | image`). Anything
 * else a third-party catalog declares (pdf, video, audio) MUST be filtered out
 * before it reaches the host: the harness message content only supports
 * text/image blocks, so an unrepresentable modality would fail on the request
 * path.
 */
export const HOST_INPUT_MODALITIES = Object.freeze(['text', 'image'])

/**
 * Assistant-message fields pi-ai accepts as a raw reasoning field on replay.
 *
 * Source: `@earendil-works/pi-ai/dist/api/openai-completions.js`
 * (`OPENAI_COMPLETIONS_REASONING_FIELDS`) — the same list its streaming reader
 * probes for a reasoning delta. A catalog that names its interleaved reasoning
 * field must name one of these, or the value cannot be represented on the wire.
 */
export const PI_AI_REASONING_FIELDS = Object.freeze([
  'reasoning',
  'reasoning_content',
  'reasoning_text',
])

/**
 * The `max_output_tokens` floor the OpenAI Responses PROTOCOL requires.
 *
 * Source: `@earendil-works/pi-ai/dist/api/openai-responses.js`, which already
 * clamps with `Math.max(value, 16)`. This plugin clamps at its own per-protocol
 * adaptation step as well, so the guarantee survives a pi-ai change.
 *
 * Deliberately NOT described as gateway behaviour: measured 2026-09-11, this
 * relay answers `200` for `max_output_tokens` of 1, 8 and 15 on `grok-4.6` — it
 * does not enforce the contract for us. The floor is a protocol-level
 * requirement, and the upstream a relay forwards to may enforce it even when
 * the relay does not.
 */
export const RESPONSES_MIN_OUTPUT_TOKENS = 16

/**
 * The value policies for the relay's session header (the design notes §2.4.2).
 *
 * `session-id` forwards the host's own `GenerateOptions.sessionId`; `uuid`
 * substitutes an opaque, process-stable value. This array is the ONE source of
 * truth for both the settings schema (`config.js` builds its `z.union` from it)
 * and the runtime validation (`session.js`), so a new mode cannot be accepted
 * by one and refused by the other.
 */
export const SESSION_HEADER_MODES = Object.freeze(['session-id', 'uuid'])
