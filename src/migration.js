/**
 * The one-time move of a LEGACY plain-text token out of the settings document.
 *
 * Before 0.6.0 this plugin offered an inline `apiKey` field and stored the token
 * verbatim in `~/.dsh/settings.yaml`. That is a configuration file: it is read
 * by every surface that renders settings, copied by hand, and backed up by
 * anything that touches the harness home — none of which should ever hold a
 * bearer token. The field is gone from the page; this module is what happens to
 * a document that already carries one.
 *
 * The decision is pure and the effect is injected, for the same reason
 * `credential.js` is built that way: the repository has no `node_modules`, so
 * anything importing `@deepseek-ai/dsh-*` at module scope cannot run under bare
 * `node --test`. `tests/migration.test.mjs` therefore drives every branch —
 * including the two that must NOT delete the token (a store that refuses the
 * write, and a composition with no credential plane at all) — against fakes.
 *
 * @module dsh-opencodego/migration
 */

import { PKG } from './vocab.js'

/**
 * The legacy inline token one stored user section still carries.
 *
 * A blank or whitespace-only value is absent: it is what a cleared form field
 * looks like after a save, and treating it as a token would both store nothing
 * and delete the field for no reason.
 *
 * @param {unknown} userSection - the RAW user layer of this plugin's namespace.
 * @returns {string | undefined} the trimmed token, or `undefined`.
 */
