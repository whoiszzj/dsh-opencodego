/**
 * Unit tests for the official-baseline layer: the pure helpers, the resolution
 * rules against an in-memory source, and the shape of the committed document.
 *
 * The resolution cases below are the ones that are actually hard — each was a
 * real failure while the rules were being written, so they are pinned here
 * rather than left to a live refresh to notice:
 *
 *   - `deepseek-flash` has no `base_model` and no canonical file of its own, so
 *     it is found only through a provider directory that references its own
 *     namespace;
 *   - `deepseek-v4.1-flash` has no file of its own anywhere — its contract lives
 *     in `deepseek-flash.toml`, which *targets* the same canonical model;
 *   - `minimax-m2.5` is authored as `MiniMax-M2.5`, so the match is
 *     case-insensitive;
 *   - `longcat-2.0` and `hy3` are authored by one brand and served by another
 *     provider directory (Meituan → `longcat`, Tencent → `tencent-tokenhub`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  buildOfficialRecord,
  ladderOrder,
  normalizeReasoningOptions,
  OFFICIAL_BASELINE_KIND,
  OFFICIAL_BASELINE_VERSION,
  officialBaselineDocument,
  officialRecordFor,
  reasoningContract,
  reasoningLevels,
  resolveOfficialSources,
} from '../src/official-baseline.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = resolve(HERE, '..', 'data', 'opencode-go.official.json')

/** An in-memory `source` adapter: a Map of path → text, plus optional dirs. */
function fakeSource(files, dirs = {}) {
  return {
    read: (path) => files.get(path),
    list: (dir) => dirs[dir],
  }
}

test('ladderOrder sorts by the canonical ladder, not alphabetically', () => {
  assert.deepEqual(ladderOrder(['high', 'low', 'max']), ['low', 'high', 'max'])
  assert.deepEqual(ladderOrder(['max', 'none', 'minimal']), ['none', 'minimal', 'max'])
  assert.deepEqual(ladderOrder(['weird', 'low']), ['low', 'weird'])
})

test('normalizeReasoningOptions keeps the declared shape, in ladder order', () => {
  assert.deepEqual(
    normalizeReasoningOptions([
      { type: 'effort', values: ['max', 'low', 'high'] },
      { type: 'toggle' },
      { type: 'budget_tokens', max: 262144 },
      { type: 'unknown' },
      'not an object',
    ]),
    [
      { type: 'effort', values: ['low', 'high', 'max'] },
      { type: 'toggle' },
      { type: 'budget_tokens', max: 262144 },
      { type: 'unknown' },
    ],
  )
  assert.deepEqual(normalizeReasoningOptions(undefined), [])
})

test('reasoningContract renders the ladder a person reads', () => {
  const of = (raw) => reasoningContract(normalizeReasoningOptions(raw))
  assert.equal(of([{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }]),
    'off / low / high / max')
  assert.equal(of([{ type: 'toggle' }]), 'off / on')
  assert.equal(of([{ type: 'effort', values: ['high', 'max'] }]), 'high / max')
  assert.equal(of([{ type: 'toggle' }, { type: 'budget_tokens', max: 262144 }]),
    'off / on + budget≤262144')
  assert.equal(of([
    { type: 'toggle' },
    { type: 'effort', values: ['low', 'medium', 'xhigh'] },
    { type: 'budget_tokens', max: 262144 },
  ]), 'off / low / medium / xhigh + budget≤262144')
  assert.equal(of([]), 'none declared')
})

test('reasoningLevels maps spellings to host levels, and folds none into off', () => {
  const { levels, hasOff, unmappable } = reasoningLevels(normalizeReasoningOptions([
    { type: 'toggle' },
    { type: 'effort', values: ['none', 'low', 'high'] },
  ]))
  // `none` is the provider's spelling for the host level `off`; `off` is not a
  // configurable level here (it means "omit the parameter"), so it is reported
  // as `hasOff` rather than as a level.
  assert.equal(hasOff, true)
  assert.deepEqual(levels, { low: 'low', high: 'high' })
  assert.deepEqual(unmappable, [])

  const weird = reasoningLevels(normalizeReasoningOptions([
    { type: 'effort', values: ['low', 'ludicrous'] },
  ]))
  assert.deepEqual(weird.levels, { low: 'low' })
  assert.deepEqual(weird.unmappable, ['ludicrous'])
})

