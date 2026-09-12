/**
 * Unit tests for the relay session header: name/mode validation, the value
 * policy, the attribution merge, and the two structural invariants the audit
 * asked to pin (the header reaches THIS route's requests only, and attribution
 * is always present in the same request).
 *
 * None of this needs a host install: `session.js` imports only `vocab.js`, and
 * the probe tool's classifier is a pure function. The one thing that cannot be
 * imported here is `config.js` (it needs `@deepseek-ai/schemastery`, which the
 * repo deliberately does not vendor), so the schema/runtime consistency is
 * pinned by reading `config.js` as source and asserting it uses the SAME
 * vocabulary and the SAME normalizers as the runtime.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classifyProbeResponse,
  PROBE_CANDIDATES,
  REGRESSION_CANDIDATES,
  verdictFor,
} from '../scripts/probe-session-headers.mjs'
import {
  DEFAULT_SESSION_HEADER_MODE,
  normalizeSessionHeaderMode,
  normalizeSessionHeaderName,
  requestHeaders,
  SessionHeaderMap,
} from '../src/session.js'
import { SESSION_HEADER_MODES } from '../src/vocab.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const readSource = (relative) => readFileSync(join(root, relative), 'utf8')

/* ── name normalization ───────────────────────────────────────────────────── */

test('a session header name is trimmed and lower-cased', () => {
  assert.equal(normalizeSessionHeaderName('  X-OpenCode-Session  '), 'x-opencode-session')
  assert.equal(normalizeSessionHeaderName('x-opencode-session'), 'x-opencode-session')
  // Every RFC 7230 token character survives normalization untouched.
  const token = "x-a!#$%&'*+-.^_`|~09"
  assert.equal(normalizeSessionHeaderName(token), token)
})

test('an empty session header name is refused with a named error', () => {
  for (const value of ['', '   ', undefined, null]) {
    assert.throws(
      () => normalizeSessionHeaderName(value),
      /opencode-go-native: sessionHeader must be a non-empty header name/,
      `expected a refusal for ${JSON.stringify(value)}`,
    )
  }
})

test('a name outside the HTTP token charset is refused, not handed to fetch', () => {
  // Surrounding whitespace is trimmed first (a yml scalar can carry it); an
  // INTERNAL separator or control character cannot be normalized away.
  for (const value of ['x session', 'x:session', 'x-session\nfoo', 'x-session\u0000', 'x-session,', 'x-session()']) {
    assert.throws(
      () => normalizeSessionHeaderName(value),
      /is not a valid HTTP header name/,
      `expected a refusal for ${JSON.stringify(value)}`,
    )
  }
  assert.equal(normalizeSessionHeaderName('x-session\n'), 'x-session')
})

/* ── mode normalization ───────────────────────────────────────────────────── */

test('the value policy defaults to session-id and accepts exactly the vocabulary modes', () => {
  assert.equal(DEFAULT_SESSION_HEADER_MODE, 'session-id')
  assert.equal(normalizeSessionHeaderMode(undefined), 'session-id')
  assert.equal(normalizeSessionHeaderMode(null), 'session-id')
  for (const mode of SESSION_HEADER_MODES) assert.equal(normalizeSessionHeaderMode(mode), mode)
})

test('an unknown value policy is refused and the error names every legal mode', () => {
  for (const value of ['sessionid', 'SESSION-ID', 'uuid4', '', 5, true, {}]) {
    assert.throws(
      () => normalizeSessionHeaderMode(value),
      (error) => {
        assert.match(error.message, /opencode-go-native: sessionHeaderMode must be one of/)
        for (const mode of SESSION_HEADER_MODES) assert.match(error.message, new RegExp(`"${mode}"`))
        return true
      },
      `expected a refusal for ${String(value)}`,
    )
  }
})

/* ── value policy ─────────────────────────────────────────────────────────── */

test('session-id mode forwards the host id verbatim and stably', () => {
  const map = new SessionHeaderMap('session-id')
  assert.equal(map.valueFor('sess-abc'), 'sess-abc')
  assert.equal(map.valueFor('sess-abc'), 'sess-abc')
  assert.equal(map.valueFor('sess-def'), 'sess-def')
  // Non-string ids are stringified rather than dropped.
  assert.equal(map.valueFor(42), '42')
})

test('uuid mode substitutes an opaque value that is process-stable per conversation', () => {
  const map = new SessionHeaderMap('uuid')
  const first = map.valueFor('sess-abc')
  assert.notEqual(first, 'sess-abc')
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(map.valueFor('sess-abc'), first)
  assert.notEqual(map.valueFor('sess-def'), first)
})

