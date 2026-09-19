/**
 * Probe what the OpenCode Go relay says about QUOTA and BALANCE.
 *
 * The feature under investigation: "explicit balance limits per subscription".
 * Before designing an accounting layer we must know what the gateway itself
 * already reports, because whatever it reports is the only TRUSTWORTHY balance
 * fact for a subscription. Three questions, three parts:
 *
 *   A. the model list (GET /models) — do its response headers carry any
 *      rate-limit / quota / remaining counters? (some relays publish them only
 *      here, and it costs almost nothing)
 *   B. one minimal chat request — the full response header set, plus the
 *      `usage` object the body returns (what fields exist decides whether a
 *      token ledger can bill the same way the provider does)
 *   C. candidate account endpoints (GET /usage /balance /account /subscription
 *      /billing /me /quota /credits, on the /v1 base and the parent path) —
 *      does a balance API exist at all?
 *
 * Like every live tool here it is GATED: without `--live` (or `OCG_LIVE_PROBES=1`)
 * it prints the plan and issues zero requests. The bearer token is read from
 * `OPENCODE_GO_API_KEY`, else `$DSH_HOME/.credentials.yaml`, else
 * `~/.dsh/.credentials.yaml` — the same chain `probe-session-headers.mjs`
 * uses — and the value is NEVER printed: every emitted string goes through
 * `redact()` first, and response-header values are additionally scrubbed of
 * anything equal to the key.
 *
 *   node scripts/probe-quota.mjs --live
 *   node scripts/probe-quota.mjs --live --model glm-5.3-flash
 *   node scripts/probe-quota.mjs --live --no-chat     # skip part B (no quota spend)
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API_KEY_ENV = 'OPENCODE_GO_API_KEY'
const DEFAULT_BASE = 'https://opencode.ai/zen/go/v1'
const DEFAULT_MODEL = 'glm-5.3-flash'
const SESSION_HEADER = 'x-opencode-session'
const PROBE_VALUE = 'ocg-quota-probe'
const TIMEOUT_MS = 90_000

const CANDIDATE_ENDPOINTS = [
  '/usage',
  '/balance',
  '/account',
  '/subscription',
  '/billing',
  '/me',
  '/quota',
  '/credits',
]

function readApiKey() {
  const fromEnv = process.env[API_KEY_ENV]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const candidates = [
    process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, '.credentials.yaml'),
    join(homedir(), '.dsh', '.credentials.yaml'),
  ].filter((path) => path !== undefined)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(API_KEY_ENV))
    if (line === undefined) continue
    const value = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
    if (value.length > 0) return value
  }
  throw new Error(`no ${API_KEY_ENV}: export it, or provide $DSH_HOME/.credentials.yaml / ~/.dsh/.credentials.yaml`)
}

/** Redact the secret from anything about to be printed, then bound the length. */
function clean(value, secret) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (secret.length > 0) text = text.split(secret).join('[REDACTED]')
  if (text.length > 400) text = `${text.slice(0, 400)}…`
  return text
}

/** The header set minus the noise; quota-relevant names are flagged. */
function summarizeHeaders(headers, secret) {
  const out = {}
  for (const [name, value] of headers.entries()) {
    const interesting = /limit|quota|remain|reset|usage|credit|balance|plan|seat|subscription|retry/i.test(name)
    out[name] = interesting ? clean(value, secret) : clean(value, secret)
  }
  return out
}

async function fetchWithTimeout(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function main() {
  const args = process.argv.slice(2)
  const live = args.includes('--live') || process.env.OCG_LIVE_PROBES === '1'
  const noChat = args.includes('--no-chat')
  const modelAt = args.indexOf('--model')
  const model = modelAt >= 0 ? args[modelAt + 1] : DEFAULT_MODEL
  const baseAt = args.indexOf('--base')
  const base = baseAt >= 0 ? args[baseAt + 1].replace(/\/+$/, '') : DEFAULT_BASE

  const plan = [
    `A. GET ${base}/models            — response headers (quota counters?)`,
    noChat
      ? 'B. SKIPPED (--no-chat)'
      : `B. POST ${base}/chat/completions — one minimal request (${model}) for headers + usage body`,
    `C. GET ${base}{${CANDIDATE_ENDPOINTS.join(',')}} and parent — balance API?`,
  ].join('\n')

  if (!live) {
    console.log(`probe-quota: OFFLINE (no request sent)\n${plan}\n\npass --live to spend a handful of requests.`)
    return
  }

  const key = readApiKey()
  const headers = {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    [SESSION_HEADER]: PROBE_VALUE,
  }

  // ── A. model list headers ───────────────────────────────────────────────
  console.log('── A. GET /models ─────────────────────────────────────────')
  try {
    const res = await fetchWithTimeout(`${base}/models`, { headers })
    console.log(`status: ${res.status}`)
    console.log(JSON.stringify(summarizeHeaders(res.headers, key), null, 2))
  } catch (error) {
    console.log(`failed: ${clean(error?.message ?? String(error), key)}`)
  }

  // ── B. one minimal chat: headers + usage shape ──────────────────────────
  if (!noChat) {
    console.log(`\n── B. POST /chat/completions (${model}, max_tokens=1) ─────────`)
    try {
      const res = await fetchWithTimeout(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          max_tokens: 1,
          stream: false,
        }),
      })
      console.log(`status: ${res.status}`)
      console.log('headers:')
      console.log(JSON.stringify(summarizeHeaders(res.headers, key), null, 2))
      const text = await res.text()
      let usage = undefined
      try { usage = JSON.parse(text)?.usage } catch { /* keep raw */ }
      console.log(`usage: ${JSON.stringify(usage ?? clean(text, key))}`)
    } catch (error) {
      console.log(`failed: ${clean(error?.message ?? String(error), key)}`)
    }
  }

  // ── C. candidate account endpoints, /v1 base and parent path ────────────
  console.log('\n── C. candidate balance endpoints ─────────────────────────')
  const parent = base.replace(/\/v1$/, '')
  const targets = new Set()
  for (const prefix of [base, parent]) {
    for (const endpoint of CANDIDATE_ENDPOINTS) targets.add(`${prefix}${endpoint}`)
  }
  for (const url of [...targets].sort()) {
    try {
      const res = await fetchWithTimeout(url, { headers })
      let note = ''
      if (res.status < 400) {
        const text = (await res.text()).slice(0, 200)
        note = ` body: ${clean(text, key)}`
      }
      console.log(`${res.status}  ${url}${note}`)
    } catch (error) {
      console.log(`ERR  ${url}  ${clean(error?.message ?? String(error), key)}`)
    }
  }
  console.log('\n(done; headers above are the relay’s own words — record anything quota-shaped in the design notes)')
}

main().catch((error) => {
  console.error(`probe-quota failed: ${error?.message ?? error}`)
  process.exitCode = 1
})
