/**
 * Unit tests for endpoint health classification.
 *
 * The categories exist so the audit's requirement C is satisfiable without
 * inventing host model-information fields: this is plugin-owned diagnostics,
 * and these tests pin the operator-facing action for each measured gate.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyEndpointHealth,
  ENDPOINT_HEALTH,
  EndpointHealthLog,
  HEALTH_ACTION,
} from '../src/health.js'

// Both are `RegionError`; the wording decides whether the workspace opt-in is
// the fix (China-hosted) or nothing local can be (a country block).
const REGION = 'OpenAI API error (403): {"type":"RegionError","message":"The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai/workspace"}'
const CHINA_ONLY = 'OpenAI API error (403): {"message":"The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai"}'
const DATA_POLICY = 'OpenAI API error (403): {"type":"DataPolicyError","message":"This model collects data used to improve its quality and requires explicit opt in"}'
const COUNTRY = 'OpenAI API error (403): {"param":null,"message":"Error from provider (Console Go): Upstream request failed: [unsupported_country_region_territory] Country, region, or territory not supported"}'
// The same `RegionError` type, a different situation and a different action.
const REGION_COUNTRY = 'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}'
const FORMAT = 'OpenAI API error (401): {"type":"ModelError","message":"Model qwen3.8-flash is not supported for format openai"}'
const PATH = '404 <!DOCTYPE html><html lang="en">'
const UNAVAILABLE = '400: {"type":"server_error","message":"Error from provider (Console Go): Upstream request failed: Model is unavailable."}'
const UPSTREAM = 'OpenAI API error (500): {"type":"error","message":"Internal server error"}'

test('each measured gate lands in its own category', () => {
  assert.equal(classifyEndpointHealth(REGION).category, ENDPOINT_HEALTH.REGION)
  assert.equal(classifyEndpointHealth(CHINA_ONLY).category, ENDPOINT_HEALTH.REGION)
  assert.equal(classifyEndpointHealth(DATA_POLICY).category, ENDPOINT_HEALTH.DATA_POLICY)
  assert.equal(classifyEndpointHealth(COUNTRY).category, ENDPOINT_HEALTH.COUNTRY_BLOCK)
  assert.equal(classifyEndpointHealth(REGION_COUNTRY).category, ENDPOINT_HEALTH.COUNTRY_BLOCK)
  assert.equal(classifyEndpointHealth(FORMAT).category, ENDPOINT_HEALTH.FORMAT_UNSUPPORTED)
  assert.equal(classifyEndpointHealth(PATH).category, ENDPOINT_HEALTH.PROTOCOL_PATH_MISSING)
  assert.equal(classifyEndpointHealth(UNAVAILABLE).category, ENDPOINT_HEALTH.MODEL_UNAVAILABLE)
  assert.equal(classifyEndpointHealth(UPSTREAM).category, ENDPOINT_HEALTH.UPSTREAM)
  assert.equal(classifyEndpointHealth(undefined).category, ENDPOINT_HEALTH.UNKNOWN)
})

test('the actionable categories carry an action and the status they saw', () => {
  const region = classifyEndpointHealth(REGION)
  assert.equal(region.status, 403)
  assert.equal(region.action, HEALTH_ACTION[ENDPOINT_HEALTH.REGION])
  assert.match(region.action, /workspace/)
  assert.match(classifyEndpointHealth(DATA_POLICY).action, /data-use policy/)
  assert.match(classifyEndpointHealth(COUNTRY).action, /Nothing local can fix this/)
  assert.match(classifyEndpointHealth(REGION_COUNTRY).action, /Nothing local can fix this/)
  // A transient 500 has nothing for the operator to do.
  assert.equal(classifyEndpointHealth(UPSTREAM).action, undefined)
})

test('the log keeps the latest record per model and lists only the unusable ones', () => {
  const log = new EndpointHealthLog({ now: () => 42 })
  log.record('gpt-5.6-luna', 'openai-responses', COUNTRY)
  log.record('glm-5.3-flash', 'openai-completions', undefined)
  log.record('glm-5.3-flash', 'openai-responses', UPSTREAM)
  assert.equal(log.latest('glm-5.3-flash').category, ENDPOINT_HEALTH.UPSTREAM)
  const unusable = log.unusable()
  assert.deepEqual(unusable.map((entry) => entry.modelId), ['gpt-5.6-luna'])
  assert.match(log.summaryLines()[0], /gpt-5.6-luna: country-block \(HTTP 403\)/)
  assert.match(log.summaryLines()[0], /Nothing local can fix this/)
})

test('a successful later attempt clears the model from the unusable list', () => {
  const log = new EndpointHealthLog()
  log.record('mimo-v2-pro', 'openai-completions', UNAVAILABLE)
  assert.equal(log.unusable().length, 1)
  log.record('mimo-v2-pro', 'openai-completions', undefined)
  assert.deepEqual(log.unusable(), [])
  assert.equal(log.latest('mimo-v2-pro').category, ENDPOINT_HEALTH.OK)
})

test('history is bounded per model', () => {
  const log = new EndpointHealthLog({ maxPerModel: 2 })
  for (let index = 0; index < 5; index++) log.record('m', 'openai-completions', UPSTREAM)
  assert.equal(log.snapshot()[0].history.length, 2)
})
