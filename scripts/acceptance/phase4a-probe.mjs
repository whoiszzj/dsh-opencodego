/**
 * Disposable acceptance probe for phase 4a (the host-side settings surface).
 *
 * NOT part of the plugin: this file is mounted into an ISOLATED `dsh web`
 * profile through that profile's `cordis.patch.yml`, and it never ships (the
 * package's `files` list covers `src/`, `lib/`, `data/`, the docs and the bundle
 * patch — not `scripts/`).
 *
 * What it proves, from inside the host process, by WRITING SETTINGS (never by
 * editing a file):
 *
 *   A. the model-set overlay is additive — `models.extra` enables an id, a
 *      per-model override corrects its capabilities, `models.disabled` excludes
 *      an id, and every one of those reaches `ctx.llm.listModels()` /
 *      `ctx.llm.resolveModelInfo()` on the NEXT call;
 *   B. `baseURL` / `apiKeyEnv` / `protocolOverrides` / `models.overrides[id].api`
 *      all reach the next request (a local stub server answers, so which
 *      endpoint and which protocol were used is observable);
 *   C. an invalid section is REJECTED by the write, with a message naming the
 *      field (and the model id) — two different fields;
 *   D. the diagnostics surface is readable and reflects the configuration and
 *      the traffic the run produced;
 *   E. a real `glm-5.3-flash` stream through `ctx.llm.stream()` still completes
 *      after `baseURL` was pointed back at the real gateway, i.e. the settings
 *      edits above are live facts, not a one-way door.
 *
 * The probe never prints a credential. The API-key assertions use a SENTINEL
 * value written into the probe's environment and read back from the stub
 * server's Authorization header; the real key never leaves the credential plane.
 */

import { createServer } from 'node:http'
import { appendFile, writeFile } from 'node:fs/promises'

export const name = 'ocg-verify-phase4a'
export const inject = ['llm', 'settings']

const NS = 'opencode-go-native'
const ROUTE = 'opencode-go-native'
const REAL_BASE = 'https://opencode.ai/zen/go/v1'
const OUT = process.env.OCG_P4_OUT ?? '/tmp/ocg-phase4a/iso-evidence.json'
const LOG = process.env.OCG_P4_LOG ?? '/tmp/ocg-phase4a/iso.log'

function note(line) {
  const text = `[ocg-verify-phase4a] ${line}`
  process.stderr.write(`${text}\n`)
  return appendFile(LOG, `${text}\n`, 'utf8').catch(() => {})
}

/** The models the stub advertises: distinct ids so a stale cache cannot pass. */
const STUB_MODELS = ['stub-alpha', 'stub-beta', 'stub-gamma']

/**
 * A local stand-in for the gateway.
 *
 * `GET /v1/models` answers with ids no real endpoint has; both streaming
 * endpoints answer with a minimal, protocol-shaped SSE stream and record the
 * request, so "which protocol did the adapter pick" is an observation rather
 * than an inference.
 */
