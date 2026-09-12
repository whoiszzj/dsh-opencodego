/**
 * The built browser half, exercised as the web module loader would load it.
 *
 * This is the evidence that makes "the page works" checkable on a machine with
 * no browser: `lib/client.js` is evaluated with a `window.__ModuleLoader__` stub
 * that captures the registration, its factory is materialized with a `react`
 * stand-in (seed-word shaped), and the section is driven through the settings,
 * credential, and route faces the registration built.
 *
 * What it does NOT prove, and says so: the loader serves the bundle, and the
 * shell paints it. Those are covered by `scripts/acceptance/phase4b-run.sh`
 * (curl for the served script + the route payloads) and by the honest
 * "UI not rendered in a real browser" note in PROGRESS.md.
 *
 * @module tests/client-bundle
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const MANIFEST = new URL('../package.json', import.meta.url)

/**
 * Evaluate the built bundle and answer its registered factory.
 * @returns {{id: string, factory: Function, source: string}} the registration.
 */
async function loadRegistration() {
  let source
  try {
    source = await readFile(BUNDLE, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(
      'tests/client-bundle.test.mjs: lib/client.js is missing — run `npm run build` first '
      + '(the published `npm test` runs after `prepack`, which builds it)',
    )
  }
  let registration
  const window = {
    __ModuleLoader__: { load: (entry) => { registration = entry } },
  }
  // The bundle is a browser file; the only globals it touches are these two.
  globalThis.window = window
  try {
    // eslint-disable-next-line no-new-func -- the point IS to evaluate the artifact
    new Function('window', source)(window)
  } finally {
    delete globalThis.window
  }
  assert.ok(registration !== undefined, 'the bundle registered nothing with __ModuleLoader__.load')
  return { ...registration, source }
}

/** Drain the microtask queue (every `.then` a test fetch answers with). */
async function drainMicrotasks() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

/**
 * A `react` stand-in with just enough fidelity to drive one section: hooks keep
 * state across renders, `useEffect` runs synchronously, and `createElement`
 * builds a plain tree that can be searched as text.
 * @returns {object} the fake module.
 */
function fakeReact() {
  const states = []
  const refs = []
  const effectDeps = []
  let changed = false
  let cursor = 0
  let effectsFired = 0
  const effectCount = () => effectsFired
  /**
   * Evaluate function components inline, the way React does.
   *
   * Without this the tree keeps `{ type: TextField, props: { field: … } }` nodes
   * and no real `<input>` ever exists — a harness that cannot see the leaves
   * cannot check what the page renders.
   */
  const build = (type, props, children) => {
    if (typeof type === 'function') {
      const produced = type(props ?? {})
      if (produced === undefined || produced === null) return produced
      return build(produced.type, produced.props, produced.children)
    }
    // Children FLATTEN, like the DOM appending an array-valued child: the page
    // writes `[cond ? option : null, options.map(...)]`, and a nested array would
    // otherwise hide every `<option>` from the search helpers.
    return { type, props: props ?? {}, children: flatten(children ?? []) }
  }
  /** Resolve component calls inside a child list and flatten nested arrays. */
  const flatten = (list) => {
    const out = []
    for (const child of list) {
      if (child === undefined || child === null || typeof child === 'boolean') continue
      if (Array.isArray(child)) {
        out.push(...flatten(child))
        continue
      }
      if (typeof child === 'object' && 'type' in child && 'props' in child) {
        out.push(build(child.type, child.props, child.children))
        continue
      }
      out.push(child)
    }
    return out
  }
  const api = {
    createElement: (type, props, ...children) => build(type, props, children),
    Fragment: 'Fragment',
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(states[index]) : next
        // `Object.is`, like React: a value that is only deep-equal does not
        // re-render. That is what makes the section's catalogue effect converge.
        if (!Object.is(value, states[index])) {
          states[index] = value
          changed = true
        }
      }
      return [states[index], set]
    },
    useRef: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    /**
     * Effects with React's dependency semantics.
     *
     * This is not a convenience. A section whose effects re-subscribe on every
     * render is a real bug, and a harness that ran every effect every time would
     * HIDE it (handing back a deep-equal answer forever instead of converging).
     * So the dependency list is honored: `[]` runs once, an effect whose
     * dependencies never move does not run again, and a component that gets this
     * wrong spins here until `settle` gives up and says so.
     */
    useEffect: (effect, deps) => {
      // Hook position, like React's hook order — NOT a per-pass counter, or the
      // first effect would look new on every render.
      const index = cursor
      cursor += 1
      const previous = effectDeps[index]
      const next = deps === undefined ? undefined : [...deps]
      const stale = previous === undefined
        || next === undefined
        || next.length !== previous.length
        || next.some((value, position) => !Object.is(value, previous[position]))
      effectDeps[index] = next
      if (stale) {
        effectsFired += 1
        effect()
      }
      return undefined
    },
    useMemo: (factory) => factory(),
    /**
     * Render like React does around effects, then drain the microtask queue, over
     * and over until nothing changed.
     */
    render: (Component, props) => {
      cursor = 0
      effectsFired = 0
      changed = false
      return Component(props)
    },
    settle: async (Component, props) => {
      let tree
      const pass = async () => {
        cursor = 0
        effectsFired = 0
        changed = false
        tree = Component(props)
        await drainMicrotasks()
        return changed || effectsFired > 0
      }
      let moved = await pass()
      for (let guard = 0; guard < 200 && moved; guard += 1) {
        moved = await pass()
      }
      if (moved) throw new Error('the section never settled after 200 passes (an effect is re-subscribing every render?)')
      void effectCount
      return tree
    },
  }
  return api
}

