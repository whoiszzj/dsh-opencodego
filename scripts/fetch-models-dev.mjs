/**
 * Fetch the models.dev catalog and write the versioned snapshot this plugin
 * reads at runtime.
 *
 * Run it deliberately, review the diff, commit the result:
 *
 *   node scripts/fetch-models-dev.mjs                    # fetch and write data/opencode-go.models.json
 *   node scripts/fetch-models-dev.mjs --input api.json   # rebuild from a saved api.json (offline, reproducible)
 *   node scripts/fetch-models-dev.mjs --check            # fail if the committed snapshot is out of date
 *
 * Fetching uses `curl` (the same tool `wenzetan/dsh-llm-newapi`'s
 * `fetch-models-dev.mjs` uses, so a corporate proxy environment behaves the
 * same way) and falls back to Node's global `fetch` when curl is unavailable.
 * There is deliberately no GitHub TOML fallback: this plugin consumes exactly
 * one provider block, and a second source would silently change the shape.
 *
 * The output keeps UPSTREAM FACTS ONLY — the raw `provider.npm`, the raw
 * `modalities.input` list, the raw effort spellings. Every interpretation
 * (npm rule → protocol, modality filtering, effort → thinking level) happens at
 * runtime in `src/protocol-map.js` and `src/capabilities.js`, which are also
 * what this script imports so the two can never drift.
 *
 * CROSS-PROVIDER BACKFILL: the gateway lists some ids the `opencode-go` section
 * of models.dev does not record (measured: `deepseek-flash` — the gateway serves
 * it, models.dev catalogues that exact id under the `deepseek` provider). The
 * script backfills those by EXACT id from the same api.json document: the
 * model-level facts carry over, the other provider's `npm` does NOT (the
 * gateway speaks its own protocol rule, so a backfilled record inherits the
 * provider default). The provenance lands in the header's `backfill` map, so a
 * reader sees which record came from which provider section. Tune the list with
 * `--backfill=id1,id2` (or `--backfill=none`).
 *
 * Run: node scripts/fetch-models-dev.mjs
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { SNAPSHOT_KIND, SNAPSHOT_PROVIDER, trimModelRecord } from '../src/snapshot.js'
import { PROVIDER_NPM_DEFAULT } from '../src/protocol-map.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const DEFAULT_SOURCE = 'https://models.dev/api.json'
const DEFAULT_OUT = join(root, 'data', 'opencode-go.models.json')

/**
 * Gateway-listed ids the `opencode-go` section does not record, backfilled by
 * exact id from other provider sections (see the header note). `hy3-preview` is
 * deliberately absent: no provider section carries it (it is a gateway-side
 * pre-listing whose upstream currently answers "Model is unavailable").
 */
const DEFAULT_BACKFILL = Object.freeze(['deepseek-flash'])

/**
 * Backfill missing ids from the SAME catalog document, other provider sections.
 * @returns {{ models: object, backfill: Record<string, string>, missing: string[] }}
 */
function backfillFromOtherProviders(catalog, models, ids) {
  const backfill = {}
  const missing = []
  for (const id of ids) {
    if (models[id] !== undefined) continue
    let found = false
    for (const [pname, provider] of Object.entries(catalog)) {
      if (pname === SNAPSHOT_PROVIDER) continue
      const raw = typeof provider === 'object' && provider !== null
        ? (typeof provider.models === 'object' && provider.models !== null ? provider.models[id] : undefined)
        : undefined
      if (raw === undefined) continue
      const trimmed = trimModelRecord(raw)
      if (trimmed === undefined) continue
      // The other provider's npm package describes THEIR api, not this gateway:
      // drop it so the record inherits the opencode-go provider rule.
      const { npm, ...facts } = trimmed
      models[id] = facts
      backfill[id] = pname
      found = true
      break
    }
    if (!found) missing.push(id)
  }
  return { backfill, missing }
}

/** Parse `--flag value` pairs. */
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

