/**
 * Run the capability sync against the LIVE gateway for a few ids, exactly as
 * the settings page does.
 *
 *   node scripts/probe-sync.mjs kimi-k3 glm-5 omen-alpha
 *
 * This exists because the sync's rules were written against the gateway's real
 * behaviour, and a unit test with a fake fetch cannot notice the gateway
 * changing its mind. Three ids are enough to cover the branches that matter:
 * a model that works, a model the gateway still lists but upstream no longer
 * serves, and a model no first-party provider documents at all.
 *
 * The credential is read from `$OPENCODE_GO_API_KEY`, else from the same
 * `$DSH_HOME/.credentials.yaml` reference the plugin uses. It is never printed.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadOfficialBaseline, officialRecordFor } from '../src/official-baseline.js'
import { protocolChainForModel, resolveProtocol } from '../src/protocol-map.js'
import { requestHeaders } from '../src/session.js'
import { syncModel, syncedLayerFromSync } from '../src/sync.js'

/**
 * The host's mandatory attribution header, when this script is run with the
 * host's module resolution available (`NODE_PATH=<profile>/node_modules`). A
 * standalone run falls back to a plain user agent: attribution is a HOST policy
 * for its own requests, and this is a diagnostic run.
 */
async function loadAttribution() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.attributionHeaders === 'function') return mod.attributionHeaders
  } catch { /* fall through */ }
  return () => ({ 'user-agent': 'dsh-opencodego/scripts/probe-sync' })
}

const BASE_URL = 'https://opencode.ai/zen/go/v1'
const DEFAULT_IDS = ['kimi-k3', 'glm-5', 'omen-alpha']

function loadKey() {
  const fromEnv = process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  const match = /^\s*OPENCODE_GO_API_KEY:\s*(\S+)\s*$/mu.exec(text)
  if (match === null) throw new Error('OPENCODE_GO_API_KEY not found in the environment or $DSH_HOME/.credentials.yaml')
  return match[1].replace(/^["']|["']$/gu, '')
}

const ids = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const targets = ids.length > 0 ? ids : DEFAULT_IDS
const attributionHeaders = await loadAttribution()
const key = loadKey()
const loaded = loadOfficialBaseline()
if (!loaded.ok) throw new Error(loaded.error)

for (const id of targets) {
  const official = officialRecordFor(loaded.baseline, id)
  const protocol = resolveProtocol(id, { overrides: {}, snapshotNpm: undefined })
  const result = await syncModel({
    id,
    baseURL: BASE_URL,
    apiKey: key,
    fetchImpl: (...args) => fetch(...args),
    baseHeaders: () => requestHeaders(attributionHeaders(), 'x-opencode-session', 'probe-sync'),
    protocol,
    alternates: (modelId, primary) => protocolChainForModel(modelId, { maxAttempts: 3 })
      .filter((candidate) => candidate !== primary),
    official,
  })
  const layer = syncedLayerFromSync(result)
  process.stdout.write([
    `\n===== ${id}`,
    `  official baseline : ${official === undefined ? 'NONE (no first-party provider documents it)' : `${official.lab} · ${official.reasoningContract}`}`,
    `  status            : ${result.status}${result.reason === undefined ? '' : ` — ${result.reason}`}`,
    `  protocol          : recommended=${result.protocol.recommended} chosen=${String(result.protocol.chosen)} verified=${String(result.protocol.verified)}`,
    `  context / output  : ${String(result.contextWindow)} / ${String(result.maxTokens)} (from baseline, zero requests)`,
    `  input modalities  : ${result.input.join(', ') || '—'} (from baseline, zero requests)`,
    `  reasoning         : source=${result.reasoning?.source ?? '—'} levels=${JSON.stringify(result.reasoning?.levels ?? {})} off=${String(result.reasoning?.hasOff)}`,
    `  reasoning detail  : contract=${String(result.reasoning?.contract)} works=${String(result.reasoning?.declaredContractWorks)} rejected=${JSON.stringify(result.reasoning?.rejected?.map((r) => r.level) ?? [])}`,
    `  off mechanisms    : ${(result.reasoning?.offMechanisms ?? []).join(', ') || '—'}`,
    `  interleaved field : ${String(result.interleavedField)} (${String(result.interleavedFieldSource)})`,
    `  requests spent    : ${result.evidence.length}`,
    `  evidence          : ${result.evidence.map((row) => `${row.step}${row.level === undefined ? '' : `:${row.level}`}→${String(row.status)}`).join(' ')}`,
    `  layer entry       : ${JSON.stringify(layer).slice(0, 160)}…`,
  ].join('\n') + '\n')
}
