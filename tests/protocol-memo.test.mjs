/**
 * Unit tests for the learned protocol-refusal memo and for per-protocol request
 * adaptation.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ProtocolRejectionMemo } from '../src/protocol-memo.js'
import { adaptRequestForProtocol, baseUrlForProtocol } from '../src/request-adapt.js'

/* ── the memo ─────────────────────────────────────────────────────────────── */

test('a remembered refusal reorders the chain but keeps every candidate', () => {
  const memo = new ProtocolRejectionMemo({ now: () => 1_000 })
  const chain = ['anthropic-messages', 'openai-completions']
  assert.deepEqual(memo.demote('qwen3.8-flash', chain), chain)
  memo.remember('qwen3.8-flash', 'anthropic-messages', '404 <!DOCTYPE html>')
  assert.deepEqual(memo.demote('qwen3.8-flash', chain), ['openai-completions', 'anthropic-messages'])
  // The refused protocol stays in the chain: if every alternative fails, the
  // endpoint's own refusal is still what the caller sees.
  assert.equal(memo.demote('qwen3.8-flash', chain).length, chain.length)
})

test('a refusal is scoped to one model and expires', () => {
  let now = 0
  const memo = new ProtocolRejectionMemo({ ttlMs: 100, now: () => now })
  memo.remember('a', 'anthropic-messages')
  assert.equal(memo.rejected('a', 'anthropic-messages'), true)
  assert.equal(memo.rejected('a', 'openai-completions'), false)
  assert.equal(memo.rejected('b', 'anthropic-messages'), false)
  now = 99
  assert.equal(memo.rejected('a', 'anthropic-messages'), true)
  now = 101
  assert.equal(memo.rejected('a', 'anthropic-messages'), false)
  assert.deepEqual(memo.snapshot(), [])
})

test('the snapshot reports what is currently believed, and clear forgets it', () => {
  const memo = new ProtocolRejectionMemo({ now: () => 0 })
  memo.remember('a', 'anthropic-messages', '404')
  assert.deepEqual(memo.snapshot(), [{ protocol: 'anthropic-messages', expiresAt: 900_000, reason: '404' }])
  memo.clear()
  assert.deepEqual(memo.snapshot(), [])
})

/* ── per-protocol adaptation ──────────────────────────────────────────────── */

const MODEL = { maxTokens: 131_072 }

test('the Responses output floor is applied on the protocol that has it', () => {
  const raised = adaptRequestForProtocol('openai-responses', { maxTokens: 8 }, MODEL)
  assert.equal(raised.maxTokens, 16)
  assert.match(raised.notes.join(' '), /floor 16/)
  // At the floor nothing changes, and nothing is noted.
  const exact = adaptRequestForProtocol('openai-responses', { maxTokens: 16 }, MODEL)
  assert.equal(exact.maxTokens, 16)
  assert.deepEqual(exact.notes, [])
})

test('a request above the model cap is capped, not sent as-is', () => {
  const capped = adaptRequestForProtocol('openai-completions', { maxTokens: 500_000 }, MODEL)
  assert.equal(capped.maxTokens, 131_072)
  assert.match(capped.notes.join(' '), /capped to the model's 131072/)
})

test('an omitted cap stays omitted for completions and responses', () => {
  assert.equal(adaptRequestForProtocol('openai-completions', {}, MODEL).maxTokens, undefined)
  assert.equal(adaptRequestForProtocol('openai-responses', {}, MODEL).maxTokens, undefined)
})

test('anthropic-messages always gets a max_tokens', () => {
  const adapted = adaptRequestForProtocol('anthropic-messages', {}, MODEL)
  assert.equal(adapted.maxTokens, 131_072)
  assert.match(adapted.notes.join(' '), /defaulted to the model's/)
  // An explicit value is respected.
  assert.equal(adaptRequestForProtocol('anthropic-messages', { maxTokens: 4_096 }, MODEL).maxTokens, 4_096)
})

test('a nonsense cap is treated as absent, not forwarded', () => {
  for (const value of [0, -1, 1.5, Number.NaN, 'many']) {
    assert.equal(adaptRequestForProtocol('openai-completions', { maxTokens: value }, MODEL).maxTokens, undefined)
  }
})

test('the anthropic base drops one /v1 because the Anthropic SDK appends /v1/messages', () => {
  const base = 'https://opencode.ai/zen/go/v1'
  assert.equal(baseUrlForProtocol('openai-completions', base), base)
  assert.equal(baseUrlForProtocol('openai-responses', base), base)
  assert.equal(baseUrlForProtocol('anthropic-messages', base), 'https://opencode.ai/zen/go')
  // REGRESSION: the Anthropic SDK appends `/v1/messages`, so an anthropic base
  // that still ends in `/v1` silently doubles the segment into the gateway's
  // HTML 404 page. Phase 1 misread exactly that as "this endpoint serves no
  // anthropic path", so the invariant is pinned here, for every shape a
  // configured base can take.
  for (const configured of [
    'https://opencode.ai/zen/go/v1',
    'https://gateway.example/v1',
    'https://gateway.example/api/v1',
  ]) {
    assert.ok(
      !baseUrlForProtocol('anthropic-messages', configured).endsWith('/v1'),
      `${configured} must not reach the Anthropic SDK still ending in /v1`,
    )
  }
  // Only a trailing /v1 is removed, and a base without it is left alone.
  assert.equal(baseUrlForProtocol('anthropic-messages', 'https://opencode.ai/zen/go'), 'https://opencode.ai/zen/go')
  assert.equal(baseUrlForProtocol('anthropic-messages', 'https://api.example.com/v1/'), 'https://api.example.com/v1/')
})
