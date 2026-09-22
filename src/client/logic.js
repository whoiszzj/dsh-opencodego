/**
 * Every decision the settings page makes, as pure functions.
 *
 * The page's React component (`./section.js`) owns nothing but pixels and
 * promise plumbing: it renders what these functions return and calls the
 * settings/credential remotes with the values they compute. That split exists so
 * the rules can be tested by `node --test` with no DOM and no browser engine —
 * see `tests/client-logic.test.mjs` — which is the only honest way to claim the
 * page "works" on a machine that has no browser.
 *
 * In particular this module owns:
 *
 *   - the host settings payload → form draft (and back) mapping, including the
 *     three `models` sub-shapes the host declares as `z.any()` and therefore
 *     cannot render itself (`models.{disabled,extra,overrides}` plus
 *     `replaceDiscovered`);
 *   - the MODEL DIRECTORY: one row per model in effect, derived from the
 *     endpoint catalogue joined with the draft's overlay. The page offers two
 *     acts on it — pick models from the gateway (selection is committed to
 *     settings immediately, so picking IS activating) and add one by id.
 *     Exclusion (`models.disabled`) is the storage detail behind "not picked";
 *     the page never shows the word;
 *   - the credential plan: the API-key field stages a value for the CREDENTIAL
 *     store, which is a different write from the settings document, and this
 *     module is where that distinction is made;
 *   - the client-side validators that mirror the host's own rules (RFC 7230
 *     header names, positive capacities, `extra`/`disabled` contradictions), so
 *     a mistake is visible before a round-trip;
 *   - the field-level mapping of the host's rejection text onto the control that
 *     caused it;
 *   - the write operations, computed as path-addressed ops against the DRAFT so
 *     an untouched field is never written.
 *
 * @module dsh-opencodego/client/logic
 */

import {
  CONFIGURABLE_INPUT_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_SESSION_HEADER,
  DEFAULT_SUB_ID,
  SETTINGS_NS,
  SESSION_HEADER_MODES,
  SUBSCRIPTION_ID_PATTERN,
  SUPPORTED_PROTOCOLS,
  USAGE_WINDOW_KEYS,
  USAGE_WINDOW_LABELS,
} from './vocab.js'

// ── small helpers ──────────────────────────────────────────────────────────

/** A plain (non-array, non-null) object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON with object keys sorted, so a string compare is a value compare. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key])
    }
    return out
  }
  return value === undefined ? null : value
}

/** Stable stringification of a JSON value, for dirty checks and test assertions. */
export function stableString(value) {
  return JSON.stringify(canonical(value))
}

/** Deep structural equality over JSON values. */
export function deepEqual(left, right) {
  return stableString(left) === stableString(right)
}

/** Trim one string field of a draft, mapping the empty string to `undefined`. */
function trimmed(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/** One stored number as the form's blank-or-number cell. */
function numberOrBlank(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : ''
}

/** A positive count, or `undefined` for anything else (the defaults payload is untrusted). */
function positiveCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A list of distinct strings from an untrusted payload. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry === 'string' && !out.includes(entry)) out.push(entry)
  }
  return out
}

// ── host payload → form ────────────────────────────────────────────────────

/**
 * Form-side defaults, mirrored from the host schema so a fresh namespace renders filled.
 *
 * There is no top-level API-key cell any more: the keys belong to the
 * subscription ROWS, and each row stages one write-only value for the credential
 * store (see {@link stagedCredentialPlans}), so no stored secret is ever carried
 * back into a form.
 */
export const FORM_DEFAULTS = Object.freeze({
  baseURL: DEFAULT_BASE_URL,
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  displayName: undefined,
  sessionHeader: DEFAULT_SESSION_HEADER,
  sessionHeaderEnabled: true,
  sessionHeaderMode: 'session-id',
  sync: false,
  activeSubscription: DEFAULT_SUB_ID,
  // SHIPPED default: load no models until the operator picks some. Kept in step
  // with `src/config.js`, which is the value the route actually applies.
  replaceDiscovered: true,
})

/** Locate this plugin's namespace view in a `settings.describe()` answer. */
export function namespaceView(describe, ns = SETTINGS_NS) {
  if (!isPlainObject(describe) || !Array.isArray(describe.namespaces)) return undefined
  return describe.namespaces.find((view) => isPlainObject(view) && view.ns === ns)
}

/**
 * Whether a pre-0.6.0 plain-text `apiKey` is still stored for this namespace.
 *
 * Unlike the removed inline field, this is not a supported state: it is the
 * migration's work item. The host strips `role('secret')` values from the wire,
 * so the check accepts every spelling the read could take — the raw user layer,
 * the resolved value, or the redaction sidecar — and reports the presence, never
 * the value.
 *
 * @param {object} view - one `SettingsNamespaceView`.
 * @returns {boolean} whether a legacy inline token is present.
 */
export function legacyApiKeyPresent(view) {
  const secrets = Array.isArray(view?.secrets) ? view.secrets : []
  const bySidecar = secrets.some((entry) => {
    const path = Array.isArray(entry?.path) ? entry.path : []
    return entry?.set === true && path.length === 1 && path[0] === 'apiKey'
  })
  const user = isPlainObject(view?.user) ? view.user : {}
  const value = isPlainObject(view?.value) ? view.value : {}
  return bySidecar
    || typeof user.apiKey === 'string' && user.apiKey.length > 0
    || typeof value.apiKey === 'string' && value.apiKey.length > 0
}

/**
 * Normalize one `models.extra` declaration into the form's editable row.
 *
 * The stored shape is the schema's (`{ id, name?, api?, … }`); everything the
 * operator did NOT say stays absent rather than becoming a default, because
 * "inherit from the snapshot" and "pin to 200 000" are different claims.
 *
 * @param {unknown} raw - one stored entry.
 * @param {number} index - position, for a stable row key.
 * @returns {object} the editable row.
 */
export function extraDraftFrom(raw, index) {
  const entry = isPlainObject(raw) ? raw : {}
  return {
    key: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `extra-${String(index)}`,
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    api: typeof entry.api === 'string' ? entry.api : '',
    contextWindow: numberOrBlank(entry.contextWindow),
    maxTokens: numberOrBlank(entry.maxTokens),
    input: Array.isArray(entry.input) ? entry.input.filter((modality) => typeof modality === 'string') : [],
    reasoning: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
    reasoningEfforts: Array.isArray(entry.reasoningEfforts)
      ? entry.reasoningEfforts.filter((level) => typeof level === 'string')
      : [],
  }
}

/** One stored override object (or the absence of one) as the form's per-attribute cells. */
function overrideRowFrom(id, raw) {
  const claims = isPlainObject(raw) ? raw : {}
  const row = { id, api: '', contextWindow: '', maxTokens: '', reasoningEfforts: [], input: [] }
  if (typeof claims.api === 'string') row.api = claims.api
  row.contextWindow = numberOrBlank(claims.contextWindow)
  row.maxTokens = numberOrBlank(claims.maxTokens)
  if (Array.isArray(claims.reasoningEfforts)) {
    row.reasoningEfforts = claims.reasoningEfforts.filter((level) => typeof level === 'string')
  }
  if (Array.isArray(claims.input)) row.input = claims.input.filter((modality) => typeof modality === 'string')
  if (typeof claims.reasoning === 'boolean') row.reasoning = claims.reasoning
  return row
}

/**
 * Build the editable draft from one namespace view.
 *
 * Layering rule: a field the USER layer names is shown as the operator's own
 * value (it is what will be written back), while a field only the resolved
 * layer carries is shown as the inherited default. The `models` block is read
 * from the user layer when present, because the resolved layer has already been
 * normalized into a different shape (`extra` as an id-keyed map) which is not
 * what a form edits.
 *
 * The stored `apiKey` is the LEGACY plain-text token and is never put in the
 * form: it is reported through {@link legacyApiKeyPresent} so the page can warn,
 * and the migration removes it. Each subscription row's own `apiKey` is a
 * staging field for a NEW credential, which always starts blank.
 *
 * @param {object} view - one `SettingsNamespaceView`.
 * @returns {object} the form state.
 */
export function formFromView(view) {
  const value = isPlainObject(view?.value) ? view.value : {}
  const user = isPlainObject(view?.user) ? view.user : {}
  const models = isPlainObject(user.models) ? user.models : {}

  const scalar = (key) => (key in user ? user[key] : value[key])

  const extraSource = Array.isArray(models.extra) ? models.extra : []
  const overridesSource = isPlainObject(models.overrides) ? models.overrides : {}

  return {
    baseURL: typeof scalar('baseURL') === 'string' ? scalar('baseURL') : FORM_DEFAULTS.baseURL,
    // The default subscription's credential slot. This IS the system-default
    // reference the whole route reads, so it is never rendered as an editable
    // field — but a blank value in a hand-edited document falls back to the
    // shipped default rather than becoming an unfixable validation error.
    apiKeyEnv: typeof scalar('apiKeyEnv') === 'string' && scalar('apiKeyEnv').trim().length > 0
      ? scalar('apiKeyEnv').trim()
      : FORM_DEFAULTS.apiKeyEnv,
    displayName: typeof scalar('displayName') === 'string' ? scalar('displayName') : '',
    sessionHeader: typeof scalar('sessionHeader') === 'string' ? scalar('sessionHeader') : FORM_DEFAULTS.sessionHeader,
    sessionHeaderEnabled: scalar('sessionHeaderEnabled') !== false,
    sessionHeaderMode: SESSION_HEADER_MODES.includes(scalar('sessionHeaderMode'))
      ? scalar('sessionHeaderMode')
      : FORM_DEFAULTS.sessionHeaderMode,
    sync: scalar('sync') !== false,
    disabled: Array.isArray(models.disabled) ? models.disabled.filter((id) => typeof id === 'string') : [],
    extra: extraSource.map(extraDraftFrom),
    overrides: Object.entries(overridesSource).map(([id, raw]) => overrideRowFrom(id, raw)),
    // The form must default to the SAME thing the host's schema defaults to
    // (`config.js`), or a fresh install renders as "everything the gateway
    // advertises is enabled" while the host actually loads nothing — the page
    // and the route would disagree about the model set.
    replaceDiscovered: 'replaceDiscovered' in models
      ? models.replaceDiscovered === true
      : FORM_DEFAULTS.replaceDiscovered,
    // The subscription rows (0.8.2). The first row is ALWAYS the implicit
    // default — it edits the legacy top-level fields (`displayName` for its
    // name, `apiKeyEnv` for its credential slot) rather than becoming a second
    // copy of them. Extra entries follow in configured order.
    subscriptions: subscriptionDraftsFrom(user, value),
    // WHICH subscription pays. A single id, never a boolean per row: the page
    // cannot render two "on" rows because there is nowhere to put a second one.
    activeSubscription: typeof scalar('activeSubscription') === 'string' && scalar('activeSubscription').trim().length > 0
      ? scalar('activeSubscription').trim()
      : DEFAULT_SUB_ID,
  }
}

