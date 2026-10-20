import { expect, test } from 'claude-code/testing'
import { overloadRetryDelay } from '../hooks/model'
import { assistantText } from '../hooks/activity'
import type { CodexAgent } from '../types'

const agent = (patch: Partial<CodexAgent> = {}) => ({
  capacityInput: 'Run the task', capacityAttempts: 0, capacityStartedAt: 1000,
  turnStartedAt: 1000, capacityWorkObserved: false, ...patch,
} as CodexAgent)
const failed = (patch: Record<string, unknown> = {}) => ({
  id: 'fixture-turn', status: 'failed', items: [],
  error: { message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded' }, ...patch,
})

test('terminal overload retries have attempt, elapsed and provider-delay bounds', () => {
  expect(overloadRetryDelay(agent(), failed(), 1000)).toBe(2000)
  expect(overloadRetryDelay(agent(), failed({ items: [{ type: 'userMessage' }] }), 1000)).toBe(2000)
  expect(overloadRetryDelay(agent({ capacityAttempts: 1 }), failed(), 4000)).toBe(4000)
  expect(overloadRetryDelay(agent({ capacityAttempts: 2 }), failed(), 4000)).toBe(null)
  expect(overloadRetryDelay(agent(), failed({ error: { codexErrorInfo: 'serverOverloaded', retryAfterMs: 9000 } }), 1000)).toBe(9000)
  expect(overloadRetryDelay(agent(), failed({ error: { codexErrorInfo: 'serverOverloaded', retryAfterMs: 120001 } }), 1000)).toBe(null)
  expect(overloadRetryDelay(agent(), failed(), 120000)).toBe(null)
  expect(overloadRetryDelay(agent(), failed({ error: { codexErrorInfo: 'serverOverloaded', retryAfterMs: -1 } }), 1000)).toBe(null)
})

test('capacity prose, partial work, ambiguous outcomes and server retries cannot repeat input', () => {
  for (const turn of [
    failed({ status: 'inProgress' }), failed({ status: 'interrupted' }),
    failed({ error: { message: 'model at capacity' } }),
    failed({ error: { codexErrorInfo: 'other' } }),
    failed({ error: { codexErrorInfo: 'rateLimitExceeded' } }),
    failed({ error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } } }),
    failed({ willRetry: true }), failed({ error: { codexErrorInfo: 'serverOverloaded', willRetry: true } }),
    failed({ items: [{ type: 'commandExecution', command: 'touch file' }] }), failed({ items: undefined }),
  ]) expect(overloadRetryDelay(agent(), turn, 1000)).toBe(null)
  expect(overloadRetryDelay(agent({ capacityWorkObserved: true }), failed(), 1000)).toBe(null)
  expect(overloadRetryDelay(agent({ capacityInput: undefined }), failed(), 1000)).toBe(null)
})

test('assistant prose is redacted without truncation', () => {
  const line = assistantText(`TOKEN=${'x'.repeat(500)} checking ${'y'.repeat(500)}`)
  expect(line.length > 500).toBe(true)
  expect(line).toContain('[redacted]')
  expect(line).not.toContain('xxx')
  expect(line).not.toContain('…')
})
