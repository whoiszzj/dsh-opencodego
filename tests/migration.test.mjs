/**
 * Unit tests for the one-time move of a pre-0.6.0 plain-text token into the
 * credential store.
 *
 * Both halves are host-free (`src/migration.js` imports nothing but the plugin's
 * own vocabulary), so bare `node --test` drives every branch — including the two
 * that must NOT delete the operator's only copy of a token: a store that refuses
 * the write, and a composition with no credential plane at all.
 *
 * @module tests/migration
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createLegacyKeyMigrationRunner,
  legacyApiKeyOf,
  planLegacyApiKeyMigration,
  runLegacyApiKeyMigration,
} from '../src/migration.js'

const TOKEN = 'sk-LEGACY-not-a-real-key'
const REFERENCE = 'OPENCODE_GO_API_KEY'
const DEFAULT = 'OPENCODE_GO_API_KEY'

/** A credential provider stub that records every call. */
function credentialStub({ configured = false, resolveValue = undefined, setThrows = undefined } = {}) {
  const calls = { describe: [], set: [], resolve: [] }
  return {
    calls,
    seam: {
      describe: async (ref) => {
        calls.describe.push(ref)
        return { configured, writable: true }
      },
      set: async (ref, value) => {
        calls.set.push({ ref, value })
        if (setThrows !== undefined) throw setThrows
      },
      resolve: async (ref) => {
        calls.resolve.push(ref)
        return resolveValue === undefined ? undefined : { value: resolveValue }
      },
    },
  }
}

/** The settings writer stub. */
function settingsStub({ throws = undefined } = {}) {
  const ops = []
  return {
    ops,
    // Two call shapes reach this stub: the direct seam (`mutate(ops)`) and the
    // runner's settings-service shape (`mutate(ns, ops, revision)`).
    mutate: async (first, second) => {
      ops.push(second === undefined ? first : second)
      if (throws !== undefined) throw throws
    },
  }
}

/** The host brand function, reduced to the grammar it enforces. */
const credentialRef = (raw) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(raw))) throw new TypeError(`bad ref ${String(raw)}`)
  return String(raw)
}

// ── reading the legacy value ───────────────────────────────────────────────

test('legacyApiKeyOf reads only a non-blank string, from an object', () => {
  assert.equal(legacyApiKeyOf({ apiKey: TOKEN }), TOKEN)
  assert.equal(legacyApiKeyOf({ apiKey: `  ${TOKEN}  ` }), TOKEN)
  assert.equal(legacyApiKeyOf({ apiKey: '   ' }), undefined)
  assert.equal(legacyApiKeyOf({ apiKey: 42 }), undefined)
  assert.equal(legacyApiKeyOf({}), undefined)
  assert.equal(legacyApiKeyOf(undefined), undefined)
  assert.equal(legacyApiKeyOf(['a']), undefined)
})

test('planLegacyApiKeyMigration names the one case with nothing to do and the one that cannot proceed', () => {
  assert.deepEqual(planLegacyApiKeyMigration({ userSection: {}, defaultReference: DEFAULT }), { action: 'none' })
  assert.deepEqual(
    planLegacyApiKeyMigration({ userSection: { apiKey: TOKEN }, reference: REFERENCE, defaultReference: DEFAULT }),
    { action: 'migrate', reference: REFERENCE, value: TOKEN },
  )
  // A blank reference falls back to the plugin's default rather than refusing.
  assert.deepEqual(
    planLegacyApiKeyMigration({ userSection: { apiKey: TOKEN }, reference: '  ', defaultReference: DEFAULT }),
    { action: 'migrate', reference: DEFAULT, value: TOKEN },
  )
  assert.deepEqual(
    planLegacyApiKeyMigration({ userSection: { apiKey: TOKEN }, defaultReference: '' }).action,
    'keep',
  )
})

// ── running it ─────────────────────────────────────────────────────────────

test('no legacy value: nothing is touched at all', async () => {
  const { seam, calls } = credentialStub()
  const settings = settingsStub()
  const outcome = await runLegacyApiKeyMigration({
    userSection: {}, defaultReference: DEFAULT, credentials: seam, credentialRef, mutateSettings: settings.mutate,
  })
  assert.deepEqual(outcome, { action: 'none' })
  assert.deepEqual(calls, { describe: [], set: [], resolve: [] })
  assert.deepEqual(settings.ops, [])
})

