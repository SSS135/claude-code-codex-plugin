import { expect, test } from 'claude-code/testing'
import { activityEvent, assistantText, commandPreview, LiveActivity, MAX_ACTIVITY_CHUNK, MAX_ASSISTANT_TEXT, redactActivity } from '../hooks/activity'

const equal = (actual: unknown, expected: unknown) => expect(actual).toBe(expected)
const match = (actual: string, expected: RegExp) => expect(actual).toMatch(expected)
const doesNotMatch = (actual: string, expected: RegExp) => expect(actual).not.toMatch(expected)
const ok = (actual: boolean) => expect(actual).toBe(true)

test('replay projects only public text and completed command metadata', () => {
  equal(activityEvent('item/started', { item: { type: 'commandExecution', command: 'node --test' } }), null)
  expect(activityEvent('item/completed', { item: { type: 'commandExecution', command: 'node --test', exitCode: 1, aggregatedOutput: 'private output' } })).toEqual({ kind: 'command', command: 'node --test', result: 'exit 1' })
  expect(activityEvent('item/completed', { item: { type: 'fileChange', changes: [{ path: 'src/main.ts', diff: 'private patch' }] } })).toEqual({ kind: 'text', text: 'Files changed: src/main.ts' })
  expect(activityEvent('item/completed', { item: { type: 'agentMessage', text: 'Checking the test now.' } })).toEqual({ kind: 'text', text: 'Checking the test now.' })
  for (const method of ['item/reasoning/textDelta', 'item/commandExecution/outputDelta', 'turn/diff/updated', 'config/updated']) equal(activityEvent(method, { delta: 'private' }), null)
  equal(activityEvent('item/completed', { item: { type: 'reasoning', text: 'private reasoning' } }), null)
  equal(activityEvent('item/completed', { item: { type: 'mcpToolCall', result: 'private response' } }), null)
})

test('redaction removes environment values, credentials, identifiers and terminal controls before clipping', () => {
  const inputs = [
    'TOKEN=very-private node task.js', 'REGION="very private" node task.js', "X='very private' node task.js",
    'TOKEN=$(echo very-private) node task.js', 'TOKEN=`echo very-private` node task.js',
    'TOKEN="very private', 'TOKEN=very\\ private node task.js',
    'curl --token very-private', 'curl --api-key "very private"', 'Authorization: Bearer very-private',
    'curl --token $(echo very-private)', 'Authorization: very-private', 'X-Api-Key: very-private',
    'https://user:very-private@example.test', 'https://example.test?token=very-private',
    '{"sessionId":"very-private"}', 'session_id: very-private',
    'ghp_veryprivate0123456789', 'sk-proj-veryprivate0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    '-----BEGIN PRIVATE KEY-----\nvery-private\n-----END PRIVATE KEY-----',
  ]
  for (const input of inputs) {
    const safe = redactActivity(input)
    doesNotMatch(safe, /very.private|veryprivate|eyJ/)
    match(safe, /redacted/)
  }
  equal(redactActivity('\x1b[31mred\x1b[0m\nnext\u202etext'), 'red next text')
  doesNotMatch(redactActivity(`TOKEN=${'s'.repeat(5000)}`, 100), /ssss/)
  doesNotMatch(redactActivity('019c6e27-e55b-73d1-87d8-4e01f1f75043'), /019c6e27/)
})

