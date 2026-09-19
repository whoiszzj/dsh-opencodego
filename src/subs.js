/**
 * The SUBSCRIPTION layer: N OpenCode Go subscriptions (API keys) behind the one
 * route this plugin owns.
 *
 * A subscription is a **name and a key, and nothing else**. The gateway address,
 * the model catalogue, the protocol rules and the synced capabilities are
 * ROUTE-WIDE facts shared by every subscription: a measurement taken with one
 * key describes the gateway, not the account. What is per-subscription is the
 * credential (its own `GET {baseURL}/usage` balance is answered per key) — and
 * that is all the plugin asks of it.
 *
 * EXACTLY ONE subscription is ACTIVE at a time. There is no pool, no automatic
 * rotation and no failover: switching is an OPERATOR act (one click in the
 * settings list), and it is a SETTINGS write — the request path resolves exactly
 * one key slot, so "who pays" is one pointer read.
 *
 * The key never enters the settings document. Each subscription owns ONE
 * STORAGE SLOT, NAMED AFTER THE SUBSCRIPTION ITSELF — `me@example.com` →
 * `OPENCODE_GO_ME_EXAMPLE_COM` — so the credential store is readable on
 * its own and two accounts can never be confused. A row the operator has not
 * named falls back to the stable id-derived spelling
 * (`refForSubscriptionId`), which is also kept as the read fallback for a row
 * whose name changed: a rename moves the slot, and the runtime moves the key
 * with it (`subruntime#reconcile`) instead of losing it.
 *
 * Beside those per-row slots there is ONE LIVE SLOT: the top-level `apiKeyEnv`
 * (shipped as `OPENCODE_GO_API_KEY`). It is the single variable the rest of the
 * harness can see, and the runtime keeps it pointed at whichever row is ACTIVE
 * by copying that row's stored value into it (`subruntime#reconcile`). So the
 * operator's mental model holds literally: N keys sit in N named slots, and
 * selecting a row makes the selected key the one in the live variable.
 *
 * Per-row slots are why deleting a row never has to be a lossy act, and why
 * `default` — a row synthesized from the top-level fields BEFORE this design —
 * could acquire a slot of its own without renaming anybody else's.
 *
 * This module has no host imports: the normalization and the active-pointer
 * resolution are unit-tested with a bare `node --test`.
 *
 * @module dsh-opencodego/subs
 */

import { PKG } from './vocab.js'

/** The reserved id of the subscription synthesized from the legacy top-level fields. */
export const DEFAULT_SUB_ID = 'default'

/** What the synthesized `default` subscription is called when nothing names it. */
export const DEFAULT_SUB_LABEL = '默认'

/** The label length ceiling, mirrored loosely in client/vocab.js. */
export const SUBSCRIPTION_LABEL_MAX = 60

/** The quota windows the gateway reports, in display order. Mirrored in client/vocab.js. */
export const USAGE_WINDOW_KEYS = Object.freeze(['rolling', 'weekly', 'monthly'])

/** A subscription id: stable, path-safe, bounded. Mirrored in client/vocab.js. */
export const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/**
 * A credential reference: a POSIX environment-variable name, exactly what
 * `@deepseek-ai/dsh-credentials`'s `credentialRef` brands. Every DERIVED slot
 * name satisfies this, which is what makes "derive it from the id" safe.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Keys one stored `subscriptions[]` entry may name. Mirrored in client/vocab.js.
 *
 * Deliberately THREE: an id (internal, stable, the address the active pointer
 * uses), a label (the name the operator sees), and `hidden` — which in practice
 * only the reserved `default` entry carries, because that row is SYNTHESIZED
 * from the top-level fields and cannot be removed by deleting an entry. Deleting
 * it in the UI therefore means hiding it (`{ id: 'default', hidden: true }`), and
 * the credential slot it names survives: only the ROW goes away.
 *
 * A field reappearing here is a knob the single-active redesign removed — a
 * per-key gateway address, a balance cap, an enable flag, or a hand-written
 * credential slot that could drift from the derived one.
 */
