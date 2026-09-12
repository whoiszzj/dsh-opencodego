// Real-key inference check for the inline-apiKey path, run inside an isolated
// dsh whose settings.yaml carries the key inline. The credentials reference
// (OPENCODE_GO_API_KEY) is deliberately ABSENT from this instance's credential
// store, so a successful call proves the inline value is what authenticated —
// and the resolve-call counter proves the store was never consulted.
// Prints only booleans/status: never the key, never its length.
import { writeFileSync } from 'node:fs'

export const name = 'ocg-apikey-live'
export const inject = ['llm', 'credentials']

const ROUTE = 'opencode-go-native'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
  const out = process.env.OCG_LIVE_OUT
  void (async () => {
    const evidence = { route: ROUTE }
    const credentials = ctx.get('credentials')
    const resolveCalls = []
    if (credentials !== undefined) {
      const original = credentials.resolve.bind(credentials)
      credentials.resolve = async (ref) => {
        resolveCalls.push(String(ref))
        return await original(ref)
      }
    }
    evidence.credentialServicePresent = credentials !== undefined

    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = ctx.llm.listProviders().some((p) => (p.id ?? p.provider) === ROUTE)
      } catch { /* registry not readable yet */ }
      if (!ready) await sleep(500)
    }
    evidence.routeRegistered = ready

    try {
      const models = await ctx.llm.listModels(ROUTE)
      evidence.modelCount = models.length
    } catch (error) {
      evidence.listModelsError = String(error?.message ?? error).slice(0, 180)
    }

    try {
      let text = ''
      let finish
      let usage
      for await (const chunk of ctx.llm.stream({
        provider: ROUTE,
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
        sessionId: 'ocg-apikey-live-1',
        maxTokens: 64,
      })) {
        if (chunk?.type === 'text' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish') finish = chunk
        if (chunk?.type === 'usage') usage = chunk
      }
      evidence.stream = {
        text: text.slice(0, 60),
        finishKind: finish?.reason?.kind ?? finish?.kind,
        totalTokens: usage?.usage?.totalTokens,
      }
    } catch (error) {
      evidence.streamError = String(error?.message ?? error).slice(0, 220)
    }

    evidence.credentialResolveCalls = resolveCalls
    evidence.storeWasConsulted = resolveCalls.length > 0
    writeFileSync(out, JSON.stringify(evidence, null, 1))
  })()
}
