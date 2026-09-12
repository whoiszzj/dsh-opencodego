/**
 * The model-capability SYNC: what one OpenCode Go model id can actually do,
 * established by asking the gateway rather than by trusting a snapshot.
 *
 * The user-facing contract this implements (agreed 2026-09-12):
 *
 *   - **availability** — is this id still served at all? If not, say WHY (the
 *     upstream is gone, the account/region is gated, every protocol refused)
 *     and let the operator switch models. Never silently keep a dead id.
 *   - **protocol** — OpenCode's own recommendation wins, which is the models.dev
 *     `provider.npm` rule the request path already uses (`resolveProtocol`);
 *     with no recommendation it is the provider default, OpenAI-shaped. The
 *     recommendation is then VERIFIED, because a recommendation is not a
 *     measurement. A model may answer on more than one protocol; the
 *     recommendation is preferred and the rest are recorded as alternates.
 *   - **max context / max output** — taken from the official baseline. These are
 *     NOT probed: the user decided that, and neither number is safely
 *     measurable from a cheap request.
 *   - **reasoning** — the official contract is PROBED first. If every declared
 *     level is accepted, the official contract is what gets stored (not the
 *     full host ladder, which would offer levels the provider never declared).
 *     Only when there is no official contract — or it does not survive contact
 *     with the gateway — is the whole ladder probed and whatever actually works
 *     stored. `none` is the provider's spelling for "do not reason" and is not
 *     a level; it is reported as `hasOff`.
 *   - **image** — taken from the official baseline. NOT probed.
 *
 * Everything here is measured, and every measurement is kept: `evidence` holds
 * one row per request, so a stored capability can always be explained.
 *
 * @module dsh-opencodego/sync
 */

import { reasoningLevels } from './official-baseline.js'
import { FALLBACK_PROTOCOL, SUPPORTED_PROTOCOLS } from './vocab.js'

export const SYNC_KIND = 'dsh-opencodego/model-sync'
export const SYNC_VERSION = 1

/** How a model id answered. */
export const SYNC_STATUS = Object.freeze({
  /** The id answers on at least one protocol. */
  AVAILABLE: 'available',
  /** The gateway still lists it, the upstream no longer serves it. */
  DELISTED: 'delisted',
  /** Region / country / data-policy gate: not a property of the model. */
  GATED: 'gated',
  /** Nothing answered, and not for a reason above. */
  ERROR: 'error',
})

/** The full host ladder, probed only when there is no official contract. */
export const EFFORT_LADDER = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/**
 * Probe budgets. A sync is a diagnostic, not a benchmark: it must be cheap
 * enough that a user will press the button, so every request is small.
 */
/**
 * Per-request ceiling. A sync must not be able to hang: measured responses for a
 * 600-token reasoning probe land in single-digit seconds, so a minute and a half
 * means something is wrong and the run should say so rather than wait forever.
 */
export const REQUEST_TIMEOUT_MS = 90_000

export const AVAILABILITY_MAX_TOKENS = 16
export const REASONING_MAX_TOKENS = 600
export const REASONING_PROMPT =
  'Which is larger, 9.11 or 9.9? Think it through step by step, then state the answer.'

/** The request surface each protocol speaks. */
const PROTOCOL_PATH = Object.freeze({
  'openai-completions': 'chat/completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'v1/messages',
})

/**
 * The absolute URL one protocol is called at.
 *
 * Mirrors `baseUrlForProtocol` + the path the API implementation appends: the
 * OpenAI shapes append a bare path to the configured base (which is documented
 * to include `/v1`), while `anthropic-messages` goes through a client that
 * appends `/v1/messages`, so a base already ending in `/v1` must not double it.
 *
 * @param {string} protocol - one of {@link SUPPORTED_PROTOCOLS}.
 * @param {string} baseURL - the configured gateway base.
 * @returns {string} the URL to POST to.
 */
export function endpointFor(protocol, baseURL) {
  const base = String(baseURL ?? '').replace(/\/+$/u, '')
  const path = PROTOCOL_PATH[protocol] ?? PROTOCOL_PATH[FALLBACK_PROTOCOL]
  if (protocol !== 'anthropic-messages') return `${base}/${path}`
  return `${base.replace(/\/v1$/u, '')}/${path}`
}

/**
 * The two ways a model can be told not to think. They are genuinely different
 * mechanisms on the wire and a model may accept either, both or neither, so both
 * are probed and either one succeeding means the model has an off switch.
 *
 * `openai-responses` has no toggle field at all, so only the effort spelling
 * applies there — probing a field the dialect does not define would send a body
 * identical to "no reasoning asked for", which always succeeds and would claim
 * an off switch that was never tested.
 */