// ── subscriptions + balance (0.8) ──────────────────────────────────────────

/**
 * One stored `subscriptions[]` entry as an editable row.
 *
 * A subscription is a NAME and a KEY. The credential slot is DERIVED from the
 * id (host-side `refForSubscriptionId`) and shown read-only; the stored entry
 * carries `{ id, label }` (plus `hidden` when the row was taken off the list).
 * Cells stay blank where the entry says nothing.
 */
export function subDraftFrom(raw, index) {
  const entry = isPlainObject(raw) ? raw : {}
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  return {
    key: id.length > 0 ? id : `sub-${String(index)}`,
    isDefault: id === DEFAULT_SUB_ID,
    id,
    label: typeof entry.label === 'string' ? entry.label : '',
    // A row the operator removed from the list. It is not rendered, and it is
    // written back with the marker so the document keeps saying so.
    hidden: entry.hidden === true,
    // WRITE-ONLY staging, exactly like the legacy top-level API-key field.
    apiKey: '',
  }
}

/**
 * The draft's subscription rows: the implicit default row (seeded from the
 * top-level fields it stands for), then the configured extras, with a
 * reserved-id entry folded back into the default row.
 *
 * NO row carries a credential slot: each one's slot is DERIVED from its name
 * (`subscriptionSlotOf`), so the form cannot promise a slot the host would not
 * resolve.
 */
export function subscriptionDraftsFrom(user, value) {
  const scalar = (key) => (key in user ? user[key] : value[key])
  const rows = [{
    key: DEFAULT_SUB_ID,
    isDefault: true,
    id: DEFAULT_SUB_ID,
    label: typeof scalar('displayName') === 'string' ? scalar('displayName') : '',
    hidden: false,
    apiKey: '',
  }]
  const byKey = new Map([[DEFAULT_SUB_ID, rows[0]]])
  for (const [index, raw] of (Array.isArray(user.subscriptions) ? user.subscriptions : []).entries()) {
    const entry = isPlainObject(raw) ? raw : {}
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const existing = id === DEFAULT_SUB_ID ? byKey.get(id) : undefined
    if (existing !== undefined) {
      // ONLY the reserved id folds into the default row. A duplicated non-
      // default id stays TWO rows so the validator can point at the second
      // one — silently merging the operator's typo into one row would hide the
      // exact document shape the host refuses to resolve.
      Object.assign(existing, subDraftFrom(entry, index), { key: DEFAULT_SUB_ID, isDefault: true, id: DEFAULT_SUB_ID })
      continue
    }
    const row = subDraftFrom(entry, index)
    byKey.set(row.key, row)
    rows.push(row)
  }
  return rows
}

/** A blank row for the "添加订阅" button, born with the id it will be stored under. */
export function blankSubDraft(id) {
  const own = typeof id === 'string' && id.trim().length > 0 ? id.trim() : 'sub-2'
  return {
    key: own,
    isDefault: false,
    id: own,
    label: '',
    hidden: false,
    apiKey: '',
  }
}

/**
 * A fresh subscription id: `sub-2`, `sub-3`, … — the first one free.
 *
 * The id is minted when the ROW IS CREATED, not when it is saved, and that is
 * load-bearing rather than cosmetic. A row's `key` in the form IS its id, and a
 * key that changes under the draft breaks three things at once (measured):
 * which panel is expanded, which staged secret belongs to which row, and
 * whether the form still looks dirty after a write — the last one showed up as a
 * 保存 button that enabled itself for no discernible reason. An id that exists
 * from birth never moves, so none of that can drift.
 *
 * @param {Set<string>} taken - ids already claimed (the other rows plus `default`).
 * @returns {string} an unused subscription id.
 */
export function mintSubscriptionId(taken = new Set()) {
  let n = 2
  while (taken.has(`sub-${String(n)}`)) n += 1
  return `sub-${String(n)}`
}

/** The ids a form's rows already claim, `default` included. */
function takenIds(form) {
  const taken = new Set([DEFAULT_SUB_ID])
  for (const row of Array.isArray(form?.subscriptions) ? form.subscriptions : []) {
    const id = trimmed(row?.id)
    if (id !== undefined) taken.add(id)
  }
  return taken
}

/**
 * The reference-safe slug of a subscription name — the client half of the host's
 * `subs.js#subscriptionSlug`. `tests/vocabulary.test.mjs` compares this
 * function's output against the host's for the same names, so the two halves
 * cannot drift.
 *
 * @param {string} label - the name the operator typed.
 * @returns {string} the slug, or `''` when the name carries no usable character.
 */
export function subscriptionSlug(label) {
  return String(label ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
}

/**
 * The credential slot one row's key is stored under — its OWN slot, NAMED AFTER
 * THE ROW, exactly as the host's `refForSubscriptionLabel` derives it. A row the
 * operator has not named yet has nothing to derive from and falls back to the
 * id-derived spelling, which is also what the host resolves for it.
 *
 * The LIVE slot (the top-level `apiKeyEnv`) is NOT this: the host overwrites it
 * with the active row's value on every switch, so a key stored there could not
 * survive one.
 *
 * @param {object} row - one draft row.
 * @param {string} [label] - the row's EFFECTIVE name, when it lives outside the
 *   row (the default row keeps its name in the top-level `displayName`).
 * @returns {string} e.g. `work@example.com` → `OPENCODE_GO_WORK_EXAMPLE_COM`.
 */
export function subscriptionSlotOf(row, label) {
  const own = typeof label === 'string' ? label : (typeof row?.label === 'string' ? row.label : '')
  const slug = subscriptionSlug(own)
  if (slug.length > 0) return `OPENCODE_GO_${slug}`
  const id = row?.isDefault === true || row?.id === DEFAULT_SUB_ID ? DEFAULT_SUB_ID : String(row?.id ?? '')
  return `OPENCODE_GO_${id.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`
}

/**
 * The rows in stored shape, with ids minted for the ones that never had one.
 * A row that says nothing at all (the adder's blank line) is dropped, exactly
 * like a blank `models.extra` row.
 */
function subscriptionEntries(form) {
  const out = []
  const taken = new Set([DEFAULT_SUB_ID])
  for (const row of Array.isArray(form?.subscriptions) ? form.subscriptions : []) {
    if (row?.isDefault === true) continue
    const label = trimmed(row?.label)
    if (label === undefined) continue
    // The id is minted when the row is CREATED, so this only has to stand in for
    // a hand-written document whose entry lost its id — where it is derived from
    // the rows around it, deterministically, so a dirty comparison still holds.
    const existing = trimmed(row?.id)
    const id = existing !== undefined && !taken.has(existing) ? existing : mintSubscriptionId(taken)
    taken.add(id)
    out.push({ row, id, label, hidden: row.hidden === true })
  }
  return out
}

/**
 * Serialize the subscription rows for storage.
 *
 * The DEFAULT row is normally not written at all: its name IS `displayName` and
 * its credential slot IS `apiKeyEnv`, two top-level fields this page already
 * edits (writing a `{ id: 'default' }` entry as well would be a second spelling
 * of the same two facts). It IS written when the operator took that row off the
 * list — `{ id: 'default', hidden: true }` is the only way to express that,
 * because the host synthesizes the row from those top-level fields and there is
 * no entry to delete. Extra rows are `{ id, label }`; the credential slot is
 * derived from the id on the host side.
 */
export function subsBlockFrom(form) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  const out = []
  const fallback = rows.find((row) => row?.isDefault === true)
  if (fallback !== undefined && fallback.hidden === true) out.push({ id: DEFAULT_SUB_ID, hidden: true })
  for (const { id, label, hidden } of subscriptionEntries(form)) {
    out.push(hidden ? { id, label, hidden: true } : { id, label })
  }
  return out
}

/**
 * The credential slot names the form's rows address, keyed by row key — what
 * the page shows beside each row and what `stagedCredentialPlans` writes to.
 */
export function subscriptionSlots(form) {
  const slots = new Map()
  for (const row of Array.isArray(form?.subscriptions) ? form.subscriptions : []) {
    // The default row's NAME is the top-level `displayName`, so its slot has to
    // be derived from that — the row itself carries no label.
    if (row?.isDefault === true) slots.set(row.key, subscriptionSlotOf(row, form?.displayName))
  }
  for (const { row, id } of subscriptionEntries(form)) {
    slots.set(row.key, subscriptionSlotOf({ ...row, id }, row.label))
  }
  return slots
}

/**
 * Patch one subscription row by its stable key (or its id, for rows whose key
 * was minted before the id was typed — the same dual address `extra` rows use).
 */
export function patchSubRow(form, key, changes) {
  const matches = (row) => row.key === key || (typeof row.id === 'string' && row.id.length > 0 && row.id === key)
  return {
    ...form,
    subscriptions: (Array.isArray(form?.subscriptions) ? form.subscriptions : [])
      .map((row) => (matches(row) ? { ...row, ...changes } : row)),
  }
}

/** Append a fresh empty row, minting the id it keeps for the rest of its life. */
export function addSubscriptionRow(form) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  return {
    ...form,
    subscriptions: [...rows, blankSubDraft(mintSubscriptionId(takenIds(form)))],
  }
}

/**
 * Remove one row (by key or id).
 *
 * The page never offers this for the ACTIVE row (it pays for every request), so
 * the pointer only has to be repointed defensively, for a hand-built draft. The
 * default row is HIDDEN rather than dropped — see the body for why.
 */
