/**
 * Disposable acceptance probe for phase 4b (the browser half's data face).
 *
 * NOT part of the plugin: this file is mounted into an ISOLATED `dsh web`
 * profile through that profile's `cordis.patch.yml` (see `phase4b-run.sh`), and
 * it never ships (the package's `files` list covers `src/`, `lib/`, `data/`, the
 * docs and the bundle patch — not `scripts/`).
 *
 * The browser half cannot be rendered here (no browser, no DOM). What this probe
 * proves is the part that CAN be proved from inside the host process, using the
 * SAME seam the page uses — the documented settings service API
 * (`describe` / `get` / `update` / `mutate`, which the Remote namespace mirrors
 * one-for-one):
 *
 *   A. this namespace registers, `describe()` hands the page a serialized
 *      schemastery envelope, and the `models` node in it is the opaque
 *      `z.any()` node — which is WHY the page renders those three sub-shapes
 *      itself (`src/client/logic.js`);
 *   B. path-addressed writes round-trip `models.disabled` / `models.extra` /
 *      `models.overrides` and read back byte-identical through both the resolved
 *      `get()` and the RAW `user` layer the form loads from — plus removal
 *      (`unset`) and a second write that leaves the other sub-shapes alone;
 *   C. a stale `expectedRevision` is REFUSED, which is what makes the page's
 *      two-tab story honest;
 *   D. invalid overlays are refused with messages that NAME the field path and
 *      the model id, so the page's message→control mapping has real input;
 *   E. the diagnostics payload the page fetches over HTTP has `kind:
 *      dsh-opencodego/diagnostics` and reflects the overlay just written;
 *   F. the effective catalogue the page's checkbox column renders includes the
 *      extra id and excludes the disabled one.
 *
 * Ordering matters and is the reason this probe owns a route: it must run AFTER
 * `dsh-opencodego` has registered its settings namespace, and "the namespace is
 * registered" is not observable at mount time. So the runner does the ROUND TRIP
 * through the plugin's own HTTP surface first (POST /opencode-go-native/models
 * makes the host half's settings registration requirement obvious), and then
 * curls THIS probe's route, which runs the assertions above in the same process.
 *
 * No credential is ever read, printed, or written by this probe: its settings
 * edits name the REFERENCE only (`OPENCODE_GO_API_KEY`, the shipped default),
 * never a key value.
 */

import { appendFile } from 'node:fs/promises'

export const name = 'ocg-verify-phase4b'
export const inject = ['settings']

const NS = 'opencode-go-native'
const LOG = process.env.OCG_P4B_LOG ?? '/tmp/ocg-phase4b/iso.log'

function note(line) {
  const text = `[ocg-verify-phase4b] ${line}`
  process.stderr.write(`${text}\n`)
  return appendFile(LOG, `${text}\n`).catch(() => {})
}

/** The overlay this probe writes: all three sub-shapes, every extra key named. */
const OVERLAY = {
  disabled: ['stub-retired'],
  extra: [{
    id: 'phase4b-hand-declared',
    name: 'Phase 4b Hand Declared',
    api: 'openai-responses',
    contextWindow: 65_536,
    maxTokens: 4_096,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: ['low', 'high'],
  }],
  overrides: {
    'glm-5.3-flash': { contextWindow: 4_096, api: 'openai-completions' },
  },
  replaceDiscovered: false,
}

/** Serialize one value with sorted keys, for a byte comparison of the overlay. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

const show = (value) => JSON.stringify(canonical(value))

/** Let the serialized write chain and its listeners settle. */
function settle(ms = 120) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The RAW user section (what the settings page's form loads from). */
function rawUserLayer(ctx) {
  const view = ctx.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === NS)
  return view?.user ?? {}
}

/** The revision the last write produced. */
function latestRevision(ctx) {
  return ctx.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === NS)?.revision
}

/**
 * Walk a serialized schemastery envelope to a named property.
 *
 * The envelope is `{ uid, refs }`: `refs` maps a numeric handle to one node's
 * snapshot, and an object node names its children through `dict` (handle →
 * handle). Measured, not assumed — the first version of this probe looked for
 * JSON-Schema `properties`, found none, and drew the wrong conclusion about what
 * the page can read.
 * @param {object} envelope - `schema.toJSON()`.
 * @param {string[]} path - property path from the root.
 * @returns {object | undefined} the node snapshot, or the scalar's string value.
 */
function schemaNodeAt(envelope, path) {
  const refs = envelope?.refs
  if (refs === undefined) return undefined
  let node = refs[String(envelope.uid)]
  for (const key of path) {
    const handle = node?.dict?.[key]
    if (handle === undefined) return undefined
    node = refs[String(handle)]
  }
  return node
}

