/**
 * Unit tests for the subscription layer (0.8.2): normalization (the default
 * subscription is always implicit, an entry is a NAME and nothing else) and the
 * single ACTIVE pointer that decides who pays.
 *
 * Host-free by construction (`subs.js` imports only `vocab.js`), so bare
 * `node --test` runs the whole decision table.
 *
 * @module tests/subs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  activeSubscriptionOf,
  CREDENTIAL_REF_PATTERN,
  DEFAULT_SUB_ID,
  DEFAULT_SUB_LABEL,
  normalizeSubscriptions,
  refForSubscriptionId,
  resolveActiveSubscription,
  SUBSCRIPTION_ENTRY_KEYS,
  SUBSCRIPTION_ID_PATTERN,
  SUBSCRIPTION_LABEL_MAX,
  USAGE_WINDOW_KEYS,
} from '../src/subs.js'

const base = {
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  displayName: undefined,
}

/* ── normalization ────────────────────────────────────────────────────── */

test('a pre-0.8 document resolves to exactly the implicit default subscription', () => {
  for (const raw of [undefined, null, []]) {
    const list = normalizeSubscriptions(raw, base)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, DEFAULT_SUB_ID)
    assert.equal(list[0].apiKeyRef, 'OPENCODE_GO_DEFAULT')
    assert.equal(list[0].label, DEFAULT_SUB_LABEL)
    assert.equal(list[0].isDefault, true)
  }
})

test('the legacy displayName names the default subscription', () => {
  const [first] = normalizeSubscriptions(undefined, { ...base, displayName: 'opencode' })
  assert.equal(first.label, 'opencode')
})

test('extras append in configured order; the reserved id PATCHES the default', () => {
  const list = normalizeSubscriptions([
    { id: 'work', label: '公司号' },
    { id: 'default', label: '我的号' },
    { id: 'home' },
  ], base)
  assert.deepEqual(list.map((sub) => sub.id), ['default', 'work', 'home'])
  // The patch kept everything the entry did not name (the id is the address,
  // not a display string) and applied what it did.
  assert.equal(list[0].id, DEFAULT_SUB_ID)
  assert.equal(list[0].label, '我的号')
  assert.equal(list[0].apiKeyRef, 'OPENCODE_GO_DEFAULT', 'the default row owns a derived slot like every other row')
  assert.equal(list[0].isDefault, true)
  assert.equal(list[1].label, '公司号')
  assert.equal(list[1].isDefault, false)
})

test('the credential slot is DERIVED from the id, so the document stores no reference', () => {
  assert.equal(refForSubscriptionId('work'), 'OPENCODE_GO_WORK')
  assert.equal(refForSubscriptionId('team-2'), 'OPENCODE_GO_TEAM_2')
  assert.equal(refForSubscriptionId('a_b'), 'OPENCODE_GO_A_B')
  assert.equal(refForSubscriptionId(DEFAULT_SUB_ID), 'OPENCODE_GO_DEFAULT')
  for (const id of ['work', 'team-2', 'a_b', 'X', DEFAULT_SUB_ID]) {
    assert.match(refForSubscriptionId(id), CREDENTIAL_REF_PATTERN, 'a derived slot must be a usable reference name')
  }
  const list = normalizeSubscriptions([{ id: 'work' }, { id: 'team-2' }], base)
  assert.deepEqual(list.map((sub) => sub.apiKeyRef), [
    'OPENCODE_GO_DEFAULT', 'OPENCODE_GO_WORK', 'OPENCODE_GO_TEAM_2',
  ])
})

test('a row with no label falls back to its id, and one with no id is refused', () => {
  const list = normalizeSubscriptions([{ id: 'work' }], base)
  assert.equal(list[1].label, 'work')
  assert.throws(() => normalizeSubscriptions([{ label: '公司号' }], base), /subscriptions\[0\]\.id/)
})

test('a bad entry is refused at its own path, naming the field', () => {
  assert.throws(() => normalizeSubscriptions([{ id: 'bad id!' }], base), /not a valid subscription id/)
  assert.throws(() => normalizeSubscriptions([{ id: 'work' }, { id: 'work' }], base), /repeats/)
  assert.throws(() => normalizeSubscriptions([{ id: 'work', cap: { weekly: 50 } }], base), /subscriptions\[0\] names unknown key "cap"/)
  assert.throws(() => normalizeSubscriptions([{ id: 'work', baseURL: 'https://x/v1' }], base), /unknown key "baseURL"/)
  assert.throws(() => normalizeSubscriptions([{ id: 'work', apiKeyEnv: 'OCG_WORK' }], base), /unknown key "apiKeyEnv"/)
  assert.throws(() => normalizeSubscriptions([{ id: 'work', label: 'x'.repeat(SUBSCRIPTION_LABEL_MAX + 1) }], base), /label is longer than/)
  // Every knob the redesign removed is refused BY NAME, so a document that
  // still carries one is told what happened instead of being silently ignored.
  assert.throws(() => normalizeSubscriptions([{ id: 'work', apiKeyRef: 'MY_SLOT' }], base), /unknown key "apiKeyRef"/)
  assert.throws(() => normalizeSubscriptions([{ id: 'default', apiKeyEnv: 'MY_SLOT' }], base), /unknown key "apiKeyEnv"/)
  assert.throws(() => normalizeSubscriptions({ 0: { id: 'work' } }, base), /must be an array/)
})

