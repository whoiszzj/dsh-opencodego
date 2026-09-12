/**
 * Unit tests for the browser-trust fence over the plugin's HTTP surface.
 *
 * The fence is the weaker of the two claims a route can make (it is a
 * DNS-rebinding / cross-site defense, not authentication), so its branches are
 * pinned here rather than assumed: a route that describes a provider must not be
 * readable by a random page.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isLoopbackHostname, isTrustedApiRequest } from '../src/http.js'

const request = (headers) => ({ headers })

test('the loopback vocabulary is exactly the loopback vocabulary', () => {
  for (const hostname of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname)
  }
  for (const hostname of ['example.com', '10.0.0.1', '127.0.0.256', '127.0.0', 'localhost.example.com', '0.0.0.0']) {
    assert.equal(isLoopbackHostname(hostname), false, hostname)
  }
})

test('a request with no Host is refused', () => {
  assert.equal(isTrustedApiRequest(request({})), false)
  assert.equal(isTrustedApiRequest(request({ host: 'not a host' })), false)
})

test('a loopback page passes with or without an Origin', () => {
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080' })), true)
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
  // Some Chromium builds serialize a non-default-port loopback Origin without
  // the port; the Host fence already bound the authority.
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' })), true)
  assert.equal(isTrustedApiRequest(request({ host: 'localhost:3080' })), true)
})

test('a cross-site browser marker is refused even from a loopback Host', () => {
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })), true)
})

test('a foreign Host or a foreign Origin is refused', () => {
  assert.equal(isTrustedApiRequest(request({ host: 'evil.example:3080' })), false)
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'https://evil.example' })), false)
  // The literal "null" origin (sandboxed iframe, file: page) is opaque.
  assert.equal(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'null' })), false)
})

test('a configured trusted authority widens the fence without weakening the markers', () => {
  const trusted = ['gui.example:8443']
  assert.equal(isTrustedApiRequest(request({ host: 'gui.example:8443' }), trusted), true)
  assert.equal(isTrustedApiRequest(request({ host: 'other.example:8443' }), trusted), false)
  assert.equal(
    isTrustedApiRequest(request({ host: 'gui.example:8443', 'sec-fetch-site': 'cross-site' }), trusted),
    false,
  )
  assert.equal(isTrustedApiRequest(request({ host: 'gui.example:8443', origin: 'https://evil.example' }), trusted), false)
})

test('a repeated header (array) is not mistaken for a string', () => {
  assert.equal(isTrustedApiRequest(request({ host: ['127.0.0.1:3080', 'evil.example'] })), false)
})