export const OFF_MECHANISMS = Object.freeze({
  EFFORT_NONE: 'reasoning_effort=none',
  THINKING_DISABLED: 'thinking=disabled',
})

/** The off-probe steps that exist on one protocol. */
export function offStepsFor(protocol) {
  const steps = [{ level: 'off', mechanism: OFF_MECHANISMS.EFFORT_NONE, wire: 'none' }]
  if (protocol !== 'openai-responses') {
    steps.push({ level: 'off', mechanism: OFF_MECHANISMS.THINKING_DISABLED, toggleOff: true })
  }
  return steps
}

/**
 * The body for one probe.
 *
 * The reasoning field is protocol-specific because the contracts are: the
 * OpenAI shapes carry a top-level effort (`reasoning_effort`, or
 * `reasoning.effort` on the Responses shape), while the Anthropic surface
 * carries `thinking.type` plus `output_config.effort` — which is exactly what
 * the first-party contracts in the baseline document for it
 * (e.g. `providers/deepseek/provider.toml`).
 *
 * @param {string} protocol - the protocol being probed.
 * @param {string} model - the model id.
 * @param {object} options - probe inputs.
 * @param {number} options.maxTokens - the output budget.
 * @param {string} options.prompt - the user turn.
 * @param {{ wire?: string, toggleOff?: boolean }} [options.reasoning] - the level, when probing one.
 * @returns {object} the JSON body.
 */
export function bodyFor(protocol, model, { maxTokens, prompt, reasoning }) {
  if (protocol === 'openai-responses') {
    const body = { model, input: prompt, max_output_tokens: Math.max(maxTokens, 16) }
    if (reasoning?.wire !== undefined) body.reasoning = { effort: reasoning.wire }
    return body
  }
  if (protocol === 'anthropic-messages') {
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
    if (reasoning !== undefined) {
      if (reasoning.toggleOff === true) body.thinking = { type: 'disabled' }
      else {
        body.thinking = { type: 'enabled' }
        if (reasoning.wire !== undefined) body.output_config = { effort: reasoning.wire }
      }
    }
    return body
  }
  const body = {
    model,
    stream: false,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  }
  if (reasoning !== undefined) {
    if (reasoning.toggleOff === true) body.thinking = { type: 'disabled' }
    else if (reasoning.wire !== undefined) body.reasoning_effort = reasoning.wire
  }
  return body
}

/** Headers one probe carries: the relay's routing header, plus Anthropic auth. */
function headersFor(protocol, { apiKey, baseHeaders, sessionHeaders }) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...baseHeaders,
    ...sessionHeaders,
  }
  if (protocol === 'anthropic-messages') {
    // The Anthropic surface authenticates with `x-api-key`; measured on the
    // gateway, a request carrying only `authorization` answers
    // `401 AuthError: Missing API key.`
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
  }
  return headers
}

/** Which reasoning field a reply used, if any. */
function reasoningFieldOf(message) {
  if (message === null || typeof message !== 'object') return undefined
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof message[field] === 'string' && message[field].length > 0) return field
  }
  return undefined
}

/**
 * Read whatever dialect answered into the few facts a sync needs.
 * @param {object | undefined} parsed - the decoded body, when it decoded.
 * @param {number | null} status - the HTTP status.
 * @returns {{ reasoningField?: string, reasoningChars: number, text: string }} the reply facts.
 */
export function readReply(parsed, status) {
  if (parsed === null || typeof parsed !== 'object' || (status ?? 0) >= 400) {
    return { reasoningChars: 0, text: '' }
  }
  // OpenAI chat shape
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
  if (choice !== undefined) {
    const message = choice.message ?? {}
    const field = reasoningFieldOf(message)
    return {
      reasoningField: field,
      reasoningChars: field === undefined ? 0 : String(message[field]).length,
      text: typeof message.content === 'string' ? message.content : '',
    }
  }
  // Anthropic shape: thinking and text are separate blocks.
  if (Array.isArray(parsed.content)) {
    let chars = 0
    let text = ''
    let field
    for (const block of parsed.content) {
      if (block?.type === 'thinking' || block?.type === 'reasoning') {
        chars += String(block.thinking ?? block.text ?? '').length
        field = 'thinking'
      } else if (block?.type === 'text') text += String(block.text ?? '')
    }
    return { reasoningField: field, reasoningChars: chars, text }
  }
  // OpenAI Responses shape: reasoning rides its own output item.
  if (Array.isArray(parsed.output)) {
    let chars = 0
    let text = ''
    let field
    for (const item of parsed.output) {
      for (const part of item?.content ?? []) {
        const value = String(part?.text ?? '')
        if (part?.type === 'output_text') text += value
        else if (part?.type === 'reasoning_text' || part?.type === 'summary_text') {
          chars += value.length
          field = 'reasoning'
        }
      }
    }
    return { reasoningField: field, reasoningChars: chars, text }
  }
  return { reasoningChars: 0, text: '' }
}

