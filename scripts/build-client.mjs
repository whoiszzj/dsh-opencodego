/**
 * Build the browser half into `lib/client.js`.
 *
 * The repository has no bundler dependency and the client half must not add one
 * (a browser half that needs `npm install esbuild` before it can be built is a
 * browser half that cannot be built on this machine — measured: neither
 * `esbuild` nor `tsdown` resolves from this checkout's dependency closure). So
 * this is a ~200-line bundler for the ONE shape the client half is allowed to
 * have:
 *
 *   - static relative imports between `src/client/*.js`, rewritten into a local
 *     module table as CJS `require`s. Every local `require` is DEFERRED to the
 *     importing factory's own execution (never run while the table is being
 *     built), so bundle-local cycles cannot happen by construction;
 *   - every other static import stays a runtime `require(...)` of a module the
 *     platform seed table answers. That table (dsh 0.1.5) provides `react`,
 *     `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 *     `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 *     `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
 *     `@deepseek-ai/dsh-client-ui-dockkit` — read from the shell's own
 *     `staticModules` factory in the installed `dsh-web-frontend` bundle.
 *     `package.json#dsh.client.external` is written from the union of the
 *     specifiers this build actually saw, so the host's graph row carries the
 *     same fact instead of a hand-maintained copy.
 *
 * The accepted source subset is deliberately what the client half uses:
 * bindings, function/class declarations, `export` markers, and no dynamic
 * `import()` or `export default`. Anything outside it fails the build loudly
 * rather than producing a bundle that only misbehaves in a browser — where no
 * test in this repository could see it.
 *
 * Output shape is the ModuleLoader registration contract:
 *
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { … } })
 *
 * The generated file also calls `pnpm pkg get` for its `id`, and writes back
 * `package.json#dsh.client.external`, which is why the id cannot drift from the
 * manifest and the externals cannot drift from the code.
 *
 * Run: node scripts/build-client.mjs
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src', 'client')
const outFile = join(root, 'lib', 'client.js')
const manifestFile = join(root, 'package.json')

/**
 * Every `import …` statement in one source, as whole statements.
 *
 * A statement ends at its `from '…'` clause (or at the line, for a bare
 * `import 'x'`), so a wrapped binding list is consumed as a unit — measured
 * failure mode: `import React, { useEffect, … } from 'react'` splits across two
 * lines, and a line-at-a-time rewrite leaves a dangling `} from './logic.js'`
 * behind, which is exactly what {@link assertNoLeftovers} exists to catch.
 * @param {string} source - one module's source.
 * @returns {Array<{ text: string, index: number, end: number }>} the statements.
 */
function importStatements(source) {
  const found = []
  const lines = source.split('\n')
  let offset = 0
  for (let line = 0; line < lines.length; line += 1) {
    const start = offset
    offset += lines[line].length + 1
    if (!/^\s*import\b/u.test(lines[line])) continue
    const chunk = []
    let cursor = line
    for (;;) {
      chunk.push(lines[cursor])
      const candidate = chunk.join('\n')
      if (/^\s*import\s*'[^']*'\s*;?\s*$/u.test(candidate)) break
      if (/from\s*'[^']*'\s*;?\s*$/u.test(candidate)) break
      if (cursor + 1 >= lines.length) break
      cursor += 1
    }
    const end = start + chunk.join('\n').length
    found.push({ text: chunk.join('\n').trim(), index: start, end })
    line = cursor
    offset = end + 1
  }
  return found
}
/** The binding list and source of `import [Default,] { a, b as c } from '…'`. */
const NAMED_IMPORT = /^import\s*(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([\s\S]*?)\}\s*from\s*'([^']+)'\s*;?$/u
/** The source of a bare `import 'react'` statement. */
const BARE_IMPORT = /^import\s*'([^']+)'\s*;?$/u
/** The local name and source of `import X from 'react'` / `import * as X from 'react'`. */
const IDENTITY_IMPORT = /^import\s*(\*\s*as\s+([A-Za-z_$][\w$]*)|[A-Za-z_$][\w$]*)\s*from\s*'([^']+)'\s*;?$/u

/**
 * Module specifiers the web shell's own `staticModules` table answers (dsh
 * 0.1.5). A bundle requiring one of these needs no graph edge: the seed word
 * exists before any plugin materializes. Read from
 * `@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js` (`staticModules`).
 */
const SHELL_SEED_WORDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * Reject the source shapes this bundler cannot represent faithfully.
 *
 * Diagnostic-only: the authoritative check is that {@link transform} leaves no
 * `import`/`export` marker behind (see `assertNoLeftovers`), because a
 * miscompile here would only ever surface in a browser.
 * @param {string} file - module path, for the message.
 * @param {string} source - its source.
 */