test('a legacy token is stored under the reference, then removed from the settings document', async () => {
  const { seam, calls } = credentialStub({ configured: false })
  const settings = settingsStub()
  const lines = []
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN },
    reference: REFERENCE,
    defaultReference: DEFAULT,
    credentials: seam,
    credentialRef,
    mutateSettings: settings.mutate,
    log: (level, message) => lines.push(`${level}:${message}`),
  })
  assert.deepEqual(outcome, { action: 'migrated', reference: REFERENCE })
  assert.deepEqual(calls.set, [{ ref: REFERENCE, value: TOKEN }])
  assert.deepEqual(settings.ops, [[{ op: 'unset', path: ['apiKey'] }]])
  assert.ok(lines.some((line) => line.startsWith('info:') && /migrated/u.test(line)))
})

test('an already-configured reference is not overwritten; the plain text is still retired', async () => {
  const { seam, calls } = credentialStub({ configured: true })
  const settings = settingsStub()
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN }, reference: REFERENCE, defaultReference: DEFAULT,
    credentials: seam, credentialRef, mutateSettings: settings.mutate,
  })
  assert.deepEqual(outcome, { action: 'migrated', reference: REFERENCE })
  assert.deepEqual(calls.set, [], 'a deliberately stored credential must not be replaced by an older copy')
  assert.deepEqual(settings.ops, [[{ op: 'unset', path: ['apiKey'] }]])
})

test('a store that refuses the write leaves the token alone', async () => {
  const { seam } = credentialStub({ configured: false, setThrows: new Error('read-only provider') })
  const settings = settingsStub()
  const lines = []
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN }, reference: REFERENCE, defaultReference: DEFAULT,
    credentials: seam, credentialRef, mutateSettings: settings.mutate, log: (level, message) => lines.push(`${level}:${message}`),
  })
  assert.equal(outcome.action, 'kept')
  assert.match(outcome.reason, /read-only provider/u)
  assert.deepEqual(settings.ops, [], 'the operator\'s only copy of the token must survive a failed store')
  assert.ok(lines.some((line) => line.startsWith('warn:')))
})

test('a shadowing read-only source is not a failure: the reference already resolves, so the field is unset', async () => {
  // `set` refuses while an exported environment variable shadows the reference,
  // which is exactly the state the seam documents — the plain text is redundant.
  const { seam, calls } = credentialStub({ configured: false, setThrows: new Error('shadowed by the environment'), resolveValue: 'sk-FROM-ENV' })
  const settings = settingsStub()
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN }, reference: REFERENCE, defaultReference: DEFAULT,
    credentials: seam, credentialRef, mutateSettings: settings.mutate,
  })
  assert.deepEqual(outcome, { action: 'migrated', reference: REFERENCE })
  assert.deepEqual(calls.set, [{ ref: REFERENCE, value: TOKEN }])
  assert.deepEqual(settings.ops, [[{ op: 'unset', path: ['apiKey'] }]])
})

test('no credential plane: the token is reported, never deleted', async () => {
  const settings = settingsStub()
  const lines = []
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN }, reference: REFERENCE, defaultReference: DEFAULT,
    credentials: undefined, credentialRef, mutateSettings: settings.mutate, log: (level, message) => lines.push(`${level}:${message}`),
  })
  assert.equal(outcome.action, 'kept')
  assert.match(outcome.reason, /no credentials service/u)
  assert.deepEqual(settings.ops, [])
  assert.ok(lines.some((line) => line.startsWith('warn:')))
})

test('an unusable reference name is reported instead of thrown', async () => {
  const { seam } = credentialStub()
  const settings = settingsStub()
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN }, reference: 'not a reference', defaultReference: DEFAULT,
    credentials: seam, credentialRef, mutateSettings: settings.mutate,
  })
  assert.equal(outcome.action, 'kept')
  assert.match(outcome.reason, /not a valid credential reference/u)
  assert.deepEqual(settings.ops, [])
})