export const SUBSCRIPTION_ENTRY_KEYS = Object.freeze(['id', 'label', 'hidden'])

/**
 * The reference-safe slug of a subscription NAME: `me@example.com` →
 * `ME_EXAMPLE_COM`.
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
 * The credential slot one subscription NAME addresses — that row's OWN storage.
 *
 * Named after the subscription itself (usually the account's email), so an
 * operator reading `.credentials.yaml` can tell which key is which without
 * consulting the settings document. `undefined` for a name with no usable
 * character (an unlabelled row, a fresh install), where the caller falls back to
 * the id-derived spelling.
 *
 * @param {string} label - the subscription name.
 * @returns {string | undefined} e.g. `OPENCODE_GO_ME_EXAMPLE_COM`.
 */
export function refForSubscriptionLabel(label) {
  const slug = subscriptionSlug(label)
  return slug.length === 0 ? undefined : `OPENCODE_GO_${slug}`
}

/**
 * The credential slot one subscription id addresses — the LEGACY spelling.
 *
 * Ids are opaque (`sub-2`) or was the address in 0.8.2/0.8.3, so this is kept
 * for two jobs: it is the read FALLBACK for a key stored under the old spelling,
 * and it is what makes a RENAME survivable — a renamed row's new name-slug is
 * empty, the stable id-derived slot still holds the key, and the runtime copies
 * it across.
 *
 * @param {string} id - a validated subscription id (including `default`).
 * @returns {string} e.g. `work` → `OPENCODE_GO_WORK`.
 */
export function refForSubscriptionId(id) {
  return `OPENCODE_GO_${String(id).toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`
}

/**
 * Normalize one entry of the configured `subscriptions` array.
 *
 * The entry for the reserved id `default` PATCHES the synthesized default
 * rather than replacing it: the legacy top-level fields stay the base (every
 * pre-0.8.0 document keeps working untouched), and an operator who renames the
 * default subscription addresses it by id instead of discovering a second
 * spelling of "the old fields".
 *
 * @param {object} raw - one stored entry.
 * @param {number} index - position, for the error path.
 * @returns {{ id: string, label: string | undefined, hidden: boolean }} the entry facts.
 */
function normalizeEntry(raw, index) {
  const entry = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const path = `subscriptions[${String(index)}]`
  for (const key of Object.keys(entry)) {
    if (!SUBSCRIPTION_ENTRY_KEYS.includes(key)) {
      throw new Error(`${PKG}: ${path} names unknown key "${key}" (allowed: ${SUBSCRIPTION_ENTRY_KEYS.join(', ')})`)
    }
  }
  const id = entry.id === undefined ? undefined : String(entry.id).trim()
  if (id === undefined || id.length === 0) {
    throw new Error(`${PKG}: ${path}.id must name the subscription (letters, digits, "-" and "_", up to 40 chars)`)
  }
  if (!SUBSCRIPTION_ID_PATTERN.test(id)) {
    throw new Error(`${PKG}: ${path}.id "${id}" is not a valid subscription id (allowed: A-Z a-z 0-9 _ -, 1-40 characters)`)
  }
  const label = typeof entry.label === 'string' && entry.label.trim().length > 0
    ? entry.label.trim()
    : undefined
  if (label !== undefined && label.length > SUBSCRIPTION_LABEL_MAX) {
    throw new Error(`${PKG}: ${path}.label is longer than ${String(SUBSCRIPTION_LABEL_MAX)} characters`)
  }
  if (entry.hidden !== undefined && typeof entry.hidden !== 'boolean') {
    throw new Error(`${PKG}: ${path}.hidden must be true or false (got: ${String(entry.hidden)})`)
  }
  return { id, label, hidden: entry.hidden === true }
}

