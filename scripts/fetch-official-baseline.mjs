/**
 * Read the OFFICIAL capability baseline out of `anomalyco/models.dev` and write
 * the versioned file the plugin syncs against.
 *
 * Run it deliberately, review the diff, commit the result:
 *
 *   node scripts/fetch-official-baseline.mjs                     # refresh from GitHub
 *   node scripts/fetch-official-baseline.mjs --repo /path/to/models.dev
 *   node scripts/fetch-official-baseline.mjs --input models.json # ids from a saved /models reply
 *   node scripts/fetch-official-baseline.mjs --check             # fail if the committed file is stale
 *
 * ONLY THE FILES THAT ARE USED ARE FETCHED. The committed document records, per
 * model, the exact `sources` it was built from; a refresh re-reads those paths
 * and nothing else. A path that has moved forces that one model to be
 * re-resolved by rule, and an id with no rule is reported loudly instead of
 * being given another provider's numbers. The repository is never cloned or
 * vendored.
 *
 * `--repo` is the offline mode and is the only one that can ENUMERATE: it can
 * find the file a lab uses for a model by what that file *targets* (which is how
 * `deepseek-v4.1-flash` resolves to `deepseek-flash.toml`). The network mode
 * cannot list, so it relies on the recorded paths and the direct rules — which is
 * exactly why a cold start is generated with `--repo`.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  buildOfficialRecord,
  officialBaselineDocument,
  OFFICIAL_RAW_BASE,
  resolveOfficialSources,
} from '../src/official-baseline.js'

const run = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '..', 'data', 'opencode-go.official.json')
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) flags[name] = true
    else flags[name] = argv[++index]
  }
  return flags
}

/** Serialize with sorted keys so a diff only ever shows a real change. */
function serialize(value) {
  return `${JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }, 1)}\n`
}

