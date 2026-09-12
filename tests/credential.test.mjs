/**
 * Unit tests for the ONE decision about where a bearer token comes from.
 *
 * `resolveConnectionApiKey` is host-free by construction: the credentials
 * service, the error class, and the two brand/validate helpers are all injected.
 * That is what lets these tests assert the precedence — and, just as important,
 * assert what the losing branch did NOT do.
 *
 * The rule since 0.6.0 is single-source: the `apiKeyEnv` REFERENCE is the
 * credential, and the legacy inline `apiKey` is only a migration remnant that
 * must never outrank it. The counter-proof at the bottom swaps the two and
 * requires the same assertions to fail, so "the reference wins" cannot pass by
 * accident.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createApiKeyResolver,
  missingCredentialMessage,
  resolveConnectionApiKey,
} from '../src/credential.js'

/** The obvious sentinel, so a real token can never be mistaken for a fixture. */
const LEGACY = 'sk-LEGACY-not-a-real-key'
const STORED = 'sk-STORED-not-a-real-key'
const REFERENCE = 'OPENCODE_GO_API_KEY'

/** The host's `LlmError`, reduced to what this module uses. */
class FakeLlmError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/**
 * A credentials seam that records every call.
 *
 * The recorder is the point: "the store was consulted" is a fact about calls,
 * not about the returned string, and it is the fact the requirement names.
 */
function fakeCredentials(options = {}) {
  // Deliberately not a destructuring default: `{ value: undefined }` means "the
  // store holds nothing", and a default parameter would silently turn that back
  // into the ordinary stored key — the exact trap that once made the dead-end
  // test pass for the wrong reason.
  const value = 'value' in options ? options.value : STORED
  const describeValue = 'describeValue' in options ? options.describeValue : { configured: true, writable: true }
  const record = { resolve: [] }
  return {
    record,
    seam: {
      resolve: async (ref) => {
        record.resolve.push(ref)
        return value === undefined ? undefined : { value }
      },
      describe: async () => describeValue,
      set: async () => {},
    },
  }
}

/** The injected host helpers, with the reference grammar the real one enforces. */
const HELPERS = {
  // Mirrors `@deepseek-ai/dsh-credentials#credentialRef`: POSIX identifier.
  credentialRefOf: async () => (raw) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(raw))) {
      throw new TypeError(`credential ref "${String(raw)}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`)
    }
    return String(raw)
  },
  // Mirrors `@deepseek-ai/dsh-llm#assertUsableApiKey` + `normalizeApiKey`:
  // trims, then refuses blank or header-illegal values.
  usableApiKeyOf: async () => (raw, pkg, ref) => {
    const value = String(raw ?? '').trim()
    if (value.length === 0) throw new FakeLlmError(`${pkg}: the API key resolved from ${ref} is blank`, 'INVALID_CREDENTIAL')
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/u.test(value)) throw new FakeLlmError(`${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry`, 'INVALID_CREDENTIAL')
    return value
  },
}

/** Run the resolver with the standard collaborators. */
function resolve(options, credentials, overrides = {}) {
  return resolveConnectionApiKey({
    options,
    credentials,
    LlmError: FakeLlmError,
    ...HELPERS,
    ...overrides,
  })
}

// ── the reference is the source ────────────────────────────────────────────

test('the reference resolves the token, and a legacy inline value never outranks it', async () => {
  const { seam, record } = fakeCredentials()
  const legacySeen = []
  const value = await resolve(
    { apiKey: LEGACY, apiKeyEnv: REFERENCE },
    seam,
    { onLegacy: () => legacySeen.push(true) },
  )
  assert.equal(value, STORED, 'the stored credential is the source in force')
  assert.deepEqual(record.resolve, [REFERENCE])
  assert.deepEqual(legacySeen, [], 'the legacy copy must not even be considered while the store answers')
})

test('an empty reference value falls back to the legacy inline token, and says so', async () => {
  const { seam, record } = fakeCredentials({ value: undefined })
  const legacySeen = []
  const value = await resolve(
    { apiKey: LEGACY, apiKeyEnv: REFERENCE },
    seam,
    { onLegacy: () => legacySeen.push(true) },
  )
  assert.equal(value, LEGACY)
  assert.deepEqual(record.resolve, [REFERENCE], 'the store is always consulted first')
  assert.deepEqual(legacySeen, [true], 'the fallback is announced, never silent')
})

test('a missing inline apiKey resolves through the store alone', async () => {
  const { seam, record } = fakeCredentials()
  assert.equal(await resolve({ apiKeyEnv: REFERENCE }, seam), STORED)
  assert.deepEqual(record.resolve, [REFERENCE])
})

test('no credentials service at all still lets the legacy token work', async () => {
  const legacySeen = []
  assert.equal(await resolve({ apiKey: LEGACY, apiKeyEnv: REFERENCE }, undefined, { onLegacy: () => legacySeen.push(true) }), LEGACY)
  assert.deepEqual(legacySeen, [true])
})

test('a blank reference skips the store rather than calling the brand helper on nothing', async () => {
  const { seam, record } = fakeCredentials()
  const value = await resolve({ apiKey: LEGACY, apiKeyEnv: '' }, seam)
  assert.equal(value, LEGACY, 'a pre-0.6.0 document may name no reference at all')
  assert.deepEqual(record.resolve, [], 'an empty name has nothing to resolve')
})

// ── the dead end ───────────────────────────────────────────────────────────

