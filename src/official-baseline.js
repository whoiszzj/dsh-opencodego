/**
 * The OFFICIAL capability baseline: what each model's own authoring provider
 * declares, read from `github.com/anomalyco/models.dev`.
 *
 * Why the repository and not `models.dev/*.json`:
 *
 *   - `models.json` carries no `reasoning_options` at all;
 *   - `api.json` is a lossy flattening — it keeps provider-level
 *     `reasoning_options` but drops the TOML comments that hold the real HTTP
 *     contract (field names, allowed values, source URL, access date), and it
 *     drops `base_model`, the only reliable join key;
 *   - a *declaration* is only usable if you can see where it came from, so every
 *     record here carries the file paths it was read from.
 *
 * What "the official provider" means is decided by rule, never by guess:
 *
 *   1. `base_model = "<lab>/<slug>"` on the OpenCode Go entry;
 *   2. otherwise the authoring lab is the one with `models/<lab>/<slug>.toml`;
 *   3. otherwise a *self-referencing* provider directory — one whose own model
 *      files point back into its own namespace. A reseller never does this
 *      (`bothub` points at `meta/…`, not `bothub/…`), which is why the 100+
 *      resellers that list the same slugs are not candidates;
 *   4. otherwise the id is recorded as having no official reference. It is NOT
 *      given some other provider's numbers.
 *
 * Only the fields this plugin consumes are stored. The repository is never
 * vendored: `sources` records the handful of files each model was read from, so
 * a refresh re-fetches exactly those and nothing else.
 *
 * @module dsh-opencodego/official-baseline
 */

import { readFileSync } from 'node:fs'

import { commentBlocks, parseToml } from './official-toml.js'
import { HOST_THINKING_LEVELS } from './vocab.js'

export const OFFICIAL_BASELINE_KIND = 'dsh-opencodego/official-baseline'

/** Where the bundled baseline lives, relative to this module. */
export const OFFICIAL_BASELINE_URL = new URL('../data/opencode-go.official.json', import.meta.url)
export const OFFICIAL_BASELINE_VERSION = 1

/** Raw GitHub base for the `dev` branch of the upstream repository. */
export const OFFICIAL_RAW_BASE = 'https://raw.githubusercontent.com/anomalyco/models.dev/dev'

/** The canonical effort ladder, used to order values for display and storage. */
export const EFFORT_LADDER = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/**
 * Labs whose model namespace differs from their provider directory name.
 *
 * `models/meituan/longcat-2.0.toml` is authored by Meituan but served by the
 * `longcat` provider; Tencent's models live under its three plan providers.
 * This is the only manual knowledge in the resolution, and it is keyed by lab so
 * an unknown lab simply resolves to nothing rather than to a wrong file.
 */
export const LAB_PROVIDER_ALIASES = Object.freeze({
  meituan: Object.freeze(['longcat']),
  tencent: Object.freeze(['tencent-tokenhub', 'tencent-token-plan', 'tencent-coding-plan']),
})

/** Modalities the harness can actually carry; anything else is recorded but not input. */
export const INPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'pdf'])

/** Ladder order for a set of effort spellings, unknown spellings last and sorted. */
export function ladderOrder(values) {
  const known = EFFORT_LADDER.filter((level) => values.includes(level))
  const unknown = [...new Set(values)].filter((v) => !EFFORT_LADDER.includes(v)).sort()
  return [...known, ...unknown]
}

/**
 * Normalize `reasoning_options` into a stable, comparable shape.
 * @param {unknown} raw - the parsed `reasoning_options` array.
 * @returns {Array<{ type: string, values?: string[], min?: number, max?: number }>}
 */
export function normalizeReasoningOptions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const option of raw) {
    if (option === null || typeof option !== 'object' || Array.isArray(option)) continue
    const type = typeof option.type === 'string' ? option.type : undefined
    if (type === undefined) continue
    const entry = { type }
    if (Array.isArray(option.values)) {
      entry.values = ladderOrder(option.values.filter((v) => typeof v === 'string'))
    }
    if (Number.isSafeInteger(option.min)) entry.min = option.min
    if (Number.isSafeInteger(option.max)) entry.max = option.max
    out.push(entry)
  }
  return out
}

