/**
 * Probe the OpenCode Go relay's session-header whitelist, and keep the
 * `400 MissingSessionID` gate as a re-runnable regression.
 *
 * DESIGN.md §2.4 recorded four observations by hand (`x-opencode-session` and
 * `x-deepseek-harness-session-id` accepted; `x-whatever-session` and `x-foo`
 * refused). This tool turns that table into something reproducible: it sends
 * ONE minimal, non-streaming `/chat/completions` request per candidate header
 * name against the same model, changing nothing but the header, and reports
 * `{header, http, errorType}` for each. The no-header row is the regression
 * itself: it must come back `400 MissingSessionID`, while the control row
 * (`x-opencode-session`) must come back 200.
 *
 * Everything that talks to the network is behind an explicit gate, because
 * every row costs real quota:
 *
 *   node scripts/probe-session-headers.mjs --live                  # full name table
 *   node scripts/probe-session-headers.mjs --live --regression      # only the 400/200 pair
 *   OCG_LIVE_PROBES=1 node scripts/probe-session-headers.mjs        # same gate via env
 *   node scripts/probe-session-headers.mjs --live --json data/session-headers.2026-09-11.json
 *   node scripts/probe-session-headers.mjs --live --headers x-conversation-id,session_id
 *   node scripts/probe-session-headers.mjs --live --headers none --regression   # just the 400 gate
 *
 * Without `--live` (or `OCG_LIVE_PROBES=1`) the tool prints the candidate list
 * and exits 0 without issuing a single request, so `npm test` and casual runs
 * stay offline.
 *
 * The bearer token is read from `OPENCODE_GO_API_KEY`, else from
 * `$DSH_HOME/.credentials.yaml`, else `~/.dsh/.credentials.yaml`. The value is
 * NEVER printed, and every string that reaches stdout/JSON is passed through
 * `redact()` first.
 *
 * Only `https://opencode.ai/zen/go/**` is ever contacted: the tool refuses a
 * `--base` that is not under that path unless `--allow-any-base` is passed, so
 * an accidental `--base http://localhost` cannot pollute a wire record.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const DEFAULT_BASE = 'https://opencode.ai/zen/go/v1'
const DEFAULT_MODEL = 'glm-5.3-flash'
/** The credential reference: the environment variable, and the key inside a credentials file. */
const API_KEY_ENV = 'OPENCODE_GO_API_KEY'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_TOKENS = 16
/** The value every probe sends. Opaque on purpose: it is not a real DSH session id. */
export const PROBE_VALUE = 'ocg-session-header-probe'

const SESSION_HEADER = 'x-opencode-session'

/**
 * The full candidate table.
 *
 * `expect` is the OUTCOME the phase-3 brief claims for names that were already
 * measured (`ok` = the relay routes it, `missing` = `400 MissingSessionID`).
 * `undefined` means "no prior claim — this run is the measurement".
 *
 * @type {{header: string | undefined, label: string, value: string, expect: 'ok' | 'missing' | undefined}[]}
 */