test('neither source: the error is MISSING_CREDENTIAL and names the store, not the settings file', async () => {
  // An EMPTY store. `fakeCredentials({ value: undefined })` would NOT do this:
  // a destructuring default fires on `undefined`, so the fixture would hand back
  // the ordinary stored key and this test would silently stop testing the dead
  // end. The seam is therefore built directly.
  const empty = { resolve: async () => undefined }
  const probe = await resolve({ apiKeyEnv: REFERENCE }, empty).then((v) => `RESOLVED:${v}`, (e) => `THREW:${e.code}`)
  assert.equal(probe, 'THREW:MISSING_CREDENTIAL', `the resolver must refuse an empty store, got ${probe}`)
  await assert.rejects(
    resolve({ apiKeyEnv: REFERENCE }, empty),
    (error) => {
      assert.equal(error.code, 'MISSING_CREDENTIAL')
      assert.equal(error.message, missingCredentialMessage(REFERENCE))
      // The one way out, named explicitly — this is the text the operator acts on.
      assert.match(error.message, new RegExp(REFERENCE, 'u'))
      assert.match(error.message, /credentials service/u)
      assert.match(error.message, /credentials\.yaml/u)
      // And the removed behaviour is named as REMOVED, not offered as an option.
      assert.match(error.message, /does not read a key out of the settings document/u)
      return true
    },
  )
})

test('a missing credentials service and no token anywhere is the same dead end', async () => {
  await assert.rejects(
    resolve({ apiKeyEnv: REFERENCE }, undefined),
    (error) => error.code === 'MISSING_CREDENTIAL' && error.message.includes(REFERENCE),
  )
})

test('an unusable legacy token is refused as INVALID_CREDENTIAL, not silently used', async () => {
  const { seam, record } = fakeCredentials({ value: undefined })
  await assert.rejects(
    resolve({ apiKey: 'sk-with\nnewline', apiKeyEnv: REFERENCE }, seam),
    (error) => error.code === 'INVALID_CREDENTIAL',
  )
  // It had to miss in the store before it could reach the legacy value.
  assert.deepEqual(record.resolve, [REFERENCE])
})

test('an unusable STORED value is refused too, with the reference named', async () => {
  const { seam } = fakeCredentials({ value: 'sk-with\u0000nul' })
  await assert.rejects(
    resolve({ apiKeyEnv: REFERENCE }, seam),
    (error) => error.code === 'INVALID_CREDENTIAL' && error.message.includes(REFERENCE),
  )
})

test('the reference grammar is enforced by the host helper, not re-implemented here', async () => {
  const { seam } = fakeCredentials()
  await assert.rejects(
    resolve({ apiKey: '', apiKeyEnv: 'not a reference' }, seam),
    (error) => error instanceof TypeError && /credential ref/u.test(error.message),
  )
})

// ── the wiring ─────────────────────────────────────────────────────────────

test('the resolver re-reads the live options on every call, not once at wiring', async () => {
  // `createApiKeyResolver` itself is a one-line closure over dynamic imports of
  // host packages this repository cannot resolve under `node --test`. What can
  // be pinned here is the contract it must preserve: the caller reads
  // `options()` per call, so a settings write reaches the next request without
  // a restart. This drives exactly that shape.
  const { seam, record } = fakeCredentials()
  let current = { apiKey: LEGACY, apiKeyEnv: REFERENCE }
  const live = () => resolve(current, seam)
  assert.equal(await live(), STORED)
  current = { apiKey: undefined, apiKeyEnv: REFERENCE }
  assert.equal(await live(), STORED)
  assert.deepEqual(record.resolve, [REFERENCE, REFERENCE])
})

// ── counter-proof ──────────────────────────────────────────────────────────

/**
 * The same resolver with the precedence INVERTED.
 *
 * This is the failing-case proof: if the production code ever grew the old bug
 * that a plain-text inline value wins, these assertions must start failing. It
 * is deliberately written as the mutation of the real decision, not as a copy:
 * it answers the same call in the opposite order.
 */
function invertedResolver({ options, credentials, LlmError, credentialRefOf, usableApiKeyOf }) {
  return (async () => {
    const usable = await usableApiKeyOf()
    const inline = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
    if (inline.length > 0) return usable(inline, 'opencode-go-native', 'the legacy inline "apiKey" setting')
    if (credentials !== undefined) {
      const credentialRef = await credentialRefOf()
      const hit = await credentials.resolve(credentialRef(options.apiKeyEnv))
      if (hit !== undefined) return usable(hit.value, 'opencode-go-native', options.apiKeyEnv)
    }
    throw new LlmError(missingCredentialMessage(options.apiKeyEnv), 'MISSING_CREDENTIAL')
  })()
}

test('COUNTER-PROOF: the priority assertions FAIL when the two sources are swapped', async () => {
  /** Exactly the assertions of the first test above, against one resolver. */
  const priorityHolds = async (run) => {
    const { seam, record } = fakeCredentials()
    const legacySeen = []
    const value = await run({ options: { apiKey: LEGACY, apiKeyEnv: REFERENCE }, credentials: seam, onLegacy: () => legacySeen.push(true) })
    assert.equal(value, STORED)
    assert.deepEqual(legacySeen, [])
    void record
  }

  // The real resolver passes.
  await priorityHolds((args) => resolveConnectionApiKey({
    ...args,
    LlmError: FakeLlmError,
    ...HELPERS,
  }))

  // The inverted one must fail — and on the value, so the assertion above is not
  // vacuous. The thrown AssertionError is the evidence.
  const failures = []
  await assert.rejects(
    priorityHolds((args) => invertedResolver({ ...args, LlmError: FakeLlmError, ...HELPERS })),
    (error) => {
      assert.ok(error instanceof assert.AssertionError, `expected an assertion failure, got ${String(error)}`)
      failures.push(error.message)
      return true
    },
  )
  assert.equal(failures.length, 1)
  assert.match(failures[0], /Expected values to be strictly equal/u)
})