test('a request with no host session id still gets one stable, non-empty value', () => {
  for (const mode of SESSION_HEADER_MODES) {
    const map = new SessionHeaderMap(mode)
    const value = map.valueFor(undefined)
    assert.equal(typeof value, 'string')
    assert.ok(value.length > 0)
    assert.equal(map.valueFor(undefined), value)
    assert.equal(map.valueFor(null), value)
  }
})

test('switching the value policy takes effect without disturbing the other mode', () => {
  const map = new SessionHeaderMap('session-id')
  const hosted = map.valueFor('sess-abc')
  const opaque = map.valueFor('sess-abc', 'uuid')
  assert.equal(hosted, 'sess-abc')
  assert.notEqual(opaque, hosted)
  // Switching back returns the value this conversation already had.
  assert.equal(map.valueFor('sess-abc', 'session-id'), hosted)
  assert.equal(map.valueFor('sess-abc', 'uuid'), opaque)
})

test('an invalid policy is refused at construction and per call', () => {
  assert.throws(() => new SessionHeaderMap('nope'), /sessionHeaderMode must be one of/)
  const map = new SessionHeaderMap()
  assert.throws(() => map.valueFor('sess-abc', 'nope'), /sessionHeaderMode must be one of/)
})

/* ── the attribution merge (the same-request contract) ────────────────────── */

const ATTRIBUTION = {
  'user-agent': 'deepseek-harness/0.1.5-rc.1 (+https://github.com/deepseek-ai/deepseek-harness)',
}

test('the session header rides in the same headers object as attribution', () => {
  const headers = requestHeaders(ATTRIBUTION, 'x-opencode-session', 'sess-abc')
  assert.deepEqual(headers, { ...ATTRIBUTION, 'x-opencode-session': 'sess-abc' })
  // Inputs are never mutated: attribution is a shared, host-owned object.
  assert.deepEqual(ATTRIBUTION, {
    'user-agent': 'deepseek-harness/0.1.5-rc.1 (+https://github.com/deepseek-ai/deepseek-harness)',
  })
  assert.notEqual(headers, ATTRIBUTION)
})

test('attribution wins a name collision, case-insensitively', () => {
  const attribution = { 'X-Opencode-Session': 'attribution-value' }
  for (const name of ['x-opencode-session', 'X-OpenCode-Session', '  x-opencode-session  ']) {
    const headers = requestHeaders(attribution, name, 'sess-abc')
    assert.deepEqual(headers, { 'X-Opencode-Session': 'attribution-value' })
  }
})

test('a disabled or empty name sends no session header, and attribution still goes', () => {
  for (const name of [undefined, null, '', '   ']) {
    assert.deepEqual(requestHeaders(ATTRIBUTION, name, 'sess-abc'), { ...ATTRIBUTION })
  }
})

test('an empty session value sends no header (an un-routable header is worse than none)', () => {
  for (const value of [undefined, null, '']) {
    assert.deepEqual(requestHeaders(ATTRIBUTION, 'x-opencode-session', value), { ...ATTRIBUTION })
  }
  // A non-string value is stringified, not dropped: only EMPTY is empty.
  assert.deepEqual(requestHeaders(ATTRIBUTION, 'x-opencode-session', 0), {
    ...ATTRIBUTION,
    'x-opencode-session': '0',
  })
})

test('the emitted name is lower-cased even when the caller passes mixed case', () => {
  const headers = requestHeaders(ATTRIBUTION, 'X-Session-Id', 'sess-abc')
  assert.deepEqual(headers, { ...ATTRIBUTION, 'x-session-id': 'sess-abc' })
})

/* ── structural invariants (source-level, no host install needed) ─────────── */

