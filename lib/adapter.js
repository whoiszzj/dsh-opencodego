/**
 * `OpenCodeGoAdapter`: one harness provider route serving every model a gateway
 * advertises, each with its own wire protocol AND its own fallback chain.
 *
 * The defining mechanism is the design notes §2.1: pi-ai reads a model's OWN `api` and
 * `baseUrl` (a provider-level base URL is ignored), and `createProvider`
 * dispatches on `model.api` when handed an api MAP. So one route can serve
 * `openai-completions`, `openai-responses`, and `anthropic-messages` at once —
 * which is exactly what the official `llm-pi-ai` adapter cannot do, because it
 * flattens the model base URL into a route-level one.
 *
 * Phase 2 adds three things on top of the phase-1 loop:
 *
 *   1. **Capability prefill** from the versioned models.dev snapshot
 *      (`capabilities.js`), with the endpoint as the source of truth for which
 *      models exist and the snapshot only ever describing them;
 *   2. **A candidate protocol chain per model** (`protocol-map.js`) driven by
 *      `protocol-chain.js`, which may abandon an attempt only before a content
 *      chunk has been yielded to the caller;
 *   3. **Health and learned refusals** (`health.js`, `protocol-memo.js`) so a
 *      protocol this endpoint does not serve is tried once, not once per call.
 *
 * Every outbound HTTP request carries `attributionHeaders()`. No harness
 * telemetry (anonymous user id, session id, …) is ever added.
 *
 * @module dsh-opencodego/adapter
 */

import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  compatFor,
  imageRequestSupport,
  modelCapabilitiesWithOverrides,
  selectableThinkingLevels,
} from './capabilities.js'
import { PKG, SUPPORTED_PROTOCOLS } from './config.js'
import { buildDiagnosticsView } from './diagnostics.js'
import { EndpointHealthLog } from './health.js'
import { claimLayersFor, effectiveModelIds, modelSource } from './models.js'
import { classifyPiAiError, toPiContext, toStreamChunks } from './pi-ai.js'
import { protocolChainForModel, resolveProtocol } from './protocol-map.js'
import { ProtocolRejectionMemo, DEFAULT_PROTOCOL_MEMO_TTL_MS } from './protocol-memo.js'
import {
  chainExhaustedError,
  failureText,
  PROTOCOL_FAILURE,
  protocolFailureKind,
  retryableProtocolFailure,
  streamWithProtocolChain,
} from './protocol-chain.js'
import { adaptRequestForProtocol, baseUrlForProtocol } from './request-adapt.js'
import { requestHeaders, SessionHeaderMap } from './session.js'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * Lazily import the parts of pi-ai this adapter drives.
 *
 * the design notes §2.9: `@earendil-works/pi-ai` is not a declared dsh dependency — it
 * is a package the profile resolves (the official `dsh-llm-pi-ai` adapter
 * imports the very same specifiers). Importing lazily keeps the import
 * failure at first use with a named diagnostic instead of at plugin load,
 * where it would take the whole route down.
 *
 * @returns {Promise<object>} the pi-ai surface plus the three protocol impls.
 */
let piAiPromise
function loadPiAi() {
  if (piAiPromise === undefined) {
    piAiPromise = (async () => {
      try {
        const [core, completions, responses, anthropic] = await Promise.all([
          import('@earendil-works/pi-ai'),
          import('@earendil-works/pi-ai/api/openai-completions.lazy'),
          import('@earendil-works/pi-ai/api/openai-responses.lazy'),
          import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
        ])
        return {
          createModels: core.createModels,
          createProvider: core.createProvider,
          apis: {
            'openai-completions': completions.openAICompletionsApi(),
            'openai-responses': responses.openAIResponsesApi(),
            'anthropic-messages': anthropic.anthropicMessagesApi(),
          },
        }
      } catch (error) {
        throw new LlmError(
          `${PKG}: cannot load @earendil-works/pi-ai, which this adapter needs to speak any wire `
          + 'protocol; it ships inside the dsh installation and must resolve from the profile '
          + `(${error instanceof Error ? error.message : String(error)})`,
          'MISSING_DEPENDENCY',
          { cause: error },
        )
      }
    })()
  }
  return piAiPromise
}