/** Download the catalog with curl, falling back to Node's fetch. */
async function download(source) {
  try {
    const { stdout } = await run('curl', ['-sSL', '--fail', '--max-time', '120', source], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return { text: stdout, tool: 'curl' }
  } catch (error) {
    const response = await fetch(source, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      throw new Error(`cannot download ${source}: curl failed (${error instanceof Error ? error.message : String(error)}) and HTTP ${response.status}`)
    }
    return { text: await response.text(), tool: 'fetch' }
  }
}

/** Build the snapshot document from a raw models.dev catalog. */
export function buildSnapshot(catalog, { source, fetchedAt, backfillIds = DEFAULT_BACKFILL }) {
  const provider = catalog?.[SNAPSHOT_PROVIDER]
  if (typeof provider !== 'object' || provider === null) {
    throw new Error(`models.dev catalog has no provider "${SNAPSHOT_PROVIDER}"`)
  }
  if (typeof provider.models !== 'object' || provider.models === null) {
    throw new Error(`models.dev provider "${SNAPSHOT_PROVIDER}" has no "models" object`)
  }
  const models = {}
  const skipped = []
  for (const id of Object.keys(provider.models).sort()) {
    const trimmed = trimModelRecord(provider.models[id])
    if (trimmed === undefined) {
      skipped.push(id)
      continue
    }
    models[id] = trimmed
  }
  const { backfill, missing } = backfillFromOtherProviders(catalog, models, backfillIds)
  // Stable key order so a re-sync diffs only on facts, never on position.
  const ordered = Object.fromEntries(Object.entries(models).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
  return {
    document: {
      kind: SNAPSHOT_KIND,
      version: 1,
      source,
      provider: SNAPSHOT_PROVIDER,
      providerNpm: typeof provider.npm === 'string' ? provider.npm : PROVIDER_NPM_DEFAULT,
      providerApi: typeof provider.api === 'string' ? provider.api : undefined,
      fetchedAt,
      modelCount: Object.keys(ordered).length,
      ...(Object.keys(backfill).length === 0 ? {} : { backfill }),
      models: ordered,
    },
    skipped,
    backfill,
    backfillMissing: missing,
  }
}

/**
 * Reduce the snapshot to the facts still in use: the per-model `provider.npm`
 * (which the protocol rule reads) and the display name.
 *
 * Everything else in the upstream document describes capabilities, and
 * capabilities now come from a measured sync. Keeping them would mean the page
 * had two sources for one number with no way to tell them apart.
 *
 * @param {object} document - the built snapshot.
 * @returns {object} the trimmed document.
 */
export function trimToUsedFacts(document) {
  const models = {}
  for (const [id, record] of Object.entries(document.models ?? {})) {
    const kept = {}
    if (typeof record?.name === 'string' && record.name.length > 0) kept.name = record.name
    // `null` means "catalogued, inherits the provider package" — a meaningful
    // value the protocol rule distinguishes from "unknown id".
    if (record?.npm === null || typeof record?.npm === 'string') kept.npm = record.npm
    models[id] = kept
  }
  return { ...document, models }
}

/** Stable serialization: 2-space indent, one trailing newline. */
function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const out = typeof flags.out === 'string' ? resolve(flags.out) : DEFAULT_OUT
  const source = typeof flags.source === 'string' ? flags.source : DEFAULT_SOURCE
  const fetchedAt = typeof flags['fetched-at'] === 'string'
    ? flags['fetched-at']
    : new Date().toISOString()

  let raw
  let tool
  if (typeof flags.input === 'string') {
    raw = await readFile(resolve(flags.input), 'utf8')
    tool = `file:${resolve(flags.input)}`
  } else {
    const downloaded = await download(source)
    raw = downloaded.text
    tool = downloaded.tool
  }

  const catalog = JSON.parse(raw)
  const backfillIds = flags.backfill === undefined
    ? DEFAULT_BACKFILL
    : String(flags.backfill) === 'none'
      ? []
      : String(flags.backfill).split(',').map((id) => id.trim()).filter((id) => id.length > 0)
  const built = buildSnapshot(catalog, { source, fetchedAt, backfillIds })
  // Keep ONLY the two facts anything still reads. The capability numbers
  // (context/output/modalities/efforts) used to be the page's prefill; they are
  // now supplied by the sync and nothing else, and leaving them here would be a
  // second, silently-competing source for the same numbers — exactly the
  // "declared looks measured" problem the sync exists to end.
  const document = trimToUsedFacts(built.document)
  const { skipped, backfill, backfillMissing } = built
  const text = serialize(document)
  process.stdout.write(
    `${tool}: ${Object.keys(catalog).length} providers, ${document.modelCount} ${SNAPSHOT_PROVIDER} models`
    + `${skipped.length === 0 ? '' : `, ${skipped.length} skipped (${skipped.join(', ')})`}`
    + `${Object.keys(backfill).length === 0 ? '' : `, backfilled (${Object.entries(backfill).map(([id, from]) => `${id}←${from}`).join(', ')})`}`
    + `${backfillMissing.length === 0 ? '' : `, backfill-not-found (${backfillMissing.join(', ')})`}\n`,
  )

  if (flags.check === true) {
    const existing = await readFile(out, 'utf8').catch(() => undefined)
    if (existing === undefined) {
      process.stderr.write(`--check: ${out} does not exist\n`)
      process.exitCode = 1
      return
    }
    const existingDocument = JSON.parse(existing)
    // The timestamp is provenance, not data: a check compares the facts.
    delete existingDocument.fetchedAt
    const comparable = { ...document }
    delete comparable.fetchedAt
    if (serialize(existingDocument) !== serialize(comparable)) {
      process.stderr.write(`--check: ${out} differs from ${source}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`--check: ${out} is up to date\n`)
    return
  }

  await writeFile(out, text, 'utf8')
  process.stdout.write(`wrote ${out} (${Buffer.byteLength(text, 'utf8')} bytes, fetchedAt ${fetchedAt})\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
