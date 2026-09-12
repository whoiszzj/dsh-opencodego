/**
 * Unit tests for the fallback driver and the failure classifier.
 *
 * The failure strings here are copied from `data/protocol-matrix.*.json`, i.e.
 * they are what this endpoint actually answered — not invented examples. The
 * invariant under test is the one the audit demanded: a protocol may be
 * abandoned only BEFORE a content chunk has reached the caller.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chainExhaustedError,
  httpStatusOf,
  PROTOCOL_FAILURE,
  protocolFailureKind,
  retryableProtocolFailure,
  streamWithProtocolChain,
} from '../src/protocol-chain.js'

/* ── classifier: measured strings ─────────────────────────────────────────── */

/** Real failure texts, exactly as pi-ai rendered them for this endpoint. */
const MEASURED = {
  formatCompletions: '401: {"type":"ModelError","message":"Model grok-4.6 is not supported for format oa-compat"}',
  formatResponses: 'OpenAI API error (401): {"type":"ModelError","message":"Model qwen3.8-flash is not supported for format openai"}',
  protocolPathMissing: '404 <!DOCTYPE html><html lang="en" dir="ltr" data-locale="en"><head><meta charset="utf-8">',
  internal: 'OpenAI API error (500): {"type":"error","message":"Internal server error"}',
  upstreamFailed: 'OpenAI API error (400): {"message":"Error from provider (Console Go): Upstream request failed"}',
  unavailable: '400: {"type":"server_error","message":"Error from provider (Console Go): Upstream request failed: Model is unavailable."}',
  unsupportedModel: '401: {"type":"ModelError","message":"Model ox-alpha-free is not supported"}',
  country: 'OpenAI API error (403): {"param":null,"message":"Error from provider (Console Go): Upstream request failed: [unsupported_country_region_territory] Country, region, or territory not supported"}',
  region: 'OpenAI API error (403): {"message":"Error from provider (Console Go): Upstream request failed: The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai/workspace"}',
  dataPolicy: 'OpenAI API error (403): {"message":"Error from provider (Console Go): This model collects data used to improve its quality and requires explicit opt in"}',
}

test('httpStatusOf reads the status from the anchored positions pi-ai uses', () => {
  assert.equal(httpStatusOf(MEASURED.formatCompletions), 401)
  assert.equal(httpStatusOf(MEASURED.protocolPathMissing), 404)
  assert.equal(httpStatusOf(MEASURED.formatResponses), 401)
  assert.equal(httpStatusOf(MEASURED.country), 403)
  assert.equal(httpStatusOf('HTTP 503 from gateway'), 503)
  // A model id or token count inside a body must not be read as a status.
  assert.equal(httpStatusOf('Request failed for model qwen3.8-max'), undefined)
})

test('a format refusal is classified retryable', () => {
  for (const text of [MEASURED.formatCompletions, MEASURED.formatResponses, MEASURED.protocolPathMissing]) {
    assert.equal(protocolFailureKind(text), PROTOCOL_FAILURE.FORMAT, text)
    assert.equal(retryableProtocolFailure(text), true, text)
  }
})

test('5xx and relay-side upstream failures are transient and retryable', () => {
  for (const text of [MEASURED.internal, MEASURED.upstreamFailed]) {
    assert.equal(protocolFailureKind(text), PROTOCOL_FAILURE.TRANSIENT, text)
    assert.equal(retryableProtocolFailure(text), true, text)
  }
  assert.equal(protocolFailureKind(new TypeError('fetch failed')), PROTOCOL_FAILURE.TRANSIENT)
  assert.equal(protocolFailureKind('connect ECONNREFUSED 127.0.0.1:1'), PROTOCOL_FAILURE.TRANSIENT)
})

test('403 gates are NOT retryable, whatever protocol carries them', () => {
  for (const text of [MEASURED.country, MEASURED.region, MEASURED.dataPolicy]) {
    assert.equal(protocolFailureKind(text), PROTOCOL_FAILURE.FATAL, text)
    assert.equal(retryableProtocolFailure(text), false, text)
  }
  // A bare 403 with no recognised wording is still fatal: switching protocol
  // cannot satisfy an authorization decision.
  assert.equal(retryableProtocolFailure('OpenAI API error (403): forbidden'), false)
})

test('an unavailable or unknown model is fatal, not a protocol problem', () => {
  for (const text of [MEASURED.unavailable, MEASURED.unsupportedModel]) {
    assert.equal(retryableProtocolFailure(text), false, text)
  }
})

