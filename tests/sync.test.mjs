/**
 * Unit tests for the capability sync.
 *
 * A fake `fetch` stands in for the gateway, so every branch the sync can take is
 * exercised without a live request:
 *
 *   1. available, and the official contract survives contact with the gateway;
 *   2. available, but a level the provider declared is refused -> the ladder;
 *   3. available, and there is no official contract at all -> the ladder;
 *   4. the upstream is gone (`Model is unavailable`);
 *   5. the account/region is gated (`RegionError`);
 *   6. the recommended protocol is refused -> the next one answers;
 *   7. transport failure.
 *
 * The assertions are about what gets STORED, because that is what a user ends up
 * living with: in particular, a model with an official contract must not end up
 * offering the whole seven-level ladder.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  bodyFor,
  classifyFailure,
  endpointFor,
  overridesFromSync,
  readReply,
  REQUEST_TIMEOUT_MS,
  SYNC_STATUS,
  syncModel,
  syncedLayerFromSync,
} from '../src/sync.js'

const BASE = 'https://opencode.ai/zen/go/v1'
const ATTRIBUTION = () => ({ 'user-agent': 'dsh-test' })
const SESSION = () => ({ 'x-opencode-session': 'test-session' })

/** A JSON response with the right shape for the protocol that was called. */
function reply(protocol, { reasoning, field = 'reasoning_content', body } = {}) {
  if (body !== undefined) return body
  if (protocol === 'anthropic-messages') {
    return {
      content: [
        ...reasoning === undefined ? [] : [{ type: 'thinking', thinking: reasoning }],
        { type: 'text', text: '9.9 is larger.' },
      ],
    }
  }
  if (protocol === 'openai-responses') {
    return {
      output: [
        ...reasoning === undefined ? [] : [{ content: [{ type: 'reasoning_text', text: reasoning }] }],
        { content: [{ type: 'output_text', text: '9.9 is larger.' }] },
      ],
    }
  }
  return {
    choices: [{
      message: {
        content: '9.9 is larger.',
        ...reasoning === undefined ? {} : { [field]: reasoning },
      },
    }],
  }
}

/**
 * Build a fake fetch from a routing table.
 * @param {object} routes - keyed by `PROTOCOL` or `PROTOCOL:marker`.
 */
function makeFetch(routes, log) {
  return async (url, init) => {
    const protocol = url.includes('/chat/completions')
      ? 'openai-completions'
      : url.includes('/v1/messages') ? 'anthropic-messages' : 'openai-responses'
    const parsed = JSON.parse(init.body)
    // A reasoning probe names a level; an availability probe does not.
    const marker = parsed.reasoning_effort ?? parsed.reasoning?.effort
      ?? parsed.output_config?.effort
      ?? (parsed.thinking?.type === 'disabled' ? 'off' : undefined)
    if (log !== undefined) log.push({ protocol, url, body: parsed, marker, headers: init.headers })
    const route = routes[marker === undefined ? protocol : `${protocol}:${marker}`]
      ?? routes[protocol]
      ?? routes['*']
    if (route === undefined) throw new Error(`no route for ${protocol}:${String(marker)}`)
    if (route instanceof Error) throw route
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: async () => JSON.stringify(route.json ?? {}),
    }
  }
}

const OFFICIAL_FULL = {
  id: 'kimi-k3',
  lab: 'moonshotai',
  contextWindow: 1048576,
  maxTokens: 131072,
  input: ['text', 'image'],
  reasoningOptions: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
  reasoningContract: 'off / low / high / max',
  interleavedField: 'reasoning_content',
}

async function run(routes, { official = OFFICIAL_FULL, protocol, alternates, log } = {}) {
  // `null` means "explicitly no official record"; a destructuring default would
  // swallow an explicit `undefined`.
  const baseline = official === null ? undefined : official
  return syncModel({
    id: baseline?.id ?? 'omen-alpha',
    baseURL: BASE,
    apiKey: 'test-key',
    fetchImpl: makeFetch(routes, log),
    baseHeaders: ATTRIBUTION,
    sessionHeaders: SESSION,
    protocol: protocol ?? { primary: 'openai-completions', source: 'models.dev-npm' },
    alternates,
    official: baseline,
  })
}

test('endpointFor matches the base each protocol must be given', () => {
  assert.equal(endpointFor('openai-completions', BASE), `${BASE}/chat/completions`)
  assert.equal(endpointFor('openai-responses', BASE), `${BASE}/responses`)
  // The Anthropic client appends /v1/messages, so the base must not keep /v1.
  assert.equal(endpointFor('anthropic-messages', BASE), 'https://opencode.ai/zen/go/v1/messages')
  assert.equal(endpointFor('anthropic-messages', 'https://x.test/api'), 'https://x.test/api/v1/messages')
})