export function removeSubRow(form, key) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  const matches = (row) => row.key === key || (row.id !== '' && row.id === key)
  const doomed = rows.find(matches)
  if (doomed === undefined) return form
  // The default row cannot be removed — the host synthesizes it from the
  // top-level `apiKeyEnv` / `displayName`, so there is no entry to delete.
  // "Deleting" it therefore HIDES it, and the credential slot it names stays
  // where it is: the operator removed a row, not a secret.
  const next = doomed.isDefault === true
    ? rows.map((row) => (row === doomed ? { ...row, hidden: true } : row))
    : rows.filter((row) => row !== doomed)
  const visible = next.filter((row) => row.hidden !== true)
  const stillPays = visible.some((row) => row.key === form?.activeSubscription
    || (row.id !== '' && row.id === form?.activeSubscription))
  return {
    ...form,
    subscriptions: next,
    // The page does not let the ACTIVE row be removed, so this only fires for a
    // hand-built draft — but leaving the pointer on a row that is gone would
    // make the route fall back silently, which is exactly what the operator did
    // not ask for.
    activeSubscription: stillPays ? form?.activeSubscription : (visible[0]?.key ?? DEFAULT_SUB_ID),
  }
}

/** Put the synthesized default row back on the list after it was hidden. */
export function restoreDefaultRow(form) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  return {
    ...form,
    subscriptions: rows.map((row) => (row?.isDefault === true ? { ...row, hidden: false } : row)),
  }
}

/** Whether the synthesized default row was taken off the list. */
export function defaultRowHidden(form) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  return rows.some((row) => row?.isDefault === true && row.hidden === true)
}

/** Point the route at one row. The page commits this immediately (选择即激活). */
export function activateSubscription(form, key) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  const target = rows.find((row) => row.key === key || (row.id !== '' && row.id === key))
  if (target === undefined) return form
  return { ...form, activeSubscription: target.key }
}

/**
 * The one-click switch's write list: whoever pays, plus the list itself when it
 * moved.
 *
 * A row that has never been saved has no stored id yet, so the pointer alone
 * would name a row the host cannot find (it resolves an unknown id back to
 * `default`, which is not what the click meant). Committing the LIST in the same
 * write is what lets a freshly added row be activated with the same gesture.
 *
 * The reserved DEFAULT row is handled by its own branch: `subscriptionEntries`
 * deliberately skips it (the host synthesizes that row from the top-level
 * fields, so there is no entry to write), but its POINTER value is `default` —
 * and returning "no ops" for it is how a click on that row used to leave the
 * page claiming a switch the host never heard about.
 *
 * @param {object} clean - the snapshot the form was loaded from.
 * @param {object} draft - the current form state.
 * @param {string} rowKey - the row that was clicked.
 * @returns {Array<{op: 'set', path: string[], value?: unknown}>} the ops, possibly empty.
 */
export function activationWriteOps(clean, draft, rowKey) {
  const rows = Array.isArray(draft?.subscriptions) ? draft.subscriptions : []
  const row = rows.find((entry) => entry?.key === rowKey || (entry?.id !== '' && entry?.id === rowKey))
  if (row === undefined || row.hidden === true) return []
  const id = row.isDefault === true || row.id === DEFAULT_SUB_ID
    ? DEFAULT_SUB_ID
    : subscriptionEntries(draft).find((entry) => entry.row.key === row.key)?.id
  // A non-default row with no name yet has no id to point at; the caller asks for
  // the name first, so reaching here means the document is not writable.
  if (id === undefined) return []
  const ops = []
  if (!deepEqual(subsBlockFrom(clean), subsBlockFrom(draft))) {
    ops.push({ op: 'set', path: ['subscriptions'], value: subsBlockFrom(draft) })
  }
  if (clean?.activeSubscription !== id) {
    ops.push({ op: 'set', path: ['activeSubscription'], value: id })
  }
  return ops
}

/** A blank extra row, for the "add a model" button. */
export function blankExtraDraft(key) {
  return {
    key: typeof key === 'string' ? key : `new-${String(Date.now())}`,
    id: '',
    name: '',
    api: '',
    contextWindow: '',
    maxTokens: '',
    input: [],
    reasoning: undefined,
    reasoningEfforts: [],
  }
}

// ── form → host payload ────────────────────────────────────────────────────

/**
 * Serialize one extra row for storage.
 *
 * Blank cells are OMITTED, not defaulted: the host treats an absent attribute as
 * "inherit from the snapshot / conservative default", so writing `null` or `0`
 * here would silently pin something the operator never said.
 *
 * @param {object} row - an editable row.
 * @returns {object} the `models.extra[i]` value.
 */
export function extraEntryFrom(row) {
  const entry = {}
  const id = trimmed(row?.id)
  entry.id = id
  const name = trimmed(row?.name)
  if (name !== undefined) entry.name = name
  const api = trimmed(row?.api)
  if (api !== undefined) entry.api = api
  if (typeof row?.contextWindow === 'number') entry.contextWindow = row.contextWindow
  if (typeof row?.maxTokens === 'number') entry.maxTokens = row.maxTokens
  if (Array.isArray(row?.input) && row.input.length > 0) entry.input = [...row.input]
  if (row?.reasoning === true || row?.reasoning === false) entry.reasoning = row.reasoning
  if (Array.isArray(row?.reasoningEfforts) && row.reasoningEfforts.length > 0) {
    entry.reasoningEfforts = [...row.reasoningEfforts]
  }
  return entry
}

/**
 * Serialize one override row. Returns `undefined` when the row claims nothing:
 * the host REJECTS an empty override (`sets nothing; remove the entry`), so an
 * all-blank row must not be written at all.
 *
 * @param {object} row - an editable override row.
 * @returns {object | undefined} the `models.overrides[id]` value.
 */
export function overrideEntryFrom(row) {
  const entry = {}
  const api = trimmed(row?.api)
  if (api !== undefined) entry.api = api
  if (typeof row?.contextWindow === 'number') entry.contextWindow = row.contextWindow
  if (typeof row?.maxTokens === 'number') entry.maxTokens = row.maxTokens
  if (Array.isArray(row?.input) && row.input.length > 0) entry.input = [...row.input]
  if (row?.reasoning === true || row?.reasoning === false) entry.reasoning = row.reasoning
  if (Array.isArray(row?.reasoningEfforts) && row.reasoningEfforts.length > 0) {
    entry.reasoningEfforts = [...row.reasoningEfforts]
  }
  return Object.keys(entry).length === 0 ? undefined : entry
}

/**
 * The complete `models` block for a draft.
 *
 * Written in the shape the HOST schema stores: `extra` is the array form the
 * user section holds (the runtime normalizes it into an id-keyed map later), and
 * an empty attribute list is omitted rather than written as `[]` — the two are
 * the same claim, and writing only one of them makes the form's round-trip
 * byte-stable, which `tests/client-logic.test.mjs` pins.
 *
 * @param {object} form - the form state.
 * @returns {object} the serializable block.
 */
export function modelsBlockFrom(form) {
  const overrides = {}
  for (const row of Array.isArray(form?.overrides) ? form.overrides : []) {
    const id = trimmed(row?.id)
    if (id === undefined) continue
    const entry = overrideEntryFrom(row)
    if (entry !== undefined) overrides[id] = entry
  }
  const extra = (Array.isArray(form?.extra) ? form.extra : [])
    .filter((row) => trimmed(row?.id) !== undefined)
    .map(extraEntryFrom)
  for (const entry of extra) {
    if (entry.reasoningEfforts !== undefined && entry.reasoningEfforts.length === 0) delete entry.reasoningEfforts
  }
  return {
    disabled: [...(Array.isArray(form?.disabled) ? form.disabled : [])],
    extra,
    overrides,
    replaceDiscovered: form?.replaceDiscovered === true,
  }
}

// ── the model directory ────────────────────────────────────────────────────

/** The empty default fact set, so a row always has placeholders to show. */
const NO_DEFAULTS = Object.freeze({
  contextWindow: undefined,
  maxTokens: undefined,
  input: [],
  reasoning: false,
  reasoningEfforts: [],
})

/** One id, trimmed, or `undefined`. */
function idOf(row) {
  return trimmed(row?.id)
}

/**
 * The model directory: one row per model this draft would serve, in endpoint
 * order, followed by the hand-declared rows the endpoint does not advertise.
 *
 * This is the page's ONE model surface. It replaces the three separate editors
 * the phase-4b page shipped:
 *
 *   - a row the endpoint advertises is an `/models` id, optionally carrying an
 *     `overrides[id]` correction;
 *   - a row the endpoint does not advertise is an `models.extra` declaration,
 *     optionally carrying a display name;
 *   - an excluded model (`models.disabled`) has no row at all — that IS what
 *     "removed from the directory" means, and the fetch dialog is how it comes
 *     back.
 *
 * A row with no id yet is the blank form the "添加模型" button creates; it is kept
 * so the operator's typing is not thrown away.
 *
 * @param {object} form - the form state.
 * @param {readonly object[]} catalogue - the `catalogueView(...).models` payload.
 * @returns {object[]} the rows.
 */
export function directoryRows(form, catalogue) {
  const models = Array.isArray(catalogue) ? catalogue.filter((model) => typeof model?.id === 'string') : []
  const byId = new Map(models.map((model) => [model.id, model]))
  const disabled = new Set(Array.isArray(form?.disabled) ? form.disabled : [])
  const extras = Array.isArray(form?.extra) ? form.extra : []
  const overrides = Array.isArray(form?.overrides) ? form.overrides : []
  const rowFor = (id, model, advertised, extra) => ({
    key: extra?.key ?? `model-${id}`,
    id,
    name: trimmed(extra?.name) ?? model?.name ?? id,
    advertised,
    extra,
    override: overrides.find((row) => idOf(row) === id),
    protocol: typeof model?.protocol === 'string' ? model.protocol : undefined,
    snapshotKnown: model?.snapshotKnown === true,
    defaults: isPlainObject(model?.defaults) ? model.defaults : NO_DEFAULTS,
  })

  const rows = []
  for (const model of models) {
    if (disabled.has(model.id)) continue
    rows.push(rowFor(model.id, model, true, extras.find((row) => idOf(row) === model.id)))
  }
  for (const extra of extras) {
    const id = idOf(extra)
    // A blank row is the operator's typing: keep it even though no id resolves.
    if (id !== undefined && (disabled.has(id) || byId.has(id))) continue
    rows.push(rowFor(id ?? '', byId.get(id), byId.has(id), extra))
  }
  return rows
}