/** One write expected to be refused, with the message captured verbatim. */
async function updateExpectingRefusal(ctx, patch) {
  try {
    await ctx.settings.update(NS, patch)
    await settle()
    return { refused: false, message: undefined }
  } catch (error) {
    return { refused: true, message: String(error?.message ?? error) }
  }
}

/** One path write expected to be refused at a stale revision. */
async function mutateExpectingRefusal(ctx, revision, ops) {
  try {
    await ctx.settings.mutate(NS, ops, revision)
    return { refused: false, message: undefined }
  } catch (error) {
    return { refused: true, message: String(error?.message ?? error), name: error?.name }
  }
}

/**
 * The diagnostics payload, read over this plugin's own HTTP route exactly as the
 * browser half reads it — the probe must not open a second logging source.
 */
async function readDiagnostics(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined) return { error: 'no webServer service' }
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/opencode-go-native/diagnostics`, {
      headers: { host: `127.0.0.1:${server.port}` },
    })
    const body = await response.json()
    return { status: response.status, kind: body?.diagnostics?.kind, payload: body?.diagnostics }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/** The effective catalogue, over the same route the page's checkbox column uses. */
async function readCatalogue(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined) return { error: 'no webServer service', models: [] }
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/opencode-go-native/models`, {
      headers: { host: `127.0.0.1:${server.port}` },
    })
    const body = await response.json()
    return { status: response.status, source: body?.source, models: body?.models ?? [] }
  } catch (error) {
    return { error: String(error?.message ?? error), models: [] }
  }
}