test('a failure object and an Error are classified the same as their text', () => {
  const asFailure = { message: MEASURED.formatResponses, code: 'AUTH' }
  assert.equal(protocolFailureKind(asFailure), PROTOCOL_FAILURE.FORMAT)
  assert.equal(protocolFailureKind(new Error(MEASURED.internal)), PROTOCOL_FAILURE.TRANSIENT)
  assert.equal(protocolFailureKind({ message: MEASURED.country, code: 'AUTH' }), PROTOCOL_FAILURE.FATAL)
})

test('the exhausted-chain error names every attempt and keeps the last failure as cause', () => {
  const error = chainExhaustedError(
    [
      { protocol: 'openai-responses', attempt: 0, kind: 'transient', message: 'HTTP 500' },
      { protocol: 'openai-completions', attempt: 0, kind: 'format', message: 'not supported for format' },
    ],
    MEASURED.formatCompletions,
  )
  assert.match(error.message, /openai-responses \(transient, attempt 1\): HTTP 500/)
  assert.match(error.message, /openai-completions \(format, attempt 1\): not supported for format/)
  assert.equal(error.cause, MEASURED.formatCompletions)
  assert.equal(error.attempts.length, 2)
})

/* ── driver ───────────────────────────────────────────────────────────────── */

const usage = (input = 0, output = 0) => ({ type: 'usage', usage: { inputTokens: input, outputTokens: output } })
const text = (value) => ({ type: 'text-delta', index: 0, text: value })
const finish = (reason) => ({ type: 'finish', reason })
const errorFinish = (message) => finish({ kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } })
const stopFinish = () => finish({ kind: 'stop' })

/** An attempt built from a fixed chunk list, recording that it was consumed. */
function attemptOf(chunks, calls, protocol) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: async () => {
          if (index === 0) calls.push(protocol)
          if (index >= chunks.length) return { done: true, value: undefined }
          const chunk = chunks[index++]
          if (typeof chunk === 'function') throw chunk()
          return { done: false, value: chunk }
        },
        return: async () => ({ done: true, value: undefined }),
      }
    },
  }
}

