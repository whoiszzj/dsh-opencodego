/**
 * Isolated-instance probe for the inline-`apiKey` change (LOOPBACK ONLY).
 *
 * Mounted by `scripts/acceptance/apikey-run.sh` into a throwaway `DSH_HOME`. A
 * browser cannot see the facts this change is about — which credential SOURCE
 * wins, what the resolved token hashes to, and what the settings document on
 * disk holds — so this probe exposes them over loopback-only routes:
 *
 *   GET  /ocg-apikey-probe/diagnostics
 *        The connection snapshot in force (`apiKeyInline`, `apiKeyEnv`), the
 *        settings-document path, and the on-disk `apiKey:` line verbatim.
 *
 *   POST /ocg-apikey-probe/probe   { publicKey }
 *        Re-imports `resolveConnectionApiKey` from the INSTALLED `lib/` and runs
 *        the host's real `assertUsableApiKey` / `credentialRef` against the saved
 *        settings. TWO calls, deliberately:
 *          1. the SAVED configuration — must resolve, and the fingerprint it
 *             publishes must equal `sha256(publicKey)`;
 *          2. the same snapshot with `apiKey` removed — must throw
 *             `MISSING_CREDENTIAL`, which is the reverse proof that the failure
 *             the user hit is still reachable, and that saving the key is what
 *             changed the outcome.
 *
 *   POST /ocg-apikey-probe/refresh
 *        Calls the plugin's own model-discovery seam
 *        (`ctx.llm.discoverModels('opencode-go-native', {})` — the same call the
 *        settings page's 获取模型 button makes) and reports what it answered: a
 *        model count, or the `code` of the error. This is the "does it still say
 *        MISSING_CREDENTIAL" check, and it is deliberately tolerant of a NETWORK
 *        failure — that is a different answer from a credential failure, and the
 *        report keeps the two apart.
 *
 * No credential VALUE is ever returned or logged, except the raw on-disk line
 * the acceptance run explicitly asks for — that IS the plain-text fact under
 * test.
 *
 * @module dsh-opencodego/acceptance/apikey-probe
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'ocg-apikey-probe'
export const inject = ['llm', 'settings', 'webServer']

const NS = 'opencode-go-native'
/** The one provider route this plugin owns. */
const PROVIDER = 'opencode-go-native'

/**
 * The INSTALLED host half's entry module, so the probe resolves through the code
 * that would actually serve a request rather than a copy in this checkout.
 * @returns {string} absolute path.
 */
function installedLibPath() {
  const entry = process.env.OCG_PLUGIN_LIB
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('OCG_PLUGIN_LIB must name the installed lib/index.js of this plugin')
  }
  return entry
}

/**
 * Import a host package from the PROFILE that owns the installed plugin.
 *
 * This probe is mounted from the checkout, so a bare `import('@deepseek-ai/…')`
 * here resolves against the REPOSITORY (which has no `node_modules`) and fails
 * — measured. Resolving from the installed plugin's own directory instead uses
 * the very instances that plugin loaded, which is also what makes the function
 * identity (`LlmError` included) the one the host half would throw.
 * @param {string} specifier - package name.
 * @returns {Promise<object>} its module namespace.
 */
function importFromProfile(specifier) {
  const require = createRequire(installedLibPath())
  return import(pathToFileURL(require.resolve(specifier)).href)
}