/** Run every phase-4b assertion and answer the evidence object. */
async function runChecks(ctx) {
  const evidence = {
    probe: 'phase4b',
    startedAt: new Date().toISOString(),
    namespace: NS,
    assertions: [],
    failures: [],
    scenarios: {},
  }
  const assertions = []
  const add = (name, pass, detail) => {
    assertions.push({ name, pass: pass === true, detail })
    if (pass !== true) evidence.failures.push(name)
  }

  try {
    const missing = ['describe', 'get', 'update', 'replace', 'mutate'].filter((name) => typeof ctx.settings[name] !== 'function')
    add('A0 the settings service answers every call the page makes', missing.length === 0, missing.join(', '))

    // ── A. describe() hands the page a schema; models is the opaque node
    const view = ctx.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === NS)
    add('A1 describe() exposes this namespace with a serialized schema envelope',
      view !== undefined && typeof view.schema === 'object' && view.schema !== null,
      view === undefined ? 'namespace missing' : String(view.schema?.type))
    const modelsNode = schemaNodeAt(view?.schema, ['models'])
    // `models` is `z.any()`: the node says so literally and carries NO child
    // handles, so a schema-driven form cannot draw its three sub-shapes.
    add('A2 the schema\'s models node is a z.any() leaf (so the page must render those sub-shapes itself)',
      modelsNode?.type === 'any'
      && Object.keys(modelsNode?.dict ?? {}).length === 0
      && schemaNodeAt(view?.schema, ['models', 'extra']) === undefined,
      show(modelsNode))
    evidence.scenarios.schema = {
      // The envelope is `{uid, refs}` and an object node names children through
      // `dict` — NOT JSON-Schema `properties`. Recorded here because the first
      // version of this probe assumed `properties` and drew the wrong conclusion.
      envelopeKeys: Object.keys(view?.schema ?? {}).sort(),
      rootType: schemaNodeAt(view?.schema, [])?.type,
      rootDictKeys: Object.keys(schemaNodeAt(view?.schema, [])?.dict ?? {}).sort().slice(0, 4),
      rootDictKeyCount: Object.keys(schemaNodeAt(view?.schema, [])?.dict ?? {}).length,
      modelsNode,
      sessionHeaderModeNode: schemaNodeAt(view?.schema, ['sessionHeaderMode']),
      descriptorKeys: Object.keys(view ?? {}).sort(),
      valueKeys: Object.keys(view?.value ?? {}).sort(),
    }

    // ── B. the three sub-shapes round-trip through the hosted write path
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['models', 'disabled'], value: OVERLAY.disabled },
      { op: 'set', path: ['models', 'extra'], value: OVERLAY.extra },
      { op: 'set', path: ['models', 'overrides'], value: OVERLAY.overrides },
      { op: 'set', path: ['models', 'replaceDiscovered'], value: OVERLAY.replaceDiscovered },
    ])
    await settle()

    const resolved = ctx.settings.get(NS) ?? {}
    const raw = rawUserLayer(ctx)
    const resolvedModels = resolved.models ?? {}
    const same = (left, right) => show(left) === show(right)
    evidence.scenarios.roundTrip = {
      wrote: OVERLAY,
      readBackResolved: {
        disabled: resolvedModels.disabled,
        extra: resolvedModels.extra,
        overrides: resolvedModels.overrides,
        replaceDiscovered: resolvedModels.replaceDiscovered,
      },
      readBackUserLayer: raw.models,
    }
    add('B1 models.disabled round-trips through the resolved section',
      same(resolvedModels.disabled, OVERLAY.disabled), show(resolvedModels.disabled))
    add('B2 models.extra round-trips through the resolved section',
      same(resolvedModels.extra, OVERLAY.extra), show(resolvedModels.extra))
    add('B3 models.overrides round-trips through the resolved section',
      same(resolvedModels.overrides, OVERLAY.overrides), show(resolvedModels.overrides))
    add('B4 the RAW user layer holds the same three shapes (this is what the form loads)',
      same(raw?.models?.disabled, OVERLAY.disabled)
      && same(raw?.models?.extra, OVERLAY.extra)
      && same(raw?.models?.overrides, OVERLAY.overrides)
      && raw?.models?.replaceDiscovered === false,
      show(raw?.models))
    // `Config.models` is `z.any()`, so the resolved layer hands `extra` back in
    // exactly the shape the user section stores (an ARRAY). Measured here rather
    // than assumed: that passthrough is what lets the form round-trip its own
    // editable shape without a transform on either side.
    const resolvedExtraShape = Array.isArray(resolvedModels.extra) ? 'array' : typeof resolvedModels.extra
    const userExtraShape = Array.isArray(raw?.models?.extra) ? 'array' : typeof raw?.models?.extra
    add('B5 the resolved models block preserves the user-section shape of every sub-shape (`z.any()` passthrough)',
      resolvedExtraShape === 'array' && userExtraShape === 'array'
      && same(resolvedModels.extra, raw?.models?.extra)
      && Array.isArray(resolvedModels.disabled)
      && typeof resolvedModels.overrides === 'object' && resolvedModels.overrides !== null,
      show({ resolvedExtraShape, userExtraShape, disabled: resolvedModels.disabled, overrides: resolvedModels.overrides }))

    // ── B6/B7. removal and an independent second write
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['models', 'replaceDiscovered'] }])
    await settle()
    add('B6 a path op can unset a field again (the form\'s "remove this" path)',
      rawUserLayer(ctx)?.models?.replaceDiscovered === undefined,
      show(rawUserLayer(ctx)?.models?.replaceDiscovered))
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['models', 'replaceDiscovered'], value: true },
      { op: 'unset', path: ['models', 'extra'] },
    ])
    await settle()
    const afterSecond = ctx.settings.get(NS) ?? {}
    add('B7 a second write can change one sub-shape without disturbing the others',
      afterSecond.models?.replaceDiscovered === true
      && same(afterSecond.models?.disabled, OVERLAY.disabled)
      && afterSecond.models?.extra === undefined,
      show({ replaceDiscovered: afterSecond.models?.replaceDiscovered, disabled: afterSecond.models?.disabled, extra: afterSecond.models?.extra }))
    // Restore the full overlay for the assertions that follow.
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['models', 'extra'], value: OVERLAY.extra },
      { op: 'set', path: ['models', 'replaceDiscovered'], value: false },
    ])
    await settle()

    // ── C. a stale revision is refused
    const revision = latestRevision(ctx)
    const conflict = await mutateExpectingRefusal(ctx, revision + 99, [
      { op: 'set', path: ['models', 'disabled'], value: ['should-not-land'] },
    ])
    evidence.scenarios.conflict = { revision, ...conflict }
    add('C1 a stale expectedRevision is refused instead of overwriting',
      conflict.refused && /changed since it was read/u.test(conflict.message), conflict.message)
    add('C2 the refused write stored nothing',
      same((ctx.settings.get(NS) ?? {}).models?.disabled, OVERLAY.disabled),
      show((ctx.settings.get(NS) ?? {}).models?.disabled))

    // ── D. field-named rejections: the text the page maps onto controls
    //
    // Each case names the sub-shape it judges, so the assertion cannot pass by
    // accident: `update()` deep-MERGES a patch over what is stored, which means
    // an "empty override" patch is a no-op rather than a rejection (measured —
    // an earlier draft of this probe asserted the opposite and was wrong). The
    // page's save path sends the whole `models` block, so the cases below send
    // the whole block too, exactly like the form does.
    const rejections = []
    for (const [label, patch] of [
      ['extra contextWindow', { models: { ...(rawUserLayer(ctx).models ?? {}), extra: [{ id: 'broken-extra', contextWindow: -5 }] } }],
      ['override sets nothing', { models: { ...(rawUserLayer(ctx).models ?? {}), overrides: { 'glm-5.3-flash': { contextWindow: 4096, api: 'openai-completions' }, 'phase4b-empty-override': {} } } }],
      ['extra + disabled contradiction', { models: { ...OVERLAY, disabled: ['phase4b-contradiction'], extra: [{ id: 'phase4b-contradiction' }] } }],
      ['invalid sessionHeader', { sessionHeader: 'x session' }],
    ]) {
      rejections.push({ label, ...(await updateExpectingRefusal(ctx, patch)) })
    }
    evidence.scenarios.rejections = rejections
    add('D1 an invalid overlay is refused with a message naming the field and the model id',
      rejections[0].refused && /models\.extra\["?broken-extra"?\]\.contextWindow/u.test(rejections[0].message),
      rejections[0].message)
    add('D2 an override that claims nothing is refused by name',
      rejections[1].refused
      && /models\.overrides\["?phase4b-empty-override"?\]/u.test(rejections[1].message)
      && /sets nothing/u.test(rejections[1].message),
      rejections[1].message)
    add('D3 an id that is both added and excluded is refused by name',
      rejections[2].refused
      && /both models\.extra and models\.disabled/u.test(rejections[2].message)
      && /phase4b-contradiction/u.test(rejections[2].message),
      rejections[2].message)
    add('D4 a malformed session header is refused with the RFC 7230 rule',
      rejections[3].refused && /RFC 7230/u.test(rejections[3].message),
      rejections[3].message)
    add('D5 every refusal left the stored section untouched',
      same((ctx.settings.get(NS) ?? {}).models?.extra, OVERLAY.extra),
      show((ctx.settings.get(NS) ?? {}).models?.extra))

    // ── E. the diagnostics payload, over the same HTTP route the page uses
    evidence.scenarios.diagnostics = await readDiagnostics(ctx)
    const payload = evidence.scenarios.diagnostics?.payload
    add('E1 the diagnostics payload carries the documented kind',
      payload?.kind === 'dsh-opencodego/diagnostics', show(payload?.kind))
    add('E2 it describes the overlay that is actually in force',
      payload?.configuration?.models?.disabled?.includes('stub-retired') === true
      && payload?.configuration?.models?.extra?.includes('phase4b-hand-declared') === true
      && payload?.configuration?.models?.overrides?.includes('glm-5.3-flash') === true,
      show(payload?.configuration?.models))
    add('E3 it carries no credential value (only the reference name)',
      !JSON.stringify(payload ?? {}).includes(process.env.OPENCODE_GO_API_KEY ?? '\u0000never-matches')
      && typeof payload?.connection?.apiKeyEnv === 'string',
      show(payload?.connection))

    // ── F. the effective catalogue the page's checkbox column renders
    const catalogue = await readCatalogue(ctx)
    evidence.scenarios.catalogue = catalogue
    add('F1 the effective catalogue includes the extra id',
      catalogue.models.some((model) => model.id === 'phase4b-hand-declared'),
      show(catalogue.models.map((model) => model.id)))
    add('F2 the effective catalogue excludes the disabled id',
      !catalogue.models.some((model) => model.id === 'stub-retired'),
      show(catalogue.models.map((model) => model.id)))
  } catch (error) {
    add('probe completed', false, String(error?.stack ?? error))
  }

  evidence.finishedAt = new Date().toISOString()
  evidence.assertions = assertions
  note(`checks done: ${assertions.filter((entry) => entry.pass).length}/${assertions.length} PASS`)
  for (const entry of assertions) {
    note(`${entry.pass ? 'PASS' : 'FAIL'} ${entry.name}${entry.pass ? '' : ` -> ${String(entry.detail).slice(0, 400)}`}`)
  }
  return evidence
}