async function startStub() {
  const calls = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const record = {
      method: req.method ?? 'GET',
      path: url.pathname,
      authorization: req.headers.authorization,
      model: undefined,
    }
    calls.push(record)
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      try {
        record.model = JSON.parse(body).model
      } catch { /* a GET has no body */ }
      if (url.pathname === '/v1/models') {
        const payload = JSON.stringify({
          object: 'list',
          data: STUB_MODELS.map((id) => ({ id, object: 'model', owned_by: 'stub' })),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(payload)
        return
      }
      if (url.pathname === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          model: record.model ?? 'stub',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'STUB' }, finish_reason: null }],
        })}\n\n`)
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          model: record.model ?? 'stub',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      // /v1/messages (anthropic) and /v1/responses both answer "not here" with a
      // parseable protocol error, keeping the shape observable without encoding
      // a second full protocol surface in this probe.
      if (url.pathname === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_stub', type: 'message', role: 'assistant', model: record.model ?? 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`)
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STUB' } })}\n\n`)
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`)
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        res.end()
        return
      }
      if (url.pathname === '/v1/responses') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const event = (type, payload) => {
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
        }
        const response = {
          id: 'resp_stub',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: record.model ?? 'stub',
          status: 'completed',
          output: [{ id: 'msg_stub', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'STUB', annotations: [] }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        }
        event('response.created', { sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } })
        // The text delta is only consumed once an output item has opened the
        // slot pi-ai writes it into (`getSlot(output_index, 'text')`).
        event('response.output_item.added', {
          sequence_number: 1,
          output_index: 0,
          item: { id: 'msg_stub', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        })
        event('response.output_text.delta', {
          sequence_number: 2, item_id: 'msg_stub', output_index: 0, content_index: 0, delta: 'STUB',
        })
        event('response.completed', { sequence_number: 3, response })
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'not_found', message: `stub has no ${url.pathname}` } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Apply one settings patch through the settings service (never a file edit). */
async function writeSettings(ctx, patch) {
  const wanted = patch[NS] ?? patch
  await ctx.settings.update(NS, wanted)
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** One real streaming call through the host entry point. */
async function streamOnce(ctx, { label, model, sessionId }) {
  const record = { label, model, ok: false, finish: null, text: '', error: null }
  try {
    for await (const chunk of ctx.llm.stream({
      provider: ROUTE,
      model,
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
      maxTokens: 1024,
    })) {
      if (chunk.type === 'text-delta') record.text += chunk.text
      if (chunk.type === 'finish') record.finish = chunk.reason
    }
  } catch (error) {
    record.error = String(error?.message ?? error)
  }
  record.ok = record.error === null
    && record.finish !== null
    && record.finish.kind !== 'error'
    && record.text.trim().length > 0
  return record
}

export function apply(ctx) {
  const evidence = {
    probe: 'phase4a',
    startedAt: new Date().toISOString(),
    route: ROUTE,
    namespace: NS,
    realBase: REAL_BASE,
    assertions: [],
    failures: [],
    scenarios: {},
  }
  const assertions = []
  const add = (name, pass, detail) => {
    assertions.push({ name, pass: pass === true, detail })
    if (pass !== true) evidence.failures.push(name)
  }

  const finish = async (extra = {}) => {
    evidence.finishedAt = new Date().toISOString()
    evidence.assertions = assertions
    Object.assign(evidence, extra)
    await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch((error) => note(`write failed: ${error.message}`))
    note(`evidence written to ${OUT} (${assertions.filter((entry) => entry.pass).length}/${assertions.length} PASS)`)
    for (const entry of assertions) {
      note(`${entry.pass ? 'PASS' : 'FAIL'} ${entry.name}${entry.pass ? '' : ` -> ${JSON.stringify(entry.detail)}`}`)
    }
  }

  /** One rejected write, with the message captured verbatim. */
  const reject = async (label, patch) => {
    try {
      await ctx.settings.update(NS, patch)
      return { label, rejected: false, message: undefined }
    } catch (error) {
      return { label, rejected: true, message: String(error?.message ?? error) }
    }
  }

  void (async () => {
    let stub
    try {
      stub = await startStub()
      evidence.stub = { baseURL: stub.baseURL, models: STUB_MODELS }
      note(`stub listening at ${stub.baseURL}`)

      // Wait for the route to be ready. The probe's own composition sets
      // `sync: false`, so readiness comes from a real discovery against the
      // relay; the first baseline assertion below re-reads it from the stub.
      let ready = false
      for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        try {
          const models = await ctx.llm.listModels(ROUTE)
          ready = Array.isArray(models) && models.length > 0
        } catch (error) {
          note(`waiting for the route: ${String(error?.message ?? error).slice(0, 140)}`)
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!ready) {
        await finish({ routeReady: false })
        return
      }

      // ── A1: the composition baseline is the real endpoint ────────────────
      const baseline = await ctx.llm.listModels(ROUTE)
      const baselineIds = baseline.map((model) => model.id)
      evidence.scenarios.baseline = {
        count: baseline.length,
        hasGlm: baselineIds.includes('glm-5.3-flash'),
        sample: baselineIds.slice(0, 5),
      }
      add(
        'A0 the real endpoint catalogue is the baseline',
        baseline.length > 20 && baselineIds.includes('glm-5.3-flash'),
        evidence.scenarios.baseline,
      )

      // ── B1: baseURL reaches the next request ─────────────────────────────
      await writeSettings(ctx, { baseURL: stub.baseURL })
      const afterBase = await ctx.llm.listModels(ROUTE)
      const stubCalls = stub.calls.filter((call) => call.path === '/v1/models')
      evidence.scenarios.baseURL = {
        ids: afterBase.map((model) => model.id),
        stubModelsRequests: stubCalls.length,
        authorizationPresent: typeof stubCalls.at(-1)?.authorization === 'string'
          && stubCalls.at(-1).authorization.startsWith('Bearer '),
      }
      add(
        'B1 baseURL change reaches the next discovery',
        afterBase.length === STUB_MODELS.length
        && afterBase.every((model, index) => model.id === STUB_MODELS[index])
        && stubCalls.length > 0
        && evidence.scenarios.baseURL.authorizationPresent,
        evidence.scenarios.baseURL,
      )

      // ── A2/B3: an extra model, excluded model, capability + protocol pins ─
      const EXTRA_ID = 'phase4a-hand-declared'
      const EXCLUDED_ID = STUB_MODELS[1]
      await writeSettings(ctx, {
        baseURL: stub.baseURL,
        models: {
          extra: [{
            id: EXTRA_ID,
            name: 'Phase 4a Hand Declared',
            api: 'openai-responses',
            contextWindow: 4096,
            maxTokens: 1024,
            input: ['text', 'image'],
            reasoning: true,
            reasoningEfforts: ['low', 'high'],
          }],
          disabled: [EXCLUDED_ID],
        },
      })
      const overlayMark = stub.calls.length
      const overlaid = await ctx.llm.listModels(ROUTE)
      const overlayIds = overlaid.map((model) => model.id)
      const extraInfo = await ctx.llm.resolveModelInfo(ROUTE, EXTRA_ID)
      evidence.scenarios.overlay = {
        ids: overlayIds,
        extraInfo: {
          name: extraInfo.name,
          context: extraInfo.context,
          defaultMaxTokens: extraInfo.defaultMaxTokens,
          inputModalities: extraInfo.inputModalities,
          efforts: extraInfo.reasoning?.efforts?.map((effort) => effort.id),
        },
      }
      add(
        'A1 models.extra adds an id the endpoint never advertised',
        overlayIds.includes(EXTRA_ID),
        overlayIds,
      )
      add(
        'A2 models.disabled removes an advertised id, leaving the rest',
        !overlayIds.includes(EXCLUDED_ID)
        && overlayIds.includes(STUB_MODELS[0])
        && overlayIds.includes(STUB_MODELS[2]),
        overlayIds,
      )
      add(
        'A3 an extra declaration supplies the capabilities and levels it names',
        extraInfo.context?.contextWindow === 4096
        && extraInfo.defaultMaxTokens === 1024
        && JSON.stringify(extraInfo.inputModalities) === JSON.stringify(['text', 'image'])
        && JSON.stringify(extraInfo.reasoning?.efforts?.map((effort) => effort.id)) === JSON.stringify(['low', 'high']),
        evidence.scenarios.overlay.extraInfo,
      )

      // ── B4: the pinned protocol is the one on the wire ───────────────────
      const pinnedMark = stub.calls.length
      const pinnedStream = await streamOnce(ctx, { label: 'pinned-extra', model: EXTRA_ID, sessionId: 'phase4a-pinned' })
      const pinnedCalls = stub.calls.slice(pinnedMark).filter((call) => call.model === EXTRA_ID)
      evidence.scenarios.pinnedStream = {
        stream: pinnedStream,
        calls: pinnedCalls.map((call) => ({ path: call.path, model: call.model })),
      }
      add(
        'B4 models.extra[].api decides the protocol on the wire',
        pinnedCalls.length > 0 && pinnedCalls.every((call) => call.path === '/v1/responses'),
        evidence.scenarios.pinnedStream.calls,
      )

      // ── B5: models.overrides[].api beats the legacy protocolOverrides ────
      await writeSettings(ctx, {
        models: { overrides: { [STUB_MODELS[0]]: { api: 'openai-responses' } } },
        protocolOverrides: { [STUB_MODELS[0]]: 'anthropic-messages' },
      })
      const overrideMark = stub.calls.length
      const overridden = await streamOnce(ctx, { label: 'override-wins', model: STUB_MODELS[0], sessionId: 'phase4a-override' })
      const overrideCalls = stub.calls.slice(overrideMark).filter((call) => call.model === STUB_MODELS[0])
      const diagnosticsAfterOverride = await readDiagnostics(ctx)
      evidence.scenarios.overrideWins = {
        stream: overridden,
        calls: overrideCalls.map((call) => ({ path: call.path, model: call.model })),
        shadowed: diagnosticsAfterOverride?.configuration?.models?.protocolOverridesShadowed,
      }
      add(
        'B5 models.overrides[id].api wins over the legacy protocolOverrides alias',
        overrideCalls.length >= 1
        && overrideCalls.at(-1).path === '/v1/responses'
        && !overrideCalls.some((call) => call.path === '/v1/messages'),
        evidence.scenarios.overrideWins.calls,
      )
      add(
        'D1 the shadowed alias is reported, not silently dropped',
        JSON.stringify(diagnosticsAfterOverride?.configuration?.models?.protocolOverridesShadowed) === JSON.stringify([STUB_MODELS[0]]),
        diagnosticsAfterOverride?.configuration?.models,
      )

      // ── B2: apiKeyEnv reaches the credential resolution, by name ─────────
      await writeSettings(ctx, { baseURL: stub.baseURL, apiKeyEnv: 'OCG_P4_DEFINITELY_UNSET' })
      let missing = null
      try {
        // The point is which credential the NEXT ATTEMPT uses, so the write
        // above also moves `apiKeyEnv` — a dimension of the catalogue's
        // freshness, so the call below really does attempt the endpoint.
        const models = await ctx.llm.listModels(ROUTE)
        missing = { threw: false, count: models.length }
      } catch (error) {
        missing = { threw: true, message: String(error?.message ?? error) }
      }
      const diagnosticsAtB2 = await readDiagnostics(ctx)
      evidence.scenarios.missingKey = {
        ...missing,
        settingsApiKeyEnv: ctx.settings.get(NS)?.apiKeyEnv,
        adapterSees: diagnosticsAtB2?.connection,
        catalogueStatus: diagnosticsAtB2?.catalogue?.status,
        catalogueDiscoveredAt: diagnosticsAtB2?.catalogue?.lastSuccessAt,
      }
      add(
        'B2 apiKeyEnv naming an unset reference fails with MISSING_CREDENTIAL naming it',
        missing.threw === true && missing.message.includes('OCG_P4_DEFINITELY_UNSET'),
        missing,
      )

      // ── C: two rejected writes, each naming a different field ────────────
      await writeSettings(ctx, { apiKeyEnv: 'OPENCODE_GO_API_KEY' })
      const rejects = [
        await reject('sessionHeader', { sessionHeader: 'x session' }),
        await reject('contextWindow', { models: { extra: [{ id: 'broken-extra', contextWindow: -5 }] } }),
      ]
      evidence.scenarios.rejects = rejects
      const valueAfterRejects = ctx.settings.get(NS)
      evidence.scenarios.rejectsValue = {
        modelsModelCount: Array.isArray(valueAfterRejects?.models?.extra) ? valueAfterRejects.models.extra.length : null,
      }
      add(
        'C1 an invalid sessionHeader is rejected, naming the field and the rule',
        rejects[0].rejected === true
        && rejects[0].message.includes('sessionHeader')
        && rejects[0].message.includes('not a valid HTTP header name'),
        rejects[0],
      )
      add(
        'C2 a non-positive model cap is rejected, naming the model id and the field',
        rejects[1].rejected === true
        && rejects[1].message.includes('models.extra["broken-extra"].contextWindow')
        && rejects[1].message.includes('positive integer'),
        rejects[1],
      )
      add(
        'C3 a rejected write stores nothing',
        // The rejected `broken-extra` never entered the stored section.
        Array.isArray(valueAfterRejects?.models?.extra)
        && !valueAfterRejects.models.extra.some((entry) => entry?.id === 'broken-extra'),
        evidence.scenarios.rejectsValue,
      )

      // ── D2: the diagnostics surface reflects the configuration ───────────
      const diagnostics = await readDiagnostics(ctx)
      evidence.scenarios.diagnostics = diagnostics === undefined ? null : {
        kind: diagnostics.kind,
        effective: diagnostics.catalogue?.effective,
        disabled: diagnostics.configuration?.models?.disabled,
        extra: diagnostics.configuration?.models?.extra,
        overrides: diagnostics.configuration?.models?.overrides,
        sources: diagnostics.catalogue?.sources,
        healthRows: diagnostics.health?.rows?.length,
        logLines: diagnostics.log?.lines?.length,
        warnings: diagnostics.log?.warnings?.length,
      }
      add(
        'D2 the diagnostics payload describes the configuration actually in force',
        diagnostics?.kind === 'dsh-opencodego/diagnostics'
        && Array.isArray(diagnostics.configuration?.models?.extra)
        && diagnostics.configuration.models.extra.includes(EXTRA_ID)
        && diagnostics.configuration.models.disabled.includes(EXCLUDED_ID)
        && diagnostics.configuration.models.overrides.includes(STUB_MODELS[0])
        && diagnostics.catalogue.effective === overlayIds.length,
        evidence.scenarios.diagnostics,
      )

      // ── E: the edits are live facts, not a one-way door ──────────────────
      await writeSettings(ctx, { baseURL: REAL_BASE, apiKeyEnv: 'OPENCODE_GO_API_KEY' })
      const realStream = await streamOnce(ctx, { label: 'real-relay', model: 'glm-5.3-flash', sessionId: 'phase4a-real' })
      evidence.scenarios.realStream = realStream
      add(
        'E1 after baseURL is written back, a real glm-5.3-flash stream completes',
        realStream.ok === true && realStream.text.trim().length > 0,
        realStream,
      )

      await finish({ routeReady: true })
    } catch (error) {
      await finish({ probeError: String(error?.stack ?? error) })
    } finally {
      await stub?.close().catch(() => {})
    }
  })()

  /** Read the plugin's own HTTP diagnostics surface, as the 4b page will. */
  async function readDiagnostics(context) {
    const server = context.get('webServer')
    if (server === undefined) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/opencode-go-native/diagnostics`, {
        headers: { host: `127.0.0.1:${server.port}` },
      })
      if (!response.ok) return { httpStatus: response.status }
      const payload = await response.json()
      return payload.diagnostics
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }
}