test('bodyFor puts the level on the field its own contract documents', () => {
  const level = { wire: 'high' }
  assert.equal(bodyFor('openai-completions', 'm', { maxTokens: 8, prompt: 'p', reasoning: level }).reasoning_effort, 'high')
  assert.deepEqual(bodyFor('openai-responses', 'm', { maxTokens: 8, prompt: 'p', reasoning: level }).reasoning, { effort: 'high' })
  const anth = bodyFor('anthropic-messages', 'm', { maxTokens: 8, prompt: 'p', reasoning: level })
  assert.deepEqual(anth.thinking, { type: 'enabled' })
  assert.deepEqual(anth.output_config, { effort: 'high' })
  const off = bodyFor('anthropic-messages', 'm', { maxTokens: 8, prompt: 'p', reasoning: { toggleOff: true } })
  assert.deepEqual(off.thinking, { type: 'disabled' })
  assert.equal(off.output_config, undefined)
  // The two off mechanisms are distinct bodies, not one body with two fields.
  assert.equal(bodyFor('openai-completions', 'm',
    { maxTokens: 8, prompt: 'p', reasoning: { toggleOff: true } }).reasoning_effort, undefined)
  assert.equal(bodyFor('openai-completions', 'm',
    { maxTokens: 8, prompt: 'p', reasoning: { wire: 'none' } }).reasoning_effort, 'none')
  // `openai-responses` has no toggle field, so a toggle probe must not silently
  // degrade into "no reasoning asked for" — which always succeeds.
  assert.equal(bodyFor('openai-responses', 'm',
    { maxTokens: 8, prompt: 'p', reasoning: { toggleOff: true } }).reasoning, undefined)
})

test('readReply reads all three dialects, and the field thinking came back on', () => {
  assert.deepEqual(readReply(reply('openai-completions', { reasoning: 'abc' }), 200),
    { reasoningField: 'reasoning_content', reasoningChars: 3, text: '9.9 is larger.' })
  assert.equal(readReply(reply('openai-completions', { reasoning: 'abc', field: 'reasoning' }), 200).reasoningField, 'reasoning')
  assert.equal(readReply(reply('openai-responses', { reasoning: 'abcd' }), 200).reasoningField, 'reasoning')
  assert.equal(readReply(reply('anthropic-messages', { reasoning: 'ab' }), 200).reasoningField, 'thinking')
  assert.deepEqual(readReply(undefined, 500), { reasoningChars: 0, text: '' })
})

test('classifyFailure tells a dead model from a gate from a protocol mismatch', () => {
  const unavailable = classifyFailure(400, { error: { message: 'Error from provider: Model is unavailable.' } }, '')
  assert.equal(unavailable.status, SYNC_STATUS.DELISTED)
  assert.equal(unavailable.retryable, false)

  const gated = classifyFailure(403, { error: { type: 'RegionError', message: 'not available in your country' } }, '')
  assert.equal(gated.status, SYNC_STATUS.GATED)
  assert.equal(gated.retryable, false)

  const format = classifyFailure(401, { error: { message: 'Model x is not supported for format oa-compat' } }, '')
  assert.equal(format.retryable, true, 'a protocol mismatch must let the sync try another protocol')
  assert.match(format.reason, /oa-compat/u)

  assert.equal(classifyFailure(500, undefined, 'boom').status, SYNC_STATUS.ERROR)
})

test('an official contract that survives is what gets stored — not the whole ladder', async () => {
  const log = []
  const result = await run({
    'openai-completions': { status: 200, json: reply('openai-completions', { reasoning: 'x' }) },
  }, { log })

  assert.equal(result.available, true)
  assert.equal(result.status, SYNC_STATUS.AVAILABLE)
  assert.equal(result.protocol.chosen, 'openai-completions')
  assert.equal(result.protocol.verified, true)
  // Declared facts come from the baseline, with zero requests spent on them.
  assert.equal(result.contextWindow, 1048576)
  assert.equal(result.maxTokens, 131072)
  assert.deepEqual(result.input, ['text', 'image'])

  assert.equal(result.reasoning.source, 'official')
  assert.equal(result.reasoning.declaredContractWorks, true)
  assert.deepEqual(result.reasoning.levels, { low: 'low', high: 'high', max: 'max' })
  assert.equal(result.reasoning.hasOff, true)
  // low + high + max, plus the two ways to switch thinking off — NOT the
  // seven-level host ladder.
  assert.equal(result.reasoning.probeCount, 5)
  const reasoningCalls = log.filter((call) => call.marker !== undefined)
  assert.equal(reasoningCalls.length, 5)
  assert.deepEqual(reasoningCalls.map((call) => call.marker).sort(),
    ['high', 'low', 'max', 'none', 'off'])
  assert.deepEqual(result.reasoning.offMechanisms.sort(),
    ['reasoning_effort=none', 'thinking=disabled'])
})

