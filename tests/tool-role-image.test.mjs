/**
 * The v4 tool role: a tool result arrives as its OWN message.
 *
 * DSH session format 4 delivers a tool result as `{ role: 'tool', toolCallId,
 * isError, content: [...] }` — a flat message — where the older format nested a
 * `tool-result` block inside a user message. Two things follow, and both are
 * pinned here:
 *
 *   1. `assertSupportedImageRoles` must admit the role. pi-ai's `toolResult`
 *      role is where a tool-returned image belongs, and the official
 *      `dsh-llm-pi-ai` adapter admits it for that reason; refusing it means a
 *      session that has ever looked at a picture fails EVERY later request with
 *      `opencode-go-native: cannot represent an image in an in-history tool
 *      message`.
 *   2. Both conversion paths must keep the result a `toolResult`, instead of
 *      degrading it into an ordinary user turn that has lost `toolCallId` and
 *      `toolName`.
 *
 * `src/pi-ai.js` imports host packages at module scope, so this file cannot
 * import it (the same constraint every other test here lives under). The two
 * pure functions are therefore sliced out of the source and exercised against
 * stubs, which keeps this runnable by bare `node --test` with no profile
 * installed.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../src/pi-ai.js', import.meta.url), 'utf8')
const BUILT = readFileSync(new URL('../lib/pi-ai.js', import.meta.url), 'utf8')

/** Slice one `function name(…) { … }` declaration out of a source file. */
function declaration(name, source = SOURCE) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name}() must be declared in pi-ai.js`)
  let index = source.indexOf('{', start)
  let depth = 0
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return source.slice(start, index + 1)
}

class LlmError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/** The host's own definition: a flat content list is what it walks. */
const contentHasImage = (content) =>
  (Array.isArray(content) ? content : []).some((block) => block?.type === 'image')

/** The two functions under test, wired to the stubs above. */
function underTest() {
  const body = [declaration('toolResultOf'), declaration('assertSupportedImageRoles')].join('\n')
  const build = new Function('LlmError', 'contentHasImage',
    `${body}\nreturn { toolResultOf, assertSupportedImageRoles }`)
  return build(LlmError, contentHasImage)
}

const image = () => ({
  type: 'image',
  attachment: {
    attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png',
  },
})
const toolMessage = (content, extra = {}) =>
  ({ role: 'tool', toolCallId: 'call_1', content, isError: false, ...extra })

test('lib/pi-ai.js is the built copy of src/pi-ai.js', () => {
  // Invariant 8 of CLAUDE.md: lib/ ships in the repository and must be rebuilt
  // from src/ in the same commit.
  assert.equal(BUILT, SOURCE, 'run `npm run build` and commit src/ and lib/ together')
})

test('the image guard admits a tool result and still refuses every other role', () => {
  const { assertSupportedImageRoles } = underTest()

  // The regression itself: a v4 tool message carrying an image — the shape a
  // session log actually holds — must not refuse the request.
  assert.doesNotThrow(() => assertSupportedImageRoles([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'look at this' }, image()] },
    toolMessage([{ type: 'text', text: '<path>shot.png</path>' }, image()]),
  ]))

  // A text-only message is never refused, whatever its role.
  assert.doesNotThrow(() => assertSupportedImageRoles([
    { role: 'assistant', content: [{ type: 'text', text: 'the sky is blue' }] },
  ]))

  // Roles with no pi-ai slot are still refused, and with the same wording the
  // official adapter uses — before any request is built.
  for (const role of ['assistant', 'system', 'developer']) {
    let refused
    try { assertSupportedImageRoles([{ role, content: [image()] }]) } catch (error) { refused = error }
    assert.ok(refused instanceof LlmError, `${role} + image must be refused`)
    assert.equal(refused.code, 'UNSUPPORTED_CONTENT')
    assert.match(refused.message,
      new RegExp(`cannot represent an image in an in-history ${role} message`, 'u'))
  }
})

test('toolResultOf reproduces the official toolResult, texts included', () => {
  const { toolResultOf } = underTest()
  const names = new Map([['call_1', 'read_image']])

  assert.deepEqual(toolResultOf(toolMessage('<path>a.png</path>'), names, '<path>a.png</path>'), {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'read_image',
    content: [{ type: 'text', text: '<path>a.png</path>' }],
    isError: false,
    timestamp: 0,
  })

  // A call the assistant turns never announced still needs a name pi-ai accepts.
  assert.equal(toolResultOf(toolMessage('x'), new Map(), 'x').toolName, 'unknown')
  // Empty output must become one placeholder text block, not an empty block.
  assert.deepEqual(toolResultOf(toolMessage(''), new Map(), '').content,
    [{ type: 'text', text: '(no output)' }])
  // A failed tool keeps its flag, so the model is told the call went wrong.
  assert.equal(toolResultOf(toolMessage('boom', { isError: true }), new Map(), 'boom').isError, true)

  // The image path hands over an ALREADY converted content list. It has to
  // travel through by identity: wrapping it in a text block would drop the
  // picture, which is the whole point of the fix.
  const blocks = [{ type: 'text', text: 'a.png' }, image()]
  assert.equal(toolResultOf(toolMessage(blocks), names, blocks).content, blocks)
})

test('both conversion paths keep a tool result a tool result', () => {
  // The text-only path cannot send the image, but it must still correlate the
  // result with its call.
  const text = declaration('textOnlyContext')
  assert.match(text, /if \(message\.role === 'tool'\) \{/u)
  assert.match(text, /messages\.push\(toolResultOf\(message, toolNames, flattenText\(message\)\)\)/u)

  // The image path is the one that actually carries the picture.
  const images = declaration('toPiContextWithImages')
  assert.match(images, /if \(message\.role === 'tool'\) \{/u)
  assert.match(images, /messages\.push\(toolResultOf\(/u)
  assert.match(images, /await userContent\(message\.content, requestImages, resolveImageAccess\)/u)
})

test('a tool message is charged against the request-image budget like any other', () => {
  // `prepareRequestImages` walks every message's content, so a tool-returned
  // image is prepared and counted even though its role is new. The collection
  // is role-agnostic, so it needed no change — this pins that it stays so.
  assert.match(declaration('prepareRequestImages'),
    /for \(const message of messages\) collectImageRefs\(message\.content, refs\)/u)
})

test('the guard no longer refuses the tool role by omission', () => {
  assert.match(SOURCE,
    /message\.role !== 'user' && message\.role !== 'tool' && contentHasImage\(message\.content\)/u)
  assert.doesNotMatch(SOURCE, /message\.role !== 'user' && contentHasImage\(message\.content\)/u)
})
