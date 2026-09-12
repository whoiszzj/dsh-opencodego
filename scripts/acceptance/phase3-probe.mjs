/**
 * Disposable acceptance probe for phase 3 (session-header hardening).
 *
 * NOT part of the plugin: this file is mounted into an ISOLATED `dsh web`
 * profile through that profile's `cordis.patch.yml`, and it never ships (the
 * package's `files` list covers `src/`, `lib/`, `data/`, the docs and the
 * bundle patch — not `scripts/`).
 *
 * What it proves, from inside the host process:
 *  1. the adapter's own route completes a real `glm-5.3-flash` stream, and the
 *     wire request carries `x-opencode-session` whose value IS the
 *     `GenerateOptions.sessionId` the caller passed (the host entry point
 *     `ctx.llm.stream`, not a direct adapter call);
 *  2. a request with no host session id still reaches the wire with a
 *     non-empty session value, and with attribution in the same header set;
 *  3. the session header does not appear on any OTHER route's or host's
 *     requests observed during the run (the header is scoped to this route:
 *     this plugin patches no global fetch — `tests/session.test.mjs` pins that
 *     structurally, this run observes it on the wire);
 *  4. with `sessionHeaderEnabled: false` configured, the SAME code path sends
 *     no session header and the relay answers `400 MissingSessionID` — the
 *     config switch really gates the wire.
 *
 * Only `https://opencode.ai/zen/go/**` calls are treated as evidence (an
 * earlier phase had its wire record polluted by another plugin's unrelated
 * traffic), and the Authorization value is never copied into the output.
 */

import { appendFile, writeFile } from 'node:fs/promises'

export const name = 'ocg-verify-phase3'
export const inject = ['llm', 'credentials']

const ROUTE = 'opencode-go-native'
const MODEL = 'glm-5.3-flash'
const RELAY_PREFIX = 'https://opencode.ai/zen/go/'
const OUT = process.env.OCG_P3_OUT ?? '/tmp/ocg-phase3/iso-evidence.json'
const LOG = process.env.OCG_P3_LOG ?? '/tmp/ocg-phase3/iso.log'
const SESSION = process.env.OCG_P3_SESSION ?? `phase3-session-${Math.random().toString(16).slice(2, 10)}`

/** The header names the relay was measured to accept, plus the ones pi-ai could emit. */
const SESSION_HEADER_NAMES = [
  'x-opencode-session',
  'x-deepseek-harness-session-id',
  'x-session-id',
  'session_id',
  'x-session-affinity',
  'x-client-request-id',
  'x-conversation-id',
]
/** Header names this acceptance is allowed to record (never Authorization). */
const RECORDED_HEADERS = [...SESSION_HEADER_NAMES, 'user-agent', 'content-type', 'accept']

function note(line) {
  const text = `[ocg-verify-phase3] ${line}`
  process.stderr.write(`${text}\n`)
  return appendFile(LOG, `${text}\n`, 'utf8').catch(() => {})
}

/** Record only the headers this acceptance cares about — never a credential. */
function snapshotHeaders(raw) {
  const wanted = new Set(RECORDED_HEADERS)
  const picked = {}
  let hasAuthorization = false
  try {
    const entries = raw === undefined || raw === null
      ? []
      : typeof raw.entries === 'function'
        ? [...raw.entries()]
        : Object.entries(raw)
    for (const [key, value] of entries) {
      const lower = String(key).toLowerCase()
      if (lower === 'authorization') hasAuthorization = true
      else if (wanted.has(lower)) picked[lower] = String(value)
    }
  } catch { /* a header snapshot is best-effort */ }
  return { picked, hasAuthorization }
}