/**
 * Resolve the configured subscription list against the live top-level facts.
 *
 * The list is ALWAYS non-empty: the implicit `default` subscription carries the
 * legacy top-level fields (its label from `displayName`, and therefore its slot
 * from that name too), and configured entries follow in configured order. An
 * entry with id `default` patches that first entry rather than adding a second
 * one. List order is display order — it no longer means priority, because
 * exactly one subscription is active. Rows marked `hidden` are dropped from the
 * resolved list; the caller must leave at least one visible.
 *
 * @param {unknown} raw - the stored `subscriptions` array.
 * @param {object} facts - resolved top-level connection facts.
 * @param {string} [facts.apiKeyEnv] - the LIVE credential reference (the one
 *   variable the harness and the request fallback read).
 * @param {string} [facts.displayName] - the legacy display name.
 * @returns {object[]} frozen, ordered, validated subscriptions.
 */
export function normalizeSubscriptions(raw, facts) {
  const legacyLabel = typeof facts?.displayName === 'string' && facts.displayName.trim().length > 0
    ? facts.displayName.trim()
    : undefined
  const liveRef = typeof facts?.apiKeyEnv === 'string' && facts.apiKeyEnv.trim().length > 0
    ? facts.apiKeyEnv.trim()
    : undefined
  if (liveRef === undefined) {
    throw new Error(`${PKG}: no live credential reference — set the top-level apiKeyEnv `
      + '(the one variable the route mirrors the active subscription into)')
  }
  const defaultSub = {
    id: DEFAULT_SUB_ID,
    label: legacyLabel ?? DEFAULT_SUB_LABEL,
    // The default row's OWN slot is named after the row, exactly like every
    // other row's — the live slot is a projection on top of it, not a place a
    // key can live (selecting any other row overwrites it).
    apiKeyRef: refForSubscriptionLabel(legacyLabel ?? DEFAULT_SUB_LABEL)
      ?? refForSubscriptionId(DEFAULT_SUB_ID),
    fallbackRefs: [refForSubscriptionId(DEFAULT_SUB_ID)],
    isDefault: true,
    hidden: false,
  }
  const list = [defaultSub]
  const byId = new Map([[DEFAULT_SUB_ID, defaultSub]])
  const entries = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw) && raw !== undefined && raw !== null) {
    throw new Error(`${PKG}: subscriptions must be an array of { id, label } entries`)
  }
  entries.forEach((rawEntry, index) => {
    const entry = normalizeEntry(rawEntry, index)
    const existing = byId.get(entry.id)
    if (existing !== undefined) {
      if (entry.id !== DEFAULT_SUB_ID) {
        throw new Error(`${PKG}: subscriptions[${String(index)}].id "${entry.id}" repeats an earlier subscription`)
      }
      // The reserved id patches the synthesized default: a name override and/or
      // the `hidden` marker, with everything unsaid inherited. A renamed default
      // row moves its slot with the name; the id-derived spelling stays behind
      // as the fallback, so the key is not stranded by the rename.
      if (entry.label !== undefined) {
        existing.label = entry.label
        existing.apiKeyRef = refForSubscriptionLabel(entry.label)
          ?? refForSubscriptionId(DEFAULT_SUB_ID)
      }
      if (entry.hidden === true) existing.hidden = true
      return
    }
    const label = entry.label ?? entry.id
    const row = {
      id: entry.id,
      label,
      apiKeyRef: refForSubscriptionLabel(label) ?? refForSubscriptionId(entry.id),
      fallbackRefs: [refForSubscriptionId(entry.id)],
      isDefault: false,
      hidden: entry.hidden === true,
    }
    byId.set(entry.id, row)
    list.push(row)
  })

  // A row somebody deleted from the list. Hiding the default row is how that row
  // goes away at all (it is synthesized from the top-level fields, so there is no
  // entry to remove), and the credential slot it names is deliberately left
  // alone: the operator removed a ROW, not a secret.
  const visible = list.filter((sub) => sub.hidden !== true)
  if (visible.length === 0) {
    throw new Error(`${PKG}: every subscription is hidden — the route needs at least one to pay for a request`)
  }

  // Two subscriptions may not share one credential slot: the page would show two
  // rows listing one key, and deleting either would silently break the other.
  // Since the slot is named after the subscription, a collision means two rows
  // carrying the same NAME (or the same id, already refused above) — the typo or
  // the duplicate the operator has to fix. Only VISIBLE rows are checked: a
  // hidden row cannot serve a request, so it cannot collide with anything.
  const refs = new Map()
  for (const sub of visible) {
    const owner = refs.get(sub.apiKeyRef)
    if (owner !== undefined) {
      throw new Error(`${PKG}: subscriptions "${owner}" and "${sub.id}" would share the credential slot `
        + `"${sub.apiKeyRef}" — two rows with the same name share one key store; give one of them another name`)
    }
    refs.set(sub.apiKeyRef, sub.id)
  }

  // A row's OWN slot must not BE the live slot: the runtime overwrites the live
  // slot with the active row's value, so a row storing its key there would have
  // it replaced by the next switch — a silent data loss dressed up as a working
  // configuration. A name can hit this (`api key` → `OPENCODE_GO_API_KEY` when
  // the live slot is the shipped default), and it is refused by name.
  const clashing = visible.find((sub) => sub.apiKeyRef === liveRef)
  if (clashing !== undefined) {
    throw new Error(`${PKG}: subscription "${clashing.label}" derives the credential slot "${clashing.apiKeyRef}", `
      + `which is the top-level apiKeyEnv (the LIVE slot the route writes the active key into). `
      + 'Rename that subscription, or point apiKeyEnv at another reference.')
  }

  // Only the VISIBLE rows reach the rest of the plugin: a hidden row has no
  // request path, so it is not in the list the adapter sees, and the active
  // pointer's unknown-id fallback handles "somebody hid the default row".
  return Object.freeze(visible.map((sub) => {
    const resolved = {
      id: sub.id,
      label: sub.label,
      apiKeyRef: sub.apiKeyRef,
      isDefault: sub.isDefault === true,
    }
    // The legacy spellings this row's key may still be stored under, for the
    // request path to try before declaring the row keyless. Never the primary,
    // never the live slot.
    const fallbacks = [...new Set(sub.fallbackRefs ?? [])]
      .filter((ref) => ref !== sub.apiKeyRef && ref !== liveRef)
    if (fallbacks.length > 0) resolved.fallbackRefs = Object.freeze(fallbacks)
    return Object.freeze(resolved)
  }))
}