test('no module patches global fetch: the session header cannot leak to other routes', () => {
  const files = readdirSync(join(root, 'src')).filter((entry) => entry.endsWith('.js'))
  assert.ok(files.length > 10)
  for (const file of files) {
    const source = readSource(join('src', file))
    assert.doesNotMatch(source, /globalThis\.fetch\s*=/, `${file} must not patch globalThis.fetch`)
    assert.doesNotMatch(source, /globalThis\[\s*['"]fetch['"]\s*\]\s*=/, `${file} must not patch globalThis.fetch`)
    assert.doesNotMatch(source, /\bglobal\.fetch\s*=/, `${file} must not patch global.fetch`)
  }
})

test('requestHeaders is called in exactly one place, with attribution() in the same call', () => {
  const callers = readdirSync(join(root, 'src'))
    .filter((entry) => entry.endsWith('.js'))
    .filter((file) => /[^.\w]requestHeaders\s*\(/.test(readSource(join('src', file))))
    .filter((file) => file !== 'session.js')
  // Two call sites and no more: the request path, and the sync probes (which
  // are also provider requests and must carry the same mandatory headers).
  assert.deepEqual(callers.sort(), ['adapter.js', 'index.js'], 'the header merge must stay in these two places')
  // …and at BOTH, the session header is merged WITH attribution, never instead of it.
  assert.match(readSource('src/adapter.js'), /headers:\s*requestHeaders\(attributionHeaders\(\)/)
  assert.match(readSource('src/index.js'), /baseHeaders:\s*\(\)\s*=>\s*requestHeaders\(attributionHeaders\(\)/)
})

test('session.js and vocab.js stay host-import-free so npm test needs no profile', () => {
  const session = readSource('src/session.js')
  const specifiers = [...session.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(specifiers, ['./vocab.js'])
  assert.doesNotMatch(readSource('src/vocab.js'), /^\s*import\s/m)
})

/* ── schema / runtime consistency (config.js needs schemastery, so read it) ─ */

test('config.js takes the mode list and the normalizers from the one implementation', () => {
  const config = readSource('src/config.js')
  assert.match(config, /import \{ normalizeSessionHeaderMode, normalizeSessionHeaderName \} from '\.\/session\.js'/)
  assert.match(config, /sessionHeaderMode:\s*z\.union\(\[\.\.\.SESSION_HEADER_MODES\]\)/)
  // No second, hand-written list that could drift from the vocabulary.
  assert.doesNotMatch(config, /\['session-id',\s*'uuid'\]/)
  assert.match(config, /normalizeSessionHeaderName\(config\.sessionHeader \?\? DEFAULT_SESSION_HEADER\)/)
  assert.match(config, /normalizeSessionHeaderMode\(config\.sessionHeaderMode\)/)
  // The resolved facts carry the switch, so a settings change can reach the adapter.
  assert.match(config, /sessionHeaderEnabled,/)
})

/* ── the live probe's classifier (the regression's decision logic) ───────── */

const MISSING_SESSION = '{"type":"error","error":{"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently."}}'

test('the probe classifier names the relay gate and every other shape', () => {
  assert.equal(classifyProbeResponse(400, MISSING_SESSION), 'MissingSessionID')
  assert.equal(classifyProbeResponse(200, '{"id":"x","object":"chat.completion"}'), 'ok')
  assert.equal(
    classifyProbeResponse(401, '{"type":"error","error":{"type":"ModelError","message":"Model kimi-k3 is not supported for format openai"}}'),
    'ModelError',
  )
  // A non-JSON body (the gateway's HTML 404 page) must still classify.
  assert.equal(classifyProbeResponse(404, '<!DOCTYPE html><html lang="en">'), 'HTTP 404')
  assert.equal(classifyProbeResponse(0, ''), 'NETWORK')
})

test('a row verdict distinguishes the 400 gate from any other failure', () => {
  assert.equal(verdictFor('missing', 400, 'MissingSessionID'), 'PASS')
  assert.equal(verdictFor('missing', 400, 'ModelError'), 'FAIL')
  assert.equal(verdictFor('missing', 200, 'ok'), 'FAIL')
  assert.equal(verdictFor('ok', 200, 'ok'), 'PASS')
  assert.equal(verdictFor('ok', 400, 'MissingSessionID'), 'FAIL')
  assert.equal(verdictFor(undefined, 500, 'HTTP 500'), 'observed')
})

test('the candidate table keeps the measured controls and the brief\'s names', () => {
  const labels = PROBE_CANDIDATES.map((candidate) => candidate.label)
  for (const required of [
    '(no session header)',
    'x-opencode-session',
    'x-deepseek-harness-session-id',
    'x-whatever-session',
    'x-foo',
    'x-session-id',
    'session_id',
    'x-session-affinity',
    'x-client-request-id',
    'x-request-id',
    'x-opencode-session-id',
    'x-opencode-request-id',
  ]) {
    assert.ok(labels.includes(required), `the table must still probe ${required}`)
  }
  // The offline gate is honest about the gate: a header-only row still needs a value.
  const empty = PROBE_CANDIDATES.find((candidate) => candidate.label.endsWith('(empty value)'))
  assert.equal(empty?.value, '')
})

test('the regression subset always contains both sides of the gate', () => {
  assert.ok(REGRESSION_CANDIDATES.some((candidate) => candidate.header === undefined))
  assert.ok(REGRESSION_CANDIDATES.some((candidate) => candidate.header === 'x-opencode-session'))
})