test('resolution: base_model is followed, and the provider file wins over the canonical', () => {
  const files = new Map([
    ['providers/opencode-go/models/kimi-k3.toml', 'base_model = "moonshotai/kimi-k3"\n'],
    ['providers/moonshotai/models/kimi-k3.toml',
      'reasoning_options = [{ type = "toggle" }]\n[limit]\ncontext = 1_048_576\noutput = 131_072\n'],
    ['models/moonshotai/kimi-k3.toml',
      'reasoning = true\n[limit]\ncontext = 1_048_576\noutput = 131_072\n[modalities]\ninput = ["text", "image"]\n'],
    ['providers/moonshotai/provider.toml', 'name = "Moonshot"\nenv = ["MOONSHOT_API_KEY"]\n'],
  ])
  const resolution = resolveOfficialSources({
    id: 'kimi-k3',
    previous: undefined,
    source: fakeSource(files),
  })
  assert.equal(resolution.lab, 'moonshotai')
  assert.equal(resolution.how, 'base_model')
  assert.deepEqual(resolution.files, {
    ocg: 'providers/opencode-go/models/kimi-k3.toml',
    providerModel: 'providers/moonshotai/models/kimi-k3.toml',
    canonicalModel: 'models/moonshotai/kimi-k3.toml',
    provider: 'providers/moonshotai/provider.toml',
  })

  const record = buildOfficialRecord({ id: 'kimi-k3', resolution, read: (p) => files.get(p) })
  assert.equal(record.contextWindow, 1048576)
  assert.equal(record.maxTokens, 131072)
  assert.deepEqual(record.input, ['text', 'image'])
  assert.equal(record.reasoningContract, 'off / on')
})

test('resolution: a file that TARGETS the same canonical model is found by listing', () => {
  // `deepseek-v4.1-flash` has no file of its own; `deepseek-flash.toml` declares
  // `base_model = "deepseek/deepseek-v4.1-flash"`.
  const files = new Map([
    ['providers/opencode-go/models/deepseek-v4.1-flash.toml',
      'base_model = "deepseek/deepseek-v4.1-flash"\n'],
    ['providers/deepseek/models/deepseek-flash.toml',
      'base_model = "deepseek/deepseek-v4.1-flash"\n'
      + 'reasoning_options = [{ type = "toggle" }, { type = "effort", values = ["low", "high", "max"] }]\n'],
    ['models/deepseek/deepseek-v4.1-flash.toml',
      '[limit]\ncontext = 1_000_000\noutput = 384_000\n'],
    ['providers/deepseek/provider.toml', 'name = "DeepSeek"\n'],
  ])
  const resolution = resolveOfficialSources({
    id: 'deepseek-v4.1-flash',
    previous: undefined,
    source: fakeSource(files, { 'providers/deepseek/models': ['deepseek-flash.toml'] }),
  })
  assert.equal(resolution.lab, 'deepseek')
  assert.equal(resolution.files.providerModel, 'providers/deepseek/models/deepseek-flash.toml')
})

test('resolution: a self-referencing provider directory names the lab', () => {
  // No `base_model` anywhere and no `models/deepseek/deepseek-flash.toml`: the
  // only signal is that the `deepseek` directory's own file points at
  // `deepseek/…`. A reseller would point at someone else's namespace.
  const files = new Map([
    ['providers/deepseek/models/deepseek-flash.toml',
      'base_model = "deepseek/deepseek-v4.1-flash"\n'
      + 'reasoning_options = [{ type = "toggle" }]\n'],
    ['models/deepseek/deepseek-v4.1-flash.toml', '[limit]\ncontext = 1_000_000\n'],
    ['providers/bothub/models/deepseek-flash.toml',
      'base_model = "deepseek/deepseek-v4.1-flash"\n'],
    ['providers/deepseek/provider.toml', 'name = "DeepSeek"\n'],
  ])
  const resolution = resolveOfficialSources({
    id: 'deepseek-flash',
    previous: undefined,
    source: fakeSource(files, {
      providers: ['deepseek', 'bothub'],
      'providers/deepseek/models': ['deepseek-flash.toml'],
      'providers/bothub/models': ['deepseek-flash.toml'],
    }),
  })
  assert.equal(resolution.lab, 'deepseek')
  assert.equal(resolution.files.providerModel, 'providers/deepseek/models/deepseek-flash.toml')
})