test('a refused level falls back to the ladder, and says the contract was refused', async () => {
  // `max` is refused by the gateway while `low`/`high` are accepted.
  const result = await run({
    'openai-completions:max': { status: 400, json: { error: { message: 'bad level' } } },
    'openai-completions': { status: 200, json: reply('openai-completions', { reasoning: 'x' }) },
  })
  assert.equal(result.available, true)
  assert.equal(result.reasoning.source, 'ladder (official contract refused)')
  assert.equal(result.reasoning.declaredContractWorks, false)
  assert.deepEqual(result.reasoning.rejected.map((entry) => entry.level), ['max'])
  // Everything the gateway DOES accept on the ladder is stored, `max` excluded.
  assert.equal(result.reasoning.levels.max, undefined)
  assert.equal(result.reasoning.levels.high, 'high')
})

test('with no official contract the whole ladder is probed, and only what works is stored', async () => {
  // `omen-alpha` has no first-party provider anywhere in models.dev.
  const result = await run({
    'openai-completions:none': { status: 400, json: { error: { message: 'no' } } },
    'openai-completions:minimal': { status: 400, json: { error: { message: 'no' } } },
    'openai-completions': { status: 200, json: reply('openai-completions', { reasoning: 'x', field: 'reasoning' }) },
  }, { official: null })

  assert.equal(result.available, true)
  assert.equal(result.officialPresent, false)
  assert.equal(result.reasoning.source, 'ladder')
  assert.equal(result.contextWindow, undefined, 'nothing is invented without a baseline')
  assert.deepEqual(Object.keys(result.reasoning.levels).sort(),
    ['high', 'low', 'max', 'medium', 'xhigh'])
  // Measured, not declared: the reply used `reasoning`, and that is recorded.
  assert.equal(result.interleavedField, 'reasoning')
  assert.equal(result.interleavedFieldSource, 'measured')
})

test('a delisted model stops immediately — no reasoning probes are spent', async () => {
  const log = []
  const result = await run({
    '*': { status: 400, json: { error: { message: 'Error from provider (Console Go): Upstream request failed: Model is unavailable.' } } },
  }, { log })
  assert.equal(result.available, false)
  assert.equal(result.status, SYNC_STATUS.DELISTED)
  assert.match(result.reason, /上游已下架/u)
  assert.equal(result.reasoning, undefined)
  assert.equal(log.length, 1, 'one probe is enough to learn an id is gone')
})

test('a gated model is reported as gated, which is not a model property', async () => {
  const result = await run({
    '*': { status: 403, json: { error: { type: 'RegionError', message: 'This model is not available in your country.' } } },
  })
  assert.equal(result.status, SYNC_STATUS.GATED)
  assert.match(result.reason, /区域门控/u)
  assert.match(result.reason, /not available in your country/u)
})

test('a refused recommended protocol falls through to one that answers', async () => {
  const log = []
  const result = await run({
    'openai-completions': { status: 401, json: { error: { message: 'Model x is not supported for format oa-compat' } } },
    'anthropic-messages': { status: 200, json: reply('anthropic-messages', { reasoning: 'y' }) },
  }, { alternates: () => ['anthropic-messages'], log })

  assert.equal(result.available, true)
  assert.equal(result.protocol.recommended, 'openai-completions')
  assert.equal(result.protocol.chosen, 'anthropic-messages')
  assert.equal(result.protocol.verified, false, 'the recommendation did NOT answer')
  assert.deepEqual(result.protocol.works, ['anthropic-messages'])
  // The reasoning probes follow the protocol that actually answered.
  const reasoning = log.filter((call) => call.marker !== undefined)
  assert.ok(reasoning.every((call) => call.protocol === 'anthropic-messages'))
})

test('every probe carries the mandatory headers, and the Anthropic auth pair', async () => {
  // Regression: the header sources are thunks, and `headersFor` spreads objects.
  // Passing the thunks through produced EMPTY headers — which passes every
  // routing test and then answers `MissingSessionID` against the real gateway.
  const log = []
  await run({
    'openai-completions': { status: 401, json: { error: { message: 'not supported for format oa-compat' } } },
    'anthropic-messages': { status: 200, json: reply('anthropic-messages', { reasoning: 'y' }) },
  }, { alternates: () => ['anthropic-messages'], log })

  for (const call of log) {
    assert.equal(call.headers['user-agent'], 'dsh-test', 'attribution must ride every request')
    assert.equal(call.headers['x-opencode-session'], 'test-session', 'the relay routing header must ride every request')
    assert.equal(call.headers.authorization, 'Bearer test-key')
  }
  // The Anthropic surface authenticates with `x-api-key`; measured on the
  // gateway, `authorization` alone answers 401 Missing API key.
  const anthropic = log.find((call) => call.protocol === 'anthropic-messages')
  assert.equal(anthropic.headers['x-api-key'], 'test-key')
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01')
})