/** One-way, non-reversible tag for a token; enough to prove WHICH value is used. */
function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/** The `apiKey:` line of the `opencode-go-native` section, as written on disk. */
function inlineKeyLine(text) {
  let inSection = false
  for (const line of String(text).split('\n')) {
    if (/^[^\s#]/u.test(line)) inSection = line.startsWith(`${NS}:`)
    if (!inSection) continue
    const match = /^\s+apiKey:\s*(.*)$/u.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

/** Only the loopback origin may read this: a verification surface, not an API. */
function fromLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read one JSON request body.
 *
 * `for await` over an `IncomingMessage` was measured to HANG inside this host's
 * request pipeline (the route fired, the body never arrived, no error): the
 * event form below is the one that works, and it is bounded by `limit` either
 * way.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum accepted body size in bytes.
 * @returns {Promise<object | undefined>} the parsed object, or undefined.
 */
function readJson(req, limit = 16_384) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * The settings document, resolved the way the host's settings-file provider
 * does: `join(DSH_HOME, 'settings.yaml')`.
 * @returns {string} absolute path.
 */
function settingsPath() {
  const override = process.env.OCG_SETTINGS_FILE
  if (typeof override === 'string' && override.length > 0) return override
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return join(home, 'settings.yaml')
  throw new Error('neither OCG_SETTINGS_FILE nor DSH_HOME is set; refusing to guess the settings document')
}

/** One promise, or a rejection naming the wait — never a hang the run cannot see. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`no answer within ${String(ms)}ms`), { code: 'PROBE_TIMEOUT' }))
      }, ms)
      timer.unref?.()
    }),
  ])
}

/**
 * @param {object} ctx - the cordis context.
 */
export function apply(ctx) {
  const document = () => {
    try {
      return readFileSync(settingsPath(), 'utf8')
    } catch (error) {
      return `(unreadable: ${String(error?.message ?? error)})`
    }
  }

  /**
   * Resolve the connection token from one snapshot, using the INSTALLED host
   * half's own function and the host's own helpers.
   * @param {object} options - one connection snapshot.
   */
  const attempt = async (options) => {
    const { resolveConnectionApiKey } = await import(pathToFileURL(installedLibPath()).href)
    const { credentialRef } = await importFromProfile('@deepseek-ai/dsh-credentials')
    const { assertUsableApiKey, LlmError } = await importFromProfile('@deepseek-ai/dsh-llm')
    try {
      const value = await resolveConnectionApiKey({
        options,
        credentials: ctx.get('credentials'),
        LlmError,
        credentialRefOf: async () => credentialRef,
        usableApiKeyOf: async () => assertUsableApiKey,
      })
      return { resolved: true, fingerprint: fingerprint(value) }
    } catch (error) {
      return { resolved: false, code: error?.code, message: String(error?.message ?? error) }
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/ocg-apikey-probe',
    handler: async (req, res) => {
      const send = (status, payload) => {
        const body = `${JSON.stringify(payload, undefined, 2)}\n`
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      if (!fromLoopback(req)) {
        send(403, { ok: false, error: 'loopback only' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname.replace(/\/+$/u, '')
      const route = `${String(req.method)} ${pathname}`
      try {
        if (route === 'GET /ocg-apikey-probe/diagnostics') {
        const saved = ctx.settings.get(NS)
        const text = document()
        const line = inlineKeyLine(text)
        send(200, {
          ok: true,
          settingsPath: settingsPath(),
          connection: {
            baseURL: saved?.baseURL,
            apiKeyEnv: saved?.apiKeyEnv,
            apiKeyInline: typeof saved?.apiKey === 'string' && saved.apiKey.length > 0,
            resolvedApiKeyFingerprint: typeof saved?.apiKey === 'string' && saved.apiKey.length > 0
              ? fingerprint(saved.apiKey)
              : undefined,
          },
          onDisk: { apiKeyPresent: line !== undefined, apiKeyLine: line },
          document: text,
        })
        return
      }

      if (route === 'POST /ocg-apikey-probe/probe') {
        const body = await readJson(req)
        if (body === undefined || typeof body.publicKey !== 'string') {
          send(400, { ok: false, error: 'body must be { publicKey: string }' })
          return
        }
        const saved = ctx.settings.get(NS)
        send(200, {
          ok: true,
          expectedFingerprint: fingerprint(body.publicKey),
          saved: {
            apiKeyInline: typeof saved?.apiKey === 'string' && saved.apiKey.length > 0,
            fingerprint: typeof saved?.apiKey === 'string' && saved.apiKey.length > 0
              ? fingerprint(saved.apiKey)
              : undefined,
            apiKeyEnv: saved?.apiKeyEnv,
          },
          withKey: await attempt(saved),
          withoutKey: await attempt({ ...saved, apiKey: undefined }),
        })
        return
      }

      if (route === 'POST /ocg-apikey-probe/refresh') {
        const body = await readJson(req)
        try {
          const models = await withTimeout(
            ctx.llm.discoverModels(NS, { provider: body?.provider ?? PROVIDER }),
            Number(process.env.OCG_REFRESH_TIMEOUT_MS ?? 20_000),
          )
          send(200, {
            ok: true,
            code: 'OK',
            modelCount: Array.isArray(models) ? models.length : undefined,
            credentialFailure: false,
          })
        } catch (error) {
          send(200, {
            ok: true,
            code: error?.code ?? 'UNKNOWN',
            message: String(error?.message ?? error),
            credentialFailure: error?.code === 'MISSING_CREDENTIAL',
          })
        }
        return
      }

      send(404, { ok: false, error: `no such probe route (${route})` })
      } catch (error) {
        process.stderr.write(`[ocg-apikey-probe] route ${route} threw: ${String(error?.stack ?? error)}\n`)
        try {
          send(500, { ok: false, error: String(error?.message ?? error) })
        } catch { /* the response was already committed */ }
      }
    },
  }), 'ocg-apikey-probe: loopback verification surface')
}
