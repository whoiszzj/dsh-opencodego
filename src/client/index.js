/**
 * Browser-half entry: the cordis plugin the web loader materializes.
 *
 * Exports exactly what cordis loading needs and nothing else (`inject` +
 * `apply`), per the module-loading contract the host's `dsh-client-modules`
 * service composes. The bundle is produced by `scripts/build-client.mjs`; this
 * file's imports are inlined at build time and `react` stays an external the
 * loader's static table answers (see that script's header).
 *
 * Two data faces, deliberately different — in BOTH transport and envelope:
 *
 *   - **settings** ride the official Remote pipeline (`ctx.remote.settings`),
 *     so writes go through the same validate → persist → publish path every
 *     other configuration surface uses, and a rejection arrives as a
 *     `settings/rejected` / `settings/conflict` failure with the host's own
 *     message. Every Remote method resolves a `RemoteResult` envelope, which
 *     {@link unwrapRemote} is the only place that unwraps;
 *   - **credentials** ride the official `ctx.remote.credentials` namespace, the
 *     same one the official Models page writes. The API key never touches the
 *     settings document: the settings write records only the reference NAME, and
 *     the value goes to the credential provider (the launch environment, or
 *     `$DSH_HOME/.credentials.yaml`);
 *   - **diagnostics and the model catalogue** ride this plugin's own read-only
 *     HTTP route (`GET/POST /opencode-go-native/…`), because a browser half
 *     cannot import a host module and the discovery draft has no Remote yet.
 *     Those answer FLAT (`{ ok: true, models }`) and ride
 *     `./logic.js#unwrapPayload` instead — the two shapes are not
 *     interchangeable, which is what made the settings page blank.
 *
 * @module dsh-opencodego/client
 */

import { OpenCodeGoSection } from './section.js'
import { describeFailure } from './logic.js'
import { SETTINGS_NS } from './vocab.js'

/**
 * Services this fiber waits for.
 *
 * `remote.settings` is spelled with its DOT because that is the service's
 * actual cordis name, not a nested property of `remote`: the gateway half
 * mounts one `RemoteNamespaceService` per generated namespace via
 * `super(ctx, 'remote.' + namespace)` (see
 * `@deepseek-ai/dsh-api-gateway/lib/client.js`, `remoteServiceKey` +
 * `RemoteNamespaceService`). Cordis's traceable proxy only forwards a
 * `remote.<sub>` read onto the context when the FULL dotted key was
 * injected (`vendor/cordis/src/utils.ts`: `ctx.reflect.props[
 * `${associate}.${prop}` ]`), so declaring `'remote'` alone answers
 * `ctx.remote.$host`/`$on`/`$mount` but makes `ctx.remote.settings` throw
 * `cannot get property "remote.settings" without inject`.
 *
 * Injecting it does not park this fiber: `dsh-api-remotes` (the client
 * assembly that owns every `remote.<ns>`) awaits all of `$mount` before its
 * own `apply` resolves, and cordis holds dependents until an injected
 * service is ACTIVE. `$host`/`$on`/`$mount` live on the `remote` service
 * object itself, which is why `'remote'` stays declared alongside it.
 *
 * `remote.credentials` is declared for the same reason `remote.settings` is: it
 * is its own generated namespace service, and the API-key field writes through
 * it so the token reaches the credential provider instead of the settings
 * document.
 */
export const inject = ['remote', 'remote.credentials', 'remote.settings', 'slots']

/**
 * Unwrap one host Remote answer: `RemoteResult<T>` is a discriminated
 * envelope, `{ ok: true, value }` or `{ ok: false, error }`, NOT the bare
 * business value (`@deepseek-ai/dsh-typert-protocol`, `RemoteResult`). This
 * is a DIFFERENT envelope from this plugin's own HTTP routes, which answer
 * flat (`{ ok: true, diagnostics }` / `{ ok: true, models }`): those already
 * ride `./logic.js#unwrapPayload`, and conflating the two is exactly the bug
 * this function exists to stop repeating.
 *
 * The failure arm carries a `RemoteError` instance whose `code`/`message`
 * are what `./logic.js#describeFailure` formats, so the error is re-thrown
 * as-is rather than flattened into a string here.
 *
 * @param {{ok: boolean, value?: unknown, error?: object}} result - the host's answer.
 * @returns {unknown} the business value.
 * @throws the host's own failure when the answer was the error arm.
 */
function unwrapRemote(result) {
  if (result?.ok === true) return result.value
  const failure = result?.error
  if (failure === undefined) {
    throw new Error('Remote 没有返回 { ok, value } 信封（宿主契约变了？）')
  }
  throw failure
}

/** Browser-trust fence note: the route is same-origin by construction (the page is served by the same host). */
const DIAGNOSTICS_URL = '/opencode-go-native/diagnostics'

/** The prefix route the host half registers for this page (see `src/index.js`). */
const MODELS_URL = '/opencode-go-native/models'