/**
 * The reasoning contract as a person reads it, e.g. `off / low / high / max`.
 *
 * `toggle` is the provider's own on/off switch, so it prints as `off`; a model
 * with only a toggle prints `off / on`. A token cap is appended as
 * `+ budget≤N`. This is a RENDERING of {@link normalizeReasoningOptions}, never
 * a replacement for it — the wire spellings are what actually go on the wire.
 *
 * @param {ReturnType<typeof normalizeReasoningOptions>} options - normalized options.
 * @returns {string} the human ladder, or `none declared`.
 */
export function reasoningContract(options) {
  if (!Array.isArray(options) || options.length === 0) return 'none declared'
  const toggle = options.some((option) => option.type === 'toggle')
  const effort = options.find((option) => option.type === 'effort')
  const values = effort?.values ?? []
  const extra = []
  for (const option of options) {
    if (option.type === 'budget_tokens') {
      if (option.max !== undefined) extra.push(`budget≤${option.max}`)
      else if (option.min !== undefined) extra.push(`budget≥${option.min}`)
      else extra.push('budget')
    } else if (option.type !== 'toggle' && option.type !== 'effort') {
      extra.push(option.type)
    }
  }
  const body = toggle
    ? `off / ${values.length > 0 ? values.join(' / ') : 'on'}`
    : values.join(' / ')
  return [body, ...extra].filter((part) => part.length > 0).join(' + ')
}

/**
 * The host thinking levels a contract covers, and the wire spelling for each.
 *
 * `off` is not a configurable level in this plugin (it means "omit the
 * parameter"), so it is reported separately as `hasOff` rather than folded into
 * `levels`.
 *
 * @param {ReturnType<typeof normalizeReasoningOptions>} options - normalized options.
 * @returns {{ levels: Record<string, string>, hasOff: boolean, unmappable: string[] }}
 *   `levels` maps a HOST level to the spelling the provider declared.
 */
export function reasoningLevels(options) {
  const levels = {}
  const unmappable = []
  let hasOff = false
  for (const option of options ?? []) {
    if (option.type === 'toggle') hasOff = true
    if (option.type !== 'effort') continue
    for (const value of option.values ?? []) {
      // `none` is the one spelling models.dev uses for "do not reason"; the host
      // calls that level `off`, and the provider's spelling is what goes out.
      const level = value.toLowerCase() === 'none' ? 'off' : value.toLowerCase()
      if (level === 'off') {
        hasOff = true
        continue
      }
      if (!HOST_THINKING_LEVELS.includes(level)) {
        if (!unmappable.includes(value)) unmappable.push(value)
        continue
      }
      if (levels[level] === undefined) levels[level] = value
    }
  }
  return { levels, hasOff, unmappable }
}

// ── resolution ───────────────────────────────────────────────────────────────

/** `a/b.toml` → `{ lab: 'a', slug: 'b' }` for a `base_model`-style reference. */
function splitRef(ref) {
  if (typeof ref !== 'string') return undefined
  const at = ref.indexOf('/')
  if (at <= 0 || at === ref.length - 1) return undefined
  return { lab: ref.slice(0, at), slug: ref.slice(at + 1) }
}

/** Provider directories that belong to one lab, in preference order. */
function providerDirsFor(lab) {
  const aliases = LAB_PROVIDER_ALIASES[lab] ?? []
  return [...new Set([lab, ...aliases, `${lab}-cn`])]
}

/**
 * Decide which files this model's official facts are read from.
 *
 * Runs against a `source` adapter so the same rules serve a local checkout
 * (which can list directories and therefore find a file by what it *targets*)
 * and a network refresh (which must not list anything, and so reuses the paths
 * a previous run recorded).
 *
 * @param {object} params - resolution inputs.
 * @param {string} params.id - the OpenCode Go model id.
 * @param {object | undefined} params.ocg - the parsed `providers/opencode-go/models/<id>.toml`.
 * @param {object | undefined} params.previous - the record from the last run, if any.
 * @param {{ read: (path: string) => string | undefined, list?: (dir: string) => string[] | undefined }} params.source
 *   `read` returns file text or `undefined`; `list` returns directory entries or
 *   `undefined` when the source cannot enumerate.
 * @returns {{ lab?: string, slug?: string, how: string, files: object, problems: string[] }}
 *   `files` names the paths by role; a missing role is simply absent.
 */