test('two subscriptions may not share one credential slot', () => {
  // `work` and `Work` derive the SAME slot; so do `a-b` and `a_b`. Both cases
  // are the typo worth refusing: two rows listing one key, and deleting either
  // silently breaking the other.
  assert.throws(
    () => normalizeSubscriptions([{ id: 'work' }, { id: 'Work' }], base),
    /would share the credential slot/,
  )
  assert.throws(
    () => normalizeSubscriptions([{ id: 'a-b' }, { id: 'a_b' }], base),
    /would share the credential slot/,
  )
})

test('a document with no LIVE reference is refused: the mirror needs somewhere to go', () => {
  assert.throws(() => normalizeSubscriptions(undefined, { displayName: 'x' }), /no live credential reference/)
})

test('a row may not derive the LIVE slot as its own storage', () => {
  // `OPENCODE_GO_API_KEY` is the shipped live slot; an id of `api-key` would
  // derive exactly it, and the runtime would overwrite that row's key on the
  // next switch. Refused by name instead of silently losing a secret.
  assert.throws(
    () => normalizeSubscriptions([{ id: 'api-key' }], base),
    /derives the credential slot "OPENCODE_GO_API_KEY".*LIVE slot/s,
  )
  // The same id is fine once the live slot is somewhere else.
  assert.deepEqual(
    normalizeSubscriptions([{ id: 'api-key' }], { apiKeyEnv: 'MAIN_KEY' }).map((sub) => sub.apiKeyRef),
    ['OPENCODE_GO_DEFAULT', 'OPENCODE_GO_API_KEY'],
  )
})

test('the resolved list is frozen, so a caller cannot mutate it in place', () => {
  const list = normalizeSubscriptions([{ id: 'work' }], base)
  assert.throws(() => { list.push({ id: 'nope' }) }, TypeError)
  assert.ok(Object.isFrozen(list[0]))
})

/* ── taking a row off the list ────────────────────────────────────────── */

test('hiding the default row is how that synthesized row leaves the list', () => {
  // The default row has no entry to delete: it IS the top-level
  // `apiKeyEnv`/`displayName`. `hidden` is the marker that takes it off, and the
  // credential slot it named is untouched — the operator removed a ROW.
  const list = normalizeSubscriptions([
    { id: 'default', hidden: true },
    { id: 'work', label: '公司号' },
  ], base)
  assert.deepEqual(list.map((sub) => sub.id), ['work'])
  assert.equal(list[0].apiKeyRef, 'OPENCODE_GO_WORK')
  // A pointer still naming the hidden row resolves to the first visible one
  // rather than leaving the route with nothing to bill.
  assert.equal(resolveActiveSubscription(list, 'default'), 'work')
})

test('a hidden extra leaves the list too, and every-hidden is refused', () => {
  const list = normalizeSubscriptions([{ id: 'work', hidden: true }, { id: 'home' }], base)
  assert.deepEqual(list.map((sub) => sub.id), ['default', 'home'])
  assert.throws(
    () => normalizeSubscriptions([{ id: 'default', hidden: true }], base),
    /every subscription is hidden/,
  )
  assert.throws(
    () => normalizeSubscriptions([{ id: 'work', hidden: 'yes' }], base),
    /\.hidden must be true or false/,
  )
  // An explicit `hidden: false` is a no-op, not an error.
  assert.deepEqual(normalizeSubscriptions([{ id: 'work', hidden: false }], base).map((sub) => sub.id), ['default', 'work'])
})

/* ── the active pointer ───────────────────────────────────────────────── */
test('exactly one subscription is active, and the pointer is a single scalar', () => {
  const list = normalizeSubscriptions([{ id: 'work' }, { id: 'home' }], base)
  assert.equal(resolveActiveSubscription(list, 'work'), 'work')
  assert.equal(resolveActiveSubscription(list, '  home  '), 'home')
  // Absent, blank, or naming a row somebody deleted: the first subscription
  // (the implicit default) is the fallback, so the route always has a payer.
  for (const raw of [undefined, null, '', '   ', 'ghost', 42, {}]) {
    assert.equal(resolveActiveSubscription(list, raw), DEFAULT_SUB_ID)
  }
  assert.equal(activeSubscriptionOf(list, 'work').id, 'work')
  assert.equal(activeSubscriptionOf(list, 'ghost').id, DEFAULT_SUB_ID)
})

/* ── vocabulary the client mirrors ────────────────────────────────────── */

test('the entry vocabulary is the name, the key address, and nothing else', () => {
  // Pinned deliberately: a field reappearing here is the per-key gateway address
  // / balance cap / enable flag / hand-written credential slot this redesign
  // removed. `hidden` is the one exception, and it earns its place: the DEFAULT
  // row is synthesized from the top-level fields, so hiding it is the only way
  // to take that row off the list.
  assert.deepEqual([...SUBSCRIPTION_ENTRY_KEYS], ['id', 'label', 'hidden'])
  assert.deepEqual([...USAGE_WINDOW_KEYS], ['rolling', 'weekly', 'monthly'])
  assert.equal(SUBSCRIPTION_ID_PATTERN.test('work-2'), true)
  assert.equal(SUBSCRIPTION_ID_PATTERN.test('bad id'), false)
  // Every derived slot name is a usable credential reference.
  assert.equal(CREDENTIAL_REF_PATTERN.test(refForSubscriptionId('work-2')), true)
})