/**
 * Classify a failed probe.
 *
 * The gateway distinguishes these itself, so the verdict is read rather than
 * inferred: a dead upstream says `Model is unavailable`, a gate names itself,
 * and a protocol mismatch says `not supported for format X` — which is the one
 * failure that means "try another protocol" rather than "this model is gone".
 *
 * @param {number | null} status - the HTTP status.
 * @param {object | undefined} parsed - the decoded body.
 * @param {string} raw - the body text, when it did not decode.
 * @returns {{ status: string, reason: string, retryable: boolean }} the verdict.
 */
export function classifyFailure(status, parsed, raw) {
  const blob = `${parsed === undefined ? '' : JSON.stringify(parsed)} ${raw}`.slice(0, 2000)
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(blob)?.[1]?.replace(/\\"/gu, '"')
  const text = message ?? blob.trim().slice(0, 240)
  if (/Model is unavailable/iu.test(blob)) {
    return { status: SYNC_STATUS.DELISTED, reason: `上游已下架：${text}`, retryable: false }
  }
  if (/RegionError|only available hosted in China|not available in your country/iu.test(blob)) {
    return { status: SYNC_STATUS.GATED, reason: `区域门控：${text}`, retryable: false }
  }
  if (/unsupported_country_region_territory|DataPolicyError|collects data used to improve/iu.test(blob)) {
    return { status: SYNC_STATUS.GATED, reason: `区域/数据政策门控：${text}`, retryable: false }
  }
  if (/not supported for format\s+(\S+)/iu.test(blob)) {
    const format = /not supported for format\s+(\S+)/iu.exec(blob)?.[1] ?? '?'
    return { status: SYNC_STATUS.ERROR, reason: `该协议不可用（format ${format}）`, retryable: true }
  }
  if (/MissingSessionID/iu.test(blob)) {
    return { status: SYNC_STATUS.ERROR, reason: `缺少会话头（插件配置问题，不是模型问题）：${text}`, retryable: true }
  }
  return { status: SYNC_STATUS.ERROR, reason: text === '' ? `HTTP ${String(status)}` : text, retryable: true }
}

/** One request, normalized. Never throws: a transport failure is a result. */
async function probe({ protocol, model, apiKey, baseURL, baseHeaders, sessionHeaders, fetchImpl, body, signal, timeoutMs }) {
  const url = endpointFor(protocol, baseURL)
  const row = { protocol, url, status: null, ok: false, note: '', reasoningField: undefined }
  const ceiling = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS
  // `AbortSignal.any` keeps BOTH reasons: the caller's stop and this ceiling.
  // A single signal cannot express "abort if either happens".
  const timeout = AbortSignal.timeout(ceiling)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: headersFor(protocol, { apiKey, baseHeaders, sessionHeaders }),
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    row.note = aborted
      ? `请求超时/被中止（上限 ${Math.round(ceiling / 1000)}s）`
      : `transport: ${error instanceof Error ? error.message : String(error)}`
    row.timedOut = aborted
    return { row, verdict: { status: SYNC_STATUS.ERROR, reason: row.note, retryable: true }, reply: undefined }
  }
  const text = await response.text().catch(() => '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  row.status = response.status
  row.ok = response.ok
  const reply = readReply(parsed, response.status)
  row.reasoningField = reply.reasoningField
  if (response.ok) return { row, verdict: undefined, reply }
  const verdict = classifyFailure(response.status, parsed, text)
  row.note = verdict.reason
  return { row, verdict, reply }
}

/**
 * Establish what one model id can do.
 *
 * @param {object} args - the sync inputs.
 * @param {string} args.id - the model id.
 * @param {string} args.baseURL - the configured gateway base.
 * @param {string} args.apiKey - the connection credential.
 * @param {(url: string, init: object) => Promise<Response>} args.fetchImpl - fetch.
 * @param {() => Record<string, string>} args.baseHeaders - mandatory attribution.
 * @param {() => Record<string, string>} args.sessionHeaders - the relay routing header.
 * @param {{ primary: string, source: string }} args.protocol - the recommendation.
 * @param {(id: string, protocol: string) => readonly string[]} [args.alternates] - other protocols worth trying, in order.
 * @param {object | undefined} args.official - the official baseline record for this id.
 * @param {AbortSignal} [args.signal] - caller cancellation.
 * @returns {Promise<object>} the sync result. Never throws for a model fault.
 */
export async function syncModel({
  id, baseURL, apiKey, fetchImpl, baseHeaders, sessionHeaders, protocol, alternates, official, signal, timeoutMs,
}) {
  const evidence = []
  const record = (row) => {
    evidence.push(row)
    return row
  }

  // Resolve the header sources ONCE. They arrive as thunks so a caller can
  // build them from live facts, but `headersFor` spreads objects — passing the
  // thunks straight through silently produced empty headers, which would have
  // turned every probe into a `MissingSessionID` against the real gateway.
  const resolvedBaseHeaders = typeof baseHeaders === 'function' ? baseHeaders() : (baseHeaders ?? {})
  const resolvedSessionHeaders = typeof sessionHeaders === 'function' ? sessionHeaders() : (sessionHeaders ?? {})
  const headers = { baseHeaders: resolvedBaseHeaders, sessionHeaders: resolvedSessionHeaders }
  if (resolvedSessionHeaders === null || typeof resolvedSessionHeaders !== 'object') {
    throw new Error('syncModel: sessionHeaders must resolve to an object')
  }

  // ── 1. availability, on the recommended protocol ─────────────────────────
  const recommended = protocol?.primary ?? FALLBACK_PROTOCOL
  const candidates = [recommended, ...(alternates?.(id, recommended) ?? []), ...SUPPORTED_PROTOCOLS]
    .filter((value, index, all) => SUPPORTED_PROTOCOLS.includes(value) && all.indexOf(value) === index)

  let chosen
  let refusal
  for (const candidate of candidates) {
    const { row, verdict, reply } = await probe({
      protocol: candidate,
      model: id,
      apiKey,
      baseURL,
      ...headers,
      fetchImpl,
      timeoutMs,
      body: bodyFor(candidate, id, { maxTokens: AVAILABILITY_MAX_TOKENS, prompt: 'Reply with exactly: OK' }),
      signal,
    })
    record({ step: 'availability', ...row })
    if (row.ok) {
      chosen = candidate
      break
    }
    refusal = verdict
    // A dead upstream or a gate is a property of the id, not of the protocol:
    // probing the rest would only spend requests to be told the same thing.
    if (verdict.retryable !== true) break
  }

  const available = chosen !== undefined
  const works = evidence.filter((row) => row.step === 'availability' && row.ok).map((row) => row.protocol)

  const base = {
    kind: SYNC_KIND,
    version: SYNC_VERSION,
    id,
    available,
    status: available ? SYNC_STATUS.AVAILABLE : (refusal?.status ?? SYNC_STATUS.ERROR),
    reason: available ? undefined : refusal?.reason,
    protocol: {
      recommended,
      source: protocol?.source,
      chosen,
      works,
      verified: works.includes(recommended),
    },
    evidence,
  }

  // ── 2. the facts that are DECLARED, never probed ─────────────────────────
  base.contextWindow = official?.contextWindow
  base.maxTokens = official?.maxTokens
  base.input = Array.isArray(official?.input) ? official.input : []
  base.officialPresent = official !== undefined

  if (!available) return base

  // ── 3. reasoning ─────────────────────────────────────────────────────────
  // The official contract is probed first. Only if it is absent — or a level
  // the provider declared is refused by the provider's own gateway — does the
  // whole ladder get probed.
  const declared = Array.isArray(official?.reasoningOptions) ? official.reasoningOptions : []
  const plan = declared.length > 0
    ? declaredPlan(declared, chosen)
    : ladderPlan(chosen)

  const accepted = []
  const rejected = []
  const offMechanisms = []
  let observedField
  for (const step of plan) {
    const { row, reply } = await probe({
      protocol: chosen,
      model: id,
      apiKey,
      baseURL,
      ...headers,
      fetchImpl,
      timeoutMs,
      body: bodyFor(chosen, id, {
        maxTokens: REASONING_MAX_TOKENS,
        prompt: REASONING_PROMPT,
        reasoning: { wire: step.wire, toggleOff: step.toggleOff },
      }),
      signal,
    })
    record({
      step: 'reasoning',
      level: step.level,
      wire: step.wire,
      mechanism: step.mechanism,
      toggleOff: step.toggleOff === true,
      ...row,
    })
    if (row.ok) {
      accepted.push(step)
      if (step.level === 'off' && step.mechanism !== undefined) offMechanisms.push(step.mechanism)
      if (reply?.reasoningField !== undefined) observedField = reply.reasoningField
    } else {
      rejected.push({ ...step, note: row.note })
    }
  }

  // The contract "works" only if every level it declares was accepted. An off
  // mechanism that failed is not held against it: a model may simply offer only
  // one of the two ways to switch thinking off.
  const levelSteps = plan.filter((step) => step.level !== 'off')
  const declaredAllAccepted = declared.length > 0
    && levelSteps.length > 0
    && levelSteps.every((step) => accepted.includes(step))
  const levels = {}
  for (const step of accepted) if (step.level !== 'off') levels[step.level] = step.wire

  base.reasoning = {
    source: declaredAllAccepted ? 'official' : (declared.length > 0 ? 'ladder (official contract refused)' : 'ladder'),
    contract: official?.reasoningContract,
    declaredContractWorks: declared.length === 0 ? undefined : declaredAllAccepted,
    levels,
    // `off` is not a configurable level in this plugin (it means "omit the
    // parameter"), so it is reported separately, along with WHICH mechanism
    // actually switched thinking off.
    hasOff: offMechanisms.length > 0,
    offMechanisms,
    rejected: rejected.map(({ level, wire, mechanism, note }) => ({ level, wire, mechanism, note })),
    probeCount: plan.length,
  }
  // D5: the field the reply actually used is measured here for free, and it has
  // been observed to differ from the snapshot (kimi-k3 answers on `reasoning`).
  base.interleavedField = observedField ?? official?.interleavedField
  base.interleavedFieldSource = observedField === undefined ? 'official' : 'measured'
  return base
}

/** The levels an official contract implies, in ladder order. */
function declaredPlan(options, protocol) {
  const { levels, hasOff } = reasoningLevels(options)
  // An explicit `none` is a declared off switch in its own right, so the effort
  // spelling is probed whenever the provider spells one — not only when it also
  // declares a toggle.
  const declaresNone = (options ?? []).some((option) => option.type === 'effort'
    && Array.isArray(option.values)
    && option.values.some((value) => String(value).toLowerCase() === 'none'))
  const plan = offStepsFor(protocol).filter((step) =>
    step.mechanism === OFF_MECHANISMS.EFFORT_NONE ? (hasOff || declaresNone) : hasOff)
  for (const level of EFFORT_LADDER) {
    if (levels[level] !== undefined) plan.push({ level, wire: levels[level] })
  }
  return plan
}

/** The whole ladder, used only when there is no official contract. */
function ladderPlan(protocol) {
  const plan = [...offStepsFor(protocol)]
  for (const level of EFFORT_LADDER) {
    if (level === 'none') continue // `none` IS the off switch; probed above
    plan.push({ level, wire: level })
  }
  return plan
}

/**
 * The `models.overrides[id]` entry a sync result implies.
 *
 * Only the keys the override vocabulary accepts are emitted; the wire
 * spellings travel in the synced layer instead, because `reasoningEfforts`
 * names host levels and cannot express `minimal → minimum`.
 *
 * @param {object} result - a {@link syncModel} result.
 * @returns {object} the override entry, or `{}` when nothing is known.
 */
export function overridesFromSync(result) {
  if (result?.available !== true) return {}
  const out = {}
  if (result.protocol?.chosen !== undefined) out.api = result.protocol.chosen
  if (Number.isSafeInteger(result.contextWindow)) out.contextWindow = result.contextWindow
  if (Number.isSafeInteger(result.maxTokens)) out.maxTokens = result.maxTokens
  if (Array.isArray(result.input) && result.input.length > 0) out.input = result.input
  const levels = Object.keys(result.reasoning?.levels ?? {})
  out.reasoning = levels.length > 0 || result.reasoning?.hasOff === true
  out.reasoningEfforts = levels
  return out
}

/**
 * The synced layer for one model: the wire spellings an override cannot carry.
 * @param {object} result - a {@link syncModel} result.
 * @returns {object} the layer entry.
 */
export function syncedLayerFromSync(result) {
  return {
    id: result.id,
    syncedAt: new Date().toISOString(),
    status: result.status,
    protocol: result.protocol,
    reasoning: result.reasoning,
    interleavedField: result.interleavedField,
    interleavedFieldSource: result.interleavedFieldSource,
    evidence: result.evidence,
  }
}