/**
 * The reasoning effort to hand pi-ai, or `undefined`.
 *
 * pi-ai's `StreamOptions.reasoning` is a `ThinkingLevel` (no `off`) and pi-ai
 * clamps it against the model's `thinkingLevelMap` itself, so `off` simply means
 * "omit the option" and an unsupported level is clamped rather than refused.
 * @param {unknown} effort - the harness `GenerateOptions.reasoningEffort`.
 * @returns {string | undefined} the value for pi-ai.
 */
function reasoningOf(effort) {
  if (effort === undefined || effort === null || effort === 'off') return undefined
  return String(effort)
}

/**
 * The gateway adapter. One instance serves the single route it is registered
 * under; the harness model id IS the wire model id, and every operation reads
 * the current connection facts instead of facts frozen at load.
 *
 * Since 0.8 that one route sits in front of N SUBSCRIPTIONS (API keys), of which
 * EXACTLY ONE is active: `config.subs#active()` names it and `activeKey()` is
 * the only credential a request resolves. There is no rotation and no failover —
 * a failure is reported to the caller, and switching who pays stays an operator
 * act in the settings list. (The pool that used to rotate keys on a quota/auth
 * failure was removed in 0.8.2 with the single-active redesign.)
 */
export class OpenCodeGoAdapter extends LlmAdapter {
  /**
   * @param {object} config - the plugin's host seams.
   * @param {object} config.provider - the route key this instance owns.
   * @param {() => object} config.options - current resolved connection facts.
   * @param {() => Promise<string>} config.resolveApiKey - current bearer token
   *   (the DEFAULT subscription's; `config.subs#activeKey()` supersedes it for
   *   the request path and stays the fallback for programmatic construction).
   * @param {import('./catalog.js').ModelCatalog} config.catalog - the model catalog.
   * @param {(level: string, message: string) => void} config.log - host logger.
   * @param {import('./subruntime.js').object} [config.subs] - the subscription
   *   runtime (`active`/`activeKey`/`rows`). Absent means "one implicit
   *   subscription", which is the pre-0.8 programmatic shape.
   * @param {() => object | undefined} [config.resolveAttachments] - the durable
   *   attachment service, read at request time (it may activate after this plugin).
   * @param {(attachments: object, ref: object) => object | undefined} [config.resolveImageAccess]
   *   - maps one durable image reference into the current tool execution world.
   * @param {object[]} [config.logged] - the plugin's own bounded log ring, so a
   *   diagnostic surface can read the lines this route emitted.
   */
  constructor(config) {
    super()
    this.config = config
    /** @type {{ key: object, models: object, provider: object } | undefined} */
    this.snapshot = undefined
    /**
     * Stable session-header values for the relay protocol this route uses.
     *
     * Deliberately ONE map for the adapter's lifetime: a value is a property of
     * the conversation, not of a configuration snapshot, so an unrelated
     * settings change must not re-mint every session (which would silently
     * discard the relay affinity the header exists to provide). The map is
     * keyed by `mode \\u0000 hostId`, so changing `sessionHeaderMode` DOES take
     * effect on the next request while the values already handed out under the
     * other mode stay stable (the design notes §2.4.2).
     */
    this.sessions = new SessionHeaderMap(config.sessionMode)
    /**
     * What this endpoint has said about each model. Plugin-owned diagnostics;
     * read it from a probe, a settings page or a log line — it is never pushed
     * into a host model-information field that does not define it.
     */
    this.health = new EndpointHealthLog()
    /** Learned protocol refusals, so a wrong protocol is paid for once. */
    this.memo = new ProtocolRejectionMemo({ ttlMs: DEFAULT_PROTOCOL_MEMO_TTL_MS })
    /** Model+category pairs whose operator action has already been logged. */
    this.announced = new Set()
    /** The plugin's own log ring (shared with the entry point's `log`). */
    this.logged = config.logged ?? []
  }

  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Go (native)' }
  }

  /**
   * The diagnostics payload a settings page consumes (phase 4a's 诊断面).
   *
   * Composed from state this adapter already keeps — the bounded log ring
   * (`this.logged`), the endpoint health log (`this.health`), the catalogue's
   * diagnostics and the current connection facts — and never from a new
   * recording source. `buildDiagnosticsView` is pure, so calling this is
   * side-effect free and cheap.
   *
   * @param {object} [limits] - per-list caps, forwarded to the view builder.
   * @returns {object} a JSON-serializable payload.
   */
  diagnostics(limits) {
    const options = this.config.options()
    return buildDiagnosticsView({
      options,
      discovered: this.config.catalog.models(),
      logged: this.logged,
      health: this.health,
      catalogDiagnostics: this.config.catalog.diagnostics,
      adapterSnapshot: this.snapshot,
      // 0.8: the per-subscription rows (label, credential slot, which one is
      // active, last-known balance). Derived from runtime state like everything
      // else here — a diagnostics read itself probes nothing, which is why this
      // uses the sync `rows()` and not the credential-describing `view()`.
      subscriptions: this.config.subs !== undefined ? this.config.subs.rows() : undefined,
    }, limits)
  }

  /**
   * The capability facts for one model id under the current configuration.
   *
   * Computed per call rather than cached: the catalog is consulted for the
   * snapshot record, so a settings change (or a model the snapshot only learns
   * about at the next refresh) is reflected on the very next request instead of
   * at the next catalog TTL.
   *
   * The configuration layers (phase 4a) are applied INSIDE the mapper rather
   * than by patching its result here, because the mapper owns the two
   * invariants a correction must not break: a modality the host cannot carry is
   * still filtered (and recorded), and a configured reasoning level is pinned by
   * the same rules a catalogued one is (the design notes §2.11). An `extra` declaration
   * is applied before an `models.overrides[id]` correction, so the more specific
   * address wins.
   *
   * @param {string} modelId - the gateway model id.
   * @param {object} options - current connection facts.
   * @returns {object} mapped capability facts.
   */
  #facts(modelId, options) {
    return modelCapabilitiesWithOverrides(
      this.config.catalog.snapshotEntryFor(modelId),
      options,
      claimLayersFor(options.models, modelId),
    )
  }

  /** The models this route currently serves, configuration overlay included. */
  #effectiveModels(options) {
    return this.config.catalog.effectiveModels(options)
  }

  /**
   * Build the pi-ai `Model` descriptor for one gateway model on one protocol.
   *
   * Both `api` and `baseUrl` are per-model on purpose (the design notes §2.1), and the
   * descriptor is rebuilt per protocol attempt because its `api` — and therefore
   * the request shape AND the endpoint path pi-ai builds — differs:
   * `anthropic-messages` goes through the Anthropic SDK, which appends
   * `/v1/messages`, so it must not receive a base that already ends in `/v1`
   * (see `baseUrlForProtocol`).
   * @param {object} args - the descriptor inputs.
   * @returns {object} a pi-ai model descriptor.
   */
  #descriptor({ modelId, name, options, protocol, facts }) {
    const compat = compatFor(facts)
    return {
      id: modelId,
      name,
      provider: this.config.provider,
      api: protocol,
      baseUrl: baseUrlForProtocol(protocol, options.baseURL),
      reasoning: facts.reasoning,
      ...facts.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: facts.thinkingLevelMap },
      input: facts.input,
      cost: facts.cost,
      contextWindow: facts.contextWindow,
      maxTokens: facts.maxTokens,
      ...compat === undefined ? {} : { compat },
    }
  }

  /**
   * The declared name for one model: an `extra` declaration wins (it is the only
   * place a name can be configured), then the endpoint's own name, then the
   * catalogued one, then the id.
   */
  #nameOf(modelId, options = this.config.options()) {
    const declared = options.models?.extra?.[modelId]?.name
    if (declared !== undefined) return declared
    return this.config.catalog.find(modelId)?.name ?? modelId
  }

  listModels(provider) {
    return (async () => {
      await this.config.catalog.refresh()
      const options = this.config.options()
      return this.#effectiveModels(options).map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: this.#facts(model.id, options).input,
      }))
    })()
  }

  resolveModel(provider, model) {
    // Deliberately cache-only: this runs on the hot path of every request and
    // of every capability query, so it must not perform network I/O. A cold
    // catalog answers with the catalogued facts (or the conservative defaults)
    // instead.
    const options = this.config.options()
    const facts = this.#facts(model, options)
    const levels = facts.reasoning
      ? selectableThinkingLevels(facts.reasoning, facts.thinkingLevelMap)
      : []
    return Promise.resolve({
      provider,
      id: model,
      name: this.#nameOf(model),
      inputModalities: facts.input,
      context: { contextWindow: facts.contextWindow },
      defaultMaxTokens: facts.maxTokens,
      // Only reported when there is a level beyond `off`: a surface that could
      // offer nothing but `off` would be a control that cannot change the
      // request (pi-ai expresses `off` by omitting the reasoning option).
      ...levels.length === 0 ? {} : {
        reasoning: {
          efforts: levels.map((level) => ({
            id: level,
            name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
          })),
        },
      },
    })
  }

  /**
   * Build (once per connection snapshot) the pi-ai collection holding this
   * route's provider.
   *
   * Identity comparison is the cache invalidation, and it is deliberately
   * two-part:
   *
   *   1. `options()` returns a fresh object per configuration resolution, so an
   *      unchanged configuration is recognized and a changed one rebuilds the
   *      collection while any request already holding the previous snapshot keeps
   *      working;
   *   2. the EFFECTIVE model-id list is compared as well, so a change whose only
   *      effect is on the model set (adding an `extra` model, excluding a
   *      discovered one) rebuilds even if the settings layer handed back an
   *      equal-looking options object. Without this, phase 4a's "edit the
   *      settings, the next request uses the new fact" contract would hold for
   *      every field except the one this phase is about.
   *
   * @returns {Promise<object>} the current snapshot.
   */
  async #snapshotNow() {
    const options = this.config.options()
    // The catalogue THIS snapshot is built from is refreshed first, so the
    // collection and the effective-id list can never describe different
    // worlds. Measured in the phase-4a isolated run: a settings write that moves
    // `baseURL` invalidates the catalogue's freshness, and a stream issued
    // immediately afterwards built its model collection from the previous
    // endpoint's list while the new discovery was still in flight — the request
    // then failed with MODEL_NOT_FOUND for a model the new endpoint advertises.
    // `refresh()` is single-flight and TTL-gated, so this costs a call only when
    // the catalogue is actually stale; a failed refresh keeps the last good list
    // (it never throws), so an unreachable endpoint cannot take the route down.
    await this.config.catalog.refresh()
    const optionsNow = this.config.options()
    const models = this.#effectiveModels(optionsNow)
    const idsKey = models.map((model) => model.id).join('\u0000')
    // One gateway address for the whole route: it is a ROUTE fact, not a
    // subscription fact (the single-active redesign removed the per-row
    // address the failover pool used to carry).
    const base = optionsNow.baseURL
    if (this.snapshot !== undefined && this.snapshot.options === optionsNow
      && this.snapshot.idsKey === idsKey && this.snapshot.base === base) {
      return this.snapshot
    }
    const piAi = await loadPiAi()
    // Every implementation is registered, not only the primaries in use: a
    // request may legitimately fall back to any protocol in its chain, and a
    // dispatch table entry costs nothing until it is dispatched to.
    const apiImpls = {}
    for (const api of SUPPORTED_PROTOCOLS) {
      if (piAi.apis[api] !== undefined) apiImpls[api] = piAi.apis[api]
    }
    // ONE pi-ai collection, for the one gateway address this route has. The
    // model configuration is route-wide (same ids, same capabilities, same
    // protocol decisions for every subscription), so there has never been a
    // reason for a second collection — the single-active redesign removed the
    // per-row address that used to imply one.
    const provider = piAi.createProvider({
      id: this.config.provider,
      name: 'OpenCode Go (native)',
      // Deliberately NO provider-level baseUrl: every model carries its own, so
      // pi-ai can never apply one route-wide endpoint (the design notes §2.1).
      models: models.map((model) => this.#descriptor({
        modelId: model.id,
        name: model.name,
        options: optionsNow,
        protocol: this.#protocolFor(model.id, optionsNow).primary,
        facts: this.#facts(model.id, optionsNow),
      })),
      auth: {
        apiKey: {
          name: this.config.provider,
          // The harness resolves the credential before dispatch, so this is
          // only reached for an id pi-ai looks up on its own. It answers with
          // the ACTIVE subscription's key — the same one the request path uses.
          resolve: async () => ({
            auth: {
              apiKey: this.config.subs !== undefined
                ? await this.config.subs.activeKey()
                : await this.config.resolveApiKey(),
            },
          }),
        },
      },
      api: apiImpls,
    })
    const collection = piAi.createModels()
    collection.setProvider(provider)
    this.snapshot = {
      options: optionsNow,
      idsKey,
      base,
      piAi,
      collection,
      models: collection,
    }
    return this.snapshot
  }

  /**
   * The protocol decision for one model under the current configuration.
   *
   * `models.extra[].api` joins the decision as a **configuration** fact, one
   * level below an explicit `models.overrides[id].api`: declaring a model that
   * does not exist yet and then having the rule guess its protocol would make
   * `api` a decorative field. The catalogue's npm fact still answers for every
   * other model, and an `extra` id that names no protocol falls back to it
   * (usually the provider default).
   *
   * @param {string} modelId - the gateway model id.
   * @param {object} options - current connection facts.
   * @returns {{ primary: string, source: string }} the decision and its provenance.
   */
  #protocolFor(modelId, options) {
    const declared = options.models.extra[modelId]?.claims?.api
    const effective = declared !== undefined
      ? { ...options.protocolOverrides, [modelId]: options.protocolOverrides[modelId] ?? declared }
      : options.protocolOverrides
    return resolveProtocol(modelId, {
      overrides: effective,
      snapshotNpm: this.config.catalog.snapshotNpmFor(modelId),
    })
  }

  /**
   * Build the pi-ai request context for one call, converting images through the
   * durable attachment service.
   *
   * The gate runs BEFORE any request exists, and a request that carries an image
   * this route cannot represent FAILS (`UNSUPPORTED_CONTENT`) instead of being
   * sent without it: silently dropping an image answers a question about a
   * picture the model never received, which the user cannot detect. The three
   * refusals are the official adapter's (`imageRequestSupport`).
   *
   * @param {object} options - the harness `GenerateOptions`.
   * @param {object} facts - the model's mapped capability facts.
   * @param {object} connection - current connection facts.
   * @returns {Promise<object>} a pi-ai request context.
   */
  async #requestContext(options, facts, connection) {
    const carriesImage = options.messages.some((message) => contentHasImage(message.content))
    const attachments = carriesImage ? this.config.resolveAttachments?.() : undefined
    const refusal = imageRequestSupport({
      carriesImage,
      input: facts.input,
      attachmentsAvailable: attachments !== undefined,
      modelId: options.model,
    })
    if (refusal !== undefined) throw new LlmError(refusal.message, refusal.code)
    if (!carriesImage) return toPiContext(options, facts)
    return toPiContext(options, facts, {
      attachments,
      resolveImageAccess: (ref) => this.config.resolveImageAccess?.(attachments, ref),
      maxRequestImageBytes: connection.maxRequestImageBytes,
      requestImagePolicy: {
        maxPixels: connection.requestImagePixelBudget,
        maxBytes: connection.requestImageMaxBytes,
      },
    })
  }

  /**
   * Build one protocol attempt: a fresh abort scope, a fresh idle watchdog, and
   * a chunk stream that maps an attempt-local timeout into a named `LlmError`
   * the fallback driver will not retry.
   *
   * @param {object} args - the attempt inputs.
   * @returns {AsyncIterable<object>} the attempt's harness chunks.
   */
  #attempt({ collection, apis, modelId, name, options, facts, protocol, context, apiKey, request, callerSignal, sessionValue }) {
    const adapted = adaptRequestForProtocol(protocol, request, facts)
    const effort = reasoningOf(request.reasoningEffort)
    const descriptor = this.#descriptor({ modelId, name, options, protocol, facts })
    if (apis[descriptor.api] === undefined) {
      throw new LlmError(`${PKG}: model "${modelId}" resolved to unsupported protocol "${descriptor.api}"`, 'INVALID_CONFIG')
    }
    const consumer = new AbortController()
    const upstream = callerSignal === undefined
      ? consumer.signal
      : AbortSignal.any([callerSignal, consumer.signal])
    const watchdog = idleWatchdog(upstream, options.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const events = collection.streamSimple(descriptor, context, {
      apiKey,
      ...effort === undefined ? {} : { reasoning: effort },
      ...request.temperature === undefined ? {} : { temperature: request.temperature },
      ...adapted.maxTokens === undefined ? {} : { maxTokens: adapted.maxTokens },
      signal: watchdog.signal,
      // Attribution is mandatory; the session header is the relay's routing
      // requirement (the design notes §2.4) and nothing else rides along — no
      // harness telemetry, no per-user identifiers.
      headers: requestHeaders(attributionHeaders(), options.sessionHeader, sessionValue),
    })
    const iterator = toStreamChunks(events, callerSignal)[Symbol.asyncIterator]()
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      consumer.abort('opencode-go-native attempt finished')
      watchdog[Symbol.dispose]()
    }
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        try {
          const result = await watchdog.next(iterator)
          if (result.done === true) dispose()
          return result
        } catch (error) {
          dispose()
          if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
            throw new LlmError(
              `${PKG} stream idle timeout after ${options.streamIdleTimeoutMs}ms on protocol "${protocol}"`,
              'TIMEOUT',
              { cause: error },
            )
          }
          if (callerSignal?.aborted === true) {
            throw new LlmError(`${PKG} request aborted by caller`, 'ABORTED', { cause: error })
          }
          throw error
        }
      },
      async return() {
        dispose()
        try {
          return (await iterator.return?.()) ?? { done: true, value: undefined }
        } catch {
          return { done: true, value: undefined }
        }
      },
      async throw(error) {
        dispose()
        try {
          return (await iterator.throw?.(error)) ?? { done: true, value: undefined }
        } catch {
          return { done: true, value: undefined }
        }
      },
    }
  }

  async *stream(options) {
    const snapshot = await this.#snapshotNow()
    const { piAi, models, options: connection } = snapshot
    if (options.stop !== undefined) {
      throw new LlmError(`${PKG} does not support GenerateOptions.stop`, 'UNSUPPORTED_OPTION')
    }
    // A model the operator excluded is refused by NAME here, before any request
    // exists, instead of being attempted and failing at the endpoint for a
    // reason that has nothing to do with the exclusion.
    if (connection.models.disabled.includes(options.model)) {
      throw new LlmError(
        `${PKG}: model "${options.model}" is excluded by models.disabled in the current configuration`,
        'INVALID_REQUEST',
      )
    }
    if (models.getModel(this.config.provider, options.model) === undefined) {
      throw new LlmError(
        `${PKG}: model "${options.model}" is not in this route's catalogue (${this.#effectiveModels(connection).length} `
        + 'models in effect); refresh the model list or add the id to models.extra',
        'MODEL_NOT_FOUND',
      )
    }
    const facts = this.#facts(options.model, connection)
    const name = this.#nameOf(options.model, connection)
    const snapshotNpm = this.config.catalog.snapshotNpmFor(options.model)
    const extraApi = connection.models.extra[options.model]?.claims?.api
    const overrides = extraApi === undefined || Object.hasOwn(connection.protocolOverrides, options.model)
      ? connection.protocolOverrides
      : { ...connection.protocolOverrides, [options.model]: extraApi }
    const chainFacts = {
      overrides,
      snapshotNpm,
      maxAttempts: connection.maxProtocolAttempts,
      includeFallback: connection.protocolFallback,
    }
    const declared = protocolChainForModel(options.model, chainFacts)
    if (connection.protocolMemoTtlMs !== this.memo.ttlMs) this.memo.ttlMs = connection.protocolMemoTtlMs
    // A protocol this endpoint has already refused by FORMAT is demoted to the
    // end of the chain, not removed: if every alternative also fails, the
    // endpoint's real refusal is still what the caller sees.
    //
    // "Pinned" covers BOTH addresses a configuration can write an operator's
    // intent at — `protocolOverrides[id]` (the legacy alias) and
    // `models.extra[].api` (the phase-4a address) — plus `models.overrides[id].api`,
    // which is folded into `protocolOverrides` by `resolveOptions`. While
    // `honorProtocolOverrides` is on, none of them is demoted by a learned note
    // (README「协议决议与回退」states exactly this).
    const pinned = Object.hasOwn(overrides, options.model)
    const memoMayReorder = connection.protocolMemoTtlMs > 0
      && !(connection.honorProtocolOverrides && pinned)
    const chain = memoMayReorder ? this.memo.demote(options.model, declared) : declared
    const context = await this.#requestContext(options, facts, connection)
    // The mode is re-read from the CURRENT resolved connection facts, so a
    // settings change reaches the next request; `config.sessionMode` is only the
    // fallback for a snapshot that predates the field. The value map keeps the
    // conversation-level stability that the relay's affinity needs.
    const sessionValue = this.sessions.valueFor(options.sessionId, connection.sessionHeaderMode ?? this.config.sessionMode)
    const request = {
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
      temperature: options.temperature,
    }
    const decision = this.#protocolFor(options.model, connection)
    if (connection.debug && chain.length > 1) {
      this.config.log(
        'info',
        `model "${options.model}" protocol chain: ${chain.join(' > ')} (primary "${decision.primary}" from ${decision.source})`,
      )
    }

    // ── WHO PAYS (0.8.2) ────────────────────────────────────────────────────
    // Exactly ONE subscription is active, so this is one credential resolution
    // followed by one attempt chain — no rotation, no gate, no second key. A
    // missing credential or a refusal is the caller's own answer: picking
    // another key is an operator act in the settings list, never something a
    // failed request decides on the caller's behalf. (The pre-0.8.2 pool that
    // rotated keys mid-stream is gone; `subruntime.js` carries what replaced it.)
    const apiKey = this.config.subs !== undefined
      ? await this.config.subs.activeKey()
      : await this.config.resolveApiKey()
    const attempt = (protocol) => this.#attempt({
      collection: models, apis: piAi.apis, modelId: options.model, name, options: connection, facts,
      protocol, context, apiKey, request, callerSignal: options.signal, sessionValue,
    })
    let yielded = false
    try {
      const drive = streamWithProtocolChain({
        chain,
        attempt,
        maxAttemptsPerProtocol: connection.transientAttemptsPerProtocol,
        // An idle timeout is this adapter's own bound on a stalled attempt, not
        // a statement about the protocol: it must surface, not fan out into
        // another protocol as if the endpoint had refused the format.
        isRetryable: (failure) => {
          if (failure instanceof LlmError && (failure.code === 'TIMEOUT' || failure.code === 'ABORTED')) return false
          return retryableProtocolFailure(failure)
        },
        kindOf: protocolFailureKind,
        buildError: (attempts, lastFailure) => {
          const summarized = chainExhaustedError(attempts, lastFailure)
          const error = new LlmError(summarized.message, classifyPiAiError(failureText(lastFailure)), { cause: lastFailure })
          // Every attempt, for a diagnostics surface: `LlmError` carries only
          // `code`/`cause`, so the attempt list rides as an own field.
          error.attempts = attempts
          return error
        },
        onAttempt: (protocol, failure, outcome) => this.#observe({
          modelId: options.model, protocol, failure, outcome, primary: decision.primary, debug: connection.debug,
        }),
      })
      for await (const chunk of drive) {
        // The chunk contract is the endpoint's own: usage then terminal, or
        // content then usage then terminal. Nothing is buffered any more — the
        // buffering existed so a ROTATING candidate could drop its envelope, and
        // there is no rotation.
        if (chunk?.type !== 'finish') yielded = true
        yield chunk
        if (chunk?.type === 'finish') return
      }
      // A chain that ended with no terminal at all is a contract break, not a
      // protocol refusal: say so rather than reporting a silent success.
      throw new LlmError(`${PKG} stream from ${connection.baseURL} ended without a terminal chunk`, 'TRANSPORT')
    } catch (error) {
      // Content already reached the caller — no protocol or retry can un-send a
      // partial answer. Surface it exactly as it is.
      if (yielded) throw error
      throw await this.#finalizeStreamError(error, connection, options)
    }
  }

  /**
   * The terminal mapping for an error the caller must see (0.8: extracted from
   * the old single-key catch so the subscription loop can surface the LAST
   * candidate's failure with exactly the codes the route has always carried).
   */
  async #finalizeStreamError(error, connection, options) {
    if (error instanceof LlmError) return error
    if (timeoutOf(error, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
      return new LlmError(`${PKG} stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
    }
    if (options.signal?.aborted === true) {
      return new LlmError(`${PKG} request aborted by caller`, 'ABORTED', { cause: error })
    }
    return new LlmError(`${PKG} stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
  }

  /**
   * Record what one attempt taught this route.
   *
   * - a FORMAT refusal is remembered in the memo so the next request for this
   *   model starts from a protocol that works (transient failures are not
   *   remembered: they say nothing about the protocol);
   * - every attempt lands in the health log, which is where the Region /
   *   data-policy / country-block categories become visible to an operator.
   * @param {object} observation - one attempt outcome.
   */
  #observe({ modelId, protocol, failure, outcome, primary, debug }) {
    if (outcome.kind === 'ok') {
      this.health.record(modelId, protocol, undefined)
      return
    }
    const kind = outcome.kind === 'retryable' ? protocolFailureKind(failure) : outcome.kind
    const entry = this.health.record(modelId, protocol, failure)
    if (kind === PROTOCOL_FAILURE.FORMAT && outcome.kind === 'retryable') {
      this.memo.remember(modelId, protocol, failureText(failure))
    }
    // A category with an ACTION is something the operator must resolve outside
    // the harness (opt a model in, accept a data policy). Say it once per model
    // and category, at a level that surfaces by default, instead of letting the
    // user rediscover the same 403 on every request.
    if (entry.action !== undefined) {
      const key = `${modelId}\u0000${entry.category}`
      if (!this.announced.has(key)) {
        this.announced.add(key)
        this.config.log(
          'warn',
          `model "${modelId}" is not usable on protocol "${protocol}" `
          + `(${entry.category}${entry.status === undefined ? '' : `, HTTP ${entry.status}`}): ${entry.action}`,
        )
      }
    }
    if (debug) {
      this.config.log(
        'info',
        `model "${modelId}" protocol "${protocol}"${protocol === primary ? ' (primary)' : ' (alternate)'} `
        + `-> ${outcome.kind}${outcome.committed ? ' after output' : ''}: ${failureText(failure).slice(0, 160)}`,
      )
    }
  }
}
