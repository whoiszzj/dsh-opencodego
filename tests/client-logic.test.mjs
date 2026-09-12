/**
 * The settings page's rules, without a browser.
 *
 * `src/client/logic.js` holds every decision the section makes; the React half
 * is only pixels and promise plumbing. That split is what lets this file pin the
 * page's behaviour with bare `node --test` — no DOM engine, no jsdom, no
 * browser. `tests/client-bundle.test.mjs` covers the other half (that the built
 * bundle registers and materializes).
 *
 * @module tests/client-logic
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addModelById,
  blankExtraDraft,
  capabilityChips,
  catalogueView,
  capacityPlaceholder,
  credentialPlan,
  deepEqual,
  describeFailure,
  describeSync,
  diagnosticsView,
  directoryRows,
  effectiveIds,
  errorPathsOf,
  modelSourceLine,
  replacementSuggestions,
  syncProgressText,
  syncTargetIds,
  formFromView,
  formatTokenCount,
  isConflictFailure,
  isDirty,
  isHeaderToken,
  isModelEnabled,
  isUsableApiKey,
  legacyApiKeyPresent,
  looksLikeSecretValue,
  modalityPlaceholder,
  modelsBlockFrom,
  modelsWriteOps,
  namespaceView,
  patchDirectoryRow,
  preserveDraftScalars,
  primaryErrorPath,
  removeDirectoryRow,
  revisionFor,
  rowIndexFor,
  setModelSelection,
  unwrapPayload,
  validateForm,
  writeOps,
} from '../src/client/logic.js'

/** The sentinel the credential fixture stages — never a real key. */
const STAGED = 'sk-SENTINEL-not-a-real-key'
/** A legacy plain-text token, as a pre-0.6.0 document stored it. */
const LEGACY = 'sk-LEGACY-not-a-real-key'

/** One `SettingsNamespaceView`-shaped fixture, as `settings.describe()` returns it. */
function viewOf({ value = {}, user, revision = 7 } = {}) {
  return {
    ns: 'opencode-go-native',
    schema: {},
    value: { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', sessionHeaderEnabled: true, sessionHeaderMode: 'session-id', sync: true, ...value },
    ...user === undefined ? {} : { user },
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** One catalogue entry as `GET /opencode-go-native/models` answers it. */
function modelOf(id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: 'openai-completions',
    protocolSource: 'models.dev-npm',
    snapshotKnown: true,
    defaults: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    effective: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    ...overrides,
  }
}

// ── reading the host's payload ─────────────────────────────────────────────

test('namespaceView finds our namespace and refuses to guess', () => {
  assert.equal(namespaceView({ namespaces: [{ ns: 'other' }, { ns: 'opencode-go-native', revision: 3 }] }).revision, 3)
  assert.equal(namespaceView({ namespaces: [{ ns: 'other' }] }), undefined)
  assert.equal(namespaceView(undefined), undefined)
  assert.equal(namespaceView({ namespaces: 'nope' }), undefined)
})

test('formFromView prefers the user layer for scalars and the user models block verbatim', () => {
  const form = formFromView(viewOf({
    value: { baseURL: 'https://from-resolved/v1', displayName: 'resolved-name' },
    user: { baseURL: 'https://from-user/v1', models: { disabled: ['retired'], extra: [{ id: 'hand' }], overrides: {}, replaceDiscovered: false } },
  }))
  assert.equal(form.baseURL, 'https://from-user/v1')
  // Not in the user layer, so the resolved (inherited) value is shown.
  assert.equal(form.displayName, 'resolved-name')
  assert.deepEqual(form.disabled, ['retired'])
  assert.equal(form.extra.length, 1)
  assert.equal(form.extra[0].id, 'hand')
  assert.equal(form.sessionHeaderMode, 'session-id')
  assert.equal(form.sessionHeaderEnabled, true)
})

test('formFromView survives a value layer that carries no models block at all', () => {
  const form = formFromView(viewOf({ value: {} }))
  assert.deepEqual(form.disabled, [])
  assert.deepEqual(form.extra, [])
  assert.deepEqual(form.overrides, [])
  // The SHIPPED default, kept in step with src/config.js: a fresh install loads
  // no models. Rendering it as false would say "everything is enabled" while the
  // route actually serves nothing.
  assert.equal(form.replaceDiscovered, true)
})

test('the API-key field always starts blank: a secret is never rendered back', () => {
  // Even when the payload carries the legacy value (a host that does not redact)
  // or the redaction sidecar says one is stored.
  for (const view of [
    viewOf({ user: { apiKey: LEGACY } }),
    { ...viewOf({ user: {} }), secrets: [{ path: ['apiKey'], set: true }] },
  ]) {
    const form = formFromView(view)
    assert.equal(form.apiKey, '', 'the staging field must never be pre-filled from the host')
  }
})

test('legacyApiKeyPresent reports the pre-0.6.0 state from every spelling the read can take', () => {
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['apiKey'], set: true }] }), true)
  assert.equal(legacyApiKeyPresent(viewOf({ user: { apiKey: LEGACY } })), true)
  assert.equal(legacyApiKeyPresent(viewOf({ value: { apiKey: LEGACY } })), true)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['apiKey'], set: false }] }), false)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['apiKeyEnv'], set: true }] }), false)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['models', 'apiKey'], set: true }] }), false)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: 'not-an-array' }), false)
})