function assertSupportedSubset(file, source) {
  if (/^\s*export\s+default\b/mu.test(source)) {
    throw new Error(`build-client: ${file} uses "export default", which the ModuleLoader factory subset does not support`)
  }
  if (/\bimport\s*\(/u.test(source)) {
    throw new Error(`build-client: ${file} uses dynamic import(), which the loader cannot resolve synchronously`)
  }
  if (/^\s*export\s+\*/mu.test(source)) {
    throw new Error(`build-client: ${file} uses "export *", which needs live bindings this bundler does not build`)
  }
}

/** Fail the build if any ESM marker survived the rewrite. */
function assertNoLeftovers(file, source) {
  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*(import|export)\b/u.test(line)) {
      throw new Error(
        `build-client: ${file}:${String(index + 1)} still has an ESM statement this bundler does not model:\n  ${line.trim()}`,
      )
    }
  }
}

/** The bundle-local specifiers one module pulls in, in source order. */
function relativeDependencies(source) {
  const found = []
  for (const statement of importStatements(source)) {
    const named = NAMED_IMPORT.exec(statement.text)
    if (named !== null && named[3].startsWith('./')) found.push(named[3].slice(2))
  }
  // A re-export names a dependency too; missing it would drop a module the
  // bundle needs from the table.
  for (const match of source.matchAll(/^[ \t]*export\s*\{[^}]*\}\s*from\s*'(\.\/[^']+)'/gmu)) {
    found.push(match[1].slice(2))
  }
  return found
}

/** Every name a module exports, as a static scan sees it. */
function exportedNames(source) {
  const names = []
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.push(match[1])
  }
  for (const match of source.matchAll(/^export\s*\{([\s\S]*?)\}\s*(?:from\s*'[^']*')?\s*$/gmu)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name.length > 0) names.push(name)
    }
  }
  return names
}

/** Rewrite one module's imports into local-table and external-require forms. */
function transform(file, source, exportsOf, externals) {
  const lines = source.split('\n')

  /** The CJS replacement for one whole import statement. */
  const rewrite = (text) => {
    const named = NAMED_IMPORT.exec(text)
    if (named !== null) {
      const [, defaultLocal, bindingList, from] = named
      const bindings = bindingList.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
      if (bindings.length === 0 && defaultLocal === undefined) return []
      const emitted = []
      if (defaultLocal !== undefined) {
        if (from.startsWith('./')) {
          // A module-to-module default export is outside the factory subset.
          throw new Error(`build-client: ${file} default-imports './${from.slice(2)}' from a bundled module, which has no default export`)
        }
        externals.add(from)
        emitted.push(`const ${defaultLocal} = require("${from}");`)
      }
      for (const binding of bindings) {
        const [imported, local = imported] = binding.split(/\s+as\s+/u).map((part) => part.trim())
        if (from.startsWith('./')) {
          const specifier = from.slice(2)
          const exported = exportsOf(specifier)
          if (exported === undefined) {
            throw new Error(`build-client: ${file} imports './${specifier}', which is not part of the bundle`)
          }
          if (!exported.has(imported)) {
            throw new Error(`build-client: ${file} imports "${imported}" from './${specifier}', which does not export it`)
          }
          emitted.push(`const ${local} = __module("./${specifier}").${imported};`)
          continue
        }
        // `import { createElement as h } from 'react'` — a named binding pulled
        // from a platform external the shell's seed table answers.
        externals.add(from)
        emitted.push(`const ${local} = require("${from}").${imported};`)
      }
      return emitted
    }
    const bare = BARE_IMPORT.exec(text)
    if (bare !== null) {
      externals.add(bare[1])
      return [`require("${bare[1]}");`]
    }
    const identity = IDENTITY_IMPORT.exec(text)
    if (identity !== null) {
      const local = identity[2] ?? identity[1]
      externals.add(identity[3])
      return [`const ${local} = require("${identity[3]}");`]
    }
    throw new Error(`build-client: ${file} has an import statement this bundler does not model:\n  ${text}`)
  }

  // 1. Replace every import statement (whole statement, so a wrapped binding
  //    list is consumed as a unit) with the CJS form the factory executes.
  //    Statements are collected first and applied last-to-first so an earlier
  //    replacement cannot move a later offset.
  for (const statement of importStatements(source).reverse()) {
    const first = source.slice(0, statement.index).split('\n').length - 1
    const last = first + statement.text.split('\n').length - 1
    lines.splice(first, last - first + 1, ...rewrite(statement.text))
  }

  // 1b. A re-export (`export { X } from './y.js'`) is a local binding too: it
  //     must become a module-table read, because the module's own export face
  //     names the symbol. Dropping the statement wholesale was a real build
  //     break — `REPLACE_DISCOVERED_WARNING is not defined` at materialization.
  lines.forEach((line, index) => {
    const match = /^(\s*)export\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'\s*;?[ \t]*$/u.exec(line)
    if (match === null) return
    const specifier = match[3].slice(2)
    const bindings = match[2].split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    const exported = exportsOf(specifier)
    if (exported === undefined) {
      throw new Error(`build-client: ${file} re-exports './${specifier}', which is not part of the bundle`)
    }
    lines[index] = bindings.map((binding) => {
      const [imported, local = imported] = binding.split(/\s+as\s+/u).map((part) => part.trim())
      if (!exported.has(imported)) {
        throw new Error(`build-client: ${file} re-exports "${imported}" from './${specifier}', which does not export it`)
      }
      return `${match[1]}const ${local} = __module("./${specifier}").${imported};`
    }).join('\n')
  })

  // 2. Strip the export markers; the factory's return object is the export face.
  return lines.map((line) => line
    .replace(/^(\s*)export\s+(async\s+)?function\s*\*?\s*/u, '$1$2function ')
    .replace(/^(\s*)export\s+class\s+/u, '$1class ')
    .replace(/^(\s*)export\s+(const|let|var)\s+/u, '$1$2 ')
    .replace(/^(\s*)export\s*\{[^}]*\}\s*;?[ \t]*$/u, '')).join('\n')
}