/**
 * Mount the probe's own read-only route, fenced exactly like the plugin's
 * (`Host` must name the loopback authority the runner connects to).
 */
function mountRoute(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/ocg-phase4b',
      handler: async (req, res) => {
        const send = (status, payload) => {
          const body = `${JSON.stringify(payload, null, 2)}\n`
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(body)
        }
        const host = req.headers.host ?? ''
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/u.test(host)) {
          send(403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
          return
        }
        const evidence = await runChecks(ctx)
        send(200, { ok: true, evidence })
      },
    }), 'ocg-phase4b: evidence route')
  })
}

/**
 * Mount the evidence route as soon as this plugin's settings namespace exists.
 *
 * The namespace is what every check needs, and it is not registered at mount
 * time (the plugin's own `ctx.inject(['settings'], …)` runs first). Polling for
 * it is the only honest readiness signal available from inside the process.
 */
export function apply(ctx) {
  mountRoute(ctx)
  const deadline = Date.now() + 120_000
  const wait = () => {
    const registered = ctx.settings.describe({ redactSecrets: true }).some((entry) => entry.ns === NS)
    if (registered) {
      note('settings namespace registered; evidence route ready')
      return
    }
    if (Date.now() > deadline) {
      note('TIMED OUT waiting for the settings namespace to register')
      return
    }
    setTimeout(wait, 200)
  }
  wait()
}