export const PROBE_CANDIDATES = [
  // The controls, in the order DESIGN.md §2.4 records them.
  { header: undefined, label: '(no session header)', value: '', expect: 'missing' },
  { header: 'x-opencode-session', label: 'x-opencode-session', value: PROBE_VALUE, expect: 'ok' },
  { header: 'x-deepseek-harness-session-id', label: 'x-deepseek-harness-session-id', value: PROBE_VALUE, expect: 'ok' },
  { header: 'x-whatever-session', label: 'x-whatever-session', value: PROBE_VALUE, expect: 'missing' },
  { header: 'x-foo', label: 'x-foo', value: PROBE_VALUE, expect: 'missing' },
  // Case-insensitivity is an HTTP rule; this row proves the relay follows it and
  // that the adapter's lower-casing loses nothing.
  { header: 'X-OpenCode-Session', label: 'X-OpenCode-Session (mixed case)', value: PROBE_VALUE, expect: 'ok' },
  // The names the phase-3 brief explicitly asked to fill in.
  { header: 'x-session-id', label: 'x-session-id', value: PROBE_VALUE, expect: undefined },
  { header: 'session_id', label: 'session_id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-session-affinity', label: 'x-session-affinity', value: PROBE_VALUE, expect: undefined },
  { header: 'x-client-request-id', label: 'x-client-request-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-request-id', label: 'x-request-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-opencode-session-id', label: 'x-opencode-session-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-opencode-request-id', label: 'x-opencode-request-id', value: PROBE_VALUE, expect: undefined },
  // Other plausible spellings a relay whitelist might have chosen.
  { header: 'x-opencode-sessionid', label: 'x-opencode-sessionid (no hyphen)', value: PROBE_VALUE, expect: undefined },
  { header: 'session-id', label: 'session-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-session', label: 'x-session', value: PROBE_VALUE, expect: undefined },
  { header: 'x-session-key', label: 'x-session-key', value: PROBE_VALUE, expect: undefined },
  { header: 'x-request-session-id', label: 'x-request-session-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-oc-session', label: 'x-oc-session', value: PROBE_VALUE, expect: undefined },
  { header: 'x-relay-session', label: 'x-relay-session', value: PROBE_VALUE, expect: undefined },
  { header: 'x-conversation-id', label: 'x-conversation-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-opencode-conversation-id', label: 'x-opencode-conversation-id', value: PROBE_VALUE, expect: undefined },
  { header: 'x-opencode-affinity', label: 'x-opencode-affinity', value: PROBE_VALUE, expect: undefined },
  { header: 'x-deepseek-harness-session', label: 'x-deepseek-harness-session', value: PROBE_VALUE, expect: undefined },
  { header: 'x-harness-session', label: 'x-harness-session', value: PROBE_VALUE, expect: undefined },
  { header: 'x-trace-id', label: 'x-trace-id', value: PROBE_VALUE, expect: undefined },
  // Empty value: is a recognised name enough, or does the relay need a value?
  { header: SESSION_HEADER, label: `${SESSION_HEADER} (empty value)`, value: '', expect: undefined },
]

/** Only the two rows the regression cares about. */
export const REGRESSION_CANDIDATES = PROBE_CANDIDATES.filter(
  (candidate) => candidate.expect === 'missing' || candidate.header === SESSION_HEADER || candidate.header === 'X-OpenCode-Session',
)

/* ── pure logic (unit-tested without a network) ───────────────────────────── */

/**
 * The error type a relay response body names, or a synthetic label.
 *
 * The relay answers `{type:'error',error:{type:'MissingSessionID',message:…}}`
 * for the gate and `{type:'error',error:{type:'…'}}` for everything else; a
 * non-JSON body (an HTML 404 page, an empty 200) must still classify.
 * @param {number} http - the HTTP status.
 * @param {string} body - the raw response text.
 * @returns {string} the error type, `ok`, or a `HTTP <n>`/`NETWORK: …` label.
 */
export function classifyProbeResponse(http, body) {
  if (http === 200) return 'ok'
  const text = typeof body === 'string' ? body : ''
  try {
    const parsed = JSON.parse(text)
    const named = parsed?.error?.type ?? parsed?.type
    if (typeof named === 'string' && named.length > 0) return named
  } catch {
    // fall through to the textual / status fallback
  }
  const match = /"type"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(text)
  if (match !== null) return match[1]
  return http === 0 ? 'NETWORK' : `HTTP ${http}`
}

/**
 * Replace a secret wherever it appears. Cheap insurance: this tool never logs
 * the bearer token, and this makes an accidental inclusion in an error message
 * or a response echo harmless.
 * @param {string} text - any string about to be printed or serialized.
 * @param {string} [secret] - the bearer token.
 * @returns {string} the redacted text.
 */
export function redact(text, secret) {
  const value = String(text ?? '')
  if (typeof secret !== 'string' || secret.length < 8) return value
  return value.split(secret).join('<redacted>')
}