/**
 * The id of the subscription a request should bill.
 *
 * The stored pointer is a single scalar, which is what makes "only one may be
 * enabled" unfalsifiable: there is no second boolean that could disagree with
 * it. An unknown or absent id falls back to the FIRST VISIBLE subscription, so a
 * document whose `activeSubscription` names a row somebody deleted — or the
 * default row somebody hid — still resolves to a working route instead of
 * failing every request.
 *
 * @param {readonly object[]} list - the resolved subscriptions.
 * @param {unknown} rawActive - the stored `activeSubscription`.
 * @returns {string} an id that exists in `list`.
 */
export function resolveActiveSubscription(list, rawActive) {
  const wanted = typeof rawActive === 'string' ? rawActive.trim() : ''
  if (wanted.length > 0 && list.some((sub) => sub.id === wanted)) return wanted
  return list[0]?.id ?? DEFAULT_SUB_ID
}

/**
 * The active subscription itself.
 *
 * @param {readonly object[]} list - the resolved subscriptions.
 * @param {unknown} rawActive - the stored `activeSubscription`.
 * @returns {object} the active entry.
 */
export function activeSubscriptionOf(list, rawActive) {
  const id = resolveActiveSubscription(list, rawActive)
  return list.find((sub) => sub.id === id) ?? list[0]
}
