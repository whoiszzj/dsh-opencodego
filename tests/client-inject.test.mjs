/**
 * Host-contract guard: the browser half may only touch a context service it
 * DECLARED in `inject`.
 *
 * This exists because the shipped page crashed exactly here. `src/client/index.js`
 * declared `inject = ['remote', 'slots']` while reading `ctx.remote.settings`,
 * and cordis resolves a nested Remote namespace as its own service under the
 * FULL dotted key (`@deepseek-ai/dsh-api-gateway/lib/client.js`:
 * `remoteServiceKey(namespace) === 'remote.' + namespace`). Its traceable proxy
 * forwards `remote.<sub>` onto the context only when that key was injected
 * (`vendor/cordis/src/utils.ts`: `ctx.reflect.props[`${associate}.${prop}`]`),
 * so the undeclared read threw `cannot get property "remote.settings" without
 * inject` inside the settings slot and the panel stayed blank. No unit test saw
 * it, because every stub answered the calls the page made directly.
 *
 * Two layers, deliberately different in strictness:
 *
 *   1. SOURCE ⇄ INJECT — always on, no host needed. Every `ctx.<a>.<b>` access
 *      in `src/client/**` must be declared verbatim, and every declared entry
 *      must be used. Deleting an inject entry fails this immediately.
 *   2. USED ⇄ HOST — only when an installed host Remote assembly is findable.
 *      A dotted key must name a namespace that assembly really generates, so a
 *      typo (`remote.setting`) cannot pass by matching itself.
 *
 * @module tests/client-inject
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = join(ROOT, 'src', 'client')
const ENTRY = join(CLIENT_DIR, 'index.js')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const MANIFEST = join(ROOT, 'package.json')

/**
 * One source line with its `//` comment removed and string/template literal
 * contents blanked (delimiters kept). Per line, so a lone `'` inside prose can
 * never swallow the rest of the file — which a whole-file scanner would do.
 * @param {string} line - one physical line of JavaScript.
 * @returns {string} the code-shaped remainder.
 */
