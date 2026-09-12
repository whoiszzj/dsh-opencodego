/**
 * Unit tests for the TOML reader and its comment extraction.
 *
 * This reader exists because the plugin has no dependency surface and the
 * published artifact is a copy of `src/`: adding a parser would change both. So
 * the reader is the one thing here that has to be trusted rather than reviewed,
 * and it is tested two ways:
 *
 *   1. the shapes models.dev actually writes, inline, below;
 *   2. a differential test against Python's `tomllib` over a real checkout of
 *      the repository, enabled by setting `MODELS_DEV_REPO`. That is the test
 *      that caught the real bug: `parseNumberOrWord` used the character class
 *      `/[\s,\]}]#/`, whose `]` closed the class early, so it matched only a
 *      delimiter followed by `]#` — it never stopped, swallowed every following
 *      statement, and silently dropped most of the file.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { commentBlocks, parseToml } from '../src/official-toml.js'

test('reads scalars, and a value never swallows the statement after it', () => {
  // The shape that broke: a bare boolean followed by more keys on later lines.
  const { data, problems } = parseToml([
    'name = "Kimi K3"',
    'attachment = false',
    'reasoning = true',
    'temperature = false',
    'context = 262_144',
    'ratio = 0.5',
  ].join('\n'))
  assert.deepEqual(problems, [])
  assert.deepEqual(data, {
    name: 'Kimi K3',
    attachment: false,
    reasoning: true,
    temperature: false,
    context: 262144,
    ratio: 0.5,
  })
})

test('reads tables, arrays of tables and dotted headers', () => {
  const { data, problems } = parseToml([
    '[limit]',
    'context = 1_048_576',
    'output = 131_072',
    '',
    '[modalities]',
    'input = ["text", "image", "video"]',
    'output = ["text"]',
    '',
    '[[reasoning_options]]',
    'type = "toggle"',
    '',
    '[[reasoning_options]]',
    'type = "effort"',
    'values = ["low", "high", "max"]',
    '',
    '[interleaved]',
    'field = "reasoning"',
    '',
    '[[cost.tiers]]',
    'tier = { type = "context", size = 200_000 }',
    'input = 4',
    '',
    '[[cost.tiers]]',
    'input = 2',
  ].join('\n'))
  assert.deepEqual(problems, [])
  assert.deepEqual(data.limit, { context: 1048576, output: 131072 })
  assert.deepEqual(data.modalities.input, ['text', 'image', 'video'])
  assert.deepEqual(data.reasoning_options, [
    { type: 'toggle' },
    { type: 'effort', values: ['low', 'high', 'max'] },
  ])
  assert.equal(data.interleaved.field, 'reasoning')
  assert.deepEqual(data.cost.tiers, [
    { tier: { type: 'context', size: 200000 }, input: 4 },
    { input: 2 },
  ])
})

test('reads the multi-line array of inline tables models.dev writes', () => {
  // Verbatim shape from providers/alibaba/models/qwen3.8-flash.toml.
  const text = [
    '# Budget: thinking_budget (Max Reasoning 262K)',
    'base_model = "alibaba/qwen3.8-flash"',
    'reasoning_options = [',
    '  { type = "toggle" },',
    '  { type = "effort", values = ["low", "medium", "xhigh"] },',
    '  { type = "budget_tokens", max = 262_144 },',
    ']',
  ].join('\n')
  const { data, problems } = parseToml(text)
  assert.deepEqual(problems, [])
  assert.equal(data.base_model, 'alibaba/qwen3.8-flash')
  assert.deepEqual(data.reasoning_options, [
    { type: 'toggle' },
    { type: 'effort', values: ['low', 'medium', 'xhigh'] },
    { type: 'budget_tokens', max: 262144 },
  ])
})

test('a comment may contain anything, including delimiters and braces', () => {
  // models.dev comments really do contain `=`, `|`, `[` and `#`.
  const { data, problems } = parseToml([
    '# OpenAI: `thinking.type = enabled|disabled`, `reasoning_effort = low|high|max`.',
    '# See https://example.com/docs # anchor',
    'flag = true',
  ].join('\n'))
  assert.deepEqual(problems, [])
  assert.deepEqual(data, { flag: true })
})

test('reads quoted keys, literal strings and multi-line strings', () => {
  const { data, problems } = parseToml([
    '"weird key" = \'literal # not a comment\'',
    'plain = """line one',
    'line two"""',
  ].join('\n'))
  assert.deepEqual(problems, [])
  assert.equal(data['weird key'], 'literal # not a comment')
  assert.equal(data.plain, 'line one\nline two')
})

test('an unreadable statement is reported, not fatal, and costs one statement', () => {
  const { data, problems } = parseToml([
    'good = 1',
    'broken = ',
    'stillGood = 2',
  ].join('\n'))
  assert.equal(data.good, 1)
  assert.equal(data.stillGood, 2)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /broken/u)
})

test('commentBlocks joins each block and keeps them in order', () => {
  const blocks = commentBlocks([
    '# first line',
    '# second line',
    'name = "x"',
    '',
    '# a second block',
    '# https://example.com (accessed 2026-06-25)',
    'other = 1',
  ].join('\n'))
  assert.deepEqual(blocks, [
    'first line second line',
    'a second block https://example.com (accessed 2026-06-25)',
  ])
})

test('differential: agrees with Python tomllib over a real checkout', (t) => {
  const repo = process.env.MODELS_DEV_REPO
  if (repo === undefined || repo.length === 0) {
    t.skip('set MODELS_DEV_REPO=/path/to/models.dev to run the differential test')
    return
  }
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue // a dangling symlink is not a test failure
      }
      if (stat.isDirectory()) walk(path)
      else if (name.endsWith('.toml')) files.push(path)
    }
  }
  for (const root of ['models', 'providers']) walk(join(repo, root))
  assert.ok(files.length > 1000, `expected a real checkout, found ${files.length} files`)

  const dump = files.map((path) => JSON.stringify({
    path: relative(repo, path),
    data: parseToml(readFileSync(path, 'utf8')).data,
  })).join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'ocg-toml-'))
  const dumpPath = join(dir, 'js.jsonl')
  writeFileSync(dumpPath, `${dump}\n`)

  // Python is the reference implementation here, not a dependency of the
  // plugin: the test is opt-in for exactly that reason.
  const script = `
import json, pathlib, sys, tomllib
repo = pathlib.Path(sys.argv[1])
mismatch = 0
count = 0
def norm(v):
    if isinstance(v, float) and v.is_integer(): return int(v)
    if isinstance(v, dict): return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list): return [norm(x) for x in v]
    return v
for line in open(sys.argv[2]):
    rec = json.loads(line)
    count += 1
    with open(repo / rec['path'], 'rb') as fh:
        py = tomllib.load(fh)
    if norm(rec['data']) != norm(py):
        mismatch += 1
        if mismatch <= 5: print('MISMATCH', rec['path'], file=sys.stderr)
print(f'{count} files, {mismatch} mismatches')
sys.exit(1 if mismatch else 0)
`
  const output = execFileSync('python3', ['-c', script, repo, dumpPath], { encoding: 'utf8' })
  assert.match(output, /0 mismatches/u, output)
})