export function resolveOfficialSources({ id, ocg, previous, source }) {
  const problems = []
  const files = {}
  const parse = (path) => {
    const text = source.read(path)
    return text === undefined ? undefined : parseCached(path, text)
  }

  // 1. the OpenCode Go entry itself is always read: it holds `base_model`.
  const ocgPath = `providers/opencode-go/models/${id}.toml`
  if (source.read(ocgPath) !== undefined) files.ocg = ocgPath
  else problems.push(`models.dev has no providers/opencode-go/models/${id}.toml`)

  // 2. a recorded path wins. This is what keeps a refresh to "exactly the files
  //    this model needs" instead of re-deriving them by trial. When any recorded
  //    file has moved, the whole plan is re-derived rather than half-reused: a
  //    record built from a mix of old and new paths is harder to trust than one
  //    built from a rule.
  if (previous?.sources !== undefined) {
    const reusable = []
    const gone = []
    for (const [role, path] of Object.entries(previous.sources)) {
      if (typeof path !== 'string' || path.length === 0) continue
      // One read per recorded path: a refresh must cost exactly the files it
      // reuses, and reading twice would double the request count for no gain.
      if (source.read(path) === undefined) gone.push(role)
      else reusable.push([role, path])
    }
    if (reusable.length > 0 && gone.length === 0) {
      return {
        lab: previous.lab,
        slug: previous.slug,
        // `how` describes the RELATIONSHIP, not the mechanism: reusing a
        // recorded path must not change the record, or `--check` would flap
        // between an offline and an online run over provenance alone.
        how: typeof previous.resolution === 'string' ? previous.resolution : 'recorded-sources',
        reused: true,
        files: { ...files, ...Object.fromEntries(reusable) },
        problems,
      }
    }
    if (gone.length > 0) {
      problems.push(`recorded source(s) gone: ${gone.join(', ')}`)
    }
  }

  const ref = splitRef(parse(ocgPath)?.base_model)
  let { lab, slug } = ref ?? {}
  const how = ref === undefined ? 'no-base-model' : 'base_model'

  // 3. no `base_model`: the lab is whoever authors `models/<lab>/<id>.toml`, or —
  //    when the source can enumerate — a provider directory that references
  //    itself. This is the `deepseek-flash` case.
  if (lab === undefined) {
    const canonical = canonicalFor(id, source)
    if (canonical !== undefined) {
      lab = canonical.lab
      slug = canonical.slug
    } else {
      const selfRef = selfReferencingProviderFor(id, source)
      if (selfRef !== undefined) {
        lab = selfRef
        slug = id
      }
    }
  }
  if (lab === undefined) {
    problems.push(`no official reference found for ${id}`)
    return { how: 'unresolved', files, problems }
  }
  slug = slug ?? id

  // 4. the lab's own provider file for this model, then the canonical model file.
  const dirs = providerDirsFor(lab)
  let providerModel
  search: for (const dir of dirs) {
    for (const candidate of [`${id}.toml`, `${slug}.toml`]) {
      const path = `providers/${dir}/models/${candidate}`
      if (source.read(path) !== undefined) {
        providerModel = path
        break search
      }
    }
    // 4b. a file that *targets* the same canonical model, found by listing.
    //     `deepseek-v4.1-flash` has no file of its own; `deepseek-flash.toml`
    //     declares `base_model = "deepseek/deepseek-v4.1-flash"`, and only an
    //     enumerable source can discover that.
    const entries = source.list?.(`providers/${dir}/models`)
    for (const name of entries ?? []) {
      if (!name.endsWith('.toml')) continue
      const path = `providers/${dir}/models/${name}`
      if (splitRef(parseCached(path, source.read(path) ?? '')?.base_model)?.slug === slug) {
        providerModel = path
        break search
      }
    }
  }
  if (providerModel !== undefined) files.providerModel = providerModel

  // the canonical model file the lab's file points at, else the lab/slug pair
  const canonicalSlug = splitRef(parse(providerModel ?? '')?.base_model)?.slug ?? slug
  for (const dir of dirs) {
    const path = `models/${lab}/${canonicalSlug}.toml`
    if (source.read(path) !== undefined) {
      files.canonicalModel = path
      break
    }
  }
  if (files.canonicalModel === undefined) {
    const ci = caseInsensitiveCanonical(lab, canonicalSlug, source)
    if (ci !== undefined) files.canonicalModel = ci
  }

  const providerToml = `providers/${lab}/provider.toml`
  if (source.read(providerToml) !== undefined) files.provider = providerToml

  if (files.providerModel === undefined && files.canonicalModel === undefined) {
    problems.push(`lab ${lab} has no file for ${id}`)
  }
  return { lab, slug, how, files, problems }
}

