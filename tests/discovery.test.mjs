/**
 * Unit tests for the model-discovery entry point the phase-4b "获取模型" button
 * calls.
 *
 * `fetchModelDraft` is the whole protocol logic and is host-free, so it is
 * driven here through a stub `fetch`: every success shape and every failure
 * class is exercised without a network and without a profile install.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { draftBaseUrl, fetchModelDraft } from '../src/discovery.js'
import { describeTransportError } from '../src/models.js'

const HOOKS = {
  options: () => ({ baseURL: 'https://gateway.example/v1' }),
  resolveApiKey: async () => 'stored-key',
}

const ATTRIBUTION = () => ({ 'user-agent': 'deepseek-harness/test' })

/** A fetch stub returning one canned response. */
function responding({ status = 200, body, json = true } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (json) return body
        throw new SyntaxError('Unexpected token < in JSON')
      },
    }
  }
  return { fetchImpl, calls }
}

test('the draft endpoint defaults to the configured base and is slash-normalized', () => {
  assert.deepEqual(draftBaseUrl(HOOKS, undefined), { baseURL: 'https://gateway.example/v1' })
  assert.deepEqual(
    draftBaseUrl(HOOKS, { baseURL: '  https://other.example/v1//  ' }),
    { baseURL: 'https://other.example/v1' },
  )
  // A blank draft baseURL means "use the configured one", not "use the empty string".
  assert.deepEqual(draftBaseUrl(HOOKS, { baseURL: '   ' }), { baseURL: 'https://gateway.example/v1' })
})

test('a non-absolute draft base is refused with the field named, before any request', async () => {
  const { fetchImpl, calls } = responding({ body: { data: [] } })
  const outcome = await fetchModelDraft({
    hooks: { ...HOOKS, options: () => ({ baseURL: 'gateway.example/v1' }) },
    fetchImpl,
    attributionHeaders: ATTRIBUTION,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'INVALID_REQUEST')
  assert.equal(
    outcome.error.message,
    'opencode-go-native: discovery baseURL must be an absolute http(s) URL including the /v1 prefix '
    + '(got: gateway.example/v1)',
  )
  assert.deepEqual(calls, [])
})

test('a draft key is used for exactly one request and the stored credential is not resolved', async () => {
  let resolved = 0
  const { fetchImpl, calls } = responding({ body: { data: [{ id: 'alpha' }] } })
  const outcome = await fetchModelDraft({
    hooks: {
      options: HOOKS.options,
      resolveApiKey: async () => {
        resolved += 1
        return 'stored-key'
      },
    },
    request: { apiKey: 'one-shot-key' },
    fetchImpl,
    attributionHeaders: ATTRIBUTION,
  })
  assert.equal(outcome.ok, true)
  assert.equal(resolved, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gateway.example/v1/models')
  assert.equal(calls[0].init.headers.authorization, 'Bearer one-shot-key')
  // The mandatory attribution rides the same request.
  assert.equal(calls[0].init.headers['user-agent'], 'deepseek-harness/test')
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[0].init.method, 'GET')
})

test('the stored credential is resolved when the draft carries none', async () => {
  const { fetchImpl, calls } = responding({ body: [] })
  const outcome = await fetchModelDraft({ hooks: HOOKS, fetchImpl, attributionHeaders: ATTRIBUTION })
  assert.equal(outcome.ok, true)
  assert.equal(calls[0].init.headers.authorization, 'Bearer stored-key')
})

test('an HTTP failure names the endpoint and the status, and carries the status', async () => {
  const { fetchImpl } = responding({ status: 401, body: {} })
  const outcome = await fetchModelDraft({ hooks: HOOKS, fetchImpl, attributionHeaders: ATTRIBUTION })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'DISCOVERY_FAILED')
  assert.equal(outcome.error.status, 401)
  assert.equal(
    outcome.error.message,
    'opencode-go-native: model discovery on https://gateway.example/v1 answered HTTP 401',
  )
})

test('a transport failure keeps the cause chain in the diagnosis', async () => {
  const cause = new Error('getaddrinfo ENOTFOUND gateway.example')
  const thrown = new TypeError('fetch failed', { cause })
  const fetchImpl = async () => {
    throw thrown
  }
  const outcome = await fetchModelDraft({ hooks: HOOKS, fetchImpl, attributionHeaders: ATTRIBUTION })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'TRANSPORT')
  assert.equal(
    outcome.error.message,
    'opencode-go-native: model discovery request to https://gateway.example/v1 failed: '
    + 'fetch failed: getaddrinfo ENOTFOUND gateway.example',
  )
  // The thrown value is preserved as the cause, so a caller keeps the stack.
  assert.equal(outcome.error.cause.cause.message, cause.message)
})

test('a non-JSON body is refused instead of being read as an empty catalogue', async () => {
  const { fetchImpl } = responding({ body: {}, json: false })
  const outcome = await fetchModelDraft({ hooks: HOOKS, fetchImpl, attributionHeaders: ATTRIBUTION })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'MALFORMED_RESPONSE')
  assert.equal(
    outcome.error.message,
    'opencode-go-native: model discovery on https://gateway.example/v1 returned a non-JSON body',
  )
})

test('both the OpenAI envelope and a bare array are accepted', async () => {
  for (const body of [{ data: [{ id: 'alpha' }] }, [{ id: 'alpha' }]]) {
    const { fetchImpl } = responding({ body })
    const outcome = await fetchModelDraft({ hooks: HOOKS, fetchImpl, attributionHeaders: ATTRIBUTION })
    assert.deepEqual(outcome.models, [{ id: 'alpha', name: 'alpha' }])
  }
})

test('ids are deduplicated, sorted, and never enriched with capabilities', async () => {
  const { fetchImpl } = responding({
    body: {
      data: [
        { id: 'zeta', name: 'Zeta', context_window: 999 },
        { id: 'alpha' },
        { id: 'zeta', name: 'Zeta again' },
        { id: '' },
        { id: 42 },
        { object: 'model' },
      ],
    },
  })
  const outcome = await fetchModelDraft({ hooks: HOOKS, fetchImpl, attributionHeaders: ATTRIBUTION })
  assert.deepEqual(outcome.models, [
    { id: 'alpha', name: 'alpha' },
    { id: 'zeta', name: 'Zeta' },
  ])
})

test('the transport-error rendering is shared, not re-implemented per path', () => {
  assert.equal(describeTransportError(new Error('plain')), 'plain')
  assert.equal(
    describeTransportError(new TypeError('fetch failed', { cause: new Error('socket hang up') })),
    'fetch failed: socket hang up',
  )
  assert.equal(describeTransportError('not an error'), 'not an error')
})