/** Every string a rendered tree contains, in order. */
function texts(node, out = []) {
  if (node === undefined || node === null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const entry of node) texts(entry, out)
    return out
  }
  if (typeof node === 'object') {
    // The stylesheet is text but not COPY; searching it would make assertions
    // like "the page says RFC 7230" trivially true.
    if (node.type === 'style') return out
    // This page puts copy in PROPS (`TextField` renders `label`, `hint` and the
    // inline `error` itself), so the searchable text is children + those props.
    // `value` is deliberately excluded: it is data the operator typed, not copy.
    for (const key of ['label', 'hint', 'error', 'placeholder', 'data-ocg-field']) {
      const value = node.props?.[key]
      if (typeof value === 'string') out.push(value)
    }
    if (Array.isArray(node.children)) for (const child of node.children) texts(child, out)
  }
  return out
}

/** Every element of one type in a rendered tree. */
function elements(node, type, out = []) {
  if (node === undefined || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) elements(entry, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) elements(child, type, out)
  return out
}

/** The one control carrying a `data-ocg-field` name. */
function control(tree, name) {
  if (tree === undefined) return undefined
  return find(tree, (node) => node.props?.['data-ocg-field'] === name)[0]
}

/** Every element whose props satisfy the predicate. */
function find(node, predicate, out = []) {
  if (node === undefined || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) find(child, predicate, out)
  return out
}

/** One catalogue entry as the enriched route answers it. */
function modelOf(id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: 'openai-completions',
    protocolSource: 'models.dev-npm',
    snapshotKnown: true,
    // Capability facts are only shown once a sync measured them, so a fixture
    // that expects chips is a synced model.
    synced: true,
    defaults: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    effective: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    ...overrides,
  }
}

/** The `SettingsNamespaceView` the host would answer with. */
function describeAnswer(overrides = {}) {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: 'llm-deepseek', schema: {}, value: {}, applies: 'restart', secrets: [], revision: 1 },
      {
        ns: 'opencode-go-native',
        schema: { type: 'object', properties: { models: {} } },
        value: {
          baseURL: 'https://opencode.ai/zen/go/v1',
          apiKeyEnv: 'OPENCODE_GO_API_KEY',
          sessionHeader: 'x-opencode-session',
          sessionHeaderEnabled: true,
          sessionHeaderMode: 'session-id',
          sync: true,
          models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: false },
        },
        user: {},
        applies: 'live',
        secrets: [],
        revision: 11,
        ...overrides,
      },
    ],
  }
}

