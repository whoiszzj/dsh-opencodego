// End-to-end proof that the INLINE apiKey reaches the wire, using a sentinel key
// that the relay answers with 401 AuthError. The credential store is monkey-
// patched to answer a DIFFERENT sentinel, so the observed outcome identifies
// which source authenticated:
//   * inline "sk-INLINE-SENTINEL"  -> reuse -> 401 "Invalid API key."
// never prints either value; the no-store run proves the aliasing.
import { writeFileSync } from 'node:fs'

export const name = 'ocg-apikey-wire'
export const inject = ['llm', 'credentials']

const ROUTE = 'opencode-go-native'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
  const out = process.env.OCG_WIRE_OUT
  const storeValue = process.env.OCG_WIRE_STORE_VALUE
  void (async () => {
    const evidence = { route: ROUTE, storeOverride: storeValue !== undefined }
    const credentials = ctx.get('credentials')
    const calls = []
    if (credentials !== undefined && storeValue !== undefined) {
      credentials.resolve = async (ref) => {
        calls.push(String(ref))
        return { value: storeValue }
      }
    }
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = ctx.llm.listProviders().some((p) => (p.id ?? p.provider) === ROUTE)
      } catch { /* not readable yet */ }
      if (!ready) await sleep(500)
    }
    evidence.routeRegistered = ready
    try {
      let text = ''
      let finish
      for await (const chunk of ctx.llm.stream({
        provider: ROUTE,
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'ocg-apikey-wire-1',
        maxTokens: 32,
      })) {
        if (chunk?.type === 'text' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish') finish = chunk
        if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') {
          evidence.finishReason = JSON.stringify(chunk.reason).slice(0, 400)
        }
      }
      evidence.outcome = 'completed'
      evidence.finishKind = finish?.reason?.kind ?? finish?.kind
      evidence.text = text.slice(0, 40)
    } catch (error) {
      evidence.outcome = 'threw'
      const message = String(error?.message ?? error)
      evidence.threw = /Invalid API key/iu.test(message)
        ? 'invalid-api-key'
        : message.slice(0, 200)
      evidence.code = error?.code
    }
    evidence.credentialResolveCalls = calls
    writeFileSync(out, JSON.stringify(evidence, null, 1))
  })()
}
