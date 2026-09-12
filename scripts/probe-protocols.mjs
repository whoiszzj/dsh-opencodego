/**
 * Probe the gateway's per-model protocol acceptance and parameter compliance.
 *
 * This is an EVIDENCE tool, not a runtime dependency: it drives pi-ai directly
 * (no DSH process, no plugin load), records what the endpoint answers for every
 * model × protocol pair, and writes both a human table and a JSON matrix. The
 * committed result is `data/protocol-matrix.<date>.json`; the endpoint's
 * behaviour is dynamic (see that file's `caveat`), so a matrix is a snapshot of
 * a moment and the tool exists to take a fresh one.
 *
 * What each attempt sends (this is the "session header + compliant parameters"
 * part):
 *   - `x-opencode-session: <probe id>` — the relay refuses a request without it;
 *   - `maxTokens` at or above the Responses API floor, never the bare default;
 *   - the model's own `baseUrl`, exactly as the adapter does;
 *   - `Authorization` from `OPENCODE_GO_API_KEY` (environment, or
 *     `$DSH_HOME/.credentials.yaml`, or `~/.dsh/.credentials.yaml`). The value is
 *     never printed.
 *
 * Usage:
 *   node scripts/probe-protocols.mjs                       # every endpoint model × 3 protocols
 *   node scripts/probe-protocols.mjs --models grok-4.6,kimi-k3
 *   node scripts/probe-protocols.mjs --json data/protocol-matrix.2026-09-11.json
 *   node scripts/probe-protocols.mjs --params              # extra compliance probes
 *   node scripts/probe-protocols.mjs --no-session          # reproduce 400 MissingSessionID
 *
 * pi-ai resolution: bare specifier first (works from inside a DSH profile),
 * then `$PI_AI_ROOT`, then `<DSH_HOME>/profiles/node_modules/...`, then
 * `~/.dsh/profiles/node_modules/...`, then the global dsh installation next to
 * the running Node binary.
 *
 * Run: node scripts/probe-protocols.mjs
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { modelCapabilities } from '../src/capabilities.js'
import { baseUrlForProtocol } from '../src/request-adapt.js'
import { classifyEndpointHealth } from '../src/health.js'
import { protocolChainForModel, protocolForModel, resolveProtocol } from '../src/protocol-map.js'
import { loadSnapshot } from '../src/snapshot.js'
import { SUPPORTED_PROTOCOLS } from '../src/vocab.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const DEFAULT_BASE = 'https://opencode.ai/zen/go/v1'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 64
const PROBE_MODEL_DEFAULTS = { defaultContextWindow: 200_000, defaultMaxTokens: 131_072 }

/* ── arguments ────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    if (inline !== undefined) flags[name] = inline
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) flags[name] = argv[++index]
    else flags[name] = true
  }
  return flags
}

/* ── credential + pi-ai discovery ─────────────────────────────────────────── */

/** The bearer token, from the environment or a credentials file. Never logged. */
async function readApiKey() {
  if (typeof process.env.OPENCODE_GO_API_KEY === 'string' && process.env.OPENCODE_GO_API_KEY.length > 0) {
    return process.env.OPENCODE_GO_API_KEY
  }
  const candidates = [
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, '.credentials.yaml'),
    join(homedir(), '.dsh', '.credentials.yaml'),
  ].filter((path) => path !== undefined)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const line = (await readFile(path, 'utf8'))
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('OPENCODE_GO_API_KEY'))
    if (line === undefined) continue
    const value = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
    if (value.length > 0) return value
  }
  throw new Error('no OPENCODE_GO_API_KEY in the environment or a credentials file')
}

/** Candidate pi-ai installation roots, best first. */
function piAiCandidates() {
  const candidates = []
  if (typeof process.env.PI_AI_ROOT === 'string') candidates.push(process.env.PI_AI_ROOT)
  for (const home of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof home === 'string') candidates.push(join(home, 'profiles', 'node_modules', '@earendil-works', 'pi-ai'))
  }
  // The global dsh installation lives beside the running Node binary.
  candidates.push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'))
  candidates.push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'))
  return [...new Set(candidates)]
}

