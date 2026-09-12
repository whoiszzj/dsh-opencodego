/**
 * Build `lib/` from `src/`.
 *
 * Phase 1 has no TypeScript toolchain and no bundler dependency in this
 * repository, so `src/*.js` IS the implementation and the build is a faithful
 * copy into `lib/`. That is deliberate:
 *
 *   - every `src/*.js` file imports only bare host packages (which the profile
 *     resolves — see README「依赖解析」) or sibling files, so the installed
 *     package needs no bundling to be loadable;
 *   - the published artifact stays readable and debuggable;
 *   - `npm run build` is a real check: it fails loudly on a syntax error and
 *     verifies the entry module parses.
 *
 * When phase 4b added the browser half it did NOT become a `tsc`/esbuild
 * pipeline: `src/client/**` is a second source tree with its own equally small
 * bundler, `scripts/build-client.mjs`, which emits `lib/client.js` in the web
 * module loader's registration format. That step runs FIRST, because it also
 * rewrites `package.json#dsh.client.external` from the externals it actually saw;
 * the host copy then follows, and both outputs are checked with `node --check`.
 *
 * Run: node scripts/build.mjs
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

/**
 * Fail the build on any file the host would refuse to parse. `node --check`
 * validates syntax only — it never resolves the bare host specifiers, whose
 * resolution is the profile's business, not the build's.
 * @param {string} file - absolute path of the emitted module.
 */
async function assertParses(file) {
  try {
    await run(process.execPath, ['--check', file])
  } catch (error) {
    throw new Error(`build: ${file} does not parse\n${error.stderr ?? error.message}`)
  }
}

/**
 * Every name one module exports, as far as a static scan can tell.
 *
 * Two spellings matter and both have bitten this build once: a generator
 * (`export async function* name`, where the `*` sits between the keyword and the
 * name) and a bare export list (`export { a, b } from './x.js'`, which must be
 * anchored to the start of a line so it cannot swallow `Object.freeze({`).
 * @param {string} source - one module's source.
 * @returns {Set<string>} the exported names.
 */
function exportedNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/^export\s*\{([\s\S]*?)\}\s*(?:from\s*'[^']*')?\s*$/gmu)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name.length > 0) names.add(name)
    }
  }
  return names
}

/**
 * `node --check` validates syntax per file, but a missing named export is a
 * LOAD-TIME failure the host only reports when it composes the plugin — which
 * is far too late to be the first time anyone notices (measured: a refactor
 * dropped four response-side exports and the isolated instance refused to boot).
 * Every local `import { … } from './x.js'` is therefore checked against the
 * sibling's exported names here, at build time.
 * @param {Map<string, string>} sources - raw source per src file.
 * @param {Map<string, Set<string>>} exportsByFile - exported names per src file.
 */
function assertLocalImportsResolve(sources, exportsByFile) {
  for (const [file, source] of sources.entries()) {
    const target = `src/${file}`
    // `[^{}]*` keeps one import statement from swallowing the next one when a
    // host import block sits between two local ones.
    for (const match of source.matchAll(/import\s*\{([^{}]*)\}\s*from\s*'(\.\/[^']+)'/gu)) {
      const specifier = match[2].slice(2)
      const exported = exportsByFile.get(specifier)
      if (exported === undefined) throw new Error(`build: ${target} imports './${specifier}', which is not a sibling module`)
      for (const entry of match[1].split(',')) {
        const name = entry.trim().split(/\s+as\s+/u)[0]?.trim()
        if (name === undefined || name.length === 0) continue
        if (!exported.has(name)) {
          throw new Error(`build: ${target} imports { ${name} } from './${specifier}', which does not export it`)
        }
      }
    }
  }
}

async function main() {
  const files = (await readdir(srcDir)).filter((name) => name.endsWith('.js')).sort()
  if (!files.includes('index.js')) throw new Error('build: src/index.js is missing')

  // `rm -rf lib/` would delete the browser half's output, so it goes first (and
  // it is what rewrites `package.json#dsh.client.external` — the host copy then
  // sees the final manifest).
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  await run(process.execPath, [join(here, 'build-client.mjs')], { cwd: root }).then(
    ({ stdout }) => process.stdout.write(stdout),
    (error) => { throw new Error(`build: the client half failed\n${error.stdout ?? ''}${error.stderr ?? error.message}`) },
  )

  let bytes = 0
  const sources = new Map()
  const exportsByFile = new Map()
  for (const file of files) {
    const source = await readFile(join(srcDir, file), 'utf8')
    sources.set(file, source)
    exportsByFile.set(file, exportedNames(source))
    const target = join(outDir, file)
    await writeFile(target, source, 'utf8')
    bytes += Buffer.byteLength(source, 'utf8')
    await assertParses(target)
  }
  assertLocalImportsResolve(sources, exportsByFile)

  process.stdout.write(`built lib/ (${files.length} modules, ${bytes} bytes): ${files.join(', ')}\n`)
}

await main()