test('resolution: the lab/provider aliases cover Meituan and Tencent', () => {
  const files = new Map([
    ['providers/opencode-go/models/longcat-2.0.toml', 'base_model = "meituan/longcat-2.0"\n'],
    ['providers/longcat/models/LongCat-2.0.toml',
      'base_model = "meituan/longcat-2.0"\n[[reasoning_options]]\ntype = "toggle"\n'],
    ['models/meituan/longcat-2.0.toml', '[limit]\ncontext = 1_000_000\noutput = 131_072\n'],
    ['providers/opencode-go/models/hy3.toml', 'base_model = "tencent/hy3"\n'],
    ['providers/tencent-tokenhub/models/hy3.toml', '[[reasoning_options]]\ntype = "toggle"\n'],
    ['models/tencent/hy3.toml', '[limit]\ncontext = 256_000\noutput = 128_000\n'],
  ])
  const longcat = resolveOfficialSources({
    id: 'longcat-2.0',
    previous: undefined,
    source: fakeSource(files, { 'providers/longcat/models': ['LongCat-2.0.toml'] }),
  })
  assert.equal(longcat.lab, 'meituan')
  assert.equal(longcat.files.providerModel, 'providers/longcat/models/LongCat-2.0.toml')

  const hy3 = resolveOfficialSources({ id: 'hy3', previous: undefined, source: fakeSource(files) })
  assert.equal(hy3.lab, 'tencent')
  assert.equal(hy3.files.providerModel, 'providers/tencent-tokenhub/models/hy3.toml')
})

test('resolution: the canonical model file matches case-insensitively', () => {
  const files = new Map([
    ['providers/opencode-go/models/minimax-m2.5.toml', 'reasoning_options = []\n'],
    ['providers/minimax/models/MiniMax-M2.5.toml', 'reasoning_options = []\n'],
    ['models/minimax/MiniMax-M2.5.toml', '[limit]\ncontext = 204_800\noutput = 131_072\n'],
  ])
  const resolution = resolveOfficialSources({
    id: 'minimax-m2.5',
    previous: undefined,
    source: fakeSource(files, {
      models: ['minimax'],
      'models/minimax': ['MiniMax-M2.5.toml'],
    }),
  })
  assert.equal(resolution.lab, 'minimax')
  assert.equal(resolution.files.canonicalModel, 'models/minimax/MiniMax-M2.5.toml')
})

test('resolution: a recorded plan is reused verbatim, without probing', () => {
  const files = new Map([
    ['providers/opencode-go/models/kimi-k3.toml', 'base_model = "moonshotai/kimi-k3"\n'],
    ['providers/moonshotai/models/kimi-k3.toml', '[[reasoning_options]]\ntype = "toggle"\n'],
  ])
  let reads = 0
  const source = {
    read: (path) => {
      reads += 1
      return files.get(path)
    },
    list: () => {
      throw new Error('a recorded plan must not need to enumerate')
    },
  }
  const resolution = resolveOfficialSources({
    id: 'kimi-k3',
    previous: {
      lab: 'moonshotai',
      slug: 'kimi-k3',
      resolution: 'base_model',
      sources: {
        ocg: 'providers/opencode-go/models/kimi-k3.toml',
        providerModel: 'providers/moonshotai/models/kimi-k3.toml',
      },
    },
    source,
  })
  // The RELATIONSHIP is preserved, so a refresh does not rewrite provenance.
  assert.equal(resolution.how, 'base_model')
  assert.equal(resolution.reused, true)
  // three reads: the OpenCode Go entry (always, it is what `files.ocg` names)
  // plus one per recorded path. A caching source makes the repeat free.
  assert.equal(reads, 3, 'one read per recorded path, and nothing else')
})

