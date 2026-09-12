// Drive the installed Chromium over CDP to reproduce the blank settings
// section in the real GUI: capture console errors, page exceptions, and the
// panel's DOM after clicking the plugin's nav entry.
//
// No Playwright: Node's built-in WebSocket speaks CDP directly.
// Resolved from the environment so the repository carries no local path.
const CHROME = process.env.CHROME_PATH
  ?? `${process.env.PLAYWRIGHT_BROWSERS_PATH ?? `${process.env.HOME ?? ''}/.cache/ms-playwright`}/chromium-1208/chrome-linux64/chrome`
const { spawn } = await import('node:child_process')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const [, , url, label, ...rest] = process.argv
const port = 9333 + Math.floor(Math.random() * 200)
const profile = mkdtempSync(join(tmpdir(), 'ocg-chrome-'))

// ── optional actions (backward compatible: no flags ⇒ the original run) ─────
//   --fill  <data-ocg-field> <value>   stage a value into a plugin control
//   --click <text>                     click a button/nav item by its text
//   --wait  <ms>                       settle time after the last action
const actions = []
for (let i = 0; i < rest.length; i += 1) {
  const flag = rest[i]
  if (flag === '--fill') { actions.push({ kind: 'fill', target: rest[i + 1], value: rest[i + 2] }); i += 2 }
  else if (flag === '--click') { actions.push({ kind: 'click', target: rest[i + 1] }); i += 1 }
  else if (flag === '--wait') { actions.push({ kind: 'wait', ms: Number(rest[i + 1]) }); i += 1 }
  else throw new Error(`gui-probe: unknown argument ${flag}`)
}
const settleMs = actions.filter((action) => action.kind === 'wait').reduce((sum, action) => sum + action.ms, 0)

const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage',
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
child.stderr.on('data', (buffer) => { stderr += String(buffer) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the DevTools HTTP endpoint until the browser is up. */
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) return await response.json()
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  throw new Error(`chrome never opened its debug port. stderr: ${stderr.slice(-500)}`)
}

const list = await targets()
const page = list.find((t) => t.type === 'page')
if (!page?.webSocketDebuggerUrl) throw new Error(`no page target: ${JSON.stringify(list).slice(0, 300)}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleLines = []
const exceptions = []
const failedRequests = []

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const waiter = pending.get(message.id)
    if (waiter) { pending.delete(message.id); waiter(message) }
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.type)
      .join(' ')
    consoleLines.push(`${message.params.type}: ${text}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails
    exceptions.push(`${d.text} ${d.exception?.description ?? ''} @${d.url ?? ''}:${d.lineNumber ?? ''}`)
  }
  if (message.method === 'Network.loadingFailed') {
    failedRequests.push(`${message.params.type} ${message.params.errorText}`)
  }
  if (message.method === 'Network.responseReceived') {
    const { status, url: u } = message.params.response
    if (status >= 400) failedRequests.push(`HTTP ${status} ${u}`)
  }
})

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')

await send('Page.navigate', { url })
await sleep(5000)

const clickByText = async (wanted, maxDepth = 6) => {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const wanted = ${JSON.stringify(wanted)};
      const nodes = [...document.querySelectorAll('button, [role="button"], a, li')];
      const hit = nodes.find(n => (n.textContent || '').trim() === wanted)
        ?? nodes.find(n => (n.textContent || '').trim().startsWith(wanted));
      if (!hit) return { clicked: false, sample: nodes.map(n => (n.textContent||'').trim().slice(0,30)).filter(Boolean).slice(0, 30) };
      hit.click();
      return { clicked: true, tag: hit.tagName, text: (hit.textContent||'').trim().slice(0,60) };
    })()`,
    returnByValue: true,
  })
  void maxDepth
  return result.result?.value
}

const record = { steps: [] }
const step = async (name, wanted) => {
  const outcome = await clickByText(wanted)
  await sleep(2500)
  const snapshot = await send('Runtime.evaluate', {
    expression: `(() => {
      const section = document.querySelector('.ocg-section');
      return {
        hasOcgSection: !!section,
        ocgText: (section?.innerText ?? '').slice(0, 500),
        settingNavItems: [...document.querySelectorAll('button,[role="button"],a,li')]
          .map(n => (n.textContent||'').trim()).filter(t => t && t.length < 24).slice(0, 30),
      };
    })()`,
    returnByValue: true,
  })
  record.steps.push({ name, outcome, snapshot: snapshot.result?.value })
}

await step('open settings', 'Settings')
await step('open plugin section', label)
await step('open plugin section (loose)', label.replace(/\s*\(native\)/i, ''))

/**
 * Run one optional action and report exactly what the page did.
 *
 * The `fill` action dispatches a native `input` event after setting `.value`,
 * because React patches the value setter and listens for the event rather than
 * polling the property — assigning `.value` alone silently does nothing, which
 * is the classic way a browser probe "passes" without testing anything.
 * @param {object} action - one parsed action.
 * @returns {Promise<object>} its outcome, for the evidence record.
 */
async function runAction(action) {
  if (action.kind === 'wait') {
    await sleep(action.ms)
    return { kind: 'wait', ms: action.ms }
  }
  if (action.kind === 'click') {
    const outcome = await clickByText(action.target)
    await sleep(1500)
    return { kind: 'click', target: action.target, ...outcome }
  }
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('[data-ocg-field=' + JSON.stringify(${JSON.stringify(action.target)}) + ']');
      if (!el) return { filled: false, reason: 'no control with that data-ocg-field' };
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(action.value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { filled: true, tag: el.tagName, type: el.type, valueLength: el.value.length };
    })()`,
    returnByValue: true,
  })
  await sleep(500)
  return { kind: 'fill', target: action.target, ...result.result?.value }
}

for (const action of actions) {
  const outcome = await runAction(action)
  record.steps.push({ name: `${action.kind} ${action.target ?? String(action.ms)}`, outcome })
  const snapshot = await send('Runtime.evaluate', {
    expression: `(() => {
      const section = document.querySelector('.ocg-section');
      const secret = document.querySelector('[data-ocg-field="apiKey"]');
      return {
        hasOcgSection: !!section,
        ocgText: (section?.innerText ?? '').slice(0, 700),
        saveDisabled: document.querySelector('[data-ocg-field="action.save"]')?.disabled,
        // The inline token control must be EMPTY at every step: the host never
        // sends the stored value back, and the form never stages it.
        apiKeyInputLength: secret === null || typeof secret.value !== 'string' ? null : secret.value.length,
      };
    })()`,
    returnByValue: true,
  })
  record.steps.at(-1).snapshot = snapshot.result?.value
}

void settleMs

console.log('--- steps ---')
console.log(JSON.stringify(record.steps, null, 1))
finalReport(consoleLines, exceptions, failedRequests)

socket.close()
child.kill('SIGKILL')

function finalReport(consoleLines, exceptions, failedRequests) {
  const errors = consoleLines.filter((line) => /^(error|assert)\b/u.test(line))
  const crashes = consoleLines.filter((line) => /slot entry crashed|without inject|Cannot read|is not a function/iu.test(line))
  console.log('--- console (last 25) ---')
  console.log(consoleLines.slice(-25).join('\n') || '(none)')
  console.log('--- console counts ---')
  console.log(JSON.stringify({
    total: consoleLines.length,
    errors: errors.length,
    slotCrashes: crashes.length,
    exceptionCount: exceptions.length,
  }))
  console.log('--- exceptions ---')
  console.log(exceptions.join('\n') || '(none)')
  console.log('--- network failures (last 15) ---')
  console.log(failedRequests.slice(-15).join('\n') || '(none)')
}
