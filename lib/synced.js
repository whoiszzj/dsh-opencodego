/**
 * The SYNCED layer: the capability facts a sync established, stored as a
 * snapshot-shaped overlay.
 *
 * Why an overlay rather than `models.overrides`: the override vocabulary names
 * HOST levels (`reasoningEfforts`), and a host level cannot carry the spelling
 * the provider needs on the wire. `qwen3.6-plus` accepts `minimum` and rejects
 * `minimal`; `kimi-k3` answers on `reasoning` while the snapshot says
 * `reasoning_content`. Both facts fit the snapshot shape (`reasoningOptions`
 * holds wire spellings, `interleavedField` holds the reply field) and neither
 * fits an override, so the synced layer speaks the snapshot's language and the
 * existing mapping code is reused unchanged.
 *
 * Precedence is what you would expect: this layer sits over the bundled
 * snapshot and UNDER `models.overrides`, so an operator's explicit correction
 * still wins over a measurement.
 *
 * The layer is written where the installation can own it (`$DSH_HOME`), never
 * into the package: a sync is a fact about ONE account at ONE moment, and
 * shipping it would be a lie about everyone else's.
 *
 * @module dsh-opencodego/synced
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SYNCED_LAYER_KIND = 'dsh-opencodego/synced-layer'
export const SYNCED_LAYER_VERSION = 1

/** The file name this layer is stored under, inside the harness home. */
export const SYNCED_LAYER_FILE = 'opencode-go.synced.json'

/**
 * The harness home, resolved the same way the rest of the toolchain resolves it:
 * `$DSH_HOME` when set, otherwise `~/.dsh`.
 * @returns {string} the directory.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** The default location of the synced layer for this installation. */
export function defaultSyncedLayerPath() {
  return join(dshHome(), SYNCED_LAYER_FILE)
}

/**
 * Turn one stored sync result into the snapshot-shaped fragment the capability
 * mapper reads.
 *
 * @param {object} entry - one stored layer entry (`{reasoning, interleavedField}`).
 * @returns {object | undefined} the fragment, or `undefined` when it says nothing.
 */
export function snapshotFragmentOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const levels = entry.reasoning?.levels
  const options = []
  if (entry.reasoning?.hasOff === true) options.push({ type: 'toggle' })
  const wires = Object.values(levels ?? {}).filter((wire) => typeof wire === 'string')
  if (wires.length > 0) options.push({ type: 'effort', values: [...new Set(wires)] })
  const fragment = {}
  if (options.length > 0) {
    fragment.reasoningOptions = options
    fragment.reasoning = true
  } else if (entry.reasoning !== undefined) {
    // A measured "this model always thinks, and there is no level to name".
    fragment.reasoningOptions = []
    fragment.reasoning = entry.reasoning.hasOff === true
  }
  if (typeof entry.interleavedField === 'string' && entry.interleavedField.length > 0) {
    fragment.interleavedField = entry.interleavedField
  }
  if (typeof entry.protocol?.chosen === 'string') fragment.protocol = entry.protocol.chosen
  // Context/output/input are recorded for the settings page to show. They are
  // deliberately NOT merged into the snapshot entry: those values come from the
  // official baseline, and the override layer is the place an operator's own
  // correction belongs. Duplicating them here would create a second, silently
  // competing source for the same number.
  return Object.keys(fragment).length === 0 ? undefined : fragment
}

/**
 * The synced layer, loaded from a file and queried by model id.
 *
 * Corrupt or unreadable input degrades to "no synced facts" rather than taking
 * the route down: the whole point of an overlay is that its absence is safe.
 */
export class SyncedLayer {
  /**
   * @param {object} [document] - a parsed layer document.
   */
  constructor(document) {
    /** @type {Record<string, object>} */
    this.models = document?.models !== null && typeof document?.models === 'object'
      ? document.models
      : {}
    this.path = document?.path
  }