/**
 * Remove one directory row.
 *
 * An ADVERTISED model cannot be removed by deleting configuration — the endpoint
 * will advertise it again on the next discovery — so removal is an exclusion
 * (`models.disabled`), which is also why a row that was excluded must not keep
 * an `extra`/`overrides` entry: the host refuses a disabled model that carries
 * either.
 *
 * @param {object} form - the form state.
 * @param {object} row - one `directoryRows(...)` row.
 * @returns {object} a new form state.
 */
export function removeDirectoryRow(form, row) {
  const id = idOf(row)
  const key = row?.key
  const extra = (Array.isArray(form?.extra) ? form.extra : [])
    .filter((entry) => (id !== undefined ? idOf(entry) !== id : entry.key !== key))
  const overrides = (Array.isArray(form?.overrides) ? form.overrides : [])
    .filter((entry) => id === undefined || idOf(entry) !== id)
  if (row?.advertised === true && id !== undefined) {
    const disabled = Array.isArray(form?.disabled) ? form.disabled : []
    return {
      ...form,
      disabled: disabled.includes(id) ? disabled : [...disabled, id],
      extra: (Array.isArray(form?.extra) ? form.extra : []).filter((entry) => idOf(entry) !== id),
      overrides,
    }
  }
  return { ...form, extra, overrides }
}

/**
 * Patch one directory row's attributes.
 *
 * Where the write lands is decided by what the row IS, and that is the one rule
 * that keeps the two storage shapes honest:
 *
 *   - an `extra` row (a model the endpoint does not advertise) writes every
 *     attribute, display name included;
 *   - an advertised row writes an `overrides[id]` correction, and a correction
 *     that ends up claiming nothing is dropped rather than stored empty (the
 *     host rejects an empty override, and an empty row is the same absence).
 *
 * `name` is only offered for an `extra` row: the endpoint names its own models,
 * and the plugin's schema deliberately refuses to rename one (see `models.js`).
 *
 * @param {object} form - the form state.
 * @param {object} row - one `directoryRows(...)` row.
 * @param {object} changes - the attributes to change (form spellings).
 * @returns {object} a new form state.
 */
export function patchDirectoryRow(form, row, changes) {
  const id = idOf(row)
  if (row?.extra !== undefined) {
    const key = row.extra.key
    return {
      ...form,
      extra: (Array.isArray(form?.extra) ? form.extra : [])
        .map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)),
    }
  }
  if (row?.advertised !== true || id === undefined) return form
  const overrides = Array.isArray(form?.overrides) ? form.overrides : []
  const existing = overrides.find((entry) => idOf(entry) === id)
  const merged = { ...(existing ?? { id, api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] }), ...changes, id }
  const next = existing === undefined
    ? [...overrides, merged]
    : overrides.map((entry) => (idOf(entry) === id ? merged : entry))
  // An override that claims nothing is not a state the host accepts; drop it.
  return { ...form, overrides: next.filter((entry) => overrideEntryFrom(entry) !== undefined) }
}

/**
 * Apply the picker's checked-set as THE selection, over the ids one endpoint
 * listing disclosed.
 *
 * The dialog is not an "add" list: its checkboxes mirror which models are
 * enabled right now, so confirming writes the whole wanted-set at once —
 *
 *   - a listed id that is checked must not be excluded (clear its exclusion);
 *   - a listed id that is unchecked becomes an exclusion (the endpoint will
 *     keep advertising it, so removal from the served set can only be an
 *     exclusion, never a deleted row);
 *   - a model moving out of the selection loses its `extra`/`overrides` claims,
 *     because the host refuses claims on an excluded model;
 *   - ids the listing did not cover (a hand-added model, an exclusion of a
 *     model the gateway no longer serves) are NOT toggled by this operation —
 *     the picker only speaks for what it showed.
 *
 * `models.replaceDiscovered` is deliberately untouched: the page no longer
 * offers it, and a document that still carries one keeps working hidden.
 *
 * @param {object} form - the form state.
 * @param {readonly object[]} candidates - the listing's models (id-carrying objects).
 * @param {readonly string[]} wanted - the ids the operator wants ENABLED.
 * @returns {object} a new form state.
 */
export function setModelSelection(form, candidates, wanted) {
  const wantedSet = new Set(Array.isArray(wanted) ? wanted : [])
  const listed = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => candidate?.id)
    .filter((id) => typeof id === 'string' && id.length > 0)
  const disabled = new Set(Array.isArray(form?.disabled) ? form.disabled : [])
  for (const id of listed) {
    if (wantedSet.has(id)) disabled.delete(id)
    else disabled.add(id)
  }
  const disabledList = [...disabled]
  const survives = (row) => {
    const id = idOf(row)
    return id === undefined || !disabled.has(id)
  }
  const overrides = (Array.isArray(form?.overrides) ? form.overrides : []).filter(survives)
  // In REPLACEMENT mode the enabled set IS `extra` (the discovered list is not a
  // base any more), so the selection must be written there. Managing `disabled`
  // alone would enable nothing at all, and the picker would look broken.
  if (form?.replaceDiscovered === true) {
    const declared = Array.isArray(form?.extra) ? form.extra : []
    const declaredIds = new Set(declared.map(idOf).filter((id) => id !== undefined))
    const next = declared.filter((row) => {
      const id = idOf(row)
      // A hand-added model the picker never listed is not the picker's to drop.
      return id === undefined || !listed.includes(id)
    })
    for (const id of listed) {
      if (!wantedSet.has(id)) continue
      const existing = declared.find((row) => idOf(row) === id)
      next.push(existing ?? { id })
      void declaredIds
    }
    return { ...form, disabled: disabledList, extra: next, overrides }
  }
  return {
    ...form,
    disabled: disabledList,
    extra: (Array.isArray(form?.extra) ? form.extra : []).filter(survives),
    overrides,
  }
}

/**
 * Add one model by id — the page's other "activate" door, for a model the
 * gateway list does not show (or has not started showing yet).
 *
 * The id is enabled, not staged: an exclusion of the same id is cleared, and a
 * declaration (`extra`) is only needed when the endpoint does not advertise it
 * (the host rejects a claim on an excluded model, never a bare advertised id).
 * Capability facts are NOT pinned here: the plugin's model state flows through
 * the catalogue at request time.
 *
 * @param {object} form - the form state.
 * @param {string} rawId - the typed model id.
 * @param {readonly string[]} advertisedIds - ids the endpoint currently serves.
 * @returns {object} a new form state (unchanged when the id adds nothing).
 */
export function addModelById(form, rawId, advertisedIds) {
  const id = trimmed(rawId)
  if (id === undefined) return form
  const advertised = new Set(Array.isArray(advertisedIds) ? advertisedIds : [])
  const disabled = (Array.isArray(form?.disabled) ? form.disabled : []).filter((entry) => entry !== id)
  const extra = Array.isArray(form?.extra) ? form.extra : []
  if (advertised.has(id) || extra.some((row) => idOf(row) === id)) {
    return { ...form, disabled }
  }
  return {
    ...form,
    disabled,
    extra: [...extra, { ...blankExtraDraft(`hand-${id}`), id, name: '' }],
  }
}

// ── validators (client-side, mirroring the host) ────────────────────────────

/** RFC 7230 `token` character set — the only shape a header name may have. */
const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u

/** Whether one string is a legal HTTP header field-name (RFC 7230 §3.2.6). */
export function isHeaderToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

/**
 * Whether a credential REFERENCE looks like it is carrying a secret value.
 *
 * The field names an environment variable; pasting the key itself there would
 * leave the runtime reading an unset reference while the secret sits in the
 * settings document. This is a *hint*, never a write gate: a deployment may
 * legitimately use a reference this heuristic does not recognize, and the host
 * is the authority on what resolves.
 */
export function looksLikeSecretValue(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length < 24) return false
  if (!/^[A-Za-z0-9_\-./+=]+$/u.test(text)) return false
  return /^(sk-|pk-|rk-|ghp_|github_pat_|xox[baprs]-)/u.test(text) || text.length >= 40
}

/**
 * Whether a staged token could be carried by an HTTP header at all.
 *
 * The host applies the authoritative check (`assertUsableApiKey` →
 * `normalizeApiKey`); this is the same rule mirrored client-side so the operator
 * sees the problem beside the field instead of as a save-time rejection. A key
 * with a control character or a newline is never a key.
 *
 * @param {string} value - the staged token.
 * @returns {boolean} whether it is storable.
 */
export function isUsableApiKey(value) {
  if (typeof value !== 'string') return false
  if (value.trim().length === 0) return false
  // VCHAR plus interior SP/HTAB (RFC 7230 field-content); DEL and CTLs are out.
  return !/[\u0000-\u0008\u000A-\u001F\u007F]/u.test(value)
}

/**
 * Field-keyed validation messages for one draft, exactly as the page shows them.
 *
 * Keys are form field names (`baseURL`, `models.extra[0].contextWindow`, …) so
 * the component can put each message beside its control. An empty object means
 * the draft is valid as far as the client can tell — the host validates again,
 * and a rejection it reports is merged into the same map by {@link errorPathsOf}.
 *
 * @param {object} form - the form state.
 * @returns {Record<string, string>} field → message.
 */