/** The capability sync. One model per request, so the page owns the progress. */
const SYNC_URL = '/opencode-go-native/sync'

/**
 * One JSON round-trip against this plugin's own route.
 *
 * The route answers with `{ ok: false, error: { code, message } }` for a
 * failure, including a discovery failure (which is a 200 with that body), so the
 * unwrapping happens in `./logic.js` where it is tested.
 *
 * `credentials: 'same-origin'` is explicit: the route's fence is the browser's
 * own same-origin markers, not a token.
 */
async function requestJson(url, options) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: options?.body === undefined ? {} : { 'content-type': 'application/json' },
    ...options,
  })
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error(`${url} 没有返回 JSON（HTTP ${String(response.status)}）`)
  }
  return payload
}

/**
 * Register the OpenCode Go settings section.
 *
 * Registration goes through `ctx.slots.inject('settings.section', …)`: the
 * settings shell owns that slot, and injecting means "register when the shell is
 * there" rather than "assume it is". A deployment that composes no settings
 * shell therefore loads this plugin and shows nothing — no failure.
 *
 * @param {object} ctx - the client plugin context.
 */
export function apply(ctx) {
  // Bind the injected services ONCE, by name: these reads are exactly what the
  // `inject` list above must declare (`remote.settings` and `remote.credentials`
  // are their OWN cordis services — see the note there), and
  // `tests/client-inject.test.mjs` holds the list and these reads against each
  // other.
  const remoteSettings = ctx.remote.settings
  const remoteCredentials = ctx.remote.credentials
  const slots = ctx.slots
  // `remote` itself (the parent service object) is not this page's data face,
  // so it is read for the fiber's own dependency truth rather than to be used.
  void ctx.remote

  // Data faces. Both ride services declared in `inject` above; nothing here is
  // optional on this side, because a composition without the settings shell
  // simply never calls `settings.section`'s registrar.
  const api = {
    /** Read every namespace, then pick ours: the Remote returns them all. */
    describeSettings: () => remoteSettings.describe().then(unwrapRemote),
    /**
     * Write path-addressed edits against the namespace as STORED, with the
     * revision this page read. The host resolves the ops against the live
     * section, so two tabs editing different fields do not clobber one
     * another, and a stale revision is refused instead of overwriting.
     */
    mutateSettings: (ns, ops, expectedRevision) => remoteSettings
      .mutate(ns, ops, expectedRevision)
      .then(unwrapRemote),
    /**
     * The credential state for one reference — presence and source, never the
     * value. A refusal here is not fatal to the page (the settings half still
     * renders), so the error arm collapses to `undefined` exactly as the
     * official Models page does.
     */
    describeCredential: (reference) => remoteCredentials.describe([reference])
      .then((result) => (result?.ok === true ? result.value?.[reference] : undefined))
      .catch(() => undefined),
    /**
     * Store one API key in the credential provider.
     *
     * The write is deliberately NOT part of `mutateSettings`: the settings
     * document records the reference NAME, and the secret goes to the store the
     * harness owns (`$DSH_HOME/.credentials.yaml`, or the launch environment
     * when one shadows it). `undefined` means stored; a refusal is returned as
     * text because it is shown beside the field.
     */
    storeCredential: (reference, value) => remoteCredentials.set(reference, value)
      .then((result) => (result?.ok === true ? undefined : describeFailure(result?.error))),
    /** Remove one stored API key (idempotent). */
    removeCredential: (reference) => remoteCredentials.unset(reference)
      .then((result) => (result?.ok === true ? undefined : describeFailure(result?.error))),
    /** The effective catalogue (`?refresh=1` forces a re-discovery). */
    catalogue: (refresh) => requestJson(refresh === true ? `${MODELS_URL}?refresh=1` : MODELS_URL),
    /** One discovery draft; the body's `apiKey` is used once and never stored. */
    discoverDraft: (body) => requestJson(MODELS_URL, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    /** The diagnostics payload (`adapter.logged` + `adapter.health`). */
    diagnostics: () => requestJson(DIAGNOSTICS_URL),
    /**
     * Sync ONE model's capabilities. Deliberately one id per call: the page can
     * then show real progress, let the operator stop between models, and never
     * hold a long request open for a whole list.
     */
    syncModel: (id, options) => requestJson(SYNC_URL, {
      method: 'POST', body: JSON.stringify({ id }), ...options,
    }),
    /** The stored synced layer (provenance for what the page is showing). */
    synced: () => requestJson(SYNC_URL),
  }

  // `inject` (not `register`): the settings shell owns this slot, so the
  // section arrives when the shell does. A page that never opens settings
  // therefore costs nothing, and a deployment without the shell shows nothing
  // rather than failing.
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'opencode-go-native',
    order: 16,
    // The shell renders this as the nav entry; plain text, no locale seat, so
    // the page carries no second dictionary to keep in sync.
    label: () => 'OpenCode Go',
    inject: () => ({ api, settingsNamespace: SETTINGS_NS }),
  }, OpenCodeGoSection))
}