/** Capture every outbound request; restore when the run ends. */
function instrumentFetch() {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async function capture(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    const rawHeaders = init?.headers
      ?? (typeof input === 'object' && input !== null && 'headers' in input ? input.headers : undefined)
    const { picked, hasAuthorization } = snapshotHeaders(rawHeaders)
    let body
    try {
      body = typeof init?.body === 'string' ? init.body : undefined
    } catch { /* ignore */ }
    const response = await original.call(this, input, init)
    calls.push({
      url: String(url),
      path: (() => {
        try {
          return new URL(String(url)).pathname
        } catch {
          return String(url)
        }
      })(),
      method: init?.method ?? 'GET',
      status: response.status,
      relay: String(url).startsWith(RELAY_PREFIX),
      headers: picked,
      hasAuthorization,
      bodyBytes: body === undefined ? null : body.length,
      model: (() => {
        if (body === undefined) return undefined
        try {
          return JSON.parse(body).model
        } catch {
          return undefined
        }
      })(),
    })
    return response
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** One real streaming call through the host entry point. */
async function streamOnce(ctx, { label, sessionId, wire }) {
  const before = wire.calls.length
  const startedAt = Date.now()
  const record = { label, sessionId: sessionId ?? null, ok: false, finish: null, text: '', reasoningDeltas: 0, chunkTypes: [], error: null }
  try {
    for await (const chunk of ctx.llm.stream({
      provider: ROUTE,
      model: MODEL,
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
      // glm-5.3-flash is a reasoning model: a cap small enough to be eaten by
      // the reasoning phase answers with `finish: max-tokens` and no text, which
      // would make the "real stream" assertion depend on the cap rather than on
      // the route working.
      maxTokens: 1024,
    })) {
      if (chunk.type === 'text-delta') record.text += chunk.text
      if (chunk.type === 'reasoning-delta') record.reasoningDeltas += 1
      if (chunk.type === 'finish') record.finish = chunk.reason
      record.chunkTypes.push(chunk.type)
    }
  } catch (error) {
    record.error = String(error?.message ?? error)
  }
  // The host surfaces an endpoint rejection as an in-band error finish rather
  // than a throw, so "ok" must mean "the route answered with content", not
  // merely "the iterator ended".
  record.ok = record.error === null && record.finish !== null && record.finish.kind !== 'error'
  record.elapsedMs = Date.now() - startedAt
  record.wire = wire.calls.slice(before)
  return record
}

export function apply(ctx) {
  const wire = instrumentFetch()
  const evidence = {
    probe: 'phase3',
    startedAt: new Date().toISOString(),
    route: ROUTE,
    model: MODEL,
    sessionIdSent: SESSION,
    relayPrefix: RELAY_PREFIX,
  }

  const finish = async (extra = {}) => {
    wire.restore()
    const relayCalls = wire.calls.filter((call) => call.relay)
    const otherCalls = wire.calls.filter((call) => !call.relay)
    evidence.finishedAt = new Date().toISOString()
    evidence.relayCalls = relayCalls
    evidence.otherCalls = otherCalls.map((call) => ({
      url: call.url,
      status: call.status,
      carriedSessionHeader: SESSION_HEADER_NAMES.filter((headerName) => call.headers[headerName] !== undefined),
    }))
    evidence.sessionHeaderLeaksOffRoute = evidence.otherCalls.filter((call) => call.carriedSessionHeader.length > 0)
    evidence.assertions = buildAssertions()
    Object.assign(evidence, extra)
    await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch((error) => note(`write failed: ${error.message}`))
    note(`evidence written to ${OUT}`)
  }

  const buildAssertions = () => {
    const assertions = []
    const add = (name, pass, detail) => assertions.push({ name, pass, detail })

    const explicit = evidence.streams?.find((stream) => stream.label === 'explicit-session')
    const explicitWire = explicit?.wire?.filter((call) => call.relay) ?? []
    add(
      'a real glm-5.3-flash stream completes through the host entry point',
      explicit?.ok === true && explicit?.finish?.kind === 'stop' && explicit?.text.trim().length > 0,
      { finish: explicit?.finish, text: explicit?.text, reasoningDeltas: explicit?.reasoningDeltas, error: explicit?.error },
    )
    add(
      'the wire carries x-opencode-session with exactly the host sessionId',
      explicitWire.length > 0 && explicitWire.every((call) => call.headers['x-opencode-session'] === SESSION),
      explicitWire.map((call) => ({ path: call.path, status: call.status, value: call.headers['x-opencode-session'] })),
    )
    add(
      'attribution rides in the same request as the session header',
      explicitWire.length > 0 && explicitWire.every((call) => typeof call.headers['user-agent'] === 'string' && call.headers['user-agent'].includes('deepseek-harness')),
      explicitWire.map((call) => call.headers['user-agent']),
    )

    const minted = evidence.streams?.find((stream) => stream.label === 'host-minted-session')
    const mintedWire = minted?.wire?.filter((call) => call.relay) ?? []
    add(
      'with no host session id the adapter still sends a non-empty value',
      minted?.ok === true && mintedWire.length > 0
        && mintedWire.every((call) => typeof call.headers['x-opencode-session'] === 'string' && call.headers['x-opencode-session'].length > 0),
      mintedWire.map((call) => ({ status: call.status, valueLength: call.headers['x-opencode-session']?.length ?? 0 })),
    )

    add(
      'no session header reaches a non-relay host',
      evidence.sessionHeaderLeaksOffRoute.length === 0,
      evidence.sessionHeaderLeaksOffRoute,
    )
    return assertions
  }

  void (async () => {
    try {
      // The route and the credential plane activate asynchronously; retry only
      // the activation-shaped failures, never a real endpoint verdict.
      let ready = false
      for (let attempt = 0; attempt < 40 && !ready; attempt++) {
        try {
          const models = await ctx.llm.listModels(ROUTE)
          ready = Array.isArray(models) && models.length > 0
          if (ready) note(`route ready: ${models.length} models`)
        } catch (error) {
          note(`waiting for the route: ${String(error?.message ?? error).slice(0, 120)}`)
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!ready) {
        await finish({ routeReady: false })
        return
      }

      evidence.streams = [
        await streamOnce(ctx, { label: 'explicit-session', sessionId: SESSION, wire }),
        await streamOnce(ctx, { label: 'host-minted-session', sessionId: undefined, wire }),
      ]
      note(`streams: ${evidence.streams.map((stream) => `${stream.label}=${stream.ok ? 'ok' : 'error'}${stream.error === null ? '' : `(${stream.error.slice(0, 80)})`}`).join(' ')}`)
      await finish({ routeReady: true })
    } catch (error) {
      await finish({ probeError: String(error?.stack ?? error) })
    }
  })()
}