export function validateForm(form) {
  const errors = {}

  const baseURL = trimmed(form?.baseURL)
  if (baseURL === undefined) errors.baseURL = '必填：网关基址（含 /v1）'
  else if (!/^https?:\/\//iu.test(baseURL)) errors.baseURL = '必须以 http:// 或 https:// 开头'

  // The credential reference is the ONLY source this plugin reads, so a blank
  // one is refused here rather than at the first request.
  const apiKeyEnv = trimmed(form?.apiKeyEnv)
  if (apiKeyEnv === undefined) {
    errors.apiKeyEnv = '必填：凭据引用名（环境变量名），例如 OPENCODE_GO_API_KEY'
  } else if (looksLikeSecretValue(form.apiKeyEnv)) {
    errors.apiKeyEnv = '这看起来是 key 本身；凭据引用名只能填环境变量名，密钥请填在订阅行的“API 密钥”格里'
  }

  // The staged credential values live on the subscription ROWS
  // (`validateSubscriptions` below): there is no top-level API-key cell any
  // more, because the top of the page is the subscription list itself.

  if (form?.sessionHeaderEnabled !== false) {
    const header = form?.sessionHeader
    if (trimmed(header) === undefined) {
      errors.sessionHeader = '启用会话头时必须填一个头名'
    } else if (!isHeaderToken(header)) {
      errors.sessionHeader = '不是合法的 HTTP 头名：只允许 RFC 7230 token 字符（!#$%&\'*+-.^_`|~ 与字母数字）'
    }
  }
  if (!SESSION_HEADER_MODES.includes(form?.sessionHeaderMode)) {
    errors.sessionHeaderMode = `必须是 ${SESSION_HEADER_MODES.join(' / ')}`
  }

  const seen = new Set()
  for (const [index, row] of (Array.isArray(form?.extra) ? form.extra : []).entries()) {
    const id = trimmed(row?.id)
    // A row with no id yet is the blank form of the next declaration: its OTHER
    // cells are still checked (they are real values the operator typed), but the
    // missing id is only refused once another row exists to compare against —
    // reporting "必填" while the operator is still typing the first character
    // would be noise, and `modelsBlockFrom` drops the row from the write anyway.
    if (id === undefined) {
      if ((Array.isArray(form?.extra) ? form.extra : []).length > 1) {
        errors[`models.extra[${index}].id`] = '必填：模型 id'
      }
    } else {
      if (seen.has(id)) errors[`models.extra[${index}].id`] = `与前面某条重复（${id}）`
      seen.add(id)
      if ((Array.isArray(form.disabled) ? form.disabled : []).includes(id)) {
        errors[`models.extra[${index}].id`] = `${id} 同时在 disabled 里；一个模型不能既追加又排除`
      }
    }
    if (trimmed(row?.api) !== undefined && !SUPPORTED_PROTOCOLS.includes(trimmed(row?.api))) {
      errors[`models.extra[${index}].api`] = `不受支持的协议；可用：${SUPPORTED_PROTOCOLS.join(' / ')}`
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      const cell = row?.[field]
      if (cell === '' || cell === undefined) continue
      if (!Number.isSafeInteger(cell) || cell <= 0) {
        errors[`models.extra[${index}].${field}`] = '必须是正整数（留空表示继承官方默认）'
      }
    }
    for (const modality of Array.isArray(row?.input) ? row.input : []) {
      if (!CONFIGURABLE_INPUT_MODALITIES.includes(modality)) {
        errors[`models.extra[${index}].input`] = `只接受 ${CONFIGURABLE_INPUT_MODALITIES.join(' / ')}`
      }
    }
    for (const level of Array.isArray(row?.reasoningEfforts) ? row.reasoningEfforts : []) {
      if (!CONFIGURABLE_THINKING_LEVELS.includes(level)) {
        errors[`models.extra[${index}].reasoningEfforts`] = `只接受 ${CONFIGURABLE_THINKING_LEVELS.join(' / ')}（off 用“关闭推理”表达）`
      }
    }
  }

  const disabled = Array.isArray(form?.disabled) ? form.disabled : []
  const disabledSeen = new Set()
  for (const [index, id] of disabled.entries()) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      errors[`models.disabled[${index}]`] = '模型 id 不能为空'
      continue
    }
    if (disabledSeen.has(id)) errors[`models.disabled[${index}]`] = `重复（${id}）`
    disabledSeen.add(id)
  }

  for (const [index, row] of (Array.isArray(form?.overrides) ? form.overrides : []).entries()) {
    const id = trimmed(row?.id)
    if (id === undefined) {
      errors[`models.overrides[${index}].id`] = '必填：要覆盖的模型 id'
      continue
    }
    // One message per control: the most actionable one wins, so an override that
    // claims nothing is reported as such even when it is also dead because the
    // model is disabled.
    if (overrideEntryFrom(row) === undefined) {
      errors[`models.overrides[${index}].id`] = `${id} 这一条什么都没写；写一个属性，或删掉它`
      continue
    }
    if (disabledSeen.has(id)) {
      errors[`models.overrides[${index}].id`] = `${id} 在 disabled 里，这条覆盖永远不会生效`
    }
    if (trimmed(row?.api) !== undefined && !SUPPORTED_PROTOCOLS.includes(trimmed(row.api))) {
      errors[`models.overrides[${index}].api`] = `不受支持的协议；可用：${SUPPORTED_PROTOCOLS.join(' / ')}`
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      const cell = row?.[field]
      if (cell === '' || cell === undefined) continue
      if (!Number.isSafeInteger(cell) || cell <= 0) {
        errors[`models.overrides[${index}].${field}`] = '必须是正整数（留空表示不覆盖）'
      }
    }
    for (const modality of Array.isArray(row?.input) ? row.input : []) {
      if (!CONFIGURABLE_INPUT_MODALITIES.includes(modality)) {
        errors[`models.overrides[${index}].input`] = `只接受 ${CONFIGURABLE_INPUT_MODALITIES.join(' / ')}`
      }
    }
    for (const level of Array.isArray(row?.reasoningEfforts) ? row.reasoningEfforts : []) {
      if (!CONFIGURABLE_THINKING_LEVELS.includes(level)) {
        errors[`models.overrides[${index}].reasoningEfforts`] = `只接受 ${CONFIGURABLE_THINKING_LEVELS.join(' / ')}`
      }
    }
  }


  validateSubscriptions(form, errors)

  return errors
}

/**
 * Subscription rows (0.8.2): a NAME per row (the id and the credential slot are
 * derived from it), no duplicate names, and a staged key the HTTP layer can
 * carry. A blank adder row is treated exactly like a blank `extra` row: silent
 * while empty, refused once it claims anything.
 */
function validateSubscriptions(form, errors) {
  const rows = Array.isArray(form?.subscriptions) ? form.subscriptions : []
  const visible = rows.filter((row) => row?.hidden !== true)
  const seenLabels = new Set()
  const active = typeof form?.activeSubscription === 'string' ? form.activeSubscription : DEFAULT_SUB_ID
  for (const [index, row] of rows.entries()) {
    const path = `subscriptions[${String(index)}]`
    if (row?.hidden === true) continue
    const label = trimmed(row?.label)
    const staged = typeof row?.apiKey === 'string' ? row.apiKey : ''
    if (row?.isDefault !== true) {
      const claims = label !== undefined || staged.trim().length > 0
      if (label === undefined) {
        if (claims) errors[`${path}.label`] = '必填：这条订阅的名字'
      } else if (seenLabels.has(label)) {
        errors[`${path}.label`] = `与前面某条订阅重名（${label}）`
      } else {
        seenLabels.add(label)
      }
      const existingId = trimmed(row?.id)
      if (existingId !== undefined && !SUBSCRIPTION_ID_PATTERN.test(existingId)) {
        errors[`${path}.label`] = `内部 id 不合法（${existingId}）：改名或删掉重加`
      }
    }
    if (staged.trim().length > 0 && !isUsableApiKey(staged)) {
      errors[`${path}.apiKey`] = '这个值不能放进 HTTP 头（含控制字符或换行）'
    }
  }
  // The route needs ONE payer. An ABSENT `subscriptions` array is not "nothing
  // configured": the host always synthesizes the default row from `apiKeyEnv`,
  // so only a list that exists and has every row hidden is a dead end.
  if (rows.length > 0 && visible.length === 0) {
    errors.subscriptions = '至少要保留一条订阅'
    return
  }
  const pays = rows.length === 0
    ? active === DEFAULT_SUB_ID
    : visible.some((row) => row?.key === active || (row?.id !== undefined && row.id !== '' && row.id === active))
  if (!pays) {
    errors.activeSubscription = `当前订阅（${active}）不在列表里；点一行重新选`
  }
}

/**
 * Whether one model id is in effect under a draft, given what the endpoint serves.
 * Mirrors the host's `discovered ∪ extra \ disabled` (all ids considered
 * discovered when the caller does not say).
 *
 * @param {string} id - the model id.
 * @param {object} form - the form state.
 * @param {readonly string[]} [discoveredIds] - ids the endpoint advertises.
 * @returns {boolean} true when the route would serve it.
 */
export function isModelEnabled(id, form, discoveredIds) {
  const extraIds = (Array.isArray(form?.extra) ? form.extra : [])
    .map((row) => trimmed(row?.id))
    .filter((entry) => entry !== undefined)
  if ((Array.isArray(form?.disabled) ? form.disabled : []).includes(id)) return false
  if (extraIds.includes(id)) return true
  if (form?.replaceDiscovered === true) return false
  return discoveredIds === undefined ? true : discoveredIds.includes(id)
}