/** A recording harness: one section, driven by explicit answers. */
async function harness({
  describe = describeAnswer(),
  catalogue,
  discovery,
  diagnostics,
  facts,
  refreshError,
  credential = { configured: false, writable: true },
  failMutate,
  failDiscover,
  failCredentialSet,
  sync,
} = {}) {
  const { factory } = await loadRegistration()
  const calls = { describe: 0, mutate: [], catalogue: [], discover: [], urls: [], credentialSet: [], credentialUnset: [], credentialDescribe: [] }
  const React = fakeReact()
  const reactModule = { default: React, ...React }
  const exports = factory((specifier) => {
    assert.equal(specifier, 'react', `the bundle required an unexpected external: ${specifier}`)
    return reactModule
  })

  const registrations = []
  const injections = []
  // The live settings document as the host would keep it: the mutate stub
  // APPLIES the ops it receives (to the USER layer and the resolved layer) and
  // answers with the new namespace view, so a path-addressed write round-trips
  // exactly like the host's resolve-against-stored semantics.
  const document = JSON.parse(JSON.stringify(describe))
  const setPath = (root, path, value) => {
    let node = root
    for (const key of path.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
      node = node[key]
    }
    node[path[path.length - 1]] = value
  }
  const unsetPath = (root, path) => {
    let node = root
    for (const key of path.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) return
      node = node[key]
    }
    delete node[path[path.length - 1]]
  }
  const ctx = {
    remote: {
      settings: {
        describe: () => {
          calls.describe += 1
          // The host answers a `RemoteResult` envelope, not the bare value:
          // `{ ok: true, value }` (`@deepseek-ai/dsh-typert-protocol`). A stub
          // that hands back the bare view is exactly what let the missing
          // unwrap ship, so the double speaks the wired shape.
          return Promise.resolve({ ok: true, value: document })
        },
        mutate: (ns, ops, revision) => {
          calls.mutate.push({ ns, ops, revision })
          if (failMutate !== undefined) return Promise.resolve({ ok: false, error: failMutate })
          const next = document.namespaces[1]
          for (const op of ops) {
            if (op.op === 'set') {
              setPath(next.user ??= {}, op.path, op.value)
              setPath(next.value ??= {}, op.path, op.value)
            } else {
              unsetPath(next.user ??= {}, op.path)
              unsetPath(next.value ??= {}, op.path)
            }
          }
          next.revision = (next.revision ?? 0) + 1
          return Promise.resolve({ ok: true, value: JSON.parse(JSON.stringify(next)) })
        },
      },
      credentials: {
        describe: (refs) => {
          calls.credentialDescribe.push([...refs])
          return Promise.resolve({
            ok: true,
            value: Object.fromEntries(refs.map((ref) => [ref, credential])),
          })
        },
        set: (ref, value) => {
          calls.credentialSet.push({ ref, value })
          if (failCredentialSet !== undefined) return Promise.resolve({ ok: false, error: failCredentialSet })
          return Promise.resolve({ ok: true, value: undefined })
        },
        unset: (ref) => {
          calls.credentialUnset.push(ref)
          return Promise.resolve({ ok: true, value: undefined })
        },
      },
    },
    slots: {
      inject: (name, callback) => injections.push({ name, callback }),
      register: (options, Component) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }

  const originalFetch = globalThis.fetch
  let catalogueAnswer
  let diagnosticsAnswer
  globalThis.fetch = async (url, options) => {
    calls.urls.push({ url, options })
    const absolute = String(url)
    if (absolute.includes('/opencode-go-native/sync')) {
      if (options?.method !== 'POST') return { status: 200, json: async () => ({ ok: true, models: {} }) }
      const wanted = JSON.parse(options.body).id
      const answer = typeof sync === 'function' ? sync(wanted) : sync?.[wanted]
      if (answer === undefined) return { status: 200, json: async () => ({ ok: false, error: { code: 'SYNC_FAILED', message: `no sync fixture for ${wanted}` } }) }
      return { status: 200, json: async () => ({ ok: true, sync: answer, saved: '/tmp/opencode-go.synced.json' }) }
    }
    if (absolute.includes('/diagnostics')) {
      if (diagnostics === undefined) throw new Error('no diagnostics fixture')
      diagnosticsAnswer ??= diagnostics
      return { status: 200, json: async () => diagnosticsAnswer }
    }
    if (options?.method === 'POST') {
      if (failDiscover !== undefined) return { status: 200, json: async () => failDiscover }
      return { status: 200, json: async () => ({ ok: true, models: discovery ?? catalogue ?? [] }) }
    }
    catalogueAnswer ??= {
      ok: true,
      source: 'cache',
      ...(facts === undefined ? {} : { facts }),
      ...(refreshError === undefined ? {} : { refreshError }),
      models: catalogue ?? [],
    }
    return { status: 200, json: async () => catalogueAnswer }
  }

  const restoreFetch = () => { globalThis.fetch = originalFetch }
  {
    exports.apply(ctx)
    const injected = injections[0]
    assert.ok(injected !== undefined, 'apply() never injected into settings.section')
    injected.callback()
    const registration = registrations[0]
    assert.ok(registration !== undefined, 'slots.register was never called')
    const props = {
      close: () => {},
      ...registration.options.inject(),
    }
    const page = {
      exports,
      registration,
      registrations,
      injections,
      registrationCount: registrations.length,
      props,
      calls,
      /** The most recent render's tree (reloads replace it). */
      get tree() { return page.currentTree },
      get text() { return texts(page.currentTree).join('\n') },
      get reloadTree() { return page.currentTree },
      currentTree: undefined,
      /** The one control a `data-ocg-field` name addresses. */
      control: (name) => control(page.currentTree, name),
      texts: (node) => texts(node ?? page.currentTree),
      find: (predicate) => find(page.currentTree, predicate),
      elements: (type) => elements(page.currentTree, type, []),
      reload: async () => {
        page.currentTree = await React.settle(registration.Component, props)
        return page.currentTree
      },
      restore: restoreFetch,
    }
    page.currentTree = await React.settle(registration.Component, props)
    return page
  }
}

// ── the artifact itself ────────────────────────────────────────────────────

test('the bundle is a ModuleLoader registration for this package, with no external but react', async () => {
  const { id, source } = await loadRegistration()
  assert.equal(id, 'dsh-opencodego')
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  assert.equal(id, manifest.name, 'the registration id must be the package name the loader keys the row by')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.external, [], 'a shell seed word needs no graph edge')
  const requires = [...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
  // The factory must not execute module bodies at parse time: only the
  // registration call may run while the script is evaluated.
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{ id: /mu)
})

test('the manifest declares what the host loader requires of a client package', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  assert.equal(typeof manifest.dsh.client.inject, 'object')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('lib'))
})