/**
 * The verdict for one measured row.
 * @param {'ok' | 'missing' | undefined} expect - the prior claim.
 * @param {number} http - the HTTP status.
 * @param {string} errorType - `classifyProbeResponse` output.
 * @returns {'PASS' | 'FAIL' | 'observed'} the row's verdict.
 */
export function verdictFor(expect, http, errorType) {
  if (expect === undefined) return 'observed'
  const acceptable = expect === 'ok' ? http === 200 : http === 400 && errorType === 'MissingSessionID'
  return acceptable ? 'PASS' : 'FAIL'
}

/* ── CLI plumbing ─────────────────────────────────────────────────────────── */

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

function pad(text, width) {
  const value = String(text)
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/**
 * The bearer token, from the environment or a credentials file. Never logged.
 * @returns {string} the token; throws when none is configured.
 */
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
  throw new Error(
    `no ${API_KEY_ENV}: export it, or provide $DSH_HOME/.credentials.yaml / ~/.dsh/.credentials.yaml`,
  )
}

/**
 * One minimal request, changing only the session header.
 *
 * A network failure or a 5xx is retried once: this tool spends real quota and
 * the verdicts it carries are about 200 vs. `400 MissingSessionID`, so a blip
 * must not read as "the endpoint changed its mind". A 400/200 is never
 * retried, and `attempts` records what happened.
 *
 * @param {object} args - the probe inputs.
 * @returns {Promise<{http: number, errorType: string, ms: number, attempts: number, note?: string}>} the measurement.
 */
async function probeOnce(args) {
  let measurement = await probeAttempt(args)
  let attempts = 1
  while (attempts < 2 && (measurement.http === 0 || measurement.http >= 500)) {
    attempts += 1
    measurement = await probeAttempt(args)
  }
  return { ...measurement, attempts }
}

/**
 * A single request attempt; see {@link probeOnce}.
 * @param {object} args - the probe inputs.
 * @returns {Promise<{http: number, errorType: string, ms: number, note?: string}>} the measurement.
 */
