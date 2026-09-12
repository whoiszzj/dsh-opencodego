/**
 * The diagnostics a settings page (phase 4b) reads, in one serializable shape.
 *
 * Two facts drive this module's existence (the design notes §2.14):
 *
 *   1. **The host logger is not a wire.** In this host version a plugin's
 *      `ctx.logger.*` output goes into cordis's in-memory exporter and reaches
 *      neither stdout nor `$DSH_HOME/web.log`, so "read the log" is not an
 *      option for a settings page. The plugin therefore keeps its own bounded
 *      ring (`adapter.logged`) and its own endpoint-health log
 *      (`adapter.health`), and this module is the ONE place those two are
 *      turned into a payload.
 *   2. **A page must not open a second logging source.** Everything here is
 *      derived from state the runtime already keeps; nothing is recorded here,
 *      nothing is sampled, and calling this function twice changes nothing.
 *
 * `buildDiagnosticsView` is host-free and pure, so `node --test` pins its shape
 * without a profile install (`tests/diagnostics.test.mjs`). `index.js` exposes
 * the result over a read-only HTTP route (the same browser surface the phase-4b
 * page can fetch) and `OpenCodeGoAdapter.diagnostics()` returns it in-process.
 *
 * @module dsh-opencodego/diagnostics
 */

import { ENDPOINT_HEALTH } from './health.js'
import { effectiveModelIds, modelSource } from './models.js'

/**
 * Payload kind, so a consumer can refuse a route that answered with something
 * else (the SPA fallback answers unknown paths with HTML).
 */
export const DIAGNOSTICS_KIND = 'dsh-opencodego/diagnostics'

/** How many effective ids the default view carries before truncating. */
export const DEFAULT_MODEL_ID_LIMIT = 500

/** How many log lines the default view carries (newest last). */
export const DEFAULT_LOG_LIMIT = 200

/** How many health records the default view carries. */
export const DEFAULT_HEALTH_LIMIT = 200

/**
 * A JSON-safe copy of the plugin's bound log ring, oldest first.
 * @param {readonly object[]} logged - `adapter.logged`.
 * @param {number} limit - most recent lines to keep.
 * @returns {object[]} the lines.
 */
export function logLines(logged, limit = DEFAULT_LOG_LIMIT) {
  const lines = Array.isArray(logged) ? logged : []
  const kept = limit > 0 ? lines.slice(-limit) : []
  return kept.map((line) => ({
    at: typeof line?.at === 'number' ? line.at : undefined,
    level: typeof line?.level === 'string' ? line.level : 'info',
    message: typeof line?.message === 'string' ? line.message : String(line?.message ?? ''),
  }))
}

/**
 * Health records, shaped for a page: one row per model with its newest
 * classification, the operator action when there is one, and a bounded history.
 *
 * Deliberately NOT reshaped into "errors only": the same model can be `ok` now
 * and blocked five minutes ago, and a page that showed only the newest state
 * would hide the recovery that makes the route usable.
 *
 * @param {object | undefined} health - an `EndpointHealthLog`.
 * @param {number} limit - most recent models to keep (by first appearance).
 * @returns {object[]} the rows.
 */
export function healthRows(health, limit = DEFAULT_HEALTH_LIMIT) {
  if (health === undefined || typeof health.snapshot !== 'function') return []
  const snapshot = health.snapshot()
  const kept = limit > 0 ? snapshot.slice(-limit) : []
  return kept.map(({ modelId, latest, history }) => ({
    modelId,
    category: latest?.category ?? ENDPOINT_HEALTH.UNKNOWN,
    protocol: latest?.protocol,
    status: latest?.status,
    at: latest?.at,
    action: latest?.action,
    history: (Array.isArray(history) ? history : []).map((entry) => ({
      at: entry?.at,
      protocol: entry?.protocol,
      category: entry?.category,
      status: entry?.status,
    })),
  }))
}

/**
 * The full diagnostics payload.
 *
 * @param {object} state - the runtime state to describe (never mutated).
 * @param {object} state.options - a resolved connection snapshot.
 * @param {readonly object[]} [state.discovered] - what the endpoint advertised last.
 * @param {readonly object[]} [state.logged] - the plugin's bounded log ring.
 * @param {object} [state.health] - the endpoint-health log.
 * @param {object} [state.catalogDiagnostics] - `ModelCatalog.diagnostics`.
 * @param {object} [state.adapterSnapshot] - `{ idsKey }` of the built pi-ai collection.
 * @param {readonly string[]} [state.loggedProtocolOverrides] - overlay facts.
 * @param {object} [limits] - per-list caps.
 * @returns {object} a JSON-serializable payload.
 */