export function legacyApiKeyOf(userSection) {
  if (typeof userSection !== 'object' || userSection === null || Array.isArray(userSection)) return undefined
  const value = userSection.apiKey
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Decide what the migration should do, without doing anything.
 *
 * @param {object} args - the facts.
 * @param {unknown} args.userSection - the raw stored user layer.
 * @param {string} [args.reference] - the credential reference the route names.
 * @param {string} args.defaultReference - the reference to fall back to.
 * @returns {{action: 'none'} | {action: 'migrate', reference: string, value: string} | {action: 'keep', reason: string}}
 *   the plan.
 */
export function planLegacyApiKeyMigration({ userSection, reference, defaultReference }) {
  const value = legacyApiKeyOf(userSection)
  if (value === undefined) return { action: 'none' }
  const named = typeof reference === 'string' && reference.trim().length > 0
    ? reference.trim()
    : defaultReference
  if (typeof named !== 'string' || named.trim().length === 0) {
    return { action: 'keep', reason: 'no credential reference is configured to store the token under' }
  }
  return { action: 'migrate', reference: named.trim(), value }
}

/**
 * Run {@link planLegacyApiKeyMigration} against the live credential and settings
 * seams.
 *
 * The settings field is unset only after the credential is known to resolve, and
 * a store that refuses the write leaves the plain text in place rather than
 * deleting the operator's only copy of the token. The caller keeps serving
 * either way: `credential.js` still reads the legacy value as a last resort.
 *
 * @param {object} args - the operation.
 * @param {unknown} args.userSection - the raw stored user layer.
 * @param {string} [args.reference] - the credential reference the route names.
 * @param {string} args.defaultReference - the reference to fall back to.
 * @param {object|undefined} args.credentials - `ctx.get('credentials')`.
 * @param {(name: string) => unknown} args.credentialRef - the host brand function.
 * @param {(ops: object[]) => Promise<unknown>} args.mutateSettings - unsets `apiKey` on this namespace.
 * @param {(level: 'info' | 'warn' | 'error', message: string) => void} [args.log] - the plugin's log sink.
 * @returns {Promise<{action: 'none' | 'migrated' | 'stored' | 'kept', reference?: string, reason?: string}>} the outcome.
 */
export async function runLegacyApiKeyMigration({
  userSection,
  reference,
  defaultReference,
  credentials,
  credentialRef,
  mutateSettings,
  log,
}) {
  const plan = planLegacyApiKeyMigration({ userSection, reference, defaultReference })
  if (plan.action === 'none') return { action: 'none' }
  if (plan.action === 'keep') {
    log?.('warn', `a legacy plain-text "apiKey" is stored in the settings document, but it cannot be migrated: ${plan.reason}`)
    return { action: 'kept', reason: plan.reason }
  }
  if (credentials === undefined) {
    const reason = 'the composition has no credentials service to store the token in'
    log?.('warn', `a legacy plain-text "apiKey" is stored in the settings document, but it cannot be migrated: ${reason}`)
    return { action: 'kept', reason }
  }

  let branded
  try {
    branded = credentialRef(plan.reference)
  } catch (error) {
    const reason = `"${plan.reference}" is not a valid credential reference (${error?.message ?? String(error)})`
    log?.('warn', `${PKG}: cannot migrate the legacy plain-text "apiKey": ${reason}`)
    return { action: 'kept', reason }
  }

  // Store only when the reference does not already resolve: overwriting a
  // credential the operator stored deliberately with an older plain-text copy
  // would be a silent downgrade.
  let stored = false
  try {
    const info = await credentials.describe(branded)
    if (info?.configured !== true) {
      await credentials.set(branded, plan.value)
      stored = true
    }
  } catch (error) {
    // `set` legitimately refuses while a READ-ONLY source shadows the reference
    // (an exported environment variable, a `.env` file). That is not a failure
    // to migrate: the reference already resolves, so the plain text is redundant
    // and safe to remove. Anything else leaves the token alone.
    const shadowed = await credentials.resolve(branded).then(
      (hit) => hit !== undefined,
      () => false,
    )
    if (!shadowed) {
      const reason = error?.message ?? String(error)
      log?.('warn', `${PKG}: cannot migrate the legacy plain-text "apiKey" into "${plan.reference}": ${reason}`)
      return { action: 'kept', reason }
    }
  }

  try {
    await mutateSettings([{ op: 'unset', path: ['apiKey'] }])
  } catch (error) {
    const reason = error?.message ?? String(error)
    log?.('warn', `${PKG}: the token is now in "${plan.reference}", but the plain-text "apiKey" could not be removed from the settings document: ${reason}`)
    return { action: stored ? 'stored' : 'kept', reference: plan.reference, reason }
  }

  log?.(
    'info',
    `${PKG}: migrated the legacy plain-text "apiKey" into the credential reference "${plan.reference}" `
    + 'and removed it from the settings document',
  )
  return { action: 'migrated', reference: plan.reference }
}

/**
 * Bind {@link runLegacyApiKeyMigration} to a plugin's live services, with the
 * once-only and service-arrival semantics the loader needs.
 *
 * `dsh web` activates plugins and services asynchronously, so the first call can
 * legitimately run before the settings or credential plane exists. The returned
 * runner therefore:
 *
 *   - reports `deferred` (and leaves itself armed) when either service is
 *     missing, so whichever arrives later can call it again;
 *   - reports `skipped` once it has actually settled, so a settings change the
 *     migration itself emits cannot re-enter it;
 *   - reads the reference from the CURRENT resolved facts at call time, so a
 *     settings edit that renames `apiKeyEnv` before the migration still stores
 *     the token under the name the operator chose.
 *
 * Extracted from `index.js` on purpose: this is the part of the trigger that can
 * be wrong (order, re-entry, deferral) and `index.js` imports host packages, so
 * keeping it here is what lets `tests/migration.test.mjs` drive it.
 *
 * @param {object} deps - the wiring.
 * @param {(name: string) => object | undefined} deps.getService - reads one live cordis service.
 * @param {() => { apiKeyEnv?: string }} deps.options - the current resolved connection facts.
 * @param {string} deps.defaultReference - the reference to fall back to.
 * @param {() => Promise<(name: string) => unknown>} deps.credentialRefOf - lazily loads the host brand function.
 * @param {string} deps.ns - the settings namespace to read and edit.
 * @param {(level: 'info' | 'warn' | 'error', message: string) => void} [deps.log] - the plugin's log sink.
 * @returns {() => Promise<{action: string, reference?: string, reason?: string}>} the runner.
 */
export function createLegacyKeyMigrationRunner({
  getService,
  options,
  defaultReference,
  credentialRefOf,
  ns,
  log,
}) {
  let settled = false
  return async function runLegacyKeyMigration() {
    if (settled) return { action: 'skipped' }
    const settings = getService('settings')
    const credentials = getService('credentials')
    if (settings === undefined || credentials === undefined) return { action: 'deferred' }
    // Claimed BEFORE the first await: the settings write below emits a change
    // that re-enters this runner through the plugin's `onChange` hook.
    settled = true

    let userSection
    try {
      const described = settings.describe()
      userSection = Array.isArray(described) ? described.find((entry) => entry.ns === ns)?.user : undefined
    } catch (error) {
      const reason = error?.message ?? String(error)
      log?.('warn', `could not read the stored settings section to check for a legacy plain-text "apiKey": ${reason}`)
      return { action: 'kept', reason }
    }

    try {
      return await runLegacyApiKeyMigration({
        userSection,
        reference: options()?.apiKeyEnv,
        defaultReference,
        credentials,
        credentialRef: await credentialRefOf(),
        mutateSettings: (ops) => settings.mutate(ns, ops, undefined),
        log,
      })
    } catch (error) {
      const reason = error?.message ?? String(error)
      log?.('warn', `${PKG}: legacy "apiKey" migration failed: ${reason}`)
      return { action: 'kept', reason }
    }
  }
}