test('revisionFor sends the host revision back, and undefined when there is none', () => {
  assert.equal(revisionFor({ revision: 12 }), 12)
  assert.equal(revisionFor({ revision: undefined }), undefined)
  assert.equal(revisionFor({ revision: '12' }), undefined)
})

// ── form ↔ config ──────────────────────────────────────────────────────────

test('extra serialization omits every blank cell instead of inventing a pin', () => {
  const block = modelsBlockFrom({
    disabled: [],
    replaceDiscovered: false,
    overrides: [],
    extra: [{ key: 'k', id: ' my-model ', name: ' My Model ', api: '', contextWindow: '', maxTokens: 4096, input: [], reasoning: undefined, reasoningEfforts: [] }],
  })
  assert.deepEqual(block.extra, [{ id: 'my-model', name: 'My Model', maxTokens: 4096 }])
})

test('extra serialization keeps every claim the operator did make', () => {
  const [entry] = modelsBlockFrom({
    extra: [{
      key: 'k', id: 'hand-declared', name: 'Hand', api: 'openai-responses',
      contextWindow: 131072, maxTokens: 16384, input: ['text', 'image'],
      reasoning: true, reasoningEfforts: ['low', 'high'],
    }],
  }).extra
  assert.deepEqual(entry, {
    id: 'hand-declared',
    name: 'Hand',
    api: 'openai-responses',
    contextWindow: 131072,
    maxTokens: 16384,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: ['low', 'high'],
  })
})

test('a half-typed row (no id yet) is not written', () => {
  const block = modelsBlockFrom({ extra: [blankExtraDraft('draft')], disabled: [], overrides: [], replaceDiscovered: false })
  assert.deepEqual(block.extra, [])
})

test('an override that claims nothing is dropped from the write, not written empty', () => {
  const block = modelsBlockFrom({
    overrides: [
      { id: 'glm-5.3-flash', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] },
      { id: 'other', api: '', contextWindow: 4096, maxTokens: '', input: [], reasoningEfforts: [] },
    ],
  })
  assert.deepEqual(block.overrides, { other: { contextWindow: 4096 } })
})

test('a form round-trips through the host section shape byte-for-byte', () => {
  const user = {
    models: {
      disabled: ['retired-model'],
      extra: [{ id: 'hand-declared', name: 'Hand Declared', api: 'openai-responses', contextWindow: 4096 }],
      overrides: { 'glm-5.3-flash': { contextWindow: 4096 } },
      replaceDiscovered: false,
    },
  }
  const form = formFromView(viewOf({ user }))
  assert.deepEqual(modelsBlockFrom(form), user.models)
})

// ── the model directory ────────────────────────────────────────────────────

test('directoryRows joins the catalogue with the overlay, and a disabled model simply has no row', () => {
  const form = formFromView(viewOf({
    user: {
      models: {
        disabled: ['retired'],
        extra: [{ id: 'hand', name: 'Hand' }],
        overrides: { alpha: { contextWindow: 4096 } },
        replaceDiscovered: false,
      },
    },
  }))
  const rows = directoryRows(form, [modelOf('alpha'), modelOf('retired')])
  assert.deepEqual(rows.map((row) => row.id), ['alpha', 'hand'])
  assert.equal(rows[0].advertised, true)
  assert.equal(rows[0].override.contextWindow, 4096)
  assert.equal(rows[0].defaults.contextWindow, 1_000_000, 'the official default is carried for the placeholders')
  assert.equal(rows[1].advertised, false)
  assert.equal(rows[1].name, 'Hand')
  assert.equal(rows[1].extra.id, 'hand')
})

test('a legacy blank row is kept for display but never written', () => {
  // The page no longer creates blank rows; a pre-0.7.0 document could still hold
  // one. It renders (the operator's typing is not thrown away) and serializes to
  // nothing (`extraEntryFrom` drops id-less rows), so it self-heals on the next
  // write.
  const form = formFromView(viewOf({ user: { models: { disabled: [], extra: [{ id: '' }], overrides: {}, replaceDiscovered: false } } }))
  const rows = directoryRows(form, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '')
  assert.deepEqual(modelsBlockFrom(form).extra, [])
})