/** `models/<lab>/<id>.toml`, matched case-insensitively (`MiniMax-M2.5`). */
function canonicalFor(id, source) {
  const entries = source.list?.('models')
  if (entries === undefined) return undefined
  const wanted = `${id}.toml`.toLowerCase()
  for (const lab of entries) {
    const names = source.list?.(`models/${lab}`)
    if (names === undefined) continue
    const hit = names.find((name) => name.toLowerCase() === wanted)
    if (hit !== undefined) return { lab, slug: hit.slice(0, -'.toml'.length) }
  }
  return undefined
}

/**
 * A provider directory that references its own namespace, which is how a lab
 * that is not named like its models is recognized (`deepseek` authors
 * `deepseek-flash`; a reseller pointing at someone else's namespace is not it).
 */
function selfReferencingProviderFor(id, source) {
  const dirs = source.list?.('providers')
  if (dirs === undefined) return undefined
  for (const dir of dirs) {
    const names = source.list?.(`providers/${dir}/models`)
    if (names === undefined || !names.includes(`${id}.toml`)) continue
    const ref = splitRef(parseCached(`providers/${dir}/models/${id}.toml`,
      source.read(`providers/${dir}/models/${id}.toml`) ?? '')?.base_model)
    if (ref?.lab === dir) return dir
  }
  return undefined
}

function caseInsensitiveCanonical(lab, slug, source) {
  const names = source.list?.(`models/${lab}`)
  if (names === undefined) return undefined
  const hit = names.find((name) => name.toLowerCase() === `${slug.toLowerCase()}.toml`)
  return hit === undefined ? undefined : `models/${lab}/${hit}`
}

/** Parse cache so a listing-heavy resolution does not re-parse the same file. */
const PARSE_CACHE = new Map()
function parseCached(path, text) {
  const hit = PARSE_CACHE.get(path)
  if (hit !== undefined && hit.text === text) return hit.data
  const { data } = parseToml(text)
  PARSE_CACHE.set(path, { text, data })
  return data
}

// ── record building ──────────────────────────────────────────────────────────

/**
 * Assemble the official record for one model from the files that were read.
 *
 * @param {object} params - record inputs.
 * @param {string} params.id - the OpenCode Go model id.
 * @param {ReturnType<typeof resolveOfficialSources>} params.resolution - which files, and why.
 * @param {(path: string) => string | undefined} params.read - file reader.
 * @returns {object} the record stored in the baseline.
 */
export function buildOfficialRecord({ id, resolution, read }) {
  const data = (path) => (path === undefined ? undefined : parseCached(path, read(path) ?? ''))
  const ocg = data(resolution.files.ocg)
  const providerModel = data(resolution.files.providerModel)
  const canonicalModel = data(resolution.files.canonicalModel)
  const provider = data(resolution.files.provider)

  const options = normalizeReasoningOptions(
    providerModel?.reasoning_options
    ?? ocg?.reasoning_options
    ?? canonicalModel?.reasoning_options,
  )
  // A provider override is often thin (levels + cost only), so limits and
  // modalities fall back to the canonical model file — the model itself.
  const limit = { ...(canonicalModel?.limit ?? {}), ...(providerModel?.limit ?? {}) }
  const modalities = {
    ...(canonicalModel?.modalities ?? {}),
    ...(providerModel?.modalities ?? {}),
  }
  const input = Array.isArray(modalities.input) ? modalities.input : []
  const notes = [
    ...(resolution.files.providerModel === undefined
      ? []
      : commentBlocks(read(resolution.files.providerModel) ?? '')),
    ...(resolution.files.provider === undefined
      ? []
      : commentBlocks(read(resolution.files.provider) ?? '')),
  ]

  return {
    id,
    lab: resolution.lab,
    slug: resolution.slug,
    resolution: resolution.how,
    contextWindow: Number.isSafeInteger(limit.context) ? limit.context : undefined,
    maxTokens: Number.isSafeInteger(limit.output) ? limit.output : undefined,
    input: INPUT_MODALITIES.filter((modality) => input.includes(modality)),
    reasoning: providerModel?.reasoning === true || canonicalModel?.reasoning === true
      || options.length > 0,
    reasoningOptions: options,
    reasoningContract: reasoningContract(options),
    interleavedField: providerModel?.interleaved?.field ?? canonicalModel?.interleaved?.field,
    provider: resolution.files.provider === undefined ? undefined : {
      id: resolution.lab,
      env: Array.isArray(provider?.env) ? provider.env : undefined,
      api: typeof provider?.api === 'string' ? provider.api : undefined,
      doc: typeof provider?.doc === 'string' ? provider.doc : undefined,
    },
    sources: resolution.files,
    notes,
  }
}