test('resolution: a moved file re-resolves the whole plan and says so', () => {
  const files = new Map([
    ['providers/opencode-go/models/kimi-k3.toml', 'base_model = "moonshotai/kimi-k3"\n'],
    ['providers/moonshotai/models/kimi-k3.toml', '[[reasoning_options]]\ntype = "toggle"\n'],
    ['models/moonshotai/kimi-k3.toml', '[limit]\ncontext = 1_048_576\n'],
  ])
  const resolution = resolveOfficialSources({
    id: 'kimi-k3',
    previous: {
      lab: 'moonshotai',
      slug: 'kimi-k3',
      resolution: 'base_model',
      sources: {
        ocg: 'providers/opencode-go/models/kimi-k3.toml',
        providerModel: 'providers/moonshotai/models/OLD-NAME.toml',
      },
    },
    source: fakeSource(files),
  })
  assert.ok(resolution.problems.some((p) => p.startsWith('recorded source(s) gone')))
  assert.equal(resolution.files.providerModel, 'providers/moonshotai/models/kimi-k3.toml')
  assert.equal(resolution.files.canonicalModel, 'models/moonshotai/kimi-k3.toml')
})

test('resolution: no official reference is reported, never guessed', () => {
  const resolution = resolveOfficialSources({
    id: 'omen-alpha',
    previous: undefined,
    source: fakeSource(new Map([['providers/opencode-go/models/omen-alpha.toml', 'reasoning = true\n']]),
      { models: [], providers: [], 'providers/opencode-go/models': ['omen-alpha.toml'] }),
  })
  assert.equal(resolution.how, 'unresolved')
  assert.ok(resolution.problems.some((p) => p.includes('no official reference')))
})

test('the committed baseline is well formed and covers the served models', () => {
  const document = JSON.parse(readFileSync(BASELINE, 'utf8'))
  assert.equal(document.kind, OFFICIAL_BASELINE_KIND)
  assert.equal(document.version, OFFICIAL_BASELINE_VERSION)
  assert.equal(document.modelCount, Object.keys(document.models).length)
  assert.ok(document.modelCount >= 30, `only ${document.modelCount} records`)

  for (const [id, record] of Object.entries(document.models)) {
    assert.equal(record.id, id)
    assert.ok(Array.isArray(record.reasoningOptions), `${id}: reasoningOptions`)
    assert.equal(typeof record.reasoningContract, 'string', `${id}: reasoningContract`)
    assert.ok(Array.isArray(record.input), `${id}: input`)
    assert.ok(record.sources !== null && typeof record.sources === 'object', `${id}: sources`)
    assert.ok(Object.keys(record.sources).length > 0, `${id}: sources is empty`)
    // The two facts the sync must never test.
    assert.ok(Number.isSafeInteger(record.contextWindow), `${id}: contextWindow`)
    assert.ok(Number.isSafeInteger(record.maxTokens), `${id}: maxTokens`)
  }

  // The resolutions that were hard to get right, pinned so a regeneration that
  // silently changes them fails here rather than in a user's model picker.
  assert.equal(document.models['deepseek-flash'].lab, 'deepseek')
  assert.equal(document.models['deepseek-flash'].sources.providerModel,
    'providers/deepseek/models/deepseek-flash.toml')
  assert.equal(document.models['deepseek-v4.1-flash'].sources.providerModel,
    'providers/deepseek/models/deepseek-flash.toml')
  assert.equal(document.models['longcat-2.0'].lab, 'meituan')
  assert.equal(document.models['hy3'].lab, 'tencent')
  assert.equal(document.models['minimax-m2.5'].lab, 'minimax')

  // `omen-alpha` has no official reference anywhere; it must be ABSENT rather
  // than carrying some other provider's numbers.
  assert.equal(document.models['omen-alpha'], undefined)
  assert.equal(officialRecordFor(document, 'omen-alpha'), undefined)
  assert.equal(officialRecordFor(document, 'kimi-k3').lab, 'moonshotai')
})

test('officialBaselineDocument stamps the source and counts the records', () => {
  const document = officialBaselineDocument({ a: { id: 'a' } }, { mode: 'test' })
  assert.equal(document.kind, OFFICIAL_BASELINE_KIND)
  assert.equal(document.version, OFFICIAL_BASELINE_VERSION)
  assert.equal(document.modelCount, 1)
  assert.equal(document.source.repo, 'github.com/anomalyco/models.dev')
  assert.equal(document.source.mode, 'test')
})