/** One file over the network: raw GitHub first, Node fetch as the fallback. */
async function downloadText(url, attempts = 3) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { stdout } = await run('curl', ['-sSL', '--fail', '--max-time', '30', url],
        { maxBuffer: 16 * 1024 * 1024 })
      return stdout
    } catch (error) {
      lastError = error
      try {
        const response = await fetch(url, { headers: { accept: 'text/plain' } })
        if (response.ok) return await response.text()
        if (response.status === 404) return undefined
        lastError = new Error(`HTTP ${response.status}`)
      } catch (fetchError) {
        lastError = fetchError
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  // A 404 is a fact ("this file does not exist"); anything else is a failure the
  // caller must not mistake for one, so it is raised.
  if (String(lastError).includes('404')) return undefined
  throw new Error(`cannot read ${url}: ${lastError}`)
}

async function fetchIds(flags) {
  if (typeof flags.models === 'string') {
    return flags.models.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
  }
  let raw
  if (typeof flags.input === 'string') {
    raw = await readFile(resolve(flags.input), 'utf8')
  } else {
    const baseURL = typeof flags['base-url'] === 'string' ? flags['base-url'] : DEFAULT_BASE_URL
    raw = await downloadText(`${baseURL.replace(/\/+$/u, '')}/models`)
  }
  const document = JSON.parse(raw)
  const list = Array.isArray(document) ? document : document.data
  if (!Array.isArray(list)) throw new Error('expected a { data: [...] } model list')
  return list.map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
}

function localSource(repo) {
  const cache = new Map()
  const read = (path) => {
    if (cache.has(path)) return cache.get(path)
    let value
    try {
      value = readFileSync(join(repo, path), 'utf8')
    } catch {
      value = undefined
    }
    cache.set(path, value)
    return value
  }
  const list = (dir) => {
    try {
      return readdirSync(join(repo, dir))
    } catch {
      return undefined
    }
  }
  return { read, list }
}

async function networkSource() {
  const cache = new Map()
  const stats = { fetched: 0, missing: 0 }
  const read = async (path) => {
    if (cache.has(path)) return cache.get(path)
    const text = await downloadText(`${OFFICIAL_RAW_BASE}/${path}`)
    stats.fetched += 1
    if (text === undefined) stats.missing += 1
    cache.set(path, text)
    return text
  }
  return { read, list: undefined, cache, stats }
}

/**
 * Run the resolver synchronously against an async reader by pre-warming exactly
 * the paths it may ask for: the OpenCode Go entry plus every recorded path.
 */
async function warmCache(source, ids, previousModels) {
  const wanted = new Set()
  for (const id of ids) {
    wanted.add(`providers/opencode-go/models/${id}.toml`)
    const prior = previousModels?.[id]
    for (const path of Object.values(prior?.sources ?? {})) {
      if (typeof path === 'string') wanted.add(path)
    }
  }
  await Promise.all([...wanted].map((path) => source.read(path)))
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const out = typeof flags.out === 'string' ? resolve(flags.out) : DEFAULT_OUT
  const ids = (await fetchIds(flags)).slice().sort()

  let previousModels = {}
  try {
    previousModels = JSON.parse(await readFile(out, 'utf8')).models ?? {}
  } catch {
    previousModels = {}
  }

  const usingRepo = typeof flags.repo === 'string'
  /** @type {{ fetched: number, missing: number } | undefined} */
  let requestStats
  let source
  if (usingRepo) {
    source = localSource(resolve(flags.repo))
  } else {
    // The resolver is synchronous; pre-warm exactly the paths it may ask for,
    // then hand it a read-from-cache adapter. Same rules, same order, in both
    // modes — only the file access differs.
    const net = await networkSource()
    await warmCache(net, ids, previousModels)
    source = { read: (path) => net.cache.get(path), list: undefined }
    requestStats = net.stats
  }

  const models = {}
  const unresolved = []
  const drifted = []
  const missingProvider = []
  for (const id of ids) {
    // `--repo` is the cold path: it re-derives every plan, so a provenance value
    // from an earlier warm run cannot be carried forward indefinitely.
    const previous = usingRepo ? undefined : previousModels[id]
    const resolution = resolveOfficialSources({ id, previous, source })
    if (resolution.how === 'unresolved') {
      unresolved.push(id)
      continue
    }
    if (resolution.problems.some((problem) => problem.startsWith('recorded source'))) drifted.push(id)
    const record = buildOfficialRecord({ id, resolution, read: (path) => source.read(path) })
    if (record.lab !== undefined && record.sources.providerModel === undefined
      && record.sources.canonicalModel === undefined) {
      missingProvider.push(id)
    }
    models[id] = record
  }

  const document = officialBaselineDocument(models, {
    // The local path is not recorded: it is a build detail, not provenance a
    // reader of the committed file can use.
    mode: usingRepo ? 'repo' : 'network',
    // Provenance, not data: `--check` ignores it.
    fetchedAt: new Date().toISOString(),
  })
  const text = serialize(document)

  const summary = `${ids.length} ids, ${Object.keys(models).length} records`
    + (requestStats === undefined
      ? ''
      : `, ${requestStats.fetched} files fetched from GitHub (${requestStats.missing} did not exist)`)
    + `${unresolved.length === 0 ? '' : `, unresolved (${unresolved.join(', ')})`}`
    + `${drifted.length === 0 ? '' : `, re-resolved after drift (${drifted.join(', ')})`}`
    + `${missingProvider.length === 0 ? '' : `, no provider file (${missingProvider.join(', ')})`}`

  if (flags.check === true) {
    const existing = await readFile(out, 'utf8').catch(() => undefined)
    if (existing === undefined) {
      process.stderr.write(`--check: ${out} does not exist\n`)
      process.exitCode = 1
      return
    }
    // `--check` asks one question: are the FACTS stale? How the file was
    // generated (`mode`) and when (`fetchedAt`) are provenance, and comparing
    // them would fail a check merely for running in the other mode.
    if (serialize(facts(JSON.parse(existing))) !== serialize(facts(document))) {
      process.stderr.write(`--check: ${out} differs from upstream (${summary})\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`--check: ${out} is up to date (${summary})\n`)
    return
  }

  await writeFile(out, text, 'utf8')
  process.stdout.write(`wrote ${out} (${Buffer.byteLength(text, 'utf8')} bytes)\n${summary}\n`)
}

/** The comparable part of a baseline document: the facts, not the provenance. */
function facts(document) {
  return {
    kind: document.kind,
    version: document.version,
    models: document.models,
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