test('materializing the factory answers the cordis plugin face', async () => {
  const { factory, source } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  // `remote.settings` and `remote.credentials` are the host's nested Remote
  // namespace service keys, which cordis requires to be declared with their dot
  // (see src/client/index.js).
  assert.deepEqual(exports.inject, ['remote', 'remote.credentials', 'remote.settings', 'slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.ok(source.includes('opencode-go-native'))
})

// ── registration ───────────────────────────────────────────────────────────

test('apply() registers exactly one settings.section with our id and label', async () => {
  const page = await harness()
  assert.equal(page.registrationCount, 1)
  assert.equal(page.injections[0].name, 'settings.section')
  assert.equal(page.registration.options.name, 'settings.section')
  assert.equal(page.registration.options.id, 'opencode-go-native')
  assert.equal(page.registration.options.label(), 'OpenCode Go')
  const face = page.registration.options.inject()
  assert.equal(face.settingsNamespace, 'opencode-go-native')
  for (const method of ['describeSettings', 'mutateSettings', 'describeCredential', 'storeCredential', 'removeCredential', 'catalogue', 'discoverDraft', 'diagnostics']) {
    assert.equal(typeof face.api[method], 'function', method)
  }
  page.restore()
})

// ── reading the settings ───────────────────────────────────────────────────

test('the section reads its namespace and renders the connection card with the credential state', async () => {
  const page = await harness({ credential: { configured: true, source: 'file', writable: true } })
  assert.equal(page.calls.describe, 1)
  assert.match(page.text, /OpenCode Go/u)
  // The namespace/revision meta line and the credential-reference field are GONE:
  // the default reference works behind the API-key field, and there is nothing
  // there for an operator to edit. The page is content, not plumbing.
  assert.ok(!page.text.includes('revision'), 'no revision meta on the page')
  assert.ok(!page.text.includes('命名空间'), 'no namespace meta on the page')
  assert.ok(!page.text.includes('凭据引用名'), 'the reference field is not rendered')
  assert.equal(page.control('apiKeyEnv'), undefined)
  // The credential VALUE never appears: the page only knows the state.
  assert.match(page.text, /凭据状态：已配置/u)
  assert.match(page.text, /来源 file/u)
  assert.match(page.text, /凭据存储/u)
  assert.match(page.text, /\.credentials\.yaml/u)
  // The key field is a password input whose own VALUE is empty.
  const key = page.control('apiKey')
  assert.ok(key !== undefined, 'the 连接 card must render the API-key control')
  assert.equal(key.props.type, 'password')
  assert.equal(key.props.value, '')
  assert.equal(key.props.placeholder, '已配置——输入新值可替换')
  assert.ok(page.control('action.clearCredential') !== undefined, 'a configured credential can be cleared')
  page.restore()
})

test('an unconfigured credential says so and offers no clear button', async () => {
  const page = await harness()
  assert.match(page.text, /凭据状态：未配置/u)
  assert.equal(page.control('apiKey').props.placeholder, '输入 API 密钥')
  assert.equal(page.control('action.clearCredential'), undefined)
  page.restore()
})

test('a pre-0.6.0 plain-text apiKey is warned about, never rendered', async () => {
  const page = await harness({
    describe: describeAnswer({
      user: { apiKey: 'sk-LEGACY-not-a-real-key' },
      secrets: [{ path: ['apiKey'], set: true }],
    }),
  })
  assert.match(page.text, /设置文件里还有旧版的明文 apiKey/u)
  assert.equal(page.control('apiKey').props.value, '', 'neither the staged field nor any input holds the legacy token')
  page.restore()
})

test('a missing namespace says so instead of rendering an empty form', async () => {
  const page = await harness({
    describe: { writable: true, hasDocument: true, namespaces: [{ ns: 'other', schema: {}, value: {}, revision: 1, secrets: [] }] },
  })
  assert.match(page.text, /没有命名空间 opencode-go-native/u)
  assert.match(page.text, /重试/u)
  page.restore()
})

test('a describe() refusal is shown verbatim and offers a retry', async () => {
  const { factory } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  const ctx = {
    remote: {
      settings: { describe: () => Promise.reject(Object.assign(new Error('provider absent'), { code: 'gateway/internal' })) },
      credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => { ctx.Component = Component; ctx.options = options; return () => {} },
    },
  }
  exports.apply(ctx)
  ctx.options.inject()
  const tree = await React.settle(ctx.Component, { close: () => {}, ...ctx.options.inject() })
  const text = texts(tree).join('\n')
  assert.match(text, /gateway\/internal: provider absent/u)
  assert.match(text, /重试/u)
})

test('the host Remote error ARM (ok: false) is shown verbatim too, not swallowed', async () => {
  const { factory } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  const ctx = {
    remote: {
      settings: {
        describe: () => Promise.resolve({
          ok: false,
          error: Object.assign(new Error('no settings provider is mounted'), { code: 'gateway/internal' }),
        }),
      },
      credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => { ctx.Component = Component; ctx.options = options; return () => {} },
    },
  }
  exports.apply(ctx)
  ctx.options.inject()
  const tree = await React.settle(ctx.Component, { close: () => {}, ...ctx.options.inject() })
  const text = texts(tree).join('\n')
  assert.match(text, /gateway\/internal: no settings provider is mounted/u)
  assert.match(text, /重试/u)
})

// ── the model directory ────────────────────────────────────────────────────

test('the model list shows every active model WITH its official facts, and no data-layer words', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha', { name: 'Alpha' }), modelOf('retired')],
    describe: describeAnswer({
      user: {
        models: {
          disabled: ['retired'],
          extra: [{ id: 'hand', name: 'Hand Declared' }],
          overrides: { alpha: { maxTokens: 2048 } },
          replaceDiscovered: false,
        },
      },
    }),
  })
  assert.match(page.text, /模型（已启用/u)
  assert.ok(page.control('action.fetch') !== undefined, 'the 获取可用模型 action exists')
  assert.ok(page.control('action.toggleAdd') !== undefined, 'the by-id adder exists')
  assert.ok(page.control('model.alpha.toggle') !== undefined)
  assert.ok(page.control('model.hand.toggle') !== undefined)
  assert.equal(page.control('model.retired.toggle'), undefined, 'a stopped model has no row at all')
  assert.match(page.text, /已自定义/u)
  // The OFFICIAL facts ride the row: no expanding, no blank fields.
  const chips = page.find((node) => node.props?.['data-ocg-chips'] === 'alpha')
  assert.equal(chips.length, 1, 'the row renders exactly one capability-chip line')
  const chipText = texts(chips[0]).join(' ')
  assert.match(chipText, /openai-completions/u)
  assert.match(chipText, /上下文 1M/u)
  assert.match(chipText, /输出 131K/u)
  assert.match(chipText, /输入 text\+image/u)
  assert.match(chipText, /思考 low\/high/u)
  // The words the operator asked to be rid of: GONE from the page.
  for (const word of ['端点', '手写', '已排除', '冻结', '恢复默认模型', '刷新目录', '目录来源', '正在使用端点模型', '已自定义模型目录', '未收录', 'models.dev']) {
    assert.ok(!page.text.includes(word), `the page must not speak "${word}"`)
  }
  page.restore()
})