test('a transport failure is a result, not a throw', async () => {
  const result = await run({ '*': new Error('ECONNREFUSED') })
  assert.equal(result.available, false)
  assert.equal(result.status, SYNC_STATUS.ERROR)
  assert.match(result.reason, /ECONNREFUSED/u)
})

test('the override and the synced layer carry different halves of the result', async () => {
  const result = await run({
    'openai-completions': { status: 200, json: reply('openai-completions', { reasoning: 'x', field: 'reasoning' }) },
  })
  const overrides = overridesFromSync(result)
  assert.deepEqual(overrides, {
    api: 'openai-completions',
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: ['low', 'high', 'max'],
  })
  // `reasoningEfforts` names HOST levels; the wire spelling cannot live there,
  // so it travels in the synced layer along with the evidence.
  const layer = syncedLayerFromSync(result)
  assert.deepEqual(layer.reasoning.levels, { low: 'low', high: 'high', max: 'max' })
  assert.equal(layer.interleavedField, 'reasoning')
  assert.ok(layer.evidence.length > 0)
  assert.ok(layer.syncedAt.length > 0)

  // An unavailable model contributes NO override: guessing here would be worse
  // than leaving the row alone and telling the operator to switch.
  assert.deepEqual(overridesFromSync({ available: false }), {})
})


test('every identifier the sync route uses has a LOCAL binding in index.js', () => {
  // Regression, and a nasty one: `src/index.js` ends with
  /// `export { protocolChainForModel, … } from './protocol-map.js'`, which
  // RE-EXPORTS the name without creating a local binding. The sync route then
  // called it and threw `ReferenceError: protocolChainForModel is not defined`
  // at request time — while every unit test stayed green, because none of them
  // load `index.js` (it needs the host packages).
  //
  // So the guard has to be static: each name is either imported or declared.
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const used = [
    'protocolChainForModel', 'resolveProtocol',
    'loadOfficialBaseline', 'officialRecordFor',
    'syncModel', 'syncedLayerFromSync',
    'SyncedLayer', 'defaultSyncedLayerPath',
    'requestHeaders', 'attributionHeaders',
  ]
  for (const name of used) {
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`, 's').test(source)
    const declared = new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(source)
    assert.ok(imported || declared,
      `${name} must have a LOCAL binding in src/index.js (a re-export does not create one)`)
  }
})


test('a gateway that never answers cannot hang the sync', async () => {
  // Without a ceiling, ONE stalled response freezes the whole run — and 停止
  // could not help, because it is only consulted between models.
  // A fetch that never answers but DOES honour the signal, the way the real one
  // does: a fake that ignores it would hang this test rather than the sync.
  const never = (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'TimeoutError'
      reject(error)
    })
  })
  const started = Date.now()
  const result = await syncModel({
    id: 'stuck', baseURL: BASE, apiKey: 'k',
    fetchImpl: never,
    baseHeaders: ATTRIBUTION, sessionHeaders: SESSION,
    protocol: { primary: 'openai-completions', source: 'models.dev-npm' },
    official: undefined,
    timeoutMs: 60,
  })
  assert.ok(Date.now() - started < 5_000, 'the ceiling must fire quickly, not never')
  assert.equal(result.available, false)
  assert.equal(result.status, SYNC_STATUS.ERROR)
  assert.match(result.reason, /超时|中止/u)
  assert.equal(result.evidence[0].timedOut, true)
  assert.equal(REQUEST_TIMEOUT_MS, 90_000, 'the shipped ceiling is documented, not incidental')
})

test('an external abort stops the run instead of being reported as a failure', async () => {
  const controller = new AbortController()
  const never = (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    // Real fetch rejects at once for an ALREADY-aborted signal; the probe starts
    // a few microtasks after `abort()` is called, so this branch is the one the
    // stop button actually takes.
    if (init.signal?.aborted === true) abort()
    else init.signal?.addEventListener('abort', abort)
  })
  const pending = syncModel({
    id: 'stuck', baseURL: BASE, apiKey: 'k',
    fetchImpl: never,
    baseHeaders: ATTRIBUTION, sessionHeaders: SESSION,
    protocol: { primary: 'openai-completions', source: 'models.dev-npm' },
    official: undefined,
    signal: controller.signal,
  })
  controller.abort('user pressed stop')
  const result = await pending
  assert.equal(result.available, false, 'the abort reaches the probe, it does not hang')
})
