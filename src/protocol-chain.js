/**
 * The fallback driver: run one model request through an ordered protocol chain,
 * switching protocols only while the attempt has produced nothing the caller
 * could have seen.
 *
 * Why this exists (DESIGN.md §2.2 and the phase-2 audit): this gateway's
 * behaviour is dynamic. `grok-4.6` once failed on both protocols and then
 * answered `200` on `openai-responses` twice in a row; four models the npm rule
 * places on `anthropic-messages` are served no `anthropic-messages` path at all;
 * and `deepseek-v4.1-flash` answers on two protocols. A static table cannot
 * express that, so the table decides the PRIMARY and this driver recovers.
 *
 * The invariant that makes retrying safe:
 *
 *   **An attempt may be abandoned only before any chunk other than `usage` has
 *   been yielded to the caller.** Those chunks are withheld in a small buffer
 *   precisely because they are discardable metadata of a failed attempt, so a
 *   retry cannot duplicate content. Once a content chunk has been yielded the
 *   attempt is committed: the error is surfaced exactly as phase 1 surfaced it,
 *   with no second request.
 *
 * Classification is evidence-based; the failure strings it recognizes are the
 * ones this endpoint actually returned (see `tests/protocol-chain.test.mjs` and
 * `data/protocol-matrix.*.json`).
 *
 * @module dsh-opencodego/protocol-chain
 */

/** What kind of protocol-level problem a failure is. */
export const PROTOCOL_FAILURE = Object.freeze({
  /** The endpoint refuses this protocol FORMAT for this model (401/404/405/415). */
  FORMAT: 'format',
  /** A temporary upstream/transport problem (5xx, socket, relay upstream failure). */
  TRANSIENT: 'transient',
  /** Anything switching protocol cannot fix: region/data-policy gates, unknown model, bad request. */
  FATAL: 'fatal',
})

/** Render any failure shape (Error, host failure object, string) as text. */
export function failureText(failure) {
  if (failure === undefined || failure === null) return ''
  if (typeof failure === 'string') return failure
  if (typeof failure.message === 'string') return failure.message
  return String(failure)
}

/**
 * The HTTP status a failure message names, when it names one.
 *
 * pi-ai's error strings put the status in one of three places: a leading
 * `404 <html…`, a parenthesized `OpenAI API error (401): …`, or an explicit
 * `HTTP 500`. Only those anchored positions are read, so a status-looking number
 * inside a JSON error body (a model id, a token count) cannot be mistaken for
 * the status.
 * @param {unknown} failure - any failure shape.
 * @returns {number | undefined} the status code.
 */
export function httpStatusOf(failure) {
  const text = failureText(failure)
  const patterns = [
    /\bHTTP\s+(\d{3})\b/i,
    /\((\d{3})\)/,
    /^\s*(?:Error:\s*)?(?:status\s*)?(\d{3})\b/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null) return Number(match[1])
  }
  return undefined
}

/**
 * Classify one failure into {@link PROTOCOL_FAILURE}.
 *
 * Order matters and is deliberate: the "explicit opt-in" gates are checked
 * FIRST, because those 403 bodies also mention the model and could otherwise be
 * matched by a looser rule. Switching protocol cannot satisfy an account or
 * geography gate, and retrying it would only add latency to an error the user
 * must resolve in their workspace.
 *
 * @param {unknown} failure - any failure shape.
 * @returns {'format' | 'transient' | 'fatal'} the kind.
 */