/**
 * The official record for one model, or `undefined`.
 * @param {object | undefined} baseline - the parsed baseline document.
 * @param {string} id - the model id.
 * @returns {object | undefined} the record.
 */
export function officialRecordFor(baseline, id) {
  const models = baseline?.models
  if (models === null || typeof models !== 'object') return undefined
  const record = models[id]
  return record !== null && typeof record === 'object' ? record : undefined
}

/**
 * The DECLARED capability numbers one official record carries, projected into
 * the snapshot entry's vocabulary — and nothing else.
 *
 * This is the bridge between the official baseline and the runtime facts chain
 * (`ModelCatalog#snapshotEntryFor` is its only consumer): context window, max
 * output and input modalities are the three facts the README promises to take
 * from models.dev verbatim, without a request. Everything else stays out on
 * purpose — `reasoningOptions` / `interleavedField` / `protocol` are MEASURED
 * facts whose home is the synced layer, and `notes` / `sources` / `lab` /
 * `slug` / `provider` / resolution metadata are provenance, not capabilities.
 * Letting them through would silently re-introduce the "declared and measured
 * look identical" confusion this plugin exists to prevent.
 *
 * The vocabulary translation is deliberate: an official record spells modalities
 * `input` (as models.dev does), while a snapshot entry spells them
 * `inputModalities` (what `mapInputModalities` reads). Raw modality strings are
 * kept unfiltered — filtering to what this build supports is the mapper's job.
 *
 * @param {object | undefined} record - one official baseline record.
 * @returns {object | undefined} the fragment, or undefined when it would be empty.
 */
export function officialCapabilityFragment(record) {
  if (record === null || typeof record !== 'object') return undefined
  const fragment = {}
  if (Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0) {
    fragment.contextWindow = record.contextWindow
  }
  if (Number.isSafeInteger(record.maxTokens) && record.maxTokens > 0) {
    fragment.maxTokens = record.maxTokens
  }
  const modalities = Array.isArray(record.input)
    ? record.input.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
  if (modalities.length > 0) fragment.inputModalities = modalities
  return Object.keys(fragment).length === 0 ? undefined : fragment
}

/**
 * Wrap a baseline document for storage, stamping provenance.
 * @param {Record<string, object>} models - records keyed by model id.
 * @param {object} provenance - where the data came from.
 * @returns {object} the document to serialise.
 */
export function officialBaselineDocument(models, provenance) {
  return {
    kind: OFFICIAL_BASELINE_KIND,
    version: OFFICIAL_BASELINE_VERSION,
    source: { repo: 'github.com/anomalyco/models.dev', branch: 'dev', rawBase: OFFICIAL_RAW_BASE, ...provenance },
    modelCount: Object.keys(models).length,
    models,
  }
}

/**
 * Load the bundled official baseline.
 *
 * Never throws: a missing or malformed file means "no official facts", which the
 * sync reports as `unresolved` rather than turning into a failed route. The
 * caller decides how loudly to say so.
 *
 * @param {URL | string} [url] - the file to read.
 * @returns {{ ok: true, baseline: object } | { ok: false, error: string }} the loader outcome.
 */
export function loadOfficialBaseline(url = OFFICIAL_BASELINE_URL) {
  let text
  try {
    text = readFileSync(url, 'utf8')
  } catch (error) {
    return { ok: false, error: `cannot read the official baseline at ${String(url)} (${error instanceof Error ? error.message : String(error)})` }
  }
  try {
    const baseline = JSON.parse(text)
    if (baseline?.kind !== OFFICIAL_BASELINE_KIND) {
      return { ok: false, error: `${String(url)} is not a ${OFFICIAL_BASELINE_KIND} document` }
    }
    return { ok: true, baseline }
  } catch (error) {
    return { ok: false, error: `the official baseline at ${String(url)} is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}