test('every listed model shows its EFFECTIVE numbers — no catalog-membership labels', async () => {
  // Two sources only: the gateway list and the plugin's state. An id the
  // bundled state does not know is not special-cased with a "not catalogued"
  // label; it simply carries the values dsh would load (the conservative
  // defaults until an operator corrects the row).
  const page = await harness({
    catalogue: [modelOf('brand-new', { snapshotKnown: false })],
  })
  const chips = page.find((node) => node.props?.['data-ocg-chips'] === 'brand-new')
  const chipText = texts(chips[0]).join(' ')
  assert.match(chipText, /上下文 1M/u, 'the effective numbers ride the row whatever their source')
  assert.ok(!chipText.includes('未收录'), 'no membership label')
  page.restore()
})

test('the source line names the two layers, and a failed gateway refresh is shown', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  assert.match(page.text, /模型名单来自网关 \/models；能力值是插件保存的模型状态/u)
  assert.equal(page.control('action.resetModels'), undefined, 'there is no reset affordance any more')
  page.restore()
  const stale = await harness({
    catalogue: [modelOf('alpha')],
    refreshError: 'GET https://opencode.ai/zen/go/v1/models answered HTTP 503',
  })
  assert.match(stale.text, /向网关刷新模型列表时出错/u)
  stale.restore()
})

test('the chevron expands the row into its attributes, with the EFFECTIVE values as placeholders', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  const toggle = page.control('model.alpha.toggle')
  assert.equal(toggle.props['aria-expanded'], 'false')
  toggle.props.onClick()
  await page.reload()
  assert.equal(page.control('model.alpha.toggle').props['aria-expanded'], 'true')
  for (const field of ['api', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts']) {
    assert.ok(page.control(`model.alpha.${field}`) !== undefined, `the expanded row must offer ${field}`)
  }
  // The capacity placeholders are the EFFECTIVE numbers, so an empty field
  // reads as the number the route will actually use.
  assert.equal(page.control('model.alpha.contextWindow').props.placeholder, '当前生效 1000000')
  assert.equal(page.control('model.alpha.maxTokens').props.placeholder, '当前生效 131072')
  assert.match(page.text, /当前生效：text \+ image/u)
  // An advertised row cannot be renamed: the endpoint names its own models.
  assert.equal(page.control('model.alpha.name'), undefined)
  page.restore()
})

test('editing an expanded advertised row writes an override into the draft', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  page.control('model.alpha.toggle').props.onClick()
  await page.reload()
  page.control('model.alpha.maxTokens').props.onChange({ target: { value: '4096' } })
  await page.reload()
  assert.equal(page.control('model.alpha.maxTokens').props.value, '4096')
  // Save: the override lands as models.overrides, never as an extra row.
  const save = page.control('action.save')
  assert.equal(save.props.disabled, false)
  await save.props.onClick()
  await drainMicrotasks()
  assert.equal(page.calls.mutate.length, 1)
  const ops = page.calls.mutate[0].ops
  assert.ok(ops.some((op) => op.path.join('.') === 'models.overrides' && op.value.alpha.maxTokens === 4096))
  assert.ok(ops.some((op) => op.path.join('.') === 'models.extra' && op.value.length === 0))
  page.restore()
})

test('the × on a row stops the model AND saves it: selection is activation, no second click', async () => {
  const page = await harness({ catalogue: [modelOf('alpha'), modelOf('beta')] })
  page.control('model.alpha.remove').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1, 'the act wrote immediately')
  assert.deepEqual(
    page.calls.mutate[0].ops.map((op) => op.path.join('.')),
    ['models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered'],
    'a model act commits ONLY the models paths',
  )
  assert.deepEqual(page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.disabled').value, ['alpha'])
  assert.match(page.text, /已停用 alpha 并保存/u)
  assert.equal(page.control('model.alpha.toggle'), undefined, 'the stopped row is gone')
  assert.ok(page.control('model.beta.toggle') !== undefined)
  page.restore()
})

test('a stop is reversible: the same document without the exclusion comes back via the adder', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha')],
    describe: describeAnswer({ user: { models: { disabled: ['alpha'], extra: [], overrides: {}, replaceDiscovered: false } } }),
  })
  assert.equal(page.control('model.alpha.toggle'), undefined, 'an excluded model has no row')
  await page.control('action.toggleAdd').props.onClick()
  await page.reload()
  page.control('add.model.id').props.onChange({ target: { value: 'alpha' } })
  await page.reload()
  await page.control('action.addModel').props.onClick()
  await drainMicrotasks()
  await page.reload()
  const disabled = page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.disabled').value
  assert.deepEqual(disabled, [], 're-adding an advertised id clears its exclusion')
  const extra = page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.extra').value
  assert.deepEqual(extra, [], 'and does NOT declare what the endpoint already serves')
  assert.match(page.text, /已添加并启用 alpha/u)
  page.restore()
})

test('按 ID 添加 activates a model the listing does not show, in one act', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  await page.control('action.toggleAdd').props.onClick()
  await page.reload()
  assert.ok(page.control('add.model.id') !== undefined)
  assert.equal(page.control('action.addModel').props.disabled, true, 'nothing typed, nothing to add')
  page.control('add.model.id').props.onChange({ target: { value: 'brand-new' } })
  await page.reload()
  assert.equal(page.control('action.addModel').props.disabled, false)
  await page.control('action.addModel').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1)
  const extra = page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.extra').value
  assert.deepEqual(extra.map((row) => row.id), ['brand-new'])
  assert.equal(extra[0].contextWindow, undefined, 'no capacity is pinned: the official facts stay inherited')
  assert.match(page.text, /已添加并启用 brand-new/u)
  assert.ok(page.control('model.brand-new.toggle') !== undefined)
  page.restore()
})