test('removing an advertised row excludes it and strips its declarations; removing a hand row just drops it', () => {
  const form = formFromView(viewOf({
    user: {
      models: {
        disabled: [],
        extra: [{ id: 'hand' }, { id: 'alpha', contextWindow: 4096 }],
        overrides: { alpha: { maxTokens: 2048 } },
        replaceDiscovered: false,
      },
    },
  }))
  const rows = directoryRows(form, [modelOf('alpha')])
  const alpha = rows.find((row) => row.id === 'alpha')
  const removed = removeDirectoryRow(form, alpha)
  assert.deepEqual(removed.disabled, ['alpha'])
  assert.deepEqual(removed.extra.map((row) => row.id).filter(Boolean), ['hand'])
  assert.deepEqual(Object.keys(modelsBlockFrom(removed).overrides), [])
  // The host refuses a disabled model that still carries extra/override, so both
  // must be gone.
  assert.equal(modelsBlockFrom(removed).extra.some((row) => row.id === 'alpha'), false)

  const hand = rows.find((row) => row.id === 'hand')
  const dropped = removeDirectoryRow(form, hand)
  assert.deepEqual(dropped.disabled, [])
  assert.deepEqual(dropped.extra.map((row) => row.id).filter(Boolean), ['alpha'])
})

test('patching an advertised row writes an override; patching a hand row writes the declaration', () => {
  const base = formFromView(viewOf({ user: { models: { disabled: [], extra: [{ id: 'hand' }], overrides: {}, replaceDiscovered: false } } }))
  const [hand] = directoryRows(base, [])
  const withName = patchDirectoryRow(base, hand, { name: 'Nice Name', contextWindow: 4096 })
  assert.deepEqual(withName.extra[0].name, 'Nice Name')
  assert.deepEqual(Object.keys(modelsBlockFrom(withName).overrides), [])

  const withAdvertised = directoryRows(base, [modelOf('alpha')]).find((row) => row.id === 'alpha')
  const patched = patchDirectoryRow(base, withAdvertised, { api: 'openai-responses', maxTokens: 8192 })
  assert.deepEqual(modelsBlockFrom(patched).overrides.alpha, { api: 'openai-responses', maxTokens: 8192 })
  assert.deepEqual(modelsBlockFrom(patched).extra, [{ id: 'hand' }], 'the advertised row is not turned into an extra')

  // A correction that ends up claiming nothing must not survive as an empty row.
  const cleared = patchDirectoryRow(patched, { ...withAdvertised, override: patched.overrides[0] }, { maxTokens: undefined, api: '' })
  assert.deepEqual(modelsBlockFrom(cleared).overrides, {})
})

test('setModelSelection applies the checked-set over the listing and keeps untouched ids alone', () => {
  const form = formFromView(viewOf({
    user: { models: { disabled: ['alpha', 'ghost'], extra: [{ id: 'hand' }], overrides: { alpha: { maxTokens: 1 } }, replaceDiscovered: false } },
  }))
  // The listing shows alpha and ghost; `hand` and any older exclusion are NOT
  // in the listing, so the operation must not speak for them.
  const candidates = [modelOf('alpha'), modelOf('ghost')]
  const applied = setModelSelection(form, candidates, ['alpha'])
  // alpha re-enabled (its exclusion cleared, its claim kept); ghost unchecked →
  // excluded; the hand row and its exclusion of nothing are untouched.
  assert.deepEqual(applied.disabled, ['ghost'])
  assert.deepEqual(Object.keys(modelsBlockFrom(applied).overrides), ['alpha'])
  assert.deepEqual(modelsBlockFrom(applied).extra.map((row) => row.id), ['hand'])
})

test('setModelSelection strips claims on a model the selection turned off', () => {
  const form = formFromView(viewOf({
    user: {
      models: {
        disabled: [],
        extra: [{ id: 'alpha', contextWindow: 4096 }, { id: 'ghost' }],
        overrides: { alpha: { maxTokens: 2048 }, beta: { api: 'openai-responses' } },
        replaceDiscovered: false,
      },
    },
  }))
  // alpha is listed and UNCHECKED; it is endpoint+extra, so both its rows of
  // claims must go (the host refuses claims on an excluded model). beta is not
  // in the listing: its claim, and everything about ghost, stay.
  const applied = setModelSelection(form, [modelOf('alpha'), modelOf('delta')], ['delta'])
  assert.ok(applied.disabled.includes('alpha'))
  assert.deepEqual(modelsBlockFrom(applied).extra.map((row) => row.id), ['ghost'])
  assert.deepEqual(Object.keys(modelsBlockFrom(applied).overrides), ['beta'])
})

test('setModelSelection leaves replaceDiscovered exactly as stored (the page never touches it)', () => {
  const form = formFromView(viewOf({ user: { models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: true } } }))
  const applied = setModelSelection(form, [modelOf('alpha')], ['alpha'])
  assert.equal(applied.replaceDiscovered, true)
})