export function buildDiagnosticsView(state, limits = {}) {
  const options = state.options
  const models = options.models
  const discovered = Array.isArray(state.discovered) ? state.discovered : []
  const discoveredIds = discovered.map((model) => model.id)
  const effectiveIds = effectiveModelIds(discoveredIds, models)
  const idLimit = Number.isSafeInteger(limits.modelIdLimit) ? limits.modelIdLimit : DEFAULT_MODEL_ID_LIMIT
  const discoveredSet = new Set(discoveredIds)

  return {
    kind: DIAGNOSTICS_KIND,
    at: typeof limits.now === 'number' ? limits.now : Date.now(),
    /**
     * The connection facts the adapter would use for the NEXT request, read from
     * the same resolved snapshot it reads. A settings page shows this, and the
     * acceptance run uses it to prove a write reached the runtime rather than
     * only the settings document — the paid-for lesson of phase 3, where
     * `sessionHeaderMode` was schema-valid, stored, and silently ignored.
     */
    connection: {
      baseURL: options.baseURL,
      apiKeyEnv: options.apiKeyEnv,
      // The token itself is never part of this payload — only the fact that a
      // legacy plain-text one is still present, which is a migration warning
      // rather than a working configuration. A diagnostics read therefore cannot
      // leak a secret through a wire boundary.
      legacyInlineKey: options.apiKey !== undefined,
    },
    configuration: {
      baseURL: options.baseURL,
      apiKeyEnv: options.apiKeyEnv,
      legacyInlineKey: options.apiKey !== undefined,
      sessionHeader: options.sessionHeaderEnabled === false ? undefined : options.sessionHeader,
      sessionHeaderEnabled: options.sessionHeaderEnabled !== false,
      sessionHeaderMode: options.sessionHeaderMode,
      snapshotEnabled: options.snapshotEnabled === true,
      protocolFallback: options.protocolFallback === true,
      honorProtocolOverrides: options.honorProtocolOverrides === true,
      maxProtocolAttempts: options.maxProtocolAttempts,
      transientAttemptsPerProtocol: options.transientAttemptsPerProtocol,
      protocolMemoTtlMs: options.protocolMemoTtlMs,
      sync: options.sync === true,
      syncTtlMs: options.syncTtlMs,
      defaultContextWindow: options.defaultContextWindow,
      defaultMaxTokens: options.defaultMaxTokens,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs,
      debug: options.debug === true,
      models: {
        disabled: [...models.disabled],
        extra: Object.keys(models.extra),
        overrides: Object.keys(models.overrides),
        replaceDiscovered: models.replaceDiscovered === true,
        // An alias that names a model whose `models.overrides[id].api` already
        // exists does not decide anything; showing it is how an operator learns
        // that the pin they wrote is not the one in force.
        protocolOverridesApplied: [...(models.protocolOverridesApplied ?? [])],
        protocolOverridesShadowed: [...(models.protocolOverridesShadowed ?? [])],
      },
    },
    catalogue: {
      status: state.catalogDiagnostics?.status ?? 'cold',
      discovered: discovered.length,
      effective: effectiveIds.length,
      lastSuccessAt: state.catalogDiagnostics?.lastSuccessAt,
      lastAttemptAt: state.catalogDiagnostics?.lastAttemptAt,
      lastError: state.catalogDiagnostics?.lastError,
      failures: state.catalogDiagnostics?.failures ?? 0,
      snapshotOnly: [...(state.catalogDiagnostics?.snapshotOnly ?? [])],
      unknownModels: [...(state.catalogDiagnostics?.unknownModels ?? [])],
      effectiveIds: effectiveIds.slice(0, idLimit),
      effectiveTruncated: effectiveIds.length > idLimit,
      // `endpoint+extra` is the interesting row: the id exists on both sides, so
      // an `extra` entry is adding attributes to a discovered model rather than
      // enabling a missing id.
      sources: effectiveIds.slice(0, idLimit).map((id) => ({
        id,
        source: modelSource(id, discoveredSet, models),
      })),
      // The identity of the pi-ai collection currently serving requests: a page
      // can show "the running snapshot covers N ids" without guessing.
      snapshotIds: (state.adapterSnapshot?.idsKey ?? '').length === 0
        ? 0
        : (state.adapterSnapshot?.idsKey ?? '').split('\u0000').length,
    },
    health: {
      rows: healthRows(state.health, limits.healthLimit ?? DEFAULT_HEALTH_LIMIT),
      unusable: typeof state.health?.unusable === 'function'
        ? state.health.unusable().map(({ modelId, latest }) => ({
          modelId,
          category: latest?.category,
          status: latest?.status,
          action: latest?.action,
        }))
        : [],
      summaryLines: typeof state.health?.summaryLines === 'function' ? state.health.summaryLines() : [],
    },
    log: {
      lines: logLines(state.logged, limits.logLimit ?? DEFAULT_LOG_LIMIT),
      warnings: logLines(state.logged, limits.logLimit ?? DEFAULT_LOG_LIMIT)
        .filter((line) => line.level === 'warn'),
    },
  }
}