test('sessionHeaderMode offers exactly the host union', async () => {
  const page = await harness()
  const select = page.control('sessionHeaderMode')
  assert.ok(select !== undefined)
  assert.deepEqual(select.children.map((child) => child.props.value), ['session-id', 'uuid'])
  page.restore()
})

// ── writes ─────────────────────────────────────────────────────────────────

test('a save writes only the moved fields, with the revision it read', async () => {
  const page = await harness()
  const nameBox = page.control('displayName')
  assert.equal(nameBox.props.value, '')
  nameBox.props.onChange({ target: { value: 'renamed' } })
  await page.reload()
  const saveButton = page.control('action.save')
  assert.ok(saveButton !== undefined)
  assert.equal(saveButton.props.disabled, false, 'the save button must enable once the draft is dirty')
  await saveButton.props.onClick()
  await drainMicrotasks()
  assert.equal(page.calls.mutate.length, 1)
  assert.equal(page.calls.mutate[0].ns, 'opencode-go-native')
  assert.equal(page.calls.mutate[0].revision, 11)
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['displayName'], value: 'renamed' }])
  assert.deepEqual(page.calls.credentialSet, [], 'no credential was staged, so none is written')
  page.restore()
})

test('a client-side validation failure blocks the write and names the control', async () => {
  const page = await harness()
  const header = page.control('sessionHeader')
  header.props.onChange({ target: { value: 'x session' } })
  await page.reload()
  const saveButton = page.control('action.save')
  await saveButton.props.onClick()
  assert.equal(page.calls.mutate.length, 0, 'nothing may be written while the draft is invalid')
  assert.match(page.text, /不是合法的 HTTP 头名/u)
  assert.match(page.text, /有字段没通过校验|RFC 7230/u)
  page.restore()
})

test('typing an API key and saving stores the credential, and never puts it in the settings ops', async () => {
  const page = await harness()
  const key = page.control('apiKey')
  const SENTINEL = 'sk-SENTINEL-not-a-real-key'
  key.props.onChange({ target: { value: SENTINEL } })
  await page.reload()
  const saveButton = page.control('action.save')
  assert.equal(saveButton.props.disabled, false, 'a staged key must enable the save button')
  await saveButton.props.onClick()
  await drainMicrotasks()
  await page.reload()
  // The settings half owes nothing: the reference is already what the document
  // says, and the secret must never appear in a settings op.
  assert.deepEqual(page.calls.mutate, [])
  assert.deepEqual(page.calls.credentialSet, [{ ref: 'OPENCODE_GO_API_KEY', value: SENTINEL }])
  assert.match(page.text, /已保存 凭据 OPENCODE_GO_API_KEY/u)
  assert.equal(page.control('apiKey').props.value, '', 'the staged secret is not kept in the form')
  page.restore()
})

test('a settings change and a staged key are saved as two different writes, settings first', async () => {
  const page = await harness()
  page.control('displayName').props.onChange({ target: { value: 'renamed' } })
  page.control('apiKey').props.onChange({ target: { value: 'sk-SENTINEL-not-a-real-key' } })
  await page.reload()
  await page.control('action.save').props.onClick()
  await drainMicrotasks()
  assert.equal(page.calls.mutate.length, 1)
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['displayName'], value: 'renamed' }])
  assert.deepEqual(page.calls.credentialSet, [{ ref: 'OPENCODE_GO_API_KEY', value: 'sk-SENTINEL-not-a-real-key' }])
  page.restore()
})

test('a refused credential write is reported, keeps the typed key, and does not repeat the settings write', async () => {
  const page = await harness({ failCredentialSet: Object.assign(new Error('reference is shadowed by the environment'), { code: 'credentials/read-only' }) })
  const SENTINEL = 'sk-SENTINEL-not-a-real-key'
  // A settings change AND a staged key in one save: settings first, credential
  // second. The second half is refused.
  page.control('displayName').props.onChange({ target: { value: 'renamed' } })
  page.control('apiKey').props.onChange({ target: { value: SENTINEL } })
  await page.reload()
  await page.control('action.save').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.match(page.text, /密钥没写进凭据存储/u)
  assert.match(page.text, /shadowed by the environment/u)
  assert.equal(page.calls.mutate.length, 1, 'the settings half stands')
  // The key the operator typed is STILL in the form: dropping it here would make
  // a refusal cost them the secret they just pasted.
  assert.equal(page.control('apiKey').props.value, SENTINEL)
  // Retry: the credential is attempted again, the settings are not re-written.
  await page.control('action.save').props.onClick()
  await drainMicrotasks()
  assert.equal(page.calls.mutate.length, 1, 'the settings write must not be repeated')
  assert.equal(page.calls.credentialSet.length, 2, 'the credential write is retried')
  page.restore()
})

test('清除已存密钥 removes the credential and says what could still shadow it', async () => {
  const page = await harness({ credential: { configured: true, source: 'env', writable: false } })
  const clear = page.control('action.clearCredential')
  assert.ok(clear !== undefined)
  await clear.props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.deepEqual(page.calls.credentialUnset, ['OPENCODE_GO_API_KEY'])
  assert.match(page.text, /已清除凭据 OPENCODE_GO_API_KEY/u)
  page.restore()
})