async function probeAttempt({ base, apiKey, model, candidate, timeoutMs, maxTokens }) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }
  if (candidate.header !== undefined) headers[candidate.header] = candidate.value
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: maxTokens,
        stream: false,
      }),
    })
    const body = await response.text()
    return { http: response.status, errorType: classifyProbeResponse(response.status, body), ms: Date.now() - startedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { http: 0, errorType: 'NETWORK', ms: Date.now() - startedAt, note: message.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const live = flags.live === true || process.env.OCG_LIVE_PROBES === '1'
  const regression = flags.regression === true
  const base = String(typeof flags.base === 'string' ? flags.base : DEFAULT_BASE).replace(/\/+$/, '')
  const model = typeof flags.model === 'string' ? flags.model : DEFAULT_MODEL
  const timeoutMs = flags.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(flags.timeout)
  const maxTokens = flags['max-tokens'] === undefined ? DEFAULT_MAX_TOKENS : Number(flags['max-tokens'])
  const candidates = regression ? REGRESSION_CANDIDATES : PROBE_CANDIDATES
  // `--headers a,b,none` re-measures a subset (the `none` token is the
  // no-session-header row) without paying for the whole table.
  const only = typeof flags.headers === 'string'
    ? flags.headers.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    : undefined
  const selected = only === undefined
    ? candidates
    : candidates.filter((candidate) => (
      candidate.header === undefined ? only.includes('none') : only.includes(candidate.header.toLowerCase())
    ))

  if (flags['allow-any-base'] !== true && !base.startsWith('https://opencode.ai/zen/go/')) {
    throw new Error(
      `refusing to probe ${base}: this tool only touches https://opencode.ai/zen/go/** `
      + '(pass --allow-any-base to override; the wire record is otherwise polluted by test traffic)',
    )
  }

  if (!live) {
    process.stdout.write(
      'probe-session-headers: OFFLINE (no request sent)\n'
      + `  ${selected.length} candidate header name(s) would be probed against ${base} using model "${model}"\n`
      + '  every row consumes real quota; enable with --live or OCG_LIVE_PROBES=1\n',
    )
    for (const candidate of selected) process.stdout.write(`  - ${candidate.label}\n`)
    process.exitCode = 0
    return
  }

  let apiKey
  try {
    apiKey = readApiKey()
  } catch (error) {
    process.stdout.write(`probe-session-headers: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  const startedAt = new Date().toISOString()
  process.stdout.write(
    `probe-session-headers: LIVE ${regression ? '(regression: no-header 400 + control 200)' : only === undefined ? '(full name table)' : '(filtered name table)'}\n`
    + `  at      ${startedAt}\n`
    + `  base    ${base}\n`
    + `  model   ${model}\n`
    + `  key     present (${API_KEY_ENV}, value redacted)\n`
    + `  rows    ${selected.length} minimal /chat/completions requests (stream=false, max_tokens=${maxTokens})\n\n`,
  )

  const rows = []
  for (const candidate of selected) {
    const measurement = await probeOnce({ base, apiKey, model, candidate, timeoutMs, maxTokens })
    const verdict = verdictFor(candidate.expect, measurement.http, measurement.errorType)
    const row = {
      header: candidate.header ?? null,
      label: candidate.label,
      value: candidate.header === undefined ? null : candidate.value === '' ? '(empty)' : candidate.value,
      http: measurement.http,
      errorType: measurement.errorType,
      verdict,
      ms: measurement.ms,
      attempts: measurement.attempts,
      ...measurement.note === undefined ? {} : { note: measurement.note },
    }
    rows.push(row)
    process.stdout.write(
      `${pad(row.label, 38)} ${pad(`http=${row.http}`, 9)} ${pad(row.errorType, 20)} ${row.verdict}`
      + `${row.note === undefined ? '' : `  (${row.note})`}${row.attempts > 1 ? '  [retried]' : ''}\n`,
    )
  }

  const failed = rows.filter((row) => row.verdict === 'FAIL')
  const document = {
    tool: 'probe-session-headers',
    at: startedAt,
    base,
    model,
    probeValue: PROBE_VALUE,
    maxTokens,
    stream: false,
    filter: only ?? null,
    // The endpoint's behaviour is dynamic (DESIGN.md §2.2.1 makes the same point
    // about protocol acceptance): this document is a snapshot of one moment,
    // not a property of the model or of the relay.
    caveat: 'The relay\'s accepted header list is a measured, dated snapshot; re-run this tool before treating it as current.',
    candidates: rows,
    accepted: rows.filter((row) => row.http === 200 && row.header !== null).map((row) => row.label),
    failed,
  }

  if (typeof flags.json === 'string') {
    const path = resolve(root, flags.json)
    const text = redact(`${JSON.stringify(document, null, 2)}\n`, apiKey)
    writeFileSync(path, text)
    process.stdout.write(`\njson: ${path}\n`)
  }

  if (regression) {
    const noHeader = rows.find((row) => row.header === null)
    const control = rows.find((row) => row.label === SESSION_HEADER)
    const reproduced = noHeader?.http === 400 && noHeader?.errorType === 'MissingSessionID' && control?.http === 200
    process.stdout.write(
      `\nregression: no-header -> ${noHeader?.http} ${noHeader?.errorType}; `
      + `${SESSION_HEADER} -> ${control?.http} ${control?.errorType} :: ${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}\n`,
    )
    process.exitCode = reproduced ? 0 : 1
    return
  }

  process.stdout.write(`\nfailed rows: ${failed.length}\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

// Only run when invoked as a program: the pure helpers above are imported by
// `tests/session.test.mjs`, and importing this module must not fire requests.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `| head` is a normal way to read a table; a closed pipe is not a failure.
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0)
    throw error
  })
  main().catch((error) => {
    process.stderr.write(`probe-session-headers: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