export function protocolFailureKind(failure) {
  const text = failureText(failure)
  // 1. Gates no protocol can pass.
  if (/RegionError|DataPolicyError|requires explicit opt[- ]?in|unsupported_country_region_territory|Country, region, or territory not supported/iu.test(text)) {
    return PROTOCOL_FAILURE.FATAL
  }
  const status = httpStatusOf(failure)
  if (status === 401 || status === 403) {
    // 401 is ambiguous on its own: the relay uses it both for "Model is not
    // supported for format <api>" (a protocol problem) and for an unusable
    // credential/model. Only the explicit format wording is retryable.
    return /not supported for format|format oa-compat|invalid format/iu.test(text)
      ? PROTOCOL_FAILURE.FORMAT
      : PROTOCOL_FAILURE.FATAL
  }
  // 2. Protocol-format rejections.
  if (/not supported for format|format oa-compat/iu.test(text)) return PROTOCOL_FAILURE.FORMAT
  // A path this gateway does not serve at all answers with its web app's HTML
  // 404 page (measured for `POST {base}/messages`). That is a protocol-routing
  // fact, not a missing resource, so it is retryable.
  if (status === 404 && /<!doctype html|<html/iu.test(text)) return PROTOCOL_FAILURE.FORMAT
  if (status === 404 || status === 405 || status === 415 || status === 501) return PROTOCOL_FAILURE.FORMAT
  // 3. A model the gateway is not serving. This is checked BEFORE the transient
  // wording below because the relay wraps it: a real answer is
  // `400 …: Upstream request failed: Model is unavailable.` — switching
  // protocol, or retrying, cannot make an unavailable model available.
  if (/Model is unavailable|is not supported/iu.test(text)) return PROTOCOL_FAILURE.FATAL
  // 4. Transient upstream/transport problems.
  if (status !== undefined && status >= 500) return PROTOCOL_FAILURE.TRANSIENT
  if (/upstream request failed|internal server error|temporarily unavailable|overloaded|service unavailable|ECONN[A-Z]+|fetch failed|socket hang up|network error/iu.test(text)) {
    return PROTOCOL_FAILURE.TRANSIENT
  }
  // 5. Everything else: a bad request, an unknown id, an unclassified refusal.
  return PROTOCOL_FAILURE.FATAL
}

/**
 * Whether {@link protocolFailureKind} says a switch to another protocol (or a
 * repeat of the same one, for a transient problem) is worth attempting.
 *
 * `403` is explicitly NOT retryable: `RegionError`, `DataPolicyError` and the
 * country block all answer 403 with an opt-in instruction, and the user must
 * act in their workspace — a second protocol merely hides the instruction.
 *
 * @param {unknown} failure - any failure shape.
 * @returns {boolean} true for {@link PROTOCOL_FAILURE.FORMAT} and `transient`.
 */
export function retryableProtocolFailure(failure) {
  const kind = protocolFailureKind(failure)
  return kind === PROTOCOL_FAILURE.FORMAT || kind === PROTOCOL_FAILURE.TRANSIENT
}

/**
 * The default error when every candidate protocol has been tried: the full
 * attempt list in the message, the last real failure as `cause`.
 * @param {object[]} attempts - the recorded attempts.
 * @param {unknown} lastFailure - the last failure seen.
 * @returns {Error} the error to throw.
 */
export function chainExhaustedError(attempts, lastFailure) {
  const summary = attempts
    .map((entry) => `${entry.protocol} (${entry.kind}, attempt ${entry.attempt + 1}): ${entry.message}`)
    .join(' | ')
  const error = new Error(
    `opencode-go-native: every candidate protocol failed — ${summary.length > 0 ? summary : 'no attempt was made'}`,
  )
  error.cause = lastFailure
  /** @type {object[]} */
  error.attempts = attempts
  return error
}

/**
 * Drive one request through a protocol chain.
 *
 * @param {object} options - the run.
 * @param {readonly string[]} options.chain - candidate protocols, primary first.
 * @param {(protocol: string, attempt: number) => AsyncIterable<object>} options.attempt
 *   Build one attempt's chunk stream. Called once per try; must be cheap to
 *   abandon.
 * @param {number} [options.maxAttemptsPerProtocol] - tries per protocol for TRANSIENT
 *   failures (default 2: the first try plus one retry). A FORMAT failure always
 *   moves straight to the next protocol.
 * @param {(failure: unknown) => boolean} [options.isRetryable] - retry predicate.
 * @param {(failure: unknown) => string} [options.kindOf] - classifier.
 * @param {(protocol: string, failure: unknown, outcome: { kind: string, committed: boolean, attempt: number }) => void} [options.onAttempt]
 *   Observability hook; never throws into the stream (its errors are swallowed
 *   except for programming mistakes, which surface as a rejected iteration).
 * @param {(attempts: object[], lastFailure: unknown) => Error} [options.buildError] - final error factory.
 * @returns {AsyncIterable<object>} harness `StreamChunk`s.
 */
