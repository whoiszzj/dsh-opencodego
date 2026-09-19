/**
 * Static wiring guards for the subscription layer (0.8.2).
 *
 * The pure behavior is pinned by `subs.test.mjs` / `subruntime.test.mjs` /
 * `usage.test.mjs`. What cannot run under bare `node --test` is the host-coupled
 * wiring itself (`adapter.js`, `index.js`), so — exactly like the
 * session/attribution guard — these tests read the SOURCE and pin the structural
 * decisions that the paid-for lessons say must not drift:
 *
 *   1. ONE key per request: the adapter asks the runtime for the ACTIVE key and
 *      there is no rotation machinery left to resurrect (the pool this replaced
 *      is exactly what the redesign removed);
 *   2. the entry point wires the runtime, the `/usage` route, and the
 *      credential-presence reader, with real imports behind every binding
 *      (invariant #5: `export { x } from './y.js'` creates no local binding);
 *   3. the schema defaults `subscriptions` to `[]` and `activeSubscription` to
 *      `default`, and the resolved facts CARRY both — the invariant-#9 rule:
 *      the page and the route must agree on who pays;
 *   4. the gateway address is a ROUTE fact, so the usage probe gets it from the
 *      resolved options rather than from a per-subscription field that no longer
 *      exists.
 *
 * @module tests/subscriptions-wiring
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const readSource = (relative) => readFileSync(join(root, relative), 'utf8')

test('the adapter spends exactly ONE key, and the rotation machinery is gone', () => {
  const adapter = readSource('src/adapter.js')
  assert.ok(adapter.includes('await this.config.subs.activeKey()'), 'the request path resolves the ACTIVE subscription')
  assert.ok(adapter.includes('await this.config.subs.activeKey()'), 'the pi-ai auth seam answers with it too')
  // No rotation, no gate, no failover summary: every one of these was part of
  // the pool, and any of them reappearing means a second payer for one request.
  for (const seam of ['pool.plan(', 'pool.preflight(', 'pool.recheck(', 'pool.keyFor(', 'pool.noteFailure(', 'pool.markSuccess(', 'firstUsableKey(', 'QUOTA_LIMIT']) {
    assert.ok(!adapter.includes(seam), `the adapter must not go back to ${seam}`)
  }
  // The commit rule that survives: once output reached the caller, a failure is
  // surfaced as-is and never re-attempted behind the caller's back.
  assert.match(adapter, /if \(yielded\) throw error/, 'a retry after output must be impossible')
  assert.match(adapter, /if \(chunk\?\.type !== 'finish'\) yielded = true/, 'the flag must ride the actual content yield')
  // Attribution rides exactly where the session guard already pins it.
  assert.equal((adapter.match(/[^.\w]requestHeaders\(/g) ?? []).length, 1)
})

test('the entry point wires the runtime, the route, and imports its bindings', () => {
  const index = readSource('src/index.js')
  // Invariant #5: a re-export without a local import is a runtime-only crash.
  assert.match(index, /import \{ createSubRuntime \} from '\.\/subruntime\.js'/)
  assert.match(index, /import \{ defaultUsageLayerPath \} from '\.\/usage\.js'/)
  assert.match(index, /const subs = createSubRuntime\(/)
  assert.match(index, /describeCredential: async \(reference\)/, 'the rows answer "is a key stored" without a value')
  // The adapter takes the runtime; the catalogue/discovery/sync take the SAME
  // active key the request path would spend.
  assert.match(index, /\n    subs,/)
  assert.ok(index.includes('const activeKey = () => subs.activeKey()'))
  assert.equal((index.match(/resolveApiKey: activeKey/g) ?? []).length, 3, 'catalogue + the discovery seam + the draft route')
  assert.ok(index.includes('await activeKey()'), 'the sync route')
  // The HTTP face carries the usage route, and it never writes settings.
  assert.ok(index.includes("'GET /opencode-go-native/usage'"))
  assert.ok(index.includes('subs.refreshAll()'))
  assert.ok(index.includes('subs.view()'))
  // Opening the panel refreshes the balance, but only the STALE rows: the route
  // must reach the stale-only mode, and the freshness gate must live in the
  // runtime — the page cannot know the operator's TTL.
  assert.match(index, /refresh === 'auto' \? await subs\.refreshStale\(\)/u)
  assert.match(readSource('src/subruntime.js'), /async refreshStale\(\)/u)
  // The probe headers are merged HERE (the pinned call sites), not inside the
  // probe module — usage.js must not import session.js.
  const usage = readSource('src/usage.js')
  assert.ok(!/from '\.\/session\.js'/u.test(usage) || !/requestHeaders\(/u.test(usage))
  assert.match(usage, /baseHeaders\(\)/, 'usage.js consumes the injected thunk (never an expanded object)')
})

test('the LIVE slot is wired and reconciled, never guessed', () => {
  const index = readSource('src/index.js')
  const subruntime = readSource('src/subruntime.js')
  // The two credential seams the runtime cannot own: a per-reference READ (the
  // upgrade/adoption path) and a per-reference WRITE (the mirror). Both must be
  // injected; a runtime that resolved the live slot itself would be a second
  // precedence rule beside `credential.js`.
  assert.match(index, /resolveCredential: async \(reference\)/)
  assert.match(index, /setCredential: async \(reference, value\)/)
  assert.match(index, /credentials\.set\(credentialRef\(reference\), value\)/)
  // The mirror must react to the SWITCH — a settings change — not only to the
  // next request, or a page that says "已切换" would be lying until traffic.
  assert.ok(index.includes('subs.reconcile()'), 'a settings change reconciles the live slot')
  assert.ok(index.includes('live: subs.projection()'), 'the page reads what the mirror actually did')
  // And the runtime reads the live slot from the ROUTE facts.
  assert.match(subruntime, /apiKeyEnv/)
  assert.match(subruntime, /async syncLive\(value, sub, \{ alreadyLive = false \} = \{\}\)/)
  assert.match(subruntime, /async reconcile\(\)/)
  // The request path reads the row's OWN slot first: a refused mirror can never
  // make a request send a stale key.
  assert.match(subruntime, /const own = await ownValueOf\(sub\)/)
})

test('the schema defaults subscriptions to [] and activeSubscription to default', () => {
  const config = readSource('src/config.js')
  assert.match(config, /subscriptions: z\.array\(z\.any\(\)\)\.default\(\[\]\)/)
  assert.match(config, /activeSubscription: z\.string\(\)\.default\('default'\)/)
  assert.match(config, /const subscriptions = normalizeSubscriptions\(config\.subscriptions, \{/)
  assert.match(config, /const activeSubscription = resolveActiveSubscription\(subscriptions, config\.activeSubscription\)/)
  // The resolved facts must actually CARRY both: an omitted field here leaves
  // the adapter with `undefined` and every request billing the wrong row.
  assert.match(config, /\n    subscriptions,\n    activeSubscription,\n    usagePollTtlMs,/)
})

test('the gateway address is a route fact: the usage probe never reads sub.baseURL', () => {
  const usage = readSource('src/usage.js')
  const subruntime = readSource('src/subruntime.js')
  assert.match(usage, /baseURL: this\.deps\.baseURL === undefined \? sub\.baseURL : this\.deps\.baseURL\(sub\)/)
  assert.match(subruntime, /baseURL: \(\) => deps\.options\(\)\.baseURL/)
})
test('subs.js, usage.js, base-url.js and subruntime.js stay host-import-free', () => {
  for (const file of ['src/subs.js', 'src/usage.js', 'src/base-url.js', 'src/subruntime.js']) {
    const source = readSource(file)
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('./') || specifier.startsWith('node:'), `${file} imports ${specifier}, which the bare test runner cannot resolve`)
    }
  }
})
