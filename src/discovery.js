/**
 * The model-discovery entry point the phase-4b "获取模型" button calls.
 *
 * Split into two layers on purpose:
 *
 *   - {@link fetchModelDraft} is the whole protocol logic and is **host-free**:
 *     it takes the `fetch` implementation and the attribution headers as
 *     arguments, so `tests/discovery.test.mjs` drives every success and every
 *     failure through a stub instead of a network (`node --test`, no profile).
 *   - {@link discover} is the thin host half: it supplies the real `fetch` and
 *     `attributionHeaders()` and wraps the pure layer's failures in `LlmError`
 *     with the same stable `code` and message. The host packages are imported
 *     **lazily inside it**, so importing this module for its pure functions does
 *     not need a profile install.
 *
 * Nothing here reads or writes settings, the credential store, or the catalogue:
 * a discovery draft names its own endpoint and may carry its own one-shot
 * credential, and the reply is candidate metadata the caller may adopt.
 *
 * @module dsh-opencodego/discovery
 */

import { describeTransportError } from './models.js'
import { PKG } from './vocab.js'

// One implementation (`models.js`), re-exported where the discovery path's
// callers expect to find it.
export { describeTransportError }

/** The normalized endpoint a draft resolves to. */
export function draftBaseUrl(hooks, request) {
  const options = hooks.options()
  const draftBase = request?.baseURL
  const baseURL = draftBase !== undefined && String(draftBase).trim().length > 0
    ? String(draftBase).trim().replace(/\/+$/u, '')
    : options.baseURL
  if (typeof baseURL !== 'string' || !/^https?:\/\//iu.test(baseURL)) {
    return {
      error: {
        code: 'INVALID_REQUEST',
        message: `${PKG}: discovery baseURL must be an absolute http(s) URL including the /v1 prefix `
          + `(got: ${String(baseURL)})`,
      },
    }
  }
  return { baseURL }
}

/**
 * The protocol logic: one `GET {baseURL}/models`, tolerating both the OpenAI
 * listing envelope and a bare array.
 *
 * @param {object} args - the operation.
 * @param {{ options: () => object, resolveApiKey: () => Promise<string> }} args.hooks
 *   the two facts this reads: current connection facts and the connection
 *   credential (the `apiKeyEnv` reference, with the legacy inline value as the
 *   last resort — see `credential.js`).
 * @param {{ baseURL?: string, apiKey?: string }} [args.request] - the draft.
 * @param {typeof fetch} args.fetchImpl - the fetch implementation to use.
 * @param {() => Record<string, string>} args.attributionHeaders - mandatory attribution for the request.
 * @param {AbortSignal} [args.signal] - caller cancellation.
 * @returns {Promise<{ ok: true, models: object[] } | { ok: false, error: { code: string, message: string, status?: number, cause?: unknown } }>}
 *   the outcome; never throws.
 */
export async function fetchModelDraft({ hooks, request, fetchImpl, attributionHeaders, signal }) {
  const resolved = draftBaseUrl(hooks, request)
  if (resolved.error !== undefined) return { ok: false, error: resolved.error }
  const baseURL = resolved.baseURL
  const draftKey = request?.apiKey
  const apiKey = draftKey !== undefined && draftKey.length > 0 ? draftKey : await hooks.resolveApiKey()
  let response
  try {
    response = await fetchImpl(`${baseURL}/models`, {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'application/json',
        // Host hard constraint: every provider HTTP request carries the
        // mandatory attribution, and nothing else identifies the caller.
        ...attributionHeaders(),
      },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'TRANSPORT',
        message: `${PKG}: model discovery request to ${baseURL} failed: ${describeTransportError(error)}`,
        cause: error,
      },
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'DISCOVERY_FAILED',
        message: `${PKG}: model discovery on ${baseURL} answered HTTP ${response.status}`,
        status: response.status,
      },
    }
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'MALFORMED_RESPONSE',
        message: `${PKG}: model discovery on ${baseURL} returned a non-JSON body`,
        cause: error,
      },
    }
  }
  const entries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
  const models = []
  const seen = new Set()
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : undefined
    if (id === undefined || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    // Capabilities are deliberately NOT invented here: the endpoint discloses
    // none (DESIGN.md §2.5) and the models.dev snapshot describes them
    // separately. The reply is a draft, not a catalogue entry.
    models.push({ id, name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id })
  }
  models.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { ok: true, models }
}

/**
 * Interrogate one endpoint for the models it advertises.
 *
 * Every failure is an `LlmError` whose message names the endpoint and, for an
 * HTTP failure, the status — so a settings page can show the operator something
 * better than "failed" (README「获取模型」).
 *
 * @param {{ options: () => object, resolveApiKey: () => Promise<string> }} hooks - connection facts and credential.
 * @param {{ baseURL?: string, apiKey?: string }} [request] - the draft.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<readonly object[]>} advertised models, id-sorted.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} with a stable `code`.
 */
export async function discover(hooks, request, signal) {
  const { attributionHeaders, LlmError } = await import('@deepseek-ai/dsh-llm')
  const outcome = await fetchModelDraft({ hooks, request, fetchImpl: fetch, attributionHeaders, signal })
  if (outcome.ok) return outcome.models
  const { code, message, cause, status } = outcome.error
  throw new LlmError(
    message,
    code,
    {
      ...cause === undefined ? {} : { cause },
      ...status === undefined ? {} : { status },
    },
  )
}