export async function* streamWithProtocolChain(options) {
  const {
    chain,
    attempt,
    maxAttemptsPerProtocol = 2,
    isRetryable = retryableProtocolFailure,
    kindOf = protocolFailureKind,
    buildError = chainExhaustedError,
  } = options
  const notify = typeof options.onAttempt === 'function' ? options.onAttempt : () => {}
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error('opencode-go-native: the protocol chain is empty; a request needs at least one candidate protocol')
  }
  const tries = Number.isSafeInteger(maxAttemptsPerProtocol) && maxAttemptsPerProtocol > 0 ? maxAttemptsPerProtocol : 1

  /** @type {object[]} */
  const attempts = []
  let lastFailure
  /** The last withheld terminal pair, replayed when the chain is exhausted. */
  let lastTerminal

  const record = (protocol, tryIndex, failure, outcome) => {
    try {
      notify(protocol, failure, { ...outcome, attempt: tryIndex })
    } catch {
      // Observability must never change the request outcome.
    }
  }

  for (const protocol of chain) {
    for (let tryIndex = 0; tryIndex < tries; tryIndex++) {
      /** @type {object[]} */
      const withheld = []
      let committed = false
      let iterator
      let retry = false
      try {
        iterator = attempt(protocol, tryIndex)[Symbol.asyncIterator]()
        while (true) {
          const step = await iterator.next()
          if (step.done) {
            for (const held of withheld) yield held
            record(protocol, tryIndex, undefined, { kind: 'ok', committed })
            return
          }
          const chunk = step.value
          if (chunk?.type === 'finish') {
            const failure = chunk.reason?.kind === 'error' ? chunk.reason.failure : undefined
            if (failure !== undefined && !committed && isRetryable(failure)) {
              const kind = kindOf(failure)
              attempts.push({ protocol, attempt: tryIndex, kind, message: failureText(failure) })
              lastFailure = failure
              lastTerminal = { usage: [...withheld], finish: chunk }
              record(protocol, tryIndex, failure, { kind: 'retryable', committed: false })
              retry = true
              break
            }
            for (const held of withheld) yield held
            withheld.length = 0
            record(protocol, tryIndex, failure, {
              kind: failure === undefined ? 'ok' : committed ? 'after-output' : 'fatal',
              committed,
            })
            yield chunk
            return
          }
          if (chunk?.type === 'usage' && !committed) {
            // Withheld: safe to discard if this attempt is abandoned, and the
            // harness contract wants usage before the terminal finish chunk.
            withheld.push(chunk)
            continue
          }
          committed = true
          for (const held of withheld) yield held
          withheld.length = 0
          yield chunk
        }
      } catch (error) {
        const kind = kindOf(error)
        attempts.push({ protocol, attempt: tryIndex, kind, message: failureText(error) })
        lastFailure = error
        if (committed) {
          record(protocol, tryIndex, error, { kind: 'after-output', committed: true })
          throw error
        }
        if (!isRetryable(error)) {
          record(protocol, tryIndex, error, { kind: 'fatal', committed: false })
          throw error
        }
        lastTerminal = undefined
        record(protocol, tryIndex, error, { kind: 'retryable', committed: false })
        retry = true
      } finally {
        try {
          await iterator?.return?.()
        } catch {
          // The abandoned attempt's transport is already being torn down by its
          // own abort controller; a failed close is not a request failure.
        }
      }
      if (!retry) break
      const kind = kindOf(lastFailure)
      // A transient problem may clear on a second try of the SAME protocol
      // (an upstream blip on the only protocol a model speaks is otherwise
      // unrecoverable); a format rejection never does.
      if (kind === PROTOCOL_FAILURE.TRANSIENT && tryIndex + 1 < tries) continue
      break
    }
  }
  if (lastTerminal !== undefined) {
    for (const held of lastTerminal.usage) yield held
    yield lastTerminal.finish
    return
  }
  throw buildError(attempts, lastFailure)
}