/** Load pi-ai's core plus the three protocol implementations. */
async function loadPiAi() {
  const attempts = []
  try {
    const [core, completions, responses, anthropic] = await Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      import('@earendil-works/pi-ai/api/openai-responses.lazy'),
      import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
    ])
    return { root: '(bare specifier)', core, completions, responses, anthropic }
  } catch (error) {
    attempts.push(`bare specifier: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const candidate of piAiCandidates()) {
    if (!existsSync(join(candidate, 'dist', 'index.js'))) {
      attempts.push(`${candidate}: no dist/index.js`)
      continue
    }
    const url = (file) => pathToFileURL(join(candidate, 'dist', file)).href
    try {
      const [core, completions, responses, anthropic] = await Promise.all([
        import(url('index.js')),
        import(url('api/openai-completions.lazy.js')),
        import(url('api/openai-responses.lazy.js')),
        import(url('api/anthropic-messages.lazy.js')),
      ])
      return { root: candidate, core, completions, responses, anthropic }
    } catch (error) {
      attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`cannot resolve @earendil-works/pi-ai:\n  ${attempts.join('\n  ')}`)
}

/* ── probing ──────────────────────────────────────────────────────────────── */

/** Sanitize a body excerpt: collapse whitespace, cap length, never carry a secret. */
/** A 200-ish verdict: the endpoint produced model output of any kind. */
function accepted(record) {
  return record.finish === 'stop' || record.text.trim().length > 0 || record.thinking.trim().length > 0
}

/** The status of a probe record: the HTTP status when one was seen, else 200 for real output. */
function statusOf(record) {
  const classified = classifyEndpointHealth(record.failure)
  return classified.status ?? (accepted(record) ? 200 : undefined)
}

/** The human-facing detail of one verdict. */
function verdictDetail(row) {
  if (row.status === 200) {
    return row.text.length > 0 ? `text=${JSON.stringify(row.text)}` : `thinking=${JSON.stringify(row.thinking)}`
  }
  return excerpt(row.failure ?? '(no verdict)', 70)
}

function excerpt(text, length = 160) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, 'Bearer <redacted>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, length)
}

/**
 * One attempt: build the model descriptor, stream, and record the verdict.
 *
 * The verdict comes from the HTTP status of the FIRST request the attempt made
 * (captured by the fetch wrapper) plus whatever pi-ai reported, because
 * "accepted" for this matrix means "the endpoint took the protocol for this
 * model", not "the answer was good".
 */
async function probeAttempt({ models, apiKey, base, modelId, protocol, sessionHeader, timeoutMs, context, reasoning, maxTokens, trace }) {
  const descriptor = {
    id: modelId,
    name: modelId,
    provider: 'opencode-go-probe',
    api: protocol,
    // Mirror the adapter: anthropic-messages goes through the Anthropic SDK,
    // which appends `/v1/messages` to whatever base it is given.
    baseUrl: baseUrlForProtocol(protocol, base),
    reasoning: reasoning !== undefined,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 131_072,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`probe deadline ${timeoutMs}ms`)), timeoutMs)
  const started = Date.now()
  let text = ''
  let thinking = ''
  let finish
  let failure
  try {
    const events = models.streamSimple(descriptor, context, {
      apiKey,
      maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
      signal: controller.signal,
      headers: {
        'user-agent': 'dsh-opencodego-probe',
        ...sessionHeader === undefined ? {} : { 'x-opencode-session': sessionHeader },
      },
    })
    for await (const event of events) {
      if (trace === true) process.stderr.write(`  [trace] ${modelId}/${protocol}: ${event.type}${event.delta === undefined ? '' : ` ${JSON.stringify(event.delta).slice(0, 40)}`}\n`)
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        if (event.type === 'text_delta') text += event.delta
        else thinking += event.delta
        // Accepted — but only once there is real output to show. The first
        // delta of a reasoning model is often just a newline, and a verdict
        // recorded on whitespace would be no verdict at all.
        if (text.trim().length > 0 || thinking.trim().length > 0) {
          controller.abort(new Error('probe verdict reached'))
          break
        }
        continue
      }
      if (event.type === 'error') {
        failure = event.error?.errorMessage ?? JSON.stringify(event.error)
        finish = 'error'
        break
      }
      if (event.type === 'done') {
        finish = event.message?.stopReason
        break
      }
    }
  } catch (error) {
    if (failure === undefined && text.length === 0 && thinking.length === 0) {
      failure = error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
  return {
    modelId,
    protocol,
    text: excerpt(text),
    thinking: excerpt(thinking, 60),
    finish,
    failure: failure === undefined ? undefined : excerpt(failure, 300),
    elapsedMs: Date.now() - started,
  }
}

/** One `GET {base}/models`. */
async function fetchModelIds(base, apiKey) {
  const response = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`GET ${base}/models answered HTTP ${response.status}`)
  const body = await response.json()
  const entries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
  return entries.map((entry) => entry?.id).filter((id) => typeof id === 'string').sort()
}

/**
 * Raw-HTTP compliance probe for the Responses `max_output_tokens` floor.
 *
 * pi-ai clamps to 16 on its own, so the only way to observe what THIS relay
 * does with a below-floor value is to speak HTTP directly. The floor is a
 * protocol-level constraint (see `RESPONSES_MIN_OUTPUT_TOKENS` in
 * `src/vocab.js`), and this records whether the relay itself enforces it: a
 * relay that tolerates 1 does not make passing 1 correct, because the upstream
 * the relay forwards to may enforce it.
 */
async function probeResponsesFloor({ base, apiKey, sessionHeader, modelId, values = [0, 1, 8, 15, 16], timeoutMs = 30_000 }) {
  const results = []
  for (const value of values) {
    try {
      const response = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...sessionHeader === undefined ? {} : { 'x-opencode-session': sessionHeader },
        },
        body: JSON.stringify({ model: modelId, input: 'Reply with OK', max_output_tokens: value, stream: true }),
        // A hung response must not stall the whole evidence run: undici's own
        // headers timeout is minutes long.
        signal: AbortSignal.timeout(timeoutMs),
      })
      let body = ''
      try {
        body = await response.text()
      } catch {
        body = ''
      }
      results.push({ maxOutputTokens: value, status: response.status, body: excerpt(body) })
    } catch (error) {
      results.push({ maxOutputTokens: value, error: excerpt(error instanceof Error ? error.message : String(error)) })
    }
  }
  return results
}

/* ── reporting ────────────────────────────────────────────────────────────── */

/** A fixed-width table row helper. */
function pad(text, width) {
  const value = String(text ?? '')
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

function renderTable(matrix) {
  const lines = []
  lines.push(`${pad('model', 30)} ${pad('protocol', 20)} ${pad('status', 7)} ${pad('category', 20)} detail`)
  lines.push('-'.repeat(120))
  for (const row of matrix) {
    lines.push(
      `${pad(row.modelId, 30)} ${pad(row.protocol, 20)} ${pad(row.status ?? '-', 7)} ${pad(row.category, 20)} `
      + verdictDetail(row),
    )
  }
  return lines.join('\n')
}

/* ── main ─────────────────────────────────────────────────────────────────── */

/**
 * A single hung socket must not cost the whole matrix. Provenance beats
 * silence for an evidence tool, so an unhandled rejection is recorded and the
 * run continues; the note is written into the document.
 */
const unhandled = []
process.on('unhandledRejection', (reason) => {
  unhandled.push(excerpt(reason instanceof Error ? reason.message : String(reason), 200))
  process.stderr.write(`[probe] unhandled rejection (recorded): ${unhandled.at(-1)}\n`)
})

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const base = (typeof flags.base === 'string' ? flags.base : DEFAULT_BASE).replace(/\/+$/, '')
  const timeoutMs = flags.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(flags.timeout)
  const maxTokens = flags['max-tokens'] === undefined ? DEFAULT_MAX_TOKENS : Number(flags['max-tokens'])
  const sessionHeader = flags['no-session'] === true
    ? undefined
    : typeof flags.session === 'string' ? flags.session : `ocg-protocol-probe-${Math.random().toString(16).slice(2, 10)}`
  const protocols = typeof flags.protocols === 'string'
    ? flags.protocols.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [...SUPPORTED_PROTOCOLS]

  const apiKey = await readApiKey()
  const piAi = await loadPiAi()
  const apis = {
    'openai-completions': piAi.completions.openAICompletionsApi(),
    'openai-responses': piAi.responses.openAIResponsesApi(),
    'anthropic-messages': piAi.anthropic.anthropicMessagesApi(),
  }
  const core = piAi.core
  const provider = core.createProvider({
    id: 'opencode-go-probe',
    name: 'OpenCode Go (probe)',
    models: [],
    auth: { apiKey: { name: 'opencode-go-probe', resolve: async () => ({ auth: { apiKey } }) } },
    api: apis,
  })
  const models = core.createModels()
  models.setProvider(provider)

  const snapshotResult = loadSnapshot()
  const snapshot = snapshotResult.ok ? snapshotResult.snapshot : undefined
  process.stdout.write(`pi-ai: ${piAi.root}\n`)
  process.stdout.write(snapshotResult.ok
    ? `snapshot: ${snapshot.size} models, fetchedAt ${snapshot.fetchedAt}\n`
    : `snapshot: unavailable (${snapshotResult.error}) — protocol columns fall back to the built-in table\n`)

  let ids
  if (typeof flags.models === 'string') {
    ids = flags.models.split(',').map((entry) => entry.trim()).filter(Boolean)
  } else {
    try {
      ids = await fetchModelIds(base, apiKey)
      process.stdout.write(`endpoint: ${ids.length} models from ${base}/models\n`)
    } catch (error) {
      if (snapshot === undefined) throw error
      ids = snapshot.ids()
      process.stdout.write(`endpoint unavailable (${error instanceof Error ? error.message : String(error)}); using snapshot ids\n`)
    }
  }

  const context = { messages: [{ role: 'user', content: 'Reply with the single word OK', timestamp: 0 }] }
  const matrix = []
  for (const modelId of ids) {
    for (const protocol of protocols) {
      const record = await probeAttempt({
        models, apiKey, base, modelId, protocol, sessionHeader, timeoutMs, context, maxTokens, trace: flags.trace === true,
      })
      const classification = classifyEndpointHealth(record.failure)
      const row = {
        modelId,
        protocol,
        status: statusOf(record),
        category: record.failure === undefined ? 'ok' : classification.category,
        kind: record.failure === undefined ? 'ok' : classification.kind,
        action: classification.action,
        finish: record.finish,
        text: record.text,
        thinking: record.thinking,
        failure: record.failure,
        elapsedMs: record.elapsedMs,
      }
      matrix.push(row)
      process.stdout.write(
        `${pad(modelId, 30)} ${pad(protocol, 20)} ${pad(row.status ?? '-', 7)} ${pad(row.category, 20)} `
        + `${row.status === 200 ? `text=${JSON.stringify(row.text)}` : excerpt(row.failure ?? '(no verdict)', 60)}\n`,
      )
    }
  }

  /* Parameter-compliance probes (opt-in: extra requests). */
  const parameterProbes = []
  if (flags.params === true) {
    process.stdout.write('\nparameter compliance probes\n')
    for (const modelId of (typeof flags['params-models'] === 'string'
      ? flags['params-models'].split(',').map((entry) => entry.trim())
      : ['glm-5.3-flash', 'grok-4.6', 'hy3', 'longcat-2.0', 'kimi-k3'])) {
      if (!ids.includes(modelId) && typeof flags.models === 'string') continue
      const entry = snapshot?.entryFor(modelId)
      const facts = modelCapabilities(entry, PROBE_MODEL_DEFAULTS)
      const chain = protocolChainForModel(modelId, {
        snapshotNpm: snapshot?.npmFor(modelId),
        overrides: {},
      })
      const primary = protocolForModel(modelId, {}, snapshot?.npmFor(modelId))
      const source = resolveProtocol(modelId, { snapshotNpm: snapshot?.npmFor(modelId) }).source
      const selectable = facts.reasoning ? facts.thinkingLevelMap : undefined
      const top = selectable === undefined
        ? undefined
        : ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'].find((level) => typeof selectable[level] === 'string')
      const reasoningProbe = top === undefined
        ? { skipped: 'no selectable thinking level in the snapshot' }
        : await probeAttempt({ models, apiKey, base, modelId, protocol: primary, sessionHeader, timeoutMs, context, maxTokens, reasoning: top })
      // A replayed assistant turn carrying a thinking block, i.e. the history
      // shape a second conversation turn sends.
      const replayContext = {
        messages: [
          { role: 'user', content: 'Think briefly, then answer.', timestamp: 0 },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'The user wants a short answer.', ...facts.thinkingField === undefined ? {} : { thinkingSignature: facts.thinkingField } },
              { type: 'text', text: 'OK' },
            ],
            api: primary,
            provider: 'opencode-go-probe',
            model: modelId,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: 0,
          },
          { role: 'user', content: 'Again, one word.', timestamp: 0 },
        ],
      }
      const replayProbe = await probeAttempt({ models, apiKey, base, modelId, protocol: primary, sessionHeader, timeoutMs, context: replayContext, maxTokens })
      parameterProbes.push({
        modelId,
        primary,
        primarySource: source,
        chain,
        snapshotReasoningLevels: facts.thinkingLevelMap,
        selectableLevels: facts.reasoning ? Object.entries(facts.thinkingLevelMap ?? {}).filter(([, wire]) => typeof wire === 'string').map(([level]) => level) : [],
        droppedModalities: facts.droppedModalities,
        recommendedReasoningEffort: top,
        reasoningEffort: {
          status: reasoningProbe.skipped === undefined ? statusOf(reasoningProbe) : undefined,
          text: reasoningProbe.text,
          thinking: reasoningProbe.thinking,
          failure: reasoningProbe.failure,
          skipped: reasoningProbe.skipped,
        },
        replayedReasoning: {
          status: statusOf(replayProbe),
          text: replayProbe.text,
          thinking: replayProbe.thinking,
          failure: replayProbe.failure,
        },
      })
      process.stdout.write(
        `${pad(modelId, 30)} primary=${pad(primary, 19)} chain=${chain.join('>')} `
        + `reasoning=${top ?? '-'}(${reasoningProbe.skipped === undefined ? statusOf(reasoningProbe) : '-'}) `
        + `replay=(${statusOf(replayProbe)})\n`,
      )
    }
    const floorModel = typeof flags['floor-model'] === 'string' ? flags['floor-model'] : 'grok-4.6'
    const floor = await probeResponsesFloor({ base, apiKey, sessionHeader, modelId: floorModel })
    process.stdout.write(`/responses max_output_tokens floor on ${floorModel}: ${floor.map((row) => `${row.maxOutputTokens}->${row.status}`).join(', ')}\n`)
    parameterProbes.push({ modelId: floorModel, responsesMaxOutputTokensFloor: floor })
  }

  if (typeof flags.json === 'string') {
    const document = {
      kind: 'dsh-opencodego/protocol-matrix',
      version: 1,
      generatedAt: new Date().toISOString(),
      base,
      maxTokens,
      sessionHeader: sessionHeader === undefined ? null : (typeof flags.session === 'string' ? flags.session : '(fresh random probe id)'),
      piAiRoot: piAi.root,
      snapshot: snapshotResult.ok
        ? { fetchedAt: snapshot.fetchedAt, source: snapshot.source, modelCount: snapshot.size }
        : { error: snapshotResult.error },
      unhandledRejections: unhandled,
      caveat: 'The endpoint\'s protocol acceptance is DYNAMIC: grok-4.6 has been seen failing on both protocols and answering 200 on /responses seconds later, and a model\'s list membership changes without notice. This matrix is a snapshot of one moment, kept as evidence for ALTERNATE_PROTOCOL_HINTS and for the fallback classification tests — never as a runtime dependency.',
      protocols,
      modelCount: ids.length,
      endpointModelIds: ids,
      decisions: ids.map((modelId) => {
        const npm = snapshot?.npmFor(modelId)
        const decision = resolveProtocol(modelId, { snapshotNpm: npm })
        return {
          modelId,
          snapshotNpm: npm === undefined ? null : npm,
          primary: decision.primary,
          primarySource: decision.source,
          chain: protocolChainForModel(modelId, { snapshotNpm: npm }),
        }
      }),
      snapshotReconciliation: {
        snapshotOnlyNotEnabled: snapshot === undefined ? [] : snapshot.snapshotOnlyIds(ids),
        advertisedButNotCatalogued: snapshot === undefined ? [] : snapshot.unknownIds(ids),
      },
      results: matrix,
      parameterProbes,
    }
    const path = resolve(flags.json)
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    process.stdout.write(`\nwrote ${path}\n`)
  }

  process.stdout.write(`\n${renderTable(matrix)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
