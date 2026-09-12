// Final migration verification (polling): wait until the harness has the route
// registered, then prove list/resolve/stream through the real entry points with
// the operator's own settings.yaml in an isolated DSH_HOME.
import { writeFileSync } from 'node:fs'

export const name = 'ocg-final-verify'
export const inject = ['llm']

const ROUTE = 'opencode-go-native'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
  const out = process.env.OCG_FINAL_OUT
  void (async () => {
    const evidence = { route: ROUTE }
    const providersSeen = new Set()
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        const providers = ctx.llm.listProviders()
        for (const provider of providers) providersSeen.add(provider.id ?? provider.provider ?? String(provider))
        ready = [...providersSeen].includes(ROUTE)
      } catch { /* the registry may not be readable yet */ }
      if (!ready) await sleep(500)
    }
    evidence.providers = [...providersSeen].sort()
    evidence.routeRegistered = ready
    // The credential plane registers asynchronously and can trail the route, so
    // wait for it before judging resolution (otherwise this probe measures its
    // own timing, not the plugin).
    for (let i = 0; i < 60 && ctx.get('credentials') === undefined; i++) await sleep(500)
    // Credential-plane diagnostics: does the service exist, and what does it
    // answer for the reference the settings name?
    try {
      const credentials = ctx.get('credentials')
      evidence.credentialsServicePresent = credentials !== undefined
      if (credentials !== undefined) {
        const hit = await credentials.resolve('OPENCODE_GO_API_KEY')
        evidence.credentialResolved = hit !== undefined
        evidence.credentialValueLength = typeof hit?.value === 'string' ? hit.value.length : undefined
      }
      evidence.envHasReferenceValue = typeof process.env.OPENCODE_GO_API_KEY === 'string'
      evidence.dshHome = process.env.DSH_HOME
    } catch (error) {
      evidence.credentialError = String(error?.message ?? error)
    }
    if (!ready) {
      writeFileSync(out, JSON.stringify(evidence, null, 1))
      return
    }
    try {
      const models = await ctx.llm.listModels(ROUTE)
      evidence.modelCount = models.length
      evidence.hasDeepseekV41Flash = models.some((model) => model.id === 'deepseek-v4.1-flash')
      evidence.sample = models.slice(0, 6).map((model) => model.id)
    } catch (error) {
      evidence.listModelsError = String(error?.message ?? error)
    }
    try {
      const info = await ctx.llm.resolveModelInfo(ROUTE, 'glm-5.3-flash')
      evidence.resolved = {
        contextWindow: info?.context?.contextWindow,
        inputModalities: info?.inputModalities,
      }
    } catch (error) {
      evidence.resolveError = String(error?.message ?? error)
    }
    try {
      let text = ''
      let finish
      let usage
      for await (const chunk of ctx.llm.stream({
        provider: ROUTE,
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: OK' }] }],
        sessionId: 'ocg-final-verify-1',
      })) {
        if (chunk?.type === 'text' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish') finish = chunk
        if (chunk?.type === 'usage') usage = chunk
      }
      evidence.stream = {
        text: text.slice(0, 40),
        finishKind: finish?.reason?.kind ?? finish?.kind,
        usage,
      }
    } catch (error) {
      evidence.streamError = String(error?.message ?? error)
    }
    writeFileSync(out, JSON.stringify(evidence, null, 1))
  })()
}