test('a credential stored but a settings write refused is reported as partial', async () => {
  const { seam, calls } = credentialStub({ configured: false })
  const settings = settingsStub({ throws: new Error('settings provider is read-only') })
  const lines = []
  const outcome = await runLegacyApiKeyMigration({
    userSection: { apiKey: TOKEN }, reference: REFERENCE, defaultReference: DEFAULT,
    credentials: seam, credentialRef, mutateSettings: settings.mutate, log: (level, message) => lines.push(`${level}:${message}`),
  })
  assert.equal(outcome.action, 'stored')
  assert.deepEqual(calls.set, [{ ref: REFERENCE, value: TOKEN }])
  assert.ok(lines.some((line) => line.startsWith('warn:') && /could not be removed/u.test(line)))
})

// ── the runner `index.js` wires ────────────────────────────────────────────

/** Build a runner over fakes, with everything recorded and the service set controllable. */
function runnerOf({ userSection = {}, reference = REFERENCE, settingsAvailable = true, credentialsAvailable = true } = {}) {
  const { seam, calls } = credentialStub()
  const settings = settingsStub()
  const settingsService = {
    ...settings,
    describe: () => [{ ns: 'opencode-go-native', user: userSection }],
  }
  const available = new Map()
  if (settingsAvailable) available.set('settings', settingsService)
  if (credentialsAvailable) available.set('credentials', seam)
  const lines = []
  const run = createLegacyKeyMigrationRunner({
    getService: (name) => available.get(name),
    options: () => ({ apiKeyEnv: reference }),
    defaultReference: DEFAULT,
    credentialRefOf: async () => credentialRef,
    ns: 'opencode-go-native',
    log: (level, message) => lines.push(`${level}:${message}`),
  })
  return { run, calls, settings, lines, available, seam, settingsService }
}

test('the runner defers — and stays armed — until both planes exist', async () => {
  const waiting = runnerOf({ userSection: { apiKey: TOKEN }, credentialsAvailable: false })
  assert.deepEqual(await waiting.run(), { action: 'deferred' })
  assert.deepEqual(waiting.settings.ops, [], 'nothing may be written while the destination is missing')
  // The credential plane arrives: the SAME runner is still armed and now works.
  waiting.available.set('credentials', waiting.seam)
  assert.deepEqual(await waiting.run(), { action: 'migrated', reference: REFERENCE })
  assert.deepEqual(waiting.settings.ops, [[{ op: 'unset', path: ['apiKey'] }]])

  const noSettings = runnerOf({ userSection: { apiKey: TOKEN }, settingsAvailable: false })
  assert.deepEqual(await noSettings.run(), { action: 'deferred' })
})

test('the runner settles once: a re-entrant call after the write is a no-op', async () => {
  const { run, calls, settings } = runnerOf({ userSection: { apiKey: TOKEN } })
  assert.equal((await run()).action, 'migrated')
  assert.deepEqual(await run(), { action: 'skipped' })
  assert.deepEqual(calls.set, [{ ref: REFERENCE, value: TOKEN }], 'the credential write must not repeat')
  assert.equal(settings.ops.length, 1, 'the settings unset must not repeat')
})

test('the runner reads the reference at call time, so a renamed apiKeyEnv is honoured', async () => {
  const { run, calls } = runnerOf({ userSection: { apiKey: TOKEN }, reference: 'RENAMED_KEY' })
  assert.deepEqual(await run(), { action: 'migrated', reference: 'RENAMED_KEY' })
  assert.deepEqual(calls.set, [{ ref: 'RENAMED_KEY', value: TOKEN }])
})

test('a settings read that throws is reported, not thrown, and leaves the token alone', async () => {
  const { seam } = credentialStub()
  const available = new Map([
    ['credentials', seam],
    ['settings', {
      describe: () => { throw new Error('settings provider is read-only') },
      mutate: async () => {},
    }],
  ])
  const lines = []
  const run = createLegacyKeyMigrationRunner({
    getService: (name) => available.get(name),
    options: () => ({ apiKeyEnv: REFERENCE }),
    defaultReference: DEFAULT,
    credentialRefOf: async () => credentialRef,
    ns: 'opencode-go-native',
    log: (level, message) => lines.push(`${level}:${message}`),
  })
  const outcome = await run()
  assert.equal(outcome.action, 'kept')
  assert.match(outcome.reason, /read-only/u)
  assert.ok(lines.some((line) => line.startsWith('warn:')))
})