  /**
   * Load a layer, tolerating every way a file can be missing or wrong.
   * @param {string | undefined} path - the file to read; `undefined` yields an empty layer.
   * @returns {SyncedLayer} the layer (never throws).
   */
  static load(path) {
    if (typeof path !== 'string' || path.length === 0) return new SyncedLayer()
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const layer = new SyncedLayer(parsed)
      layer.path = path
      return layer
    } catch {
      const layer = new SyncedLayer()
      layer.path = path
      return layer
    }
  }

  /** The stored entry for one id, or `undefined`. */
  rawEntryFor(modelId) {
    const entry = this.models[modelId]
    return entry !== null && typeof entry === 'object' ? entry : undefined
  }

  /**
   * The snapshot-shaped fragment for one id, or `undefined`.
   * @param {string} modelId - the gateway model id.
   * @returns {object | undefined} the fragment.
   */
  entryFor(modelId) {
    return snapshotFragmentOf(this.rawEntryFor(modelId))
  }

  /** Whether this id carries a synced result at all. */
  has(modelId) {
    return this.rawEntryFor(modelId) !== undefined
  }

  /** The ids with a synced result, in file order. */
  ids() {
    return Object.keys(this.models)
  }

  /**
   * Record one sync result.
   * @param {object} entry - a `syncedLayerFromSync` entry.
   * @returns {void}
   */
  put(entry) {
    if (entry?.id === undefined) return
    this.models[entry.id] = entry
  }

  /** Drop one id's result. */
  remove(modelId) {
    delete this.models[modelId]
  }

  /**
   * Drop every measurement whose model is no longer enabled.
   *
   * A synced result is a fact about ONE model at ONE moment, so it must not
   * outlive the model's presence in the configuration: otherwise removing a
   * model and adding it back shows the old verdict as if it had just been
   * measured, which is precisely the "declared looks measured" confusion the
   * sync exists to remove.
   *
   * Refuses to act on an EMPTY set: an empty answer is far more likely to be a
   * settings read that failed than every model having been removed, and wiping
   * every measurement on a transient error would be unrecoverable.
   *
   * @param {readonly string[]} activeIds - the ids currently enabled.
   * @returns {string[]} the ids that were dropped.
   */
  prune(activeIds) {
    const keep = new Set((activeIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))
    if (keep.size === 0) return []
    const dropped = []
    for (const id of Object.keys(this.models)) {
      if (keep.has(id)) continue
      dropped.push(id)
      delete this.models[id]
    }
    return dropped
  }

  /** The document to serialise. */
  toDocument() {
    return {
      kind: SYNCED_LAYER_KIND,
      version: SYNCED_LAYER_VERSION,
      updatedAt: new Date().toISOString(),
      models: this.models,
    }
  }

  /**
   * Write the layer, atomically.
   *
   * Written to a sibling temp file and renamed, so a crash mid-write cannot
   * leave a half-parsed layer that would silently drop every measurement.
   * @returns {string | undefined} the path written, or `undefined` when there is none.
   */
  save() {
    if (typeof this.path !== 'string' || this.path.length === 0) return undefined
    const text = `${JSON.stringify(this.toDocument(), undefined, 1)}\n`
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, this.path)
    return this.path
  }
}

/**
 * Overlay a synced fragment on a snapshot entry.
 *
 * A model the snapshot does not know still gets an entry when a sync measured
 * one — that is how a brand-new id, or `omen-alpha` (which no first-party
 * provider documents), ends up with capabilities that are evidence rather than
 * a guess.
 *
 * @param {object | undefined} snapshotEntry - the bundled models.dev record.
 * @param {object | undefined} syncedEntry - the synced fragment.
 * @returns {object | undefined} the entry the capability mapper should read.
 */
export function mergeSyncedEntry(snapshotEntry, syncedEntry) {
  if (syncedEntry === undefined) return snapshotEntry
  if (snapshotEntry === undefined) return { ...syncedEntry }
  const merged = { ...snapshotEntry, ...syncedEntry }
  // `interleavedField` is the snapshot's own key; keep the snapshot's shape by
  // not inventing a second name for the same fact.
  if (syncedEntry.interleavedField !== undefined) {
    merged.interleavedField = syncedEntry.interleavedField
  }
  return merged
}

/**
 * Compose the three declaration/measurement faces into the ONE entry the
 * capability mapper reads — the single merge point every consumer goes through
 * (`ModelCatalog#snapshotEntryFor`).
 *
 * Precedence, lowest first: the official baseline's DECLARED numbers
 * (contextWindow / maxTokens / inputModalities — see
 * `official-baseline.js#officialCapabilityFragment`), then the bundled snapshot
 * entry (name / npm), then the synced MEASURED fragment (reasoning / protocol /
 * interleavedField). The three field sets are disjoint by construction, so the
 * spread order is a statement of precedence, not a conflict resolution; the
 * operator's own corrections are applied ABOVE this entry by
 * `modelCapabilitiesWithOverrides`, never inside it.
 *
 * `snapshotEnabled: false` switches the whole packaged declaration face off —
 * snapshot AND official baseline together — leaving only measured facts: a
 * synced measurement is evidence about the gateway, while both declaration
 * faces are bundled models.dev claims the operator chose not to trust.
 *
 * Lives here (not in `catalog.js`) so the precedence is unit-testable without
 * the host packages the catalog imports.
 *
 * @param {object} faces - the faces to compose.
 * @param {boolean} [faces.snapshotEnabled] - whether the declaration face is on.
 * @param {object | undefined} faces.snapshotEntry - the bundled models.json record.
 * @param {object | undefined} faces.officialFragment - the projected official numbers.
 * @param {object | undefined} faces.syncedEntry - the synced measurement fragment.
 * @returns {object | undefined} the entry the capability mapper should read.
 */
export function composeEntryFaces({ snapshotEnabled = true, snapshotEntry, officialFragment, syncedEntry } = {}) {
  if (snapshotEnabled !== true) return mergeSyncedEntry(undefined, syncedEntry)
  if (snapshotEntry === undefined && officialFragment === undefined) {
    return mergeSyncedEntry(undefined, syncedEntry)
  }
  return mergeSyncedEntry({ ...officialFragment, ...snapshotEntry }, syncedEntry)
}
