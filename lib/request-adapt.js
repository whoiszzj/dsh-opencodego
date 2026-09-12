/**
 * Per-protocol request adaptation: the parameters AND the endpoint URL a
 * candidate protocol needs.
 *
 * The audit's rule is the reason this module exists: a candidate protocol may
 * need DIFFERENT request facts, and a request handed to pi-ai unchanged can
 * then fail (or miss the endpoint) for a reason the plugin could have known.
 *
 * Two measured facts drive it:
 *
 *  1. **The OpenAI Responses output floor.** The installed pi-ai already clamps
 *     with `Math.max(value, 16)` (`api/openai-responses.js`); this plugin clamps
 *     too, so the guarantee survives a pi-ai upgrade. The relay itself tolerates
 *     values below the floor (measured: 1, 8 and 15 all answer 200 on
 *     `grok-4.6`), which is exactly why the floor has to be enforced here: the
 *     protocol contract is not something this endpoint will enforce for us.
 *  2. **The Anthropic Messages path prefix.** pi-ai speaks `anthropic-messages`
 *     through the official Anthropic SDK with `baseURL: model.baseUrl`
 *     (`api/anthropic-messages.js`), and that SDK appends `/v1/messages`. A base
 *     already ending in `/v1` therefore produced
 *     `https://opencode.ai/zen/go/v1/v1/messages` — the gateway's HTML 404 page,
 *     which phase 1 (and phase 2's first probe) misread as "this endpoint serves
 *     no anthropic path". Measured: `POST {base}/messages` with an Anthropic
 *     body answers 200 for `qwen3.8-flash` and `minimax-m2.5`. The URL is part
 *     of the per-protocol adaptation.
 *
 * Reasoning levels need no adaptation: pi-ai clamps a requested level against
 * the model's `thinkingLevelMap` itself (`clampThinkingLevel`), and the host is
 * only ever offered levels this plugin derived from the catalog.
 *
 * @module dsh-opencodego/request-adapt
 */

import { RESPONSES_MIN_OUTPUT_TOKENS } from './vocab.js'

/**
 * Adapt one request to the protocol about to carry it.
 *
 * @param {string} protocol - the candidate protocol.
 * @param {{ maxTokens?: number }} request - the caller's request facts.
 * @param {{ maxTokens: number }} model - the model's own output cap.
 * @returns {{ maxTokens: number | undefined, notes: string[] }} the adapted value
 *   (`undefined` means "omit the parameter and let the provider default") plus a
 *   note for every adjustment, so an operator can see why the wire value differs
 *   from the request.
 */
export function adaptRequestForProtocol(protocol, request, model) {
  const notes = []
  let maxTokens = Number.isSafeInteger(request?.maxTokens) && request.maxTokens > 0
    ? request.maxTokens
    : undefined
  const ceiling = Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0 ? model.maxTokens : undefined

  if (maxTokens !== undefined && ceiling !== undefined && maxTokens > ceiling) {
    notes.push(`maxTokens ${maxTokens} capped to the model's ${ceiling}`)
    maxTokens = ceiling
  }

  if (protocol === 'openai-responses') {
    // The floor is enforced on the field this protocol sends, so it is raised,
    // never dropped: a caller asking for fewer tokens still gets a valid request.
    const floor = RESPONSES_MIN_OUTPUT_TOKENS
    if (maxTokens !== undefined && maxTokens < floor) {
      notes.push(`maxTokens ${maxTokens} raised to the openai-responses floor ${floor}`)
      maxTokens = floor
    }
  } else if (protocol === 'anthropic-messages' && maxTokens === undefined) {
    // `anthropic-messages` always sends `max_tokens`; pi-ai would fall back to the
    // model's own cap, so make that explicit here rather than relying on it.
    maxTokens = ceiling
    if (maxTokens !== undefined) notes.push(`maxTokens defaulted to the model's ${ceiling} for anthropic-messages`)
  }

  return { maxTokens, notes }
}

/**
 * The base URL one protocol must be given.
 *
 * `openai-completions` and `openai-responses` append a bare path
 * (`/chat/completions`, `/responses`) to `model.baseUrl`, so they take the
 * configured base as-is — which is why the configuration documents a base
 * INCLUDING `/v1`. `anthropic-messages` goes through the Anthropic SDK, which
 * appends `/v1/messages`; a base already carrying `/v1` would double it.
 *
 * Only a trailing `/v1` is stripped, and only for `anthropic-messages`: any
 * other base is passed through untouched, because guessing at a deployment's
 * path layout would be worse than letting the endpoint answer.
 *
 * @param {string} protocol - the candidate protocol.
 * @param {string} baseURL - the configured gateway base (normally ending in `/v1`).
 * @returns {string} the base to hand pi-ai for this protocol.
 */
export function baseUrlForProtocol(protocol, baseURL) {
  if (protocol !== 'anthropic-messages') return baseURL
  return String(baseURL ?? '').replace(/\/v1$/u, '')
}