/** Drain a chain run into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('a format refusal before any output falls back to the next protocol', async () => {
  const calls = []
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-responses', 'openai-completions'],
    attempt: (protocol) => attemptOf(protocol === 'openai-responses'
      // The usage chunk of the failed attempt must NOT reach the caller.
      ? [usage(0, 0), errorFinish(MEASURED.formatResponses)]
      : [usage(11, 22), text('OK'), stopFinish()], calls, protocol),
  }))
  assert.deepEqual(calls, ['openai-responses', 'openai-completions'])
  assert.deepEqual(chunks, [usage(11, 22), text('OK'), stopFinish()])
})

test('an error finish AFTER a content chunk is surfaced, never retried', async () => {
  const calls = []
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-completions', 'openai-responses'],
    attempt: (protocol) => attemptOf(
      [usage(1, 1), text('partial'), errorFinish(MEASURED.internal)],
      calls,
      protocol,
    ),
  }))
  assert.deepEqual(calls, ['openai-completions'], 'the second protocol must not be attempted')
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[2], errorFinish(MEASURED.internal))
})

test('a thrown retryable error after output propagates without a second attempt', async () => {
  const calls = []
  await assert.rejects(
    () => collect(streamWithProtocolChain({
      chain: ['openai-completions', 'openai-responses'],
      attempt: (protocol) => attemptOf(
        [text('partial'), () => new Error(MEASURED.internal)],
        calls,
        protocol,
      ),
    })),
    /Internal server error/,
  )
  assert.deepEqual(calls, ['openai-completions'])
})

test('a transient failure retries the SAME protocol before switching', async () => {
  const calls = []
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-completions', 'openai-responses'],
    maxAttemptsPerProtocol: 2,
    attempt: (protocol) => attemptOf(
      calls.length === 0
        ? [errorFinish(MEASURED.internal)]
        : [text('OK'), stopFinish()],
      calls,
      protocol,
    ),
  }))
  assert.deepEqual(calls, ['openai-completions', 'openai-completions'])
  assert.deepEqual(chunks, [text('OK'), stopFinish()])
})

test('a format failure never repeats the same protocol, even with retries left', async () => {
  const calls = []
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-responses', 'openai-completions'],
    maxAttemptsPerProtocol: 3,
    attempt: (protocol) => attemptOf(protocol === 'openai-responses'
      ? [errorFinish(MEASURED.formatResponses)]
      : [text('OK'), stopFinish()], calls, protocol),
  }))
  assert.deepEqual(calls, ['openai-responses', 'openai-completions'])
  assert.deepEqual(chunks, [text('OK'), stopFinish()])
})

test('a 403 gate is reported as-is with no fallback attempt', async () => {
  const calls = []
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-responses', 'openai-completions'],
    attempt: (protocol) => attemptOf([usage(0, 0), errorFinish(MEASURED.country)], calls, protocol),
  }))
  assert.deepEqual(calls, ['openai-responses'])
  assert.equal(chunks.length, 2)
  assert.match(chunks[1].reason.failure.message, /unsupported_country_region_territory/)
})

test('when every candidate fails in-band the last failure is replayed, not thrown', async () => {
  const calls = []
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-responses', 'openai-completions'],
    // One try per protocol: this test is about the replay of the last failure,
    // not about the same-protocol retry covered above.
    maxAttemptsPerProtocol: 1,
    attempt: (protocol) => attemptOf(
      protocol === 'openai-responses'
        ? [usage(0, 0), errorFinish(MEASURED.internal)]
        : [usage(3, 4), errorFinish(MEASURED.formatCompletions)],
      calls,
      protocol,
    ),
  }))
  assert.deepEqual(calls, ['openai-responses', 'openai-completions'])
  assert.deepEqual(chunks, [usage(3, 4), errorFinish(MEASURED.formatCompletions)])
})

test('when every candidate throws, the chain error carries the attempt list', async () => {
  const calls = []
  await assert.rejects(
    () => collect(streamWithProtocolChain({
      chain: ['openai-completions'],
      attempt: (protocol) => attemptOf([() => new TypeError('fetch failed')], calls, protocol),
    })),
    (error) => {
      assert.match(error.message, /every candidate protocol failed/)
      assert.match(error.message, /openai-completions \(transient, attempt 1\): fetch failed/)
      return true
    },
  )
  assert.deepEqual(calls, ['openai-completions', 'openai-completions'])
})

test('usage is withheld but still precedes the terminal finish on success', async () => {
  const chunks = await collect(streamWithProtocolChain({
    chain: ['openai-completions'],
    attempt: () => attemptOf([usage(5, 6), stopFinish()], [], 'openai-completions'),
  }))
  assert.deepEqual(chunks, [usage(5, 6), stopFinish()])
})

test('an empty chain is a programming error, not a silent no-op', async () => {
  await assert.rejects(
    () => collect(streamWithProtocolChain({ chain: [], attempt: () => attemptOf([], [], 'x') })),
    /protocol chain is empty/,
  )
})

test('the observability hook sees every outcome', async () => {
  const seen = []
  await collect(streamWithProtocolChain({
    chain: ['openai-responses', 'openai-completions'],
    attempt: (protocol) => attemptOf(protocol === 'openai-responses'
      ? [errorFinish(MEASURED.formatResponses)]
      : [text('OK'), stopFinish()], [], protocol),
    onAttempt: (protocol, failure, outcome) => seen.push([protocol, outcome.kind, outcome.committed]),
  }))
  assert.deepEqual(seen, [
    ['openai-responses', 'retryable', false],
    // `committed: true` records that the successful attempt was the one that
    // produced content; a retry would no longer have been possible after it.
    ['openai-completions', 'ok', true],
  ])
})

test('the fallback classifier and the health classifier agree on fatal vs retryable', async () => {
  const { classifyEndpointHealth, ENDPOINT_HEALTH } = await import('../src/health.js')
  const fatalCategories = new Set([
    ENDPOINT_HEALTH.REGION,
    ENDPOINT_HEALTH.DATA_POLICY,
    ENDPOINT_HEALTH.COUNTRY_BLOCK,
    ENDPOINT_HEALTH.MODEL_UNAVAILABLE,
    ENDPOINT_HEALTH.AUTH,
    ENDPOINT_HEALTH.BAD_REQUEST,
  ])
  for (const text of Object.values(MEASURED)) {
    const retryable = retryableProtocolFailure(text)
    const category = classifyEndpointHealth(text).category
    assert.equal(
      fatalCategories.has(category),
      !retryable,
      `${text.slice(0, 60)} -> ${category} / retryable=${retryable}`,
    )
  }
})