/**
 * Keep the manifest's declared externals equal to the non-seed externals the
 * code actually requires.
 *
 * Seed words are deliberately NOT listed: `dsh.client.external` is the
 * module-graph edge list (`"row X needs row Y's factories first"`), and a shell
 * seed needs no row. Only a specifier the platform table does not answer — i.e.
 * another plugin's package — would have to be declared, and the client half has
 * none. This keeps the field honest instead of decorative.
 */
async function syncExternals(externals) {
  const declared = [...externals].filter((specifier) => !SHELL_SEED_WORDS.has(specifier)).sort()
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const previous = Array.isArray(manifest.dsh?.client?.external) ? [...manifest.dsh.client.external].sort() : []
  if (previous.join('\u0000') === declared.join('\u0000')) return false
  manifest.dsh.client.external = declared
  await writeFile(manifestFile, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return true
}

async function main() {
  const { stdout } = await run('pnpm', ['pkg', 'get', 'name'], { cwd: root })
  const id = stdout.trim()
  if (id.length === 0) throw new Error('build-client: pnpm pkg get name returned nothing')

  /** id → { source, exported: Set<string>, deps: string[] } */
  const records = new Map()
  const order = []

  /** Depth-first walk from the entry, so composition order is deterministic. */
  const load = async (name) => {
    if (records.has(name)) return
    const source = await readFile(join(srcDir, name), 'utf8')
    assertSupportedSubset(`src/client/${name}`, source)
    const deps = relativeDependencies(source)
    records.set(name, { source, exported: new Set(exportedNames(source)), deps })
    for (const dep of deps) await load(dep)
    order.push(name)
  }

  await load('index.js')
  if (!records.has('index.js')) throw new Error('build-client: src/client/index.js is missing')

  /** Transitive closure, so a cross-module import cannot hide behind a re-export. */
  const closure = (specifier) => {
    const seen = new Set()
    const walk = (name) => {
      for (const dep of records.get(name)?.deps ?? []) {
        if (seen.has(dep)) continue
        seen.add(dep)
        walk(dep)
      }
    }
    walk(specifier)
    return seen
  }
  const exportsOf = (specifier) => {
    const record = records.get(specifier)
    if (record === undefined) return undefined
    const names = new Set(record.exported)
    for (const dep of closure(specifier)) {
      for (const name of records.get(dep).exported) names.add(name)
    }
    return names
  }

  const externals = new Set()
  const bodies = order.map((specifier) => {
    const record = records.get(specifier)
    const source = transform(`src/client/${specifier}`, record.source, exportsOf, externals)
    assertNoLeftovers(`src/client/${specifier}`, source)
    const exported = [...record.exported]
    return [
      `__define(${JSON.stringify(`./${specifier}`)}, () => {`,
      source,
      '',
      `  return { ${exported.map((name) => `${name}: ${name}`).join(', ')} };`,
      '});',
    ].join('\n')
  })

  const externalsList = [...externals].sort()
  const factory = [
    'var __modules = {};',
    'var __cache = {};',
    'function __define(id, factory) { __modules[id] = factory; }',
    'function __module(id) {',
    '  if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];',
    '  var factory = __modules[id];',
    '  if (factory === undefined) throw new Error("dsh-opencodego/client: no such bundled module: " + id);',
    '  return (__cache[id] = factory());',
    '}',
    ...bodies,
    '__module("./index.js");',
  ].join('\n')

  const banner = [
    '// dsh-opencodego client bundle (ModuleLoader factory format), generated by scripts/build-client.mjs.',
    `// id: ${id}`,
    `// modules: ${String(order.length)} (${order.join(', ')})`,
    `// externals required from the loader's module table: ${externalsList.length === 0 ? '(none)' : externalsList.join(', ')}`,
    '// Do not edit: edit src/client/*.js and run `npm run build`.',
  ].join('\n')

  const body = [
    banner,
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    factory,
    'return __module("./index.js"); } });',
    '',
  ].join('\n')

  await writeFile(outFile, body, 'utf8')
  try {
    await run(process.execPath, ['--check', outFile])
  } catch (error) {
    throw new Error(`build-client: ${outFile} does not parse\n${error.stderr ?? error.message}`)
  }
  const synced = await syncExternals(externals)
  const bytes = Buffer.byteLength(body, 'utf8')
  process.stdout.write(
    `built lib/client.js (${String(order.length)} modules, ${String(bytes)} bytes, externals: ${externalsList.join(', ') || 'none'}${synced ? '; package.json#dsh.client.external updated' : ''}): ${order.join(', ')}\n`,
  )
}

await main()