test('a host rejection is rendered beside the control it names', async () => {
  const page = await harness({
    failMutate: Object.assign(new Error('opencode-go-native: models.extra["broken-extra"].contextWindow must be a positive integer (got: -5)'), { code: 'settings/rejected' }),
    describe: describeAnswer({
      user: { models: { disabled: [], extra: [{ id: 'broken-extra' }], overrides: {}, replaceDiscovered: false } },
    }),
  })
  page.control('model.broken-extra.toggle').props.onClick()
  await page.reload()
  page.control('model.broken-extra.contextWindow').props.onChange({ target: { value: '4096' } })
  await page.reload()
  await page.control('action.save').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1)
  assert.match(page.text, /宿主拒绝了这次写入（已定位到 models\.extra\[broken-extra\]）/u)
  assert.match(page.text, /must be a positive integer/u)
  page.restore()
})

test('a revision conflict is reported as a conflict, not as a validation error', async () => {
  const page = await harness({
    failMutate: Object.assign(new Error('settings namespace "opencode-go-native" changed since it was read (expected revision 11, now 12)'), { code: 'settings/conflict' }),
  })
  page.control('displayName').props.onChange({ target: { value: 'renamed' } })
  await page.reload()
  await page.control('action.save').props.onClick()
  await page.reload()
  assert.match(page.text, /另一个标签页先保存了/u)
  assert.match(page.text, /重新载入最新设置/u)
  page.restore()
})

// ── discovery, diagnostics ─────────────────────────────────────────────────

test('获取可用模型 shows the gateway list as a PLAIN list — no capability chips', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha'), modelOf('beta')],
    discovery: [modelOf('alpha'), modelOf('beta'), modelOf('gamma', { name: 'Gamma' })],
  })
  const button = page.control('action.fetch')
  assert.ok(button !== undefined)
  await button.props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.urls.filter((call) => call.options?.method === 'POST').length, 1)
  // The draft carries the CURRENT form's baseURL, not a second endpoint field.
  assert.deepEqual(JSON.parse(page.calls.urls.find((call) => call.options?.method === 'POST').options.body), {
    baseURL: 'https://opencode.ai/zen/go/v1',
  })
  assert.ok(page.control('fetch.search') !== undefined, 'the picker offers a search box')
  // Checked mirrors the draft's enabled set — the dialog is a SELECTION, not an
  // "add" list. With the shipped default that set is EMPTY: a model the gateway
  // advertises is not a model the operator chose, so nothing starts checked.
  assert.equal(page.control('candidate.alpha').props.checked, false)
  assert.equal(page.control('candidate.gamma').props.checked, false, 'advertised is not the same as enabled')
  // Membership only. The list must not assert what a model can do: that is the
  // sync's job, and a claim here would come from a snapshot rather than from
  // evidence. The id and name are all a row carries.
  assert.equal(
    page.find((node) => node.props?.['data-ocg-chips'] === 'gamma').length, 0,
    'a candidate row renders no capability chips',
  )
  const row = page.find((node) => node.props?.className === 'ocg-candidate'
    || node.props?.className === 'ocg-candidate ocg-candidate--on')
  assert.ok(row.length >= 3, 'every discovered id still gets a row')
  page.restore()
})

test('应用选择 commits the whole new selection immediately — picking IS activating', async () => {
  const page = await harness({
    // Nothing is enabled on a fresh install, so the gesture is "pick one".
    catalogue: [],
    discovery: [modelOf('alpha'), modelOf('beta'), modelOf('gamma')],
  })
  await page.control('action.fetch').props.onClick()
  await drainMicrotasks()
  await page.reload()
  page.control('candidate.alpha').props.onChange() // on
  await page.reload()
  await page.control('fetch.apply').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1, 'the apply wrote immediately; no separate 保存 click')
  const ops = page.calls.mutate[0].ops
  assert.deepEqual(ops.map((op) => op.path.join('.')), [
    'models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered',
  ])
  // The pick lands in `extra`, which IS the enabled set in replacement mode:
  // writing `disabled` alone would activate nothing.
  const extra = ops.find((op) => op.path.join('.') === 'models.extra').value
  assert.deepEqual(extra.map((entry) => entry.id), ['alpha'])
  assert.equal(page.control('fetch.apply'), undefined, 'the dialog closed')
  assert.ok(page.control('model.alpha.toggle') !== undefined, 'the picked model is in the directory')
  assert.equal(page.control('model.beta.toggle'), undefined, 'the unpicked ones are not')
  page.restore()
})


test('a stopped model comes back through the picker: unchecked becomes checked, exclusion cleared', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha')],
    discovery: [modelOf('alpha'), modelOf('beta')],
    describe: describeAnswer({ user: { models: { disabled: ['beta'], extra: [], overrides: {}, replaceDiscovered: false } } }),
  })
  await page.control('action.fetch').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.control('candidate.beta').props.checked, false, 'a stopped model reads as unchecked, not as an "excluded" row')
  page.control('candidate.beta').props.onChange()
  await page.reload()
  await page.control('fetch.apply').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.deepEqual(page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.disabled').value, [])
  assert.match(page.text, /已启用 1 个并保存/u)
  page.restore()
})