function scrubLine(line) {
  let out = ''
  let index = 0
  while (index < line.length) {
    const char = line[index]
    const next = line[index + 1]
    if (char === '/' && next === '/') break
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char
      out += quote
      index += 1
      while (index < line.length && line[index] !== quote) {
        if (line[index] === '\\') index += 1
        index += 1
      }
      out += quote
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Every `ctx.<service>[.<sub>]` access in one source, as its dotted key.
 *
 * The chain is read at most two segments deep — `ctx.remote.settings.describe()`
 * yields `remote.settings` — because that is exactly how cordis resolves it:
 * the longest service key, then plain methods on that service. Reading further
 * would invent services out of method names (`describe`, `inject`, `register`).
 * @param {string} source - one full source file.
 * @returns {string[]} dotted service keys, in source order.
 */
function serviceKeysOf(source) {
  const keys = []
  for (const line of source.split('\n')) {
    const code = scrubLine(line)
    for (const match of code.matchAll(/\bctx\s*\??\.\s*([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?/gu)) {
      keys.push(match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`)
    }
  }
  return keys
}

/**
 * One `inject` array literal, from either a source tree (`export const inject = […]`)
 * or a built bundle (`inject = […]`).
 */
const INJECT_LITERAL = /\binject\s*=\s*\[([^\]]*)\]/u

/** Every quoted word inside one `inject` array literal. */
function quotedEntries(text) {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"/gu)].map((entry) => entry[1] ?? entry[2])
}

/** The `inject` array literal one client source declares (empty when absent). */
function declaredInjectOf(source) {
  const match = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/u.exec(source)
  return match === null ? [] : quotedEntries(match[1])
}

/**
 * The cordis service names the installed host itself declares, gathered from the
 * host's own client halves — the composition's authoritative service vocabulary.
 *
 * A name only ever appears because some shipped plugin declared it in `inject`,
 * so this cannot invent a service: `remote` comes from the API gateway,
 * `remote.settings` and its siblings from the generated Remote namespaces, and
 * `slots`/`locale`/… from the shell plugins. Returns undefined when no host
 * install is reachable.
 * @returns {Set<string>|undefined} the service names, or undefined.
 */
function collectHostContract() {
  const roots = []
  const push = (base) => { for (const dir of ['node_modules', join('web', 'node_modules')]) roots.push(join(base, dir)) }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) push(join(home, 'profiles'))
  const userHome = process.env.HOME
  if (typeof userHome === 'string' && userHome.length > 0) push(join(userHome, '.dsh', 'profiles'))
  roots.push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))

  const names = new Set()
  let found = false
  for (const root of roots) {
    const scope = join(root, '@deepseek-ai')
    if (!existsSync(scope)) continue
    found = true
    let entries
    try {
      entries = readdirSync(scope, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const client = join(scope, entry.name, 'lib', 'client.js')
      if (!existsSync(client)) continue
      let text
      try {
        text = readFileSync(client, 'utf8')
      } catch {
        continue
      }
      const match = INJECT_LITERAL.exec(text)
      if (match !== null) for (const name of quotedEntries(match[1])) names.add(name)
    }
  }
  return found ? names : undefined
}

/**
 * The host's Remote namespace set, read from an installed assembly's descriptors.
 * @param {string} clientPath - path to `dsh-api-remotes/lib/client.js`.
 * @returns {Set<string>} the namespaces it generates.
 */
function hostRemoteNamespaces(clientPath) {
  const source = readFileSync(clientPath, 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/\bnamespace\s*:\s*"([A-Za-z_$][\w$]*)"/gu)) names.add(match[1])
  return names
}

/**
 * Resolve one `ctx.<a>[.<b>]` access to the SERVICE it actually touches.
 *
 * The host contract decides, never a hardcoded list of method names: a dotted
 * access is the full two-segment service when the host declares that name
 * (`remote.settings`), and otherwise it is a method on the one-segment service
 * (`ctx.slots.inject` → `slots`). When no contract is available the deepest key
 * is taken as written, which is the conservative reading for a guard.
 * @param {string} key - the two-segment access as written.
 * @param {Set<string>|undefined} contract - host service names, when known.
 * @returns {string} the service name.
 */
function resolveService(key, contract) {
  if (!key.includes('.')) return key
  if (contract === undefined || contract.has(key)) return key
  return key.slice(0, key.indexOf('.'))
}

/** Every `src/client/*.js` file with its source text. */
async function clientSources() {
  const names = (await readdir(CLIENT_DIR)).filter((name) => name.endsWith('.js')).sort()
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(join(CLIENT_DIR, name), 'utf8') })))
}

/**
 * Find the installed host Remote assembly.
 *
 * The repository carries no `node_modules` of its own (the plugin resolves host
 * packages from the DSH profile), so this looks where a real run would: the
 * checkout's ancestors, the DSH home in the environment, and the profile roots
 * of a default install. Returns undefined when no DSH install is reachable.
 * @returns {string|undefined} absolute path to `dsh-api-remotes/lib/client.js`.
 */
function findHostRemotesClient() {
  const bases = [ROOT, ...ancestorsOf(ROOT)]
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    bases.push(join(home, 'profiles'), join(home, 'profiles', 'web'))
  }
  const userHome = process.env.HOME
  if (typeof userHome === 'string' && userHome.length > 0) {
    bases.push(join(userHome, '.dsh', 'profiles'), join(userHome, '.dsh', 'profiles', 'web'))
  }
  const candidates = bases.map((base) => join(base, 'node_modules', '@deepseek-ai', 'dsh-api-remotes', 'lib', 'client.js'))
  // The global CLI nests its own dependency tree under `<dsh>/node_modules`.
  candidates.push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-api-remotes', 'lib', 'client.js'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Every ancestor directory of one path, nearest first. */
function ancestorsOf(path) {
  const out = []
  let current = resolve(path)
  while (true) {
    const parent = dirname(current)
    if (parent === current) return out
    out.push(parent)
    current = parent
  }
}


test('the client half injects every context service it touches, and nothing else', async () => {
  const sources = await clientSources()
  const contract = collectHostContract()
  const used = []
  for (const { name, source } of sources) {
    for (const access of serviceKeysOf(source)) used.push({ access, service: resolveService(access, contract), file: name })
  }
  assert.ok(used.length > 0, 'the scan found no ctx.<service> access at all — the guard would be vacuous')

  const entry = sources.find((source) => source.name === 'index.js')
  assert.ok(entry !== undefined, 'src/client/index.js must exist')
  const declared = declaredInjectOf(entry.source)
  assert.ok(declared.length > 0, 'src/client/index.js must export a non-empty inject array')

  const usedServices = [...new Set(used.map((access) => access.service))].sort()
  const declaredKeys = [...new Set(declared)].sort()
  assert.deepEqual(
    usedServices,
    declaredKeys,
    'every cordis service the client half reads (via ctx.<service>) must be declared in its inject '
    + 'array, and every declared entry must be used — an undeclared nested Remote namespace '
    + '(e.g. remote.settings) throws `cannot get property "<key>" without inject` inside the slot renderer',
  )

  // The dotted spelling is the whole point: `remote.settings` is a SERVICE NAME,
  // not a property of `remote`. Pin it independently so a bare `remote` entry
  // can never be mistaken for it.
  for (const access of used) {
    if (!access.access.includes('.')) continue
    if (access.service !== access.access) continue
    assert.ok(
      declared.includes(access.access),
      `${access.file} reads ctx.${access.access}: declare '${access.access}' verbatim (its own cordis service), not just its first segment`,
    )
  }
})

test('the inject list is deduplicated and the manifest still carries a client row', async () => {
  const declared = declaredInjectOf(await readFile(ENTRY, 'utf8'))
  assert.equal(declared.length, new Set(declared).size, 'inject must not repeat a service')

  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  // `dsh.client.inject` is a DIFFERENT list on purpose — package-name edges for
  // factory arrival and the boot graph — so it is not asserted equal to the
  // cordis service names above; it may legitimately stay empty (this plugin
  // needs no extra package row). It must still be present and well-formed,
  // because the loader reads it unconditionally.
  assert.ok(Array.isArray(manifest.dsh.client.inject), 'package.json#dsh.client.inject must be an array')
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('the built bundle exports the same inject list (build output cannot drift)', async () => {
  let source
  try {
    source = await readFile(BUNDLE, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error('tests/client-inject.test.mjs: lib/client.js is missing — run `npm run build` first')
  }
  const declared = declaredInjectOf(await readFile(ENTRY, 'utf8'))
  const literal = `[${declared.map((key) => `'${key}'`).join(', ')}]`
  assert.ok(
    source.includes(`inject = ${literal}`),
    `the built bundle must export inject = ${literal}; rebuild after editing src/client/index.js`,
  )
})

// ── layer 2: used ⇄ host contract (runs whenever a DSH install is reachable) ─

test('every dotted client service key names a namespace the host Remote really generates', async (t) => {
  const clientPath = findHostRemotesClient()
  if (clientPath === undefined) {
    // Not a silent skip: the assertion is impossible on a machine with no DSH
    // install, and saying so is the honest report. The source⇄inject guards
    // above still run everywhere.
    t.diagnostic('no installed @deepseek-ai/dsh-api-remotes found; host-contract layer not evaluated')
    return
  }
  const namespaces = hostRemoteNamespaces(clientPath)
  assert.ok(namespaces.size > 0, `no Remote namespace descriptors found in ${clientPath}`)

  const declared = declaredInjectOf(await readFile(ENTRY, 'utf8'))
  for (const key of declared) {
    if (!key.startsWith('remote.')) continue
    const namespace = key.slice('remote.'.length)
    assert.ok(
      namespaces.has(namespace),
      `inject declares '${key}', but the installed host Remote assembly generates no such namespace `
      + `(known: ${[...namespaces].sort().join(', ')})`,
    )
  }
})