/** The ids this draft would serve, given what the endpoint serves. */
export function effectiveIds(form, discoveredIds) {
  const extraIds = (Array.isArray(form?.extra) ? form.extra : [])
    .map((row) => trimmed(row?.id))
    .filter((entry) => entry !== undefined)
  const disabled = new Set(Array.isArray(form?.disabled) ? form.disabled : [])
  const base = form?.replaceDiscovered === true
    ? []
    : [...(Array.isArray(discoveredIds) ? discoveredIds : [])]
  const out = []
  for (const id of [...base, ...extraIds]) {
    if (disabled.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * Find the draft row an error path names.
 *
 * The host's message carries the model ID (`models.extra["broken-extra"]`) while
 * the client's own validator carries the row index
 * (`models.extra[0].contextWindow`). The page renders rows by identity, so both
 * spellings resolve here to the same row — without this, a host rejection would
 * land on the wrong control as soon as rows are reordered around it.
 *
 * @param {Array<object>} rows - extra or override rows.
 * @param {string} ref - an index or a model id.
 * @returns {number} the row index, or -1.
 */
export function rowIndexFor(rows, ref) {
  const list = Array.isArray(rows) ? rows : []
  if (/^\d+$/u.test(ref)) {
    const index = Number(ref)
    if (index < list.length) return index
  }
  const wanted = typeof ref === 'string' ? ref.trim() : ref
  return list.findIndex((row) => (typeof row?.id === 'string' ? row.id.trim() : row?.id) === wanted)
}

// ── host rejection → the control that caused it ────────────────────────────

/**
 * Map one host rejection message onto form field(s).
 *
 * The host names the field path in every rejection it produces
 * (`models.extra["broken"].contextWindow must be a positive integer`, `sessionHeader
 * "x session" is not a valid HTTP header name`). Parsing that text is the only
 * way a browser half can put the message beside the right control: the Remote
 * failure carries a code and a message, not a path.
 *
 * @param {string} message - the host's message.
 * @returns {string[]} form field names, longest-prefix first.
 */
export function errorPathsOf(message) {
  const text = typeof message === 'string' ? message : ''
  const paths = []
  const push = (path) => {
    if (path.length > 0 && !paths.includes(path)) paths.push(path)
  }

  // `models.extra["id"]` / `models.extra[0]` → one spelling for the row. The
  // id-keyed form is NORMALIZED to the unquoted one (`models.extra[broken-extra]`),
  // because the page keys its inline error map by row identity and a quoted key
  // would never match: `rowIndexFor` handles both.
  for (const match of text.matchAll(/models\.extra\[(?:"([^"]*)"|(\d+))\]/gu)) {
    push(`models.extra[${match[2] ?? match[1]}]`)
  }
  for (const match of text.matchAll(/models\.overrides\[(?:"([^"]*)"|(\d+))\]/gu)) {
    push(`models.overrides[${match[2] ?? match[1]}]`)
  }
  if (/models\.extra(?![.\[])/u.test(text)) push('models.extra')
  if (/models\.overrides(?![.\[])/u.test(text)) push('models.overrides')
  if (/models\.disabled/u.test(text)) push('models.disabled')
  if (/models\.replaceDiscovered/u.test(text)) push('models.replaceDiscovered')
  // A bare `models` rejection (unknown key, wrong shape) belongs to the section.
  else if (/models(?![.\w[])/u.test(text)) push('models')
  // `subscriptions[0].id` / `subscriptions["work"].cap` → one spelling per row
  // (id refs and index refs both resolve through `rowIndexFor(rows, ref)`).
  for (const match of text.matchAll(/subscriptions\[(?:"([^"]*)"|(\d+))\]/gu)) {
    push(`subscriptions[${match[2] ?? match[1]}]`)
  }
  if (/subscriptions(?![.\w[])/u.test(text)) push('subscriptions')
  if (/sessionHeaderMode/u.test(text)) push('sessionHeaderMode')
  else if (/sessionHeader/u.test(text)) push('sessionHeader')
  // `apiKeyEnv` first: a message naming the reference must not land on the
  // credential field, and `apiKey` is a prefix of it.
  if (/apiKeyEnv/u.test(text)) push('apiKeyEnv')
  else if (/\bapiKey\b/u.test(text)) push('apiKey')
  else if (/baseURL|base url/iu.test(text)) push('baseURL')
  if (/displayName/u.test(text)) push('displayName')

  return paths.sort((left, right) => right.length - left.length)
}

/** The first field name a host message maps onto, or `undefined`. */
export function primaryErrorPath(message) {
  return errorPathsOf(message)[0]
}

/** One human line for a Remote/gateway failure, without a stack or a credential. */
export function describeFailure(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : String(error)
  return code === undefined ? message : `${code}: ${message}`
}

/** Whether a failure is the multi-tab conflict the host reports. */
export function isConflictFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'settings/conflict') return true
  return /changed since it was read/iu.test(describeFailure(error))
}

// ── form → write operations ───────────────────────────────────────────────

/** Whether the draft differs from the snapshot it was loaded from. */
export function isDirty(clean, draft) {
  return !deepEqual(clean, draft)
}

/**
 * The credential writes the form owes: one per row whose key was just typed.
 *
 * The reference is the row's derived slot (`subscriptionSlotOf`), never a value
 * the operator typed — the secret goes to the credential store and the settings
 * document records nothing about it at all. A row with no name yet has no slot
 * to write to and is skipped (its key stays staged in the form).
 *
 * @param {object} form - the form state.
 * @returns {Array<{reference: string, value: string, label: string}>} the plans.
 */
export function stagedCredentialPlans(form) {
  const slots = subscriptionSlots(form)
  const plans = []
  for (const row of Array.isArray(form?.subscriptions) ? form.subscriptions : []) {
    const value = typeof row?.apiKey === 'string' ? row.apiKey.trim() : ''
    if (value.length === 0) continue
    const reference = slots.get(row.key)
    if (typeof reference !== 'string' || reference.length === 0) continue
    plans.push({ reference, value, label: trimmed(row?.label) ?? reference, key: row.key })
  }
  return plans
}

/**
 * The write plan for ONE row's just-typed key, if it has one.
 *
 * Used by the one-click switch: the editor is a draft, but a key the operator
 * typed and then clicked away from must reach the store BEFORE the pointer moves,
 * or the row they just selected would serve with the previous key. Returns
 * `undefined` when that row has nothing staged.
 *
 * @param {object} form - the form state.
 * @param {string} rowKey - the row whose panel was open.
 * @returns {{reference: string, value: string, label: string, key: string} | undefined} the plan.
 */
export function stagedCredentialPlanFor(form, rowKey) {
  return stagedCredentialPlans(form).find((plan) => plan.key === rowKey)
}

/**
 * The `GET /opencode-go-native/usage` answer, defensively read (the same
 * whitelist discipline as {@link catalogueView} — a field not listed here is
 * a field the page cannot see; invariant #6).
 */
export function usageView(payload) {
  const body = unwrapPayload(payload)
  const subs = Array.isArray(body.subs) ? body.subs : []
  return {
    refreshError: typeof body.refreshError === 'string' && body.refreshError.length > 0 ? body.refreshError : undefined,
    subs: subs
      .filter(isPlainObject)
      .map((row) => ({
        id: typeof row.id === 'string' ? row.id : '',
        label: typeof row.label === 'string' ? row.label : '',
        apiKeyRef: typeof row.apiKeyRef === 'string' ? row.apiKeyRef : '',
        // The spellings this row's key may still live under (a rename, or an
        // upgrade). Whitelisted because "清空这条订阅的密钥" has to remove ALL of
        // them: leaving an older copy behind would quietly resurrect it.
        fallbackRefs: Array.isArray(row.fallbackRefs)
          ? row.fallbackRefs.filter((ref) => typeof ref === 'string' && ref.length > 0)
          : [],
        isDefault: row.isDefault === true,
        active: row.active === true,
        configured: typeof row.configured === 'boolean' ? row.configured : undefined,
        source: typeof row.source === 'string' && row.source.length > 0 ? row.source : undefined,
        usage: {
          windows: isPlainObject(row.usage?.windows) ? row.usage.windows : undefined,
          checkedAt: typeof row.usage?.checkedAt === 'number' ? row.usage.checkedAt : undefined,
          ageMs: typeof row.usage?.ageMs === 'number' ? row.usage.ageMs : undefined,
          error: typeof row.usage?.error === 'string' && row.usage.error.length > 0 ? row.usage.error : undefined,
        },
      })),
  }
}

/**
 * The balance bars one subscription row renders: one per KNOWN window, each with
 * its percent, the gateway's status, and a tone. "Nearly spent" (>= 85%, or any
 * non-`ok` status) reads as warn/bad — the page's promise is that a RED bar is a
 * window the gateway says is done, an AMBER one is about to be, and a missing
 * bar means nothing has been measured yet.
 *
 * @param {object} sub - one `usageView(...).subs` row.
 * @returns {Array<{window: string, label: string, percent: number | undefined, status: string | undefined, resetsAt: string | undefined, tone: string}>}
 */
export function balanceCells(sub) {
  const windows = isPlainObject(sub?.usage?.windows) ? sub.usage.windows : undefined
  const out = []
  for (const name of USAGE_WINDOW_KEYS) {
    const entry = windows?.[name]
    if (!isPlainObject(entry)) continue
    const percent = typeof entry.percent === 'number' && Number.isFinite(entry.percent)
      ? Math.round(entry.percent)
      : undefined
    const status = typeof entry.status === 'string' ? entry.status : undefined
    let tone = 'ok'
    if (status !== undefined && status !== 'ok') tone = 'bad'
    else if (percent === undefined) tone = 'dim'
    else if (percent >= 85) tone = 'warn'
    out.push({
      window: name,
      label: USAGE_WINDOW_LABELS[name] ?? name,
      percent,
      status,
      resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : undefined,
      tone,
    })
  }
  return out
}

/**
 * How far away a reset is, rounded to whole minutes. `undefined` means the
 * gateway did not give a moment this page can read — one parse, so the two
 * phrasings below can never disagree about WHEN a window resets, only about how
 * much room they have to say it.
 *
 * @param {string | undefined} iso - the gateway's `resetsAt`.
 * @param {number} now - the clock.
 * @returns {{minutes: number} | undefined} minutes until the reset (`<= 0` = due).
 */
function resetGap(iso, now) {
  if (typeof iso !== 'string') return undefined
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  return { minutes: Math.round((at - now) / 60_000) }
}

/**
 * A reset time as the full human sentence — the tooltip's wording.
 * @param {string | undefined} iso - the gateway's `resetsAt`.
 * @param {number} [now] - the clock.
 * @returns {string | undefined} e.g. `约 3 小时后重置`.
 */
export function resetPhrase(iso, now = Date.now()) {
  const gap = resetGap(iso, now)
  if (gap === undefined) return undefined
  if (gap.minutes <= 0) return '即将重置'
  if (gap.minutes < 60) return `约 ${String(gap.minutes)} 分钟后重置`
  if (gap.minutes < 60 * 24) return `约 ${String(Math.round(gap.minutes / 60))} 小时后重置`
  return `约 ${String(Math.round(gap.minutes / (60 * 24)))} 天后重置`
}

/**
 * The same fact in the space UNDER one balance pill — the row already says which
 * window it is, so the phrase only has to answer "when", in the fewest glyphs
 * that stay a sentence (`3 小时后`, not `约 3 小时后重置`).
 *
 * @param {string | undefined} iso - the gateway's `resetsAt`.
 * @param {number} [now] - the clock.
 * @returns {string | undefined} e.g. `3 小时后`.
 */
export function resetShort(iso, now = Date.now()) {
  const gap = resetGap(iso, now)
  if (gap === undefined) return undefined
  if (gap.minutes <= 0) return '即将重置'
  if (gap.minutes < 60) return `${String(gap.minutes)} 分钟后`
  if (gap.minutes < 60 * 24) return `${String(Math.round(gap.minutes / 60))} 小时后`
  return `${String(Math.round(gap.minutes / (60 * 24)))} 天后`
}

/**
 * The reset moment as a local wall-clock stamp (`09-24 08:00`) — the hovering
 * reader can then stop converting "20 天后" into a date in their head.
 *
 * @param {string | undefined} iso - the gateway's `resetsAt`.
 * @returns {string | undefined} the local `MM-DD HH:mm`, or undefined if unreadable.
 */
export function resetStamp(iso) {
  if (typeof iso !== 'string') return undefined
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return undefined
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * Path-addressed operations that turn `clean` into `draft` under one namespace.
 *
 * Only paths whose value actually moved are emitted, and a value that became
 * `undefined` becomes an `unset` — which is why `displayName` can be cleared
 * without writing `null`. The host resolves these against the section as stored,
 * so two tabs editing different fields do not overwrite one another.
 *
 * @param {object} clean - the snapshot the form was loaded from.
 * @param {object} draft - the current form state.
 * @returns {Array<{op: 'set'|'unset', path: string[], value?: unknown}>} the ops.
 */
export function writeOps(clean, draft) {
  const ops = []
  const keys = ['baseURL', 'apiKeyEnv', 'displayName', 'sessionHeader', 'sessionHeaderEnabled', 'sessionHeaderMode', 'sync', 'activeSubscription']
  for (const key of keys) {
    if (deepEqual(clean?.[key], draft?.[key])) continue
    if (draft?.[key] === undefined) {
      // A cleared string field is an explicit empty write for the host schema
      // (all of these are optional), except `displayName`, whose absence is the
      // intent.
      ops.push({ op: 'set', path: [key], value: key === 'displayName' ? '' : draft?.[key] })
      continue
    }
    ops.push({ op: 'set', path: [key], value: draft[key] })
  }

  // The subscription list (0.8.2) writes as ONE whole-array set: rows are added
  // and removed atomically, and the ids are minted here (from the names) the
  // first time a row is stored. An untouched document still writes NOTHING — the
  // pre-0.8 shape is the default shape, not an empty array.
  if (!deepEqual(subsBlockFrom(clean), subsBlockFrom(draft))) {
    ops.push({ op: 'set', path: ['subscriptions'], value: subsBlockFrom(draft) })
  }

  if (!deepEqual(modelsBlockFrom(clean), modelsBlockFrom(draft))) {
    const models = modelsBlockFrom(draft)
    ops.push({ op: 'set', path: ['models', 'disabled'], value: models.disabled })
    ops.push({ op: 'set', path: ['models', 'extra'], value: models.extra })
    ops.push({ op: 'set', path: ['models', 'overrides'], value: models.overrides })
    ops.push({ op: 'set', path: ['models', 'replaceDiscovered'], value: models.replaceDiscovered })
  }

  return ops
}

/**
 * The MODEL-ONLY slice of {@link writeOps}.
 *
 * The picker's 应用选择 and the by-id adder commit the moment the operator
 * acts — "选择即激活" — and they must not smuggle in unrelated half-typed
 * scalar edits sitting in the same draft. Emitting only the `models` paths that
 * actually moved is what lets one click save exactly what one click changed.
 *
 * @param {object} clean - the snapshot the form was loaded from.
 * @param {object} draft - the new form state after the model act.
 * @returns {Array<{op: 'set', path: string[], value?: unknown}>} the ops, possibly empty.
 */
export function modelsWriteOps(clean, draft) {
  if (deepEqual(modelsBlockFrom(clean), modelsBlockFrom(draft))) return []
  const models = modelsBlockFrom(draft)
  return [
    { op: 'set', path: ['models', 'disabled'], value: models.disabled },
    { op: 'set', path: ['models', 'extra'], value: models.extra },
    { op: 'set', path: ['models', 'overrides'], value: models.overrides },
    { op: 'set', path: ['models', 'replaceDiscovered'], value: models.replaceDiscovered },
  ]
}

/**
 * Rebuild the draft after a models-only commit: the SERVER's models block plus
 * the operator's still-unsaved scalar typing (including a staged API key).
 *
 * Without this, the commit's re-read would wipe a half-typed baseURL or drop a
 * key staged for the next full save.
 *
 * @param {object} savedForm - `formFromView` of the committed namespace.
 * @param {object} draft - the draft the commit was made from.
 * @returns {object} the new draft.
 */
export function preserveDraftScalars(savedForm, draft) {
  const keys = ['baseURL', 'apiKeyEnv', 'displayName', 'sessionHeader', 'sessionHeaderEnabled', 'sessionHeaderMode', 'sync', 'activeSubscription', 'subscriptions']
  const out = { ...savedForm }
  for (const key of keys) if (draft !== undefined && key in draft) out[key] = draft[key]
  return out
}

/**
 * The `expectedRevision` to send with a write.
 *
 * `undefined` means "write unconditionally", which is the pre-4b behaviour and
 * the right answer only when the page never read a revision. Once a revision is
 * known the page always sends it back, so a second tab's commit is refused
 * instead of silently overwritten.
 */
export function revisionFor(view) {
  return Number.isSafeInteger(view?.revision) ? view.revision : undefined
}

// ── diagnostics / discovery payload readers ────────────────────────────────

/** Unwrap one `{ ok, … }` HTTP payload, throwing the route's own error text. */
export function unwrapPayload(payload) {
  if (!isPlainObject(payload)) throw new Error('响应不是 JSON 对象')
  if (payload.ok === true) return payload
  const code = payload.error?.code ?? 'error'
  const message = payload.error?.message ?? '未知错误'
  const error = new Error(String(message))
  error.code = String(code)
  throw error
}

/** The diagnostics kind this page accepts, so an SPA fallback's HTML is refused. */
export const DIAGNOSTICS_KIND = 'dsh-opencodego/diagnostics'

/**
 * The facts the diagnostics panel renders, defensively read.
 * @param {unknown} payload - `GET /opencode-go-native/diagnostics` body.
 * @returns {{connection: object, catalogue: object, config: object, health: object[], log: object[]}}
 */
export function diagnosticsView(payload) {
  const body = unwrapPayload(payload)
  const diagnostics = isPlainObject(body.diagnostics) ? body.diagnostics : {}
  if (diagnostics.kind !== DIAGNOSTICS_KIND) {
    const error = new Error(`诊断载荷 kind 不是 ${DIAGNOSTICS_KIND}（拿到 ${String(diagnostics.kind)}）`)
    error.code = 'kind-mismatch'
    throw error
  }
  return {
    at: diagnostics.at,
    connection: isPlainObject(diagnostics.connection) ? diagnostics.connection : {},
    configuration: isPlainObject(diagnostics.configuration) ? diagnostics.configuration : {},
    // The subscription rows ride the diagnostics payload too (0.8). Whitelisted
    // explicitly: a field not named here is a field the page cannot see
    // (invariant #6 — the `synced` flag once disappeared exactly this way).
    subscriptions: Array.isArray(diagnostics.subscriptions) ? diagnostics.subscriptions : [],
    catalogue: isPlainObject(diagnostics.catalogue) ? diagnostics.catalogue : {},
    // The runtime declaration layer (0.9.0): where the declared numbers in force
    // were read from. Whitelisted here like everything else the page may show.
    official: isPlainObject(diagnostics.official) ? diagnostics.official : undefined,
    health: Array.isArray(diagnostics.health?.rows) ? diagnostics.health.rows : [],
    unusable: Array.isArray(diagnostics.health?.unusable) ? diagnostics.health.unusable : [],
    summaryLines: Array.isArray(diagnostics.health?.summaryLines) ? diagnostics.health.summaryLines : [],
    log: Array.isArray(diagnostics.log?.lines) ? diagnostics.log.lines : [],
    warnings: Array.isArray(diagnostics.log?.warnings) ? diagnostics.log.warnings : [],
  }
}

/** One model's official defaults, defensively read. */
function defaultsView(raw) {
  const defaults = isPlainObject(raw) ? raw : {}
  return {
    contextWindow: positiveCount(defaults.contextWindow),
    maxTokens: positiveCount(defaults.maxTokens),
    input: stringList(defaults.input),
    reasoning: defaults.reasoning === true,
    reasoningEfforts: stringList(defaults.reasoningEfforts),
  }
}

/**
 * The catalogue payload, defensively read.
 *
 * Both spellings of the endpoint join are accepted: the host answers `defaults`
 * (official facts, no configuration) and `effective` (with the overlay applied),
 * and a payload from an older host that carried only `inputModalities` still
 * yields a usable row rather than a blank one.
 *
 * @param {unknown} payload - `GET /opencode-go-native/models` body.
 * @returns {{source: string, models: object[]}} the view.
 */
export function catalogueView(payload) {
  const body = unwrapPayload(payload)
  const models = Array.isArray(body.models) ? body.models : []
  return {
    source: typeof body.source === 'string' ? body.source : 'draft',
    refreshError: typeof body.refreshError === 'string' && body.refreshError.length > 0
      ? body.refreshError
      : undefined,
    models: models
      .filter((model) => isPlainObject(model) && typeof model.id === 'string' && model.id.length > 0)
      .map((model) => ({
        id: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        protocol: typeof model.protocol === 'string' ? model.protocol : undefined,
        protocolSource: typeof model.protocolSource === 'string' ? model.protocolSource : undefined,
        snapshotKnown: model.snapshotKnown === true,
        // Whether a capability sync has been taken for this id. Read here so the
        // page can refuse to render capability facts it never measured — the
        // field would otherwise be dropped by this whitelist and every row would
        // look unsynced forever.
        synced: model.synced === true,
        // The stored verdict's status ('available' / 'delisted' / …): the row's
        // status dot colors "synced but dead" differently from "synced and
        // usable" without re-asking the gateway. Whitelisted like `synced` or
        // the whitelist would silently drop it (invariant #6).
        syncedStatus: typeof model.syncedStatus === 'string' && model.syncedStatus.length > 0
          ? model.syncedStatus
          : undefined,
        defaults: defaultsView(model.defaults),
        effective: isPlainObject(model.effective)
          ? model.effective
          : {
            contextWindow: undefined,
            maxTokens: undefined,
            input: stringList(model.inputModalities),
            reasoning: false,
            reasoningEfforts: [],
          },
      })),
  }
}

/**
 * The placeholder text for one capacity field: the number that is in EFFECT
 * for this model right now (bundled model state plus saved corrections), so an
 * empty input reads as what the route will actually use.
 *
 * @param {number | undefined} value - the default count.
 * @param {string} fallback - text shown when no default is known.
 * @returns {string} the placeholder.
 */
export function capacityPlaceholder(value, fallback) {
  return positiveCount(value) === undefined ? fallback : `当前生效 ${String(value)}`
}

/** The placeholder for the input-modality row of one model. */
export function modalityPlaceholder(defaults) {
  const input = stringList(defaults?.input)
  return input.length === 0 ? '默认' : `当前生效：${input.join(' + ')}`
}

// ── how a model's OFFICIAL facts are shown ─────────────────────────────────

/**
 * Compact rendering of a token count: `1000000` → `1M`, `384000` → `384K`,
 * `202752` → `203K`, `128` → `128`.
 *
 * The catalog publishes decimal limits (202752 is "200K class"), so the page
 * rounds at 1000, matching how every official model list writes these numbers.
 * @param {number | undefined} value - a positive count, or nothing.
 * @returns {string | undefined} the label.
 */
export function formatTokenCount(value) {
  const count = positiveCount(value)
  if (count === undefined) return undefined
  if (count >= 1_000_000) {
    const millions = count / 1_000_000
    return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1)}M`
  }
  if (count >= 1000) return `${String(Math.round(count / 1000))}K`
  return String(count)
}

/**
 * The capability chips one row (or one picker candidate) shows WITHOUT being
 * expanded — the answer to "the facts are blank unless you dig".
 *
 * The input is one `catalogueView(...).models` entry: `protocol` is this
 * route's own dispatch decision (model-state npm rule + overrides), and the
 * numbers shown are the model's EFFECTIVE facts — what dsh will actually load
 * for it right now (the plugin's bundled model state plus the operator's
 * corrections, or the conservative defaults where nobody has corrected
 * anything). Two sources and no more: the gateway's list decides which models
 * exist, the plugin's state decides these numbers; models.dev is not consulted
 * at runtime.
 *
 * @param {object} model - one catalogue/draft candidate view.
 * @returns {Array<{tone: string, label: string}>} chips in display order.
 */
export function capabilityChips(model) {
  const chips = []
  const protocol = typeof model?.protocol === 'string' ? model.protocol : undefined
  if (protocol !== undefined) chips.push({ tone: 'proto', label: protocol })
  const facts = effectiveFactsOf(model)
  const context = formatTokenCount(facts.contextWindow)
  if (context !== undefined) chips.push({ tone: 'cap', label: `上下文 ${context}` })
  const output = formatTokenCount(facts.maxTokens)
  if (output !== undefined) chips.push({ tone: 'cap', label: `输出 ${output}` })
  const input = stringList(facts.input)
  if (input.length > 0) chips.push({ tone: 'mod', label: `输入 ${input.join('+')}` })
  const efforts = stringList(facts.reasoningEfforts)
  if (facts.reasoning === true) {
    chips.push({ tone: 'mod', label: efforts.length > 0 ? `思考 ${efforts.join('/')}` : '思考' })
  }
  return chips
}

/** The numbers a row shows as "what an empty field means": EFFECTIVE facts first. */
function effectiveFactsOf(model) {
  if (isPlainObject(model?.effective)) return model.effective
  if (isPlainObject(model?.defaults)) return model.defaults
  return {}
}

/**
 * The one-line provenance of the numbers the page is showing. Static copy:
 * it names the sources, so no payload about a third party is needed.
 *
 * 0.9.0 changed what is true here: the declared numbers are no longer a
 * release-time snapshot the page must not mention — they are read live from
 * models.dev whenever the bundled copy cannot answer (and re-read on a TTL), so
 * the line says where they come from and what happens when the read fails.
 * @returns {string} the hint text.
 */
export function modelSourceLine() {
  return '模型名单来自网关 /models；能力值优先取 models.dev 的最新声明（运行期同步，失败时回退到插件内置数据），未校正的用保守默认。'
}

/**
 * The provenance of the DECLARED numbers, as one line for the diagnostics panel.
 *
 * 0.9.0 split the declaration face in two — a bundled release-time file and a
 * runtime layer that reads the same upstream files live — so "where did this
 * number come from" stopped being answerable from the version alone. This is
 * that answer: how many records each layer holds, what upstream had nothing for,
 * what could not be read, and whether the base is currently known to be down.
 *
 * @param {object | undefined} view - the diagnostics payload's `official` block.
 * @returns {string} the line.
 */
export function officialSourceText(view) {
  if (!isPlainObject(view)) return '（宿主没有报告运行时数据层）'
  const parts = [
    `内置 ${Number.isFinite(view.bundled) ? String(view.bundled) : '?'} 条`,
    `运行期 ${Number.isFinite(view.runtime) ? String(view.runtime) : '?'} 条`,
  ]
  if (typeof view.lastSuccessAt === 'string') parts.push(`上次成功 ${view.lastSuccessAt}`)
  const absent = stringList(view.absent)
  if (absent.length > 0) parts.push(`上游未收录：${absent.join('、')}`)
  const failed = (Array.isArray(view.failed) ? view.failed : [])
    .map((entry) => (isPlainObject(entry) ? entry.id : entry))
    .filter((id) => typeof id === 'string' && id.length > 0)
  if (failed.length > 0) parts.push(`读取失败：${failed.join('、')}`)
  if (typeof view.baseDownUntil === 'string') parts.push(`上游暂不可达（重试于 ${view.baseDownUntil}）`)
  if (typeof view.lastError === 'string' && view.lastError.length > 0) parts.push(`最近错误：${view.lastError}`)
  if (typeof view.writeError === 'string' && view.writeError.length > 0) parts.push(`缓存写入失败：${view.writeError}`)
  return parts.join(' · ')
}

// ── capability sync ─────────────────────────────────────────────────────────

/**
 * The ids a sync should visit: every model currently enabled, in the order the
 * page shows them, each once.
 *
 * A sync is a per-model question to the gateway, so it is scoped to what the
 * operator actually enabled — not to everything the gateway advertises, which
 * would spend requests on models nobody is using.
 *
 * @param {readonly {id?: unknown}[]} rows - the directory rows.
 * @returns {string[]} the ids to sync.
 */
export function syncTargetIds(rows) {
  const out = []
  for (const row of rows ?? []) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id.length > 0 && !out.includes(id)) out.push(id)
  }
  return out
}

/** Tone + text for one sync outcome. The tone is what the row paints. */
export function describeSync(result) {
  if (result === undefined) return undefined
  if (result.available !== true) {
    const delisted = result.status === 'delisted'
    return {
      tone: delisted ? 'bad' : 'warn',
      headline: delisted ? '已下架' : result.status === 'gated' ? '不可用（门控）' : '不可用',
      detail: result.reason ?? '网关没有给出原因',
      replace: true,
    }
  }
  const facts = []
  if (result.protocol?.chosen !== undefined) {
    facts.push(`协议 ${result.protocol.chosen}${result.protocol.verified === true ? '' : '（非推荐，推荐的那个不可用）'}`)
  }
  const context = formatTokenCount(result.contextWindow)
  if (context !== undefined) facts.push(`上下文 ${context}`)
  const output = formatTokenCount(result.maxTokens)
  if (output !== undefined) facts.push(`输出 ${output}`)
  const input = stringList(result.input)
  if (input.length > 0) facts.push(`输入 ${input.join('+')}`)
  const levels = Object.keys(result.reasoning?.levels ?? {})
  if (result.reasoning !== undefined) {
    const off = result.reasoning.hasOff === true ? 'off/' : ''
    facts.push(levels.length > 0 ? `思考 ${off}${levels.join('/')}` : '思考 无档位')
  }
  return {
    tone: 'ok',
    headline: '可用',
    detail: facts.length > 0 ? facts.join(' · ') : '网关接受该模型的请求',
    replace: false,
    // Shown so a surprising result can be explained rather than argued with.
    note: result.reasoning?.declaredContractWorks === false
      ? '官方契约有档位被网关拒绝，已改成实测能用的档位'
      : undefined,
  }
}

/**
 * The progress sentence for an in-flight sync.
 *
 * It reports what has FINISHED and what is IN FLIGHT separately, and includes
 * elapsed seconds. The first version printed `done + 1` as the headline, which
 * sat on the same number for the whole of a slow model and read as frozen while
 * the sync was in fact progressing.
 *
 * @param {object} state - the sync state.
 * @param {number} [now] - the clock, so the caller owns the tick.
 * @returns {string | undefined} the sentence, or `undefined` when idle.
 */
export function syncProgressText(state, now) {
  if (state?.busy !== true) return undefined
  const total = Number.isSafeInteger(state.total) ? state.total : 0
  const done = Number.isSafeInteger(state.done) ? state.done : 0
  const current = typeof state.current === 'string' && state.current.length > 0 ? state.current : undefined
  const clock = Number.isFinite(now) ? now : Date.now()
  const startedAt = Number.isFinite(state.startedAt) ? state.startedAt : clock
  const seconds = Math.max(0, Math.round((clock - startedAt) / 1000))
  const parts = [`已完成 ${done}/${total}`]
  if (current !== undefined) parts.push(`正在处理 ${current}`)
  parts.push(`已用 ${seconds}s`)
  return parts.join(' · ')
}

/**
 * What to offer in place of a model that came back unavailable.
 *
 * The point of a sync is not only to record facts but to stop an operator
 * quietly using an id that no longer works, so an unavailable row suggests a
 * concrete alternative rather than only reporting the failure.
 *
 * @param {{id?: unknown}[]} rows - the directory rows.
 * @param {Record<string, object>} results - sync results by id.
 * @returns {Record<string, string>} unavailable id -> a working id to suggest.
 */
export function replacementSuggestions(rows, results) {
  const working = []
  for (const row of rows ?? []) {
    const id = typeof row?.id === 'string' ? row.id : undefined
    if (id === undefined) continue
    if (results?.[id]?.available === true) working.push(id)
  }
  const out = {}
  for (const row of rows ?? []) {
    const id = typeof row?.id === 'string' ? row.id : undefined
    if (id === undefined) continue
    const result = results?.[id]
    if (result === undefined || result.available === true) continue
    const alternative = working.find((candidate) => candidate !== id)
    if (alternative !== undefined) out[id] = alternative
  }
  return out
}