test('a discovery failure is shown and the picker never opens', async () => {
  const page = await harness({ failDiscover: { ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'no value for credential reference "NOPE"' } } })
  await page.control('action.fetch').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.match(page.text, /MISSING_CREDENTIAL/u)
  assert.equal(page.control('fetch.apply'), undefined, 'no candidates, no dialog actions')
  page.restore()
})

test('诊断 renders the health rows, the log ring and the connection the host would use', async () => {
  const page = await harness({
    diagnostics: {
      ok: true,
      diagnostics: {
        kind: 'dsh-opencodego/diagnostics',
        at: 1,
        connection: { baseURL: 'http://127.0.0.1:45551/v1', apiKeyEnv: 'OCG_UNSET', legacyInlineKey: false },
        configuration: { models: { protocolOverridesShadowed: ['stale-alias'] } },
        catalogue: { status: 'stale', discovered: 3, effective: 2, sources: [{ id: 'a', source: 'endpoint' }, { id: 'hand', source: 'extra' }] },
        health: { rows: [{ modelId: 'a', category: 'ok', protocol: 'openai-completions', status: 200, action: 'none' }], unusable: [], summaryLines: ['a: ok'] },
        log: { lines: [{ at: 1, level: 'warn', message: 'endpoint unreachable' }], warnings: [{ at: 1, level: 'warn', message: 'endpoint unreachable' }] },
      },
    },
  })
  const button = page.control('action.diagnostics')
  assert.ok(button !== undefined)
  await button.props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.match(page.text, /http:\/\/127\.0\.0\.1:45551\/v1/u)
  assert.match(page.text, /凭据引用 OCG_UNSET（只是名字，不是值）/u)
  assert.match(page.text, /status=stale/u)
  assert.match(page.text, /a\(endpoint\)、hand\(extra\)/u)
  assert.match(page.text, /stale-alias/u)
  assert.match(page.text, /openai-completions/u)
  assert.match(page.text, /endpoint unreachable/u)
  assert.match(page.text, /warn 1 条/u)
  page.restore()
})

test('诊断 shows a route failure instead of a half-filled table', async () => {
  const { factory } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  let Component
  let options
  const ctx = {
    remote: {
      settings: { describe: () => Promise.resolve({ ok: true, value: describeAnswer() }) },
      credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (registrationOptions, Registered) => { options = registrationOptions; Component = Registered; return () => {} },
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'forbidden', message: 'only reachable from the harness GUI origin' } }) })
  try {
    exports.apply(ctx)
    const props = { close: () => {}, ...options.inject() }
    const tree = await React.settle(Component, props)
    const button = find(tree, (node) => node.props?.['data-ocg-field'] === 'action.diagnostics')[0]
    await button.props.onClick()
    const after = await React.settle(Component, props)
    assert.match(texts(after).join('\n'), /forbidden: only reachable from the harness GUI origin/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('信息同步 asks the gateway about every enabled model, one at a time, and shows it', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha'), modelOf('beta')],
    sync: (id) => (id === 'beta'
      // A model the gateway still lists and upstream no longer serves.
      ? { available: false, status: 'delisted', reason: '上游已下架：Model is unavailable.' }
      : {
          available: true,
          status: 'available',
          protocol: { chosen: 'openai-completions', verified: true },
          contextWindow: 1048576,
          maxTokens: 131072,
          input: ['text', 'image'],
          reasoning: { levels: { low: 'low', high: 'high' }, hasOff: true },
          evidence: [{ step: 'availability', status: 200 }],
        }),
  })
  const button = page.control('action.sync')
  assert.ok(button !== undefined, 'the models card offers a sync')
  assert.match(texts(button).join(' '), /信息同步/u)

  await button.props.onClick()
  await drainMicrotasks()
  await page.reload()

  // One request PER MODEL: that is what makes progress real and a stop possible
  // between models rather than only before the whole list.
  const syncCalls = page.calls.urls.filter((call) => String(call.url).includes('/opencode-go-native/sync'))
  assert.equal(syncCalls.length, 2, 'one sync request per enabled model')
  assert.deepEqual(syncCalls.map((call) => JSON.parse(call.options.body).id), ['alpha', 'beta'])

  // The verdict lands on the row it belongs to.
  const ok = page.find((node) => node.props?.['data-ocg-sync'] === 'alpha')
  assert.equal(ok.length, 1, 'the working model gets a verdict line')
  assert.match(texts(ok[0]).join(' '), /可用/u)
  assert.match(texts(ok[0]).join(' '), /上下文 1\.0M/u)

  const dead = page.find((node) => node.props?.['data-ocg-sync'] === 'beta')
  assert.equal(dead.length, 1, 'the dead model gets a verdict line too')
  const deadText = texts(dead[0]).join(' ')
  assert.match(deadText, /已下架/u)
  assert.match(deadText, /Model is unavailable/u)
  // …and it points somewhere that works, instead of only complaining.
  assert.match(deadText, /建议换用 alpha/u)
  page.restore()
})

test('a model that has never been synced shows NO capability chips, and says why', async () => {
  // The whole point of the sync: a declared number and a measured one look
  // identical once rendered, so nothing is rendered until something is measured.
  const page = await harness({ catalogue: [modelOf('fresh', { synced: false })] })
  assert.equal(
    page.find((node) => node.props?.['data-ocg-chips'] === 'fresh').length, 0,
    'an unsynced row must not show capability chips',
  )
  const notice = page.find((node) => node.props?.['data-ocg-unsynced'] === 'fresh')
  assert.equal(notice.length, 1, 'and it must say why it is empty')
  assert.match(texts(notice[0]).join(' '), /信息同步/u)
  page.restore()
})