test('addModelById enables an advertised id by clearing its exclusion, and declares only what the endpoint lacks', () => {
  const form = formFromView(viewOf({ user: { models: { disabled: ['alpha', 'beta'], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const advertised = ['alpha', 'delta']
  const enabled = addModelById(form, ' alpha ', advertised)
  assert.deepEqual(enabled.disabled, ['beta'], 'the advertised id needs no declaration; clearing its exclusion IS the activation')
  assert.deepEqual(modelsBlockFrom(enabled).extra, [])

  const declared = addModelById(enabled, 'beta', advertised)
  assert.deepEqual(declared.disabled, [])
  const extra = modelsBlockFrom(declared).extra
  assert.deepEqual(extra.map((row) => row.id), ['beta'], 'a not-advertised id becomes a declaration')
  assert.equal(extra[0].contextWindow, undefined, 'no capacity is pinned: the official facts stay inherited')

  // Adding what is already enabled/declared changes nothing.
  assert.deepEqual(modelsBlockFrom(addModelById(declared, 'beta', advertised)), modelsBlockFrom(declared))
  assert.deepEqual(modelsBlockFrom(addModelById(declared, '   ', advertised)), modelsBlockFrom(declared))
})

// ── the credential plan ────────────────────────────────────────────────────

test('credentialPlan is undefined while the field is blank, and carries the staged value otherwise', () => {
  const form = formFromView(viewOf({ user: {} }))
  assert.equal(credentialPlan(form), undefined)
  assert.deepEqual(credentialPlan({ ...form, apiKey: `  ${STAGED}  ` }), { reference: 'OPENCODE_GO_API_KEY', value: STAGED })
  // No reference to store under: the plan declines rather than guessing.
  assert.equal(credentialPlan({ ...form, apiKey: STAGED, apiKeyEnv: '' }), undefined)
})

// ── validation ─────────────────────────────────────────────────────────────

test('isHeaderToken follows RFC 7230 tokens', () => {
  for (const good of ['x-opencode-session', 'X-Session', 'a!#$%&\'*+.^_`|~']) {
    assert.equal(isHeaderToken(good), true, good)
  }
  for (const bad of ['x session', 'x:session', 'x\nsession', '', '会话', 'x/session']) {
    assert.equal(isHeaderToken(bad), false, JSON.stringify(bad))
  }
})

test('looksLikeSecretValue catches a pasted key but not a variable name', () => {
  assert.equal(looksLikeSecretValue('OPENCODE_GO_API_KEY'), false)
  assert.equal(looksLikeSecretValue('MY_KEY_2'), false)
  assert.equal(looksLikeSecretValue('sk-abcdefghijklmnopqrstuvwxyz0123456789'), true)
  assert.equal(looksLikeSecretValue('a'.repeat(40)), true)
  assert.equal(looksLikeSecretValue(undefined), false)
})

test('isUsableApiKey refuses what no HTTP header could carry', () => {
  assert.equal(isUsableApiKey(STAGED), true)
  assert.equal(isUsableApiKey('   '), false)
  assert.equal(isUsableApiKey('sk-a\nb'), false)
  assert.equal(isUsableApiKey(undefined), false)
})

test('validateForm names the control for every client-detectable mistake', () => {
  const errors = validateForm({
    baseURL: 'ftp://nope',
    apiKeyEnv: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    apiKey: 'sk-with\nnewline',
    sessionHeader: 'x session',
    sessionHeaderEnabled: true,
    sessionHeaderMode: 'session-id',
    extra: [
      { id: '', api: 'openai-chat', contextWindow: -5, maxTokens: 0, input: ['video'], reasoningEfforts: ['off'] },
      { id: 'dup', api: 'openai-responses', contextWindow: 1, maxTokens: '', input: [], reasoningEfforts: [] },
      { id: 'dup', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] },
    ],
    disabled: ['dup', 'dup'],
    overrides: [
      { id: 'dup', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] },
      { id: 'dup', api: '', contextWindow: 4096, maxTokens: '', input: [], reasoningEfforts: [] },
    ],
    replaceDiscovered: false,
  })
  assert.equal(errors.baseURL, '必须以 http:// 或 https:// 开头')
  // The reference field is a NAME; a pasted key there would leave the runtime
  // reading an unset variable while the secret sits in the settings document.
  assert.match(errors.apiKeyEnv, /引用名只能填环境变量名/u)
  // The staged credential value must be a value a header could carry.
  assert.match(errors.apiKey, /控制字符|换行/u)
  assert.match(errors.sessionHeader, /RFC 7230/u)
  assert.match(errors['models.extra[0].id'], /必填/u)
  assert.match(errors['models.extra[0].api'], /不受支持的协议/u)
  assert.match(errors['models.extra[0].contextWindow'], /正整数/u)
  assert.match(errors['models.extra[0].maxTokens'], /正整数/u)
  assert.match(errors['models.extra[0].input'], /text \/ image/u)
  assert.match(errors['models.extra[0].reasoningEfforts'], /off 用“关闭推理”表达/u)
  assert.match(errors['models.extra[2].id'], /disabled/u)
  assert.match(errors['models.disabled[1]'], /重复/u)
  assert.match(errors['models.overrides[0].id'], /什么都没写/u)
  assert.match(errors['models.overrides[1].id'], /永远不会生效/u)
})

test('validateForm requires the credential reference, the one supported source', () => {
  const base = {
    baseURL: 'https://x/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', apiKey: '', sessionHeader: 'x-s',
    sessionHeaderEnabled: true, sessionHeaderMode: 'session-id', disabled: [], extra: [], overrides: [], replaceDiscovered: false,
  }
  assert.deepEqual(validateForm(base), {})
  assert.match(validateForm({ ...base, apiKeyEnv: '   ' }).apiKeyEnv, /必填/u)
})

test('validateForm accepts a clean draft, including a disabled header with no name', () => {
  const errors = validateForm({
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    apiKey: '',
    sessionHeader: '',
    sessionHeaderEnabled: false,
    sessionHeaderMode: 'uuid',
    extra: [{ id: 'hand', api: 'openai-completions', contextWindow: 4096, maxTokens: 1024, input: ['text'], reasoningEfforts: ['low'] }],
    disabled: [],
    overrides: [{ id: 'hand', api: 'anthropic-messages', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] }],
    replaceDiscovered: false,
  })
  assert.deepEqual(errors, {})
})

// ── effective set ──────────────────────────────────────────────────────────

test('the effective set is discovered ∪ extra \\ disabled', () => {
  const base = {
    baseURL: 'https://x/v1', apiKeyEnv: 'K', sessionHeader: 'x-s', sessionHeaderEnabled: true, sessionHeaderMode: 'session-id',
    disabled: ['b'], replaceDiscovered: false, overrides: [],
    extra: [{ id: 'hand', name: '', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] }],
  }
  assert.deepEqual(effectiveIds(base, ['a', 'b', 'c']), ['a', 'c', 'hand'])
  assert.equal(isModelEnabled('b', base, ['a', 'b']), false)
  assert.equal(isModelEnabled('a', base, ['a', 'b']), true)
  assert.equal(isModelEnabled('hand', base, ['a', 'b']), true)
  // `replaceDiscovered` is the one switch that freezes the set.
  const frozen = { ...base, replaceDiscovered: true }
  assert.deepEqual(effectiveIds(frozen, ['a', 'b', 'c']), ['hand'])
  assert.equal(isModelEnabled('c', frozen, ['c']), false)
})

// ── writes ─────────────────────────────────────────────────────────────────

test('writeOps emits nothing when the draft equals the snapshot', () => {
  const form = formFromView(viewOf({ user: { baseURL: 'https://user/v1' } }))
  assert.deepEqual(writeOps(form, form), [])
  assert.equal(isDirty(form, form), false)
  assert.equal(isDirty(form, { ...form, sync: !form.sync }), true)
})

test('writeOps writes only the fields that moved, and unsets a cleared optional', () => {
  const clean = formFromView(viewOf({ user: { baseURL: 'https://a/v1', displayName: 'A', sync: true } }))
  const draft = { ...clean, displayName: '', sync: false, baseURL: 'https://b/v1' }
  const ops = writeOps(clean, draft)
  assert.deepEqual(ops, [
    { op: 'set', path: ['baseURL'], value: 'https://b/v1' },
    { op: 'set', path: ['displayName'], value: '' },
    { op: 'set', path: ['sync'], value: false },
  ])
})

test('writeOps never carries the staged credential: that write belongs to the credential store', () => {
  const clean = formFromView(viewOf({ user: {} }))
  const draft = { ...clean, apiKey: STAGED }
  assert.deepEqual(writeOps(clean, draft), [])
  // And a save that only stages a key still owes the credential plan.
  assert.deepEqual(credentialPlan(draft), { reference: 'OPENCODE_GO_API_KEY', value: STAGED })
})

test('writeOps writes the four models sub-shapes together when the block moved', () => {
  const clean = formFromView(viewOf({ user: { models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const draft = { ...clean, disabled: ['b'], replaceDiscovered: true, extra: [blankExtraDraft('x')] }
  draft.extra[0].id = 'hand'
  const paths = writeOps(clean, draft).map((op) => op.path.join('.'))
  assert.deepEqual(paths, ['models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered'])
})

// ── host rejection → control ───────────────────────────────────────────────

test('errorPathsOf maps the host\'s own messages onto the controls that caused them', () => {
  assert.deepEqual(
    errorPathsOf('opencode-go-native: sessionHeader "x session" is not a valid HTTP header name (only RFC 7230 token characters are allowed)'),
    ['sessionHeader'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: models.extra["broken-extra"].contextWindow must be a positive integer (got: -5)'),
    ['models.extra[broken-extra]'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: models.overrides["glm-5.3-flash"] sets nothing; remove the entry, or name one of api, contextWindow'),
    ['models.overrides[glm-5.3-flash]'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: model "x" appears in both models.extra and models.disabled; remove it from one of them'),
    ['models.disabled', 'models.extra'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: apiKeyEnv must name a credential reference'),
    ['apiKeyEnv'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: baseURL must be an absolute http(s) URL including the /v1 prefix'),
    ['baseURL'],
  )
})

test('primaryErrorPath picks the most specific control named', () => {
  assert.equal(
    primaryErrorPath('opencode-go-native: models.extra[1].api is not a protocol this build can dispatch'),
    'models.extra[1]',
  )
  assert.equal(primaryErrorPath('something entirely unrelated'), undefined)
  assert.equal(primaryErrorPath(undefined), undefined)
})

test('rowIndexFor resolves both the index and the model-id spelling to one row', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  assert.equal(rowIndexFor(rows, '1'), 1)
  assert.equal(rowIndexFor(rows, 'b'), 1)
  assert.equal(rowIndexFor(rows, 'missing'), -1)
  assert.equal(rowIndexFor([{ id: ' x ' }], 'x'), 0)
})

test('describeFailure and isConflictFailure read a Remote failure without inventing one', () => {
  assert.equal(describeFailure({ code: 'settings/rejected', message: 'boom' }), 'settings/rejected: boom')
  assert.equal(describeFailure('plain'), 'plain')
  assert.equal(describeFailure(undefined), '未知错误')
  assert.equal(isConflictFailure({ code: 'settings/conflict', message: 'x' }), true)
  assert.equal(isConflictFailure(new Error('settings namespace "ns" changed since it was read (expected revision 1, now 2)')), true)
  assert.equal(isConflictFailure({ code: 'settings/rejected', message: 'nope' }), false)
})

// ── diagnostics / catalogue payloads ───────────────────────────────────────

test('unwrapPayload throws the route\'s own error text', () => {
  assert.deepEqual(unwrapPayload({ ok: true, models: [] }), { ok: true, models: [] })
  assert.throws(() => unwrapPayload({ ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'no value for "X"' } }), (error) => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /no value for "X"/u)
    return true
  })
  assert.throws(() => unwrapPayload('<html>'), /不是 JSON 对象/u)
})

test('diagnosticsView refuses an SPA fallback and reads the real payload', () => {
  assert.throws(
    () => diagnosticsView({ ok: true, diagnostics: { kind: '<html>' } }),
    (error) => error.code === 'kind-mismatch',
  )
  const view = diagnosticsView({
    ok: true,
    diagnostics: {
      kind: 'dsh-opencodego/diagnostics',
      at: 1,
      connection: { baseURL: 'https://x/v1', apiKeyEnv: 'K', legacyInlineKey: true },
      configuration: { models: { protocolOverridesShadowed: ['a'] } },
      catalogue: { status: 'ok', discovered: 3, effective: 2, sources: [{ id: 'a', source: 'endpoint' }] },
      health: { rows: [{ modelId: 'a', category: 'ok' }], unusable: [], summaryLines: ['a: ok'] },
      log: { lines: [{ level: 'warn', message: 'w' }], warnings: [{ level: 'warn', message: 'w' }] },
    },
  })
  assert.equal(view.connection.apiKeyEnv, 'K')
  assert.equal(view.connection.legacyInlineKey, true)
  assert.equal(view.catalogue.effective, 2)
  assert.equal(view.health.length, 1)
  assert.equal(view.warnings.length, 1)
  assert.deepEqual(view.configuration.models.protocolOverridesShadowed, ['a'])
})

test('catalogueView reads the model-state defaults and tolerates an older payload', () => {
  const view = catalogueView({
    ok: true,
    source: 'endpoint',
    models: [
      modelOf('a'),
      { id: 'legacy', name: 'Legacy', inputModalities: ['text', 'image'], input: 'nope' },
      { nope: 1 },
    ],
  })
  assert.equal(view.source, 'endpoint')
  assert.equal(view.models.length, 2)
  assert.deepEqual(view.models[0].defaults, { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] })
  // An older host answered `inputModalities` with no `defaults` block; the row
  // must still be usable rather than throwing.
  assert.deepEqual(view.models[1].defaults, { contextWindow: undefined, maxTokens: undefined, input: [], reasoning: false, reasoningEfforts: [] })
  assert.deepEqual(view.models[1].effective.input, ['text', 'image'])
})

test('the capacity and modality placeholders show the value in EFFECT now', () => {
  assert.equal(capacityPlaceholder(1_000_000, '默认'), '当前生效 1000000')
  assert.equal(capacityPlaceholder(undefined, '默认'), '默认')
  assert.equal(capacityPlaceholder(0, '默认'), '默认')
  assert.equal(modalityPlaceholder({ input: ['text', 'image'] }), '当前生效：text + image')
  assert.equal(modalityPlaceholder({ input: [] }), '默认')
})

// ── the effective facts, shown without expanding anything ──────────────────

test('formatTokenCount writes catalog-style sizes', () => {
  assert.equal(formatTokenCount(1_000_000), '1M')
  assert.equal(formatTokenCount(1_500_000), '1.5M')
  assert.equal(formatTokenCount(384_000), '384K')
  assert.equal(formatTokenCount(202_752), '203K')
  assert.equal(formatTokenCount(128), '128')
  assert.equal(formatTokenCount(undefined), undefined)
  assert.equal(formatTokenCount(0), undefined)
})

test('capabilityChips shows the EFFECTIVE facts — the numbers dsh loads, corrections included', () => {
  const labels = capabilityChips(modelOf('a')).map((chip) => chip.label)
  assert.deepEqual(labels, [
    'openai-completions', '上下文 1M', '输出 131K', '输入 text+image', '思考 low/high',
  ])
  // A saved correction is reflected: the chip shows what the route WOULD use,
  // not the untouched built-in state.
  const corrected = capabilityChips({ ...modelOf('b'), effective: { contextWindow: 4096, maxTokens: 1024, input: ['text'], reasoning: false, reasoningEfforts: [] } })
    .map((chip) => chip.label)
  assert.deepEqual(corrected, ['openai-completions', '上下文 4K', '输出 1K', '输入 text'])
})

test('the model-source line names the TWO sources and nothing else', () => {
  const line = modelSourceLine()
  assert.match(line, /网关 \/models/u)
  assert.match(line, /插件保存的模型状态/u)
  assert.match(line, /保守默认/u)
  // The page no longer speaks of a third party at runtime.
  assert.ok(!line.includes('models.dev'), line)
})

test('the picker reads refreshError off the catalogue payload', () => {
  const view = catalogueView({ ok: true, models: [], refreshError: 'GET https://x/v1/models answered HTTP 503' })
  assert.equal(view.refreshError, 'GET https://x/v1/models answered HTTP 503')
  assert.equal(catalogueView({ ok: true, models: [] }).refreshError, undefined)
})

// ── the immediate-commit path ──────────────────────────────────────────────

test('modelsWriteOps writes ONLY the models paths (a pick never smuggles scalars)', () => {
  const clean = formFromView(viewOf({ user: { baseURL: 'https://a/v1', models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const draft = { ...clean, baseURL: 'https://half-typed/v1', disabled: ['b'] }
  const ops = modelsWriteOps(clean, draft)
  assert.deepEqual(ops.map((op) => op.path.join('.')), [
    'models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered',
  ])
  assert.deepEqual(modelsWriteOps(clean, { ...clean, baseURL: 'https://other/v1' }), [], 'scalar-only change owes no model write')
})

test('preserveDraftScalars keeps the unsaved typing across a models commit', () => {
  const saved = formFromView(viewOf({ user: { baseURL: 'https://a/v1', models: { disabled: ['b'], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const typed = { ...saved, baseURL: 'https://typing/v1', apiKey: STAGED, sessionHeader: 'x-new' }
  const merged = preserveDraftScalars(saved, typed)
  assert.equal(merged.baseURL, 'https://typing/v1')
  assert.equal(merged.apiKey, STAGED)
  assert.equal(merged.sessionHeader, 'x-new')
  // The models block comes from the server, not the pre-commit draft.
  assert.deepEqual(merged.disabled, ['b'])
})

test('the credential copy says where the value goes', async () => {
  const { API_KEY_HINT, SESSION_HEADER_HINT, LEGACY_API_KEY_WARNING } = await import('../src/client/vocab.js')
  assert.match(API_KEY_HINT, /凭据存储/u)
  assert.match(API_KEY_HINT, /不落明文/u)
  assert.match(LEGACY_API_KEY_WARNING, /迁移/u)
  assert.match(SESSION_HEADER_HINT, /RFC 7230/u)
})

// ── helpers the rest of this file relies on stay honest ─────────────────────

test('deepEqual is structural, not referential', () => {
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true)
  assert.equal(deepEqual({ a: 1, b: undefined }, { a: 1 }), true)
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
})


// ── capability sync ─────────────────────────────────────────────────────────

test('syncTargetIds visits each ENABLED model once, in page order', () => {
  assert.deepEqual(
    syncTargetIds([{ id: 'alpha' }, { id: 'beta' }, { id: 'alpha' }, { id: '' }, {}]),
    ['alpha', 'beta'],
    'the sync is scoped to what is enabled, deduplicated',
  )
  assert.deepEqual(syncTargetIds(undefined), [])
})

test('describeSync turns a measured result into one line an operator can act on', () => {
  const ok = describeSync({
    available: true,
    status: 'available',
    protocol: { chosen: 'openai-completions', verified: true },
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ['text', 'image'],
    reasoning: { levels: { low: 'low', high: 'high' }, hasOff: true },
  })
  assert.equal(ok.tone, 'ok')
  assert.match(ok.detail, /协议 openai-completions/u)
  assert.match(ok.detail, /上下文 1\.0M/u)
  assert.match(ok.detail, /输出 131K/u)
  assert.match(ok.detail, /输入 text\+image/u)
  assert.match(ok.detail, /思考 off\/low\/high/u)
  assert.equal(ok.replace, false)

  // A dead model must be LOUD and must point somewhere else.
  const dead = describeSync({ available: false, status: 'delisted', reason: '上游已下架：Model is unavailable.' })
  assert.equal(dead.tone, 'bad')
  assert.match(dead.headline, /已下架/u)
  assert.equal(dead.replace, true)

  const gated = describeSync({ available: false, status: 'gated', reason: '区域门控' })
  assert.equal(gated.tone, 'warn')
  assert.match(gated.headline, /门控/u)

  // A recommendation that did not answer is stated, not hidden.
  const fallback = describeSync({
    available: true, status: 'available',
    protocol: { chosen: 'anthropic-messages', verified: false },
    reasoning: { levels: {}, hasOff: false },
  })
  assert.match(fallback.detail, /非推荐/u)

  // A refused official contract is explained rather than silently narrowed.
  const narrowed = describeSync({
    available: true, status: 'available', protocol: { chosen: 'openai-completions', verified: true },
    reasoning: { levels: { low: 'low' }, hasOff: true, declaredContractWorks: false },
  })
  assert.match(narrowed.note, /官方契约/u)
  assert.equal(describeSync(undefined), undefined)
})

test('syncProgressText separates what FINISHED from what is in flight', () => {
  assert.equal(syncProgressText({ busy: false }), undefined)
  // The first version printed `done + 1` as the headline, so it sat on the same
  // number for the whole of a slow model and read as frozen.
  const mid = syncProgressText({ busy: true, done: 1, total: 8, current: 'glm-5.3', startedAt: 1000 }, 13_000)
  assert.match(mid, /已完成 1\/8/u)
  assert.match(mid, /正在处理 glm-5.3/u)
  assert.match(mid, /已用 12s/u)
  // The count moves as models complete, even while one is in flight.
  const later = syncProgressText({ busy: true, done: 5, total: 8, current: 'glm-5.3', startedAt: 1000 }, 13_000)
  assert.match(later, /已完成 5\/8/u)
  assert.match(later, /已用 12s/u)
  // With nothing in flight the model name is simply absent, not stale.
  assert.equal(syncProgressText({ busy: true, done: 3, total: 3, startedAt: 0 }, 0), '已完成 3/3 · 已用 0s')
})

test('replacementSuggestions offers a WORKING model, never a dead one', () => {
  const rows = [{ id: 'dead' }, { id: 'alsoDead' }, { id: 'alive' }]
  const suggestions = replacementSuggestions(rows, {
    dead: { available: false, status: 'delisted' },
    alsoDead: { available: false, status: 'gated' },
    alive: { available: true },
  })
  assert.deepEqual(suggestions, { dead: 'alive', alsoDead: 'alive' })
  // With nothing working there is nothing honest to suggest.
  assert.deepEqual(replacementSuggestions(rows, { dead: { available: false } }), {})
  // A model that works is never given a replacement.
  assert.deepEqual(replacementSuggestions(rows, { alive: { available: true } }), {})
})

test('with the shipped default, nothing is enabled until the picker says so', () => {
  // Replacement mode is the SHIPPED default: a fresh install must load NO
  // models, and the picker must still be able to activate them.
  const form = formFromView({ namespaces: [{ namespace: 'opencode-go-native', revision: 'r1', document: {} }] })
  assert.equal(form.replaceDiscovered, true, 'the default loads nothing')
  assert.deepEqual(effectiveIds(form, ['alpha', 'beta']), [], 'advertised models are not auto-enabled')

  const picked = setModelSelection(form, [{ id: 'alpha' }, { id: 'beta' }], ['beta'])
  // The selection lands in `extra`, because in this mode that IS the enabled set.
  assert.deepEqual(picked.extra.map((row) => row.id), ['beta'])
  assert.deepEqual(effectiveIds(picked, ['alpha', 'beta']), ['beta'], 'only the picked model loads')

  // De-selecting removes it again.
  const empty = setModelSelection(picked, [{ id: 'alpha' }, { id: 'beta' }], [])
  assert.deepEqual(effectiveIds(empty, ['alpha', 'beta']), [])

  // A hand-added model the picker never listed is not the picker's to drop.
  const withHandAdded = { ...picked, extra: [...picked.extra, { id: 'hand-added', name: 'Hand' }] }
  const after = setModelSelection(withHandAdded, [{ id: 'alpha' }, { id: 'beta' }], [])
  assert.deepEqual(effectiveIds(after, ['alpha', 'beta']), ['hand-added'])
})