test('replay is ordered, incremental, deduplicated, bounded and isolated by exact turn', () => {
  const feed = new LiveActivity()
  feed.begin('agent', 'turn-1')
  const event = { turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', text: 'Running tests.' } }
  feed.record('agent', 'turn-1', 'item/completed', event)
  feed.record('agent', 'turn-1', 'item/completed', event)
  equal(feed.has('agent', 'turn-1'), true)
  equal(feed.has('agent', 'old-turn'), false)
  expect(feed.take('agent', 'turn-1')).toEqual([{ kind: 'text', text: 'Running tests.' }])
  expect(feed.take('agent', 'turn-1')).toEqual([])
  equal(feed.has('agent', 'turn-1'), false)
  feed.begin('agent', 'turn-2')
  feed.record('agent', 'turn-1', 'item/completed', event)
  feed.record('agent', 'turn-2', 'item/completed', event)
  expect(feed.take('agent', 'turn-2')).toEqual([])
  for (let index = 0; index < 100; index++) feed.record('agent', 'turn-2', 'item/completed', { turnId: 'turn-2', item: { id: `i-${index}`, type: 'agentMessage', text: `${index} ${'x'.repeat(2000)}` } })
  const batches = []
  while (feed.has('agent', 'turn-2')) batches.push(feed.take('agent', 'turn-2'))
  match(JSON.stringify(batches[0]), /older Codex activity entries omitted/)
  ok(batches.length < 10)
  ok(batches.every(batch => batch.reduce((sum, event) => sum + (event.kind === 'text' ? event.text.length : event.command.length + event.result.length), 0) <= MAX_ACTIVITY_CHUNK))
  doesNotMatch(JSON.stringify(batches), /turn-2|i-99/)
  feed.forget('agent')
  expect(feed.take('agent', 'turn-2')).toEqual([])
})

test('activity feed count has a safety bound and forgetting releases delivery state', () => {
  const feed = new LiveActivity()
  for (let index = 0; index < 257; index++) {
    const id = `a-${index}`
    feed.begin(id, 'turn')
    feed.record(id, 'turn', 'item/completed', { turnId: 'turn', item: { type: 'agentMessage', text: 'Checking.' } })
  }
  equal(feed.has('a-0', 'turn'), false)
  equal(feed.has('a-256', 'turn'), true)
  feed.forget('a-256')
  equal(feed.has('a-256', 'turn'), false)
})


test('command previews unwrap shells, omit script bodies and keep status inside 120 characters', () => {
  for (const shell of ['/usr/bin/zsh', '/bin/bash', 'sh', 'dash']) {
    equal(commandPreview(`${shell} -lc "rg -n 'add_argument' market_intel/cli.py"`), "rg -n 'add_argument' market_intel/cli.py")
  }
  equal(commandPreview(String.raw`/bin/bash -lc 'rg -n '"'"'add_argument'"'"' src'`), "rg -n 'add_argument' src")
  equal(commandPreview('python3 - <<\'PY\'\nprivate body\nPY'), 'python3 - …')
  equal(commandPreview('/usr/bin/zsh -lc "python3 - <<\'PY\'\nprivate body\nPY"'), 'python3 - …')
  equal(commandPreview('TOKEN=private python3 -c \"private body\"'), '… python3 -c …')
  equal(commandPreview("python3 -c'private body'"), 'python3 -c …')
  equal(commandPreview('node --eval=private'), 'node --eval …')
  equal(commandPreview('printf first\\\nprivate body'), 'printf first …')
  equal(commandPreview('node -e "private body"'), 'node -e …')
  equal(commandPreview('python3 -c "private body"'), 'python3 -c …')
  equal(commandPreview("rg -n '^def .*|add_argument' src | head -35"), "rg -n '^def .*|add_argument' src …")
  equal(commandPreview('rg first src && echo private body'), 'rg first src …')
  equal(commandPreview('rg first src\necho private body'), 'rg first src …')
  equal(commandPreview('A=private B="private value" npm test'), '… npm test')
  const line = commandPreview(`rg ${'x'.repeat(1000)}`)
  ok(line.length <= 120)
  match(line, /…$/)
  for (const input of ['TOKEN=$(echo private)', 'curl --token private', 'curl https://user:private@example.test', 'python3 - <<EOF\nprivate\nEOF']) {
    doesNotMatch(commandPreview(input), /private|redacted|TOKEN=|<<|EOF/)
  }
})

test('assistant messages and all public summaries preserve full markdown and whitespace', () => {
  const text = `## Verification\n\n${'A complete paragraph. '.repeat(500)}\n\n- first\n- **second**\n\n\`\`\`ts\nconst value = 1\n\`\`\``
  expect(activityEvent('item/completed', { item: { type: 'agentMessage', text } })).toEqual({ kind: 'text', text })
  equal(assistantText(text), text)
  doesNotMatch(assistantText(text), /…|truncated|Message:/)
  expect(activityEvent('item/completed', { item: { type: 'reasoning', summary: [text, 'Next step.'], content: ['private raw reasoning'], text: 'private text' } })).toEqual({ kind: 'text', text: `${text}\n\nNext step.` })
  equal(activityEvent('item/completed', { item: { type: 'reasoning', content: ['private raw reasoning'] } }), null)
  equal(activityEvent('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: 'final answer' } }), null)
  expect(activityEvent('turn/plan/updated', { plan: [{ step: 'Read', status: 'completed' }, { step: 'Verify', status: 'inProgress' }] })).toEqual({ kind: 'text', text: 'Plan: 1/2 done\n\n- [x] Read\n- [ ] Verify' })
  match(assistantText('x'.repeat(MAX_ASSISTANT_TEXT + 1)), /^\[Codex message omitted:/)
  doesNotMatch(assistantText('x'.repeat(MAX_ASSISTANT_TEXT + 1)), /xxx|truncated|…/)
})

test('starts stay silent and every command replays once in order without burst suppression', () => {
  const feed = new LiveActivity()
  feed.begin('agent', 'turn')
  const event = { turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'npm test', exitCode: 0, durationMs: 1200 } }
  feed.record('agent', 'turn', 'item/started', event)
  expect(feed.take('agent', 'turn')).toEqual([])
  feed.record('agent', 'turn', 'item/completed', event)
  expect(feed.take('agent', 'turn')).toEqual([{ kind: 'command', command: 'npm test', result: 'exit 0, 1.2s' }])
  feed.record('agent', 'turn', 'item/completed', event)
  expect(feed.take('agent', 'turn')).toEqual([])
  for (let i = 0; i < 8; i++) feed.record('agent', 'turn', 'item/completed', { turnId: 'turn', item: { id: `c${i}`, type: 'commandExecution', command: `rg pattern${i}`, exitCode: 0 } })
  feed.record('agent', 'turn', 'item/completed', { turnId: 'turn', item: { id: 'note', type: 'agentMessage', text: 'Tests passed.' } })
  expect(feed.take('agent', 'turn')).toEqual([...Array.from({ length: 8 }, (_, i) => ({ kind: 'command', command: `rg pattern${i}`, result: 'exit 0' })), { kind: 'text', text: 'Tests passed.' }])
  expect(feed.take('agent', 'turn')).toEqual([])
})

test('queue overflow sheds commands before prose and keeps full large messages together', () => {
  const feed = new LiveActivity()
  feed.begin('a', 't')
  const text = `## Full message\n\n${'word '.repeat(10_000)}`
  feed.record('a', 't', 'item/completed', { turnId: 't', item: { id: 'm', type: 'agentMessage', text } })
  for (let i = 0; i < 70; i++) feed.record('a', 't', 'item/completed', { turnId: 't', item: { id: `c${i}`, type: 'commandExecution', command: 'true' } })
  expect(feed.take('a', 't')).toEqual([{ kind: 'text', text: '[11 older Codex activity entries omitted]' }, { kind: 'text', text }])
})
