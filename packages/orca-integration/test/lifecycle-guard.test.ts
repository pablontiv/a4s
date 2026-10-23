import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrcaLifecycleGuard } from '../src/index.ts'

interface HookResult {
  block?: boolean
  reason?: string
  systemPrompt?: string | string[]
}

type Handler = (
  event: Record<string, unknown>,
  context: FakeContext,
) => Promise<HookResult | void> | HookResult | void

interface FakeContext {
  cwd: string
}

interface SentMessage {
  message: { customType: string; content: string; display: boolean }
  options: { triggerTurn: boolean }
}

interface Harness {
  handlers: Map<string, Handler>
  sent: SentMessage[]
  execCalls: Array<{ command: string; args: string[] }>
  setWorkers(next: unknown[]): void
  setRunId(next: string | null): void
  setFailure(next: Error | undefined): void
}

const context: FakeContext = { cwd: '/workspace' }

interface WorkerListOptions {
  total?: number
  nextCursor?: string
  partialHostErrors?: unknown[]
}

function workerList(workers: unknown[], options: WorkerListOptions = {}): unknown {
  const total = options.total ?? workers.length
  return {
    ok: true,
    result: {
      workers,
      page: {
        total,
        hasMore: Boolean(options.nextCursor),
        ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
      },
      ...(options.partialHostErrors ? { partialHostErrors: options.partialHostErrors } : {}),
      scope: { run: 'run_1', source: 'flag' },
    },
  }
}

function reclaimableWorker(overrides: Record<string, unknown> = {}): unknown {
  return {
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    agentTerminalHandle: 'term_1',
    resource: { terminalHandle: 'term_1' },
    projection: {
      nextAction: {
        kind: 'release',
        argv: ['orchestration', 'worker-release', '--dispatch', 'ctx_1'],
      },
    },
    ...overrides,
  }
}

function createHarness(
  initialWorkers: unknown[] = [reclaimableWorker()],
  listOptions: WorkerListOptions = {},
): Harness {
  const handlers = new Map<string, Handler>()
  const sent: SentMessage[] = []
  const execCalls: Array<{ command: string; args: string[] }> = []
  let workers = initialWorkers
  let runId: string | null = 'run_1'
  let failure: Error | undefined

  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler)
      return () => {}
    },
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args })
      if (failure) throw failure
      const payload = args[1] === 'run-current'
        ? { ok: true, result: { run: runId ? { id: runId } : null } }
        : workerList(workers, listOptions)
      return { stdout: JSON.stringify(payload), stderr: '', code: 0, killed: false }
    },
    sendMessage(message: SentMessage['message'], options: SentMessage['options']) {
      sent.push({ message, options })
    },
  }

  createOrcaLifecycleGuard({ isOrcaPane: () => true })(api as never)

  return {
    handlers,
    sent,
    execCalls,
    setWorkers(next: unknown[]) {
      workers = next
    },
    setRunId(next: string | null) {
      runId = next
    },
    setFailure(next: Error | undefined) {
      failure = next
    },
  }
}

async function invoke(
  harness: Harness,
  eventName: string,
  event: Record<string, unknown>,
): Promise<HookResult | undefined> {
  const handler = harness.handlers.get(eventName)
  assert.ok(handler, `${eventName} handler was not registered`)
  const result = await handler(event, context)
  return result ?? undefined
}

test('does not register hooks outside an Orca pane', () => {
  const events: string[] = []
  createOrcaLifecycleGuard({ isOrcaPane: () => false })({
    on(name: string) {
      events.push(name)
    },
  } as never)
  assert.deepEqual(events, [])
})

test('injects exact projected actions only for a bound coordinator with reclaimable workers', async () => {
  const harness = createHarness()
  const result = await invoke(harness, 'before_agent_start', {
    type: 'before_agent_start',
    prompt: 'continue',
    systemPrompt: ['base'],
  })

  assert.ok(result)
  assert.ok(Array.isArray(result.systemPrompt))
  assert.deepEqual(result.systemPrompt.slice(0, 1), ['base'])
  const directive = result.systemPrompt.at(-1)
  assert.ok(directive)
  assert.match(directive, /Run run_1 has 1 reclaimable worker/)
  assert.match(directive, /\["orchestration","worker-release","--dispatch","ctx_1"\]/)
  assert.equal(harness.execCalls[1]?.args.includes('--include-remote'), true)

  harness.setRunId(null)
  const inactive = await invoke(harness, 'before_agent_start', {
    type: 'before_agent_start',
    prompt: 'continue',
    systemPrompt: ['base'],
  })
  assert.equal(inactive, undefined)
})

test('blocks inbox acknowledgement and fresh workers until projected cleanup completes', async () => {
  const harness = createHarness()

  const ack = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_ack',
    toolName: 'bash',
    input: { command: 'orca orchestration check --ack delivery_1 --json' },
  })
  assert.equal(ack?.block, true)
  assert.match(ack?.reason ?? '', /ctx_1/)

  const fresh = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_start',
    toolName: 'bash',
    input: { command: '"$ORCA_CLI" orchestration worker-start --task task_2 --provider codex' },
  })
  assert.equal(fresh?.block, true)

  const unrelated = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_read',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-read --dispatch ctx_1' },
  })
  assert.equal(unrelated, undefined)
})

test('guards command-path flags and shell line continuations', async () => {
  const harness = createHarness()
  const commands = [
    'orca --json orchestration check --ack delivery_1',
    'orca orchestration --json worker-start --task task_2',
    'orca --environment local orchestration check --ack delivery_1',
    'orca \\\n orchestration worker-start --task task_2',
    'orca orchestration --run run_1 check --ack delivery_1',
    'orca orchestration --ack delivery_1 check --json',
    'orca orchestration --model openai/gpt --agent omp worker-start --task task_2',
  ]

  for (const [index, command] of commands.entries()) {
    const result = await invoke(harness, 'tool_call', {
      type: 'tool_call',
      toolCallId: `call_path_${index}`,
      toolName: 'bash',
      input: { command },
    })
    assert.equal(result?.block, true, command)
  }
})

test('allows exact terminal reuse and allows guarded commands after cleanup', async () => {
  const harness = createHarness()
  const reuse = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_reuse',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_2 --terminal "term_1"' },
  })
  assert.equal(reuse, undefined)

  harness.setWorkers([])
  const ack = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_ack',
    toolName: 'bash',
    input: { command: 'orca orchestration check --ack delivery_1' },
  })
  assert.equal(ack, undefined)
})

test('blocks an acknowledgement compounded with an otherwise valid terminal reuse', async () => {
  const harness = createHarness()
  const result = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_compound',
    toolName: 'bash',
    input: {
      command: 'orca orchestration worker-start --task task_2 --terminal term_1 && orca orchestration check --ack delivery_1',
    },
  })
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /check --ack/)
})

test('handles quoted task specs and permits state-free help', async () => {
  const harness = createHarness()
  const quotedReuse = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_quoted',
    toolName: 'bash',
    input: {
      command: 'orca orchestration worker-start --spec \"Fix parser; add tests\" --terminal term_1',
    },
  })
  assert.equal(quotedReuse, undefined)

  const help = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_help',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --help' },
  })
  assert.equal(help, undefined)
})

test('does not treat flags inside task text as executable flags', async () => {
  const harness = createHarness()
  const result = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_embedded_flag',
    toolName: 'bash',
    input: {
      command: 'orca orchestration worker-start --spec "continue in --terminal term_1" --task task_2',
    },
  })
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /worker-start/)
})

test('guards wrapped and nested Orca commands', async () => {
  const harness = createHarness()
  const wrapped = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_wrapped',
    toolName: 'bash',
    input: { command: 'timeout 60 orca orchestration check --ack delivery_1' },
  })
  assert.equal(wrapped?.block, true)

  const nested = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_nested',
    toolName: 'bash',
    input: { command: 'bash -lc "orca orchestration check --ack delivery_1"' },
  })
  assert.equal(nested?.block, true)
})

test('fails closed for guarded commands when Orca inventory cannot be read', async () => {
  const harness = createHarness()
  harness.setFailure(new Error('orca unavailable'))

  const result = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_start',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_2' },
  })
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /could not verify coordinator worker state/)
})

test('fails closed when remote worker inventory is partial', async () => {
  const harness = createHarness([], {
    partialHostErrors: [{ host: 'remote', error: 'unreachable' }],
  })

  const result = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_partial',
    toolName: 'bash',
    input: { command: 'orca orchestration check --ack delivery_1' },
  })
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /partial host error/)
})

test('schedules at most one cleanup continuation until the Run becomes clear', async () => {
  const harness = createHarness()
  const event = { type: 'agent_end', messages: [] }

  await invoke(harness, 'agent_end', event)
  await invoke(harness, 'agent_end', event)
  assert.equal(harness.sent.length, 1)
  assert.deepEqual(harness.sent[0]?.options, { triggerTurn: true })

  harness.setWorkers([])
  await invoke(harness, 'agent_end', event)
  harness.setWorkers([reclaimableWorker({ dispatchId: 'ctx_2' })])
  await invoke(harness, 'agent_end', event)
  assert.equal(harness.sent.length, 2)
})

test('includes the next cursor and continues when the same Run advances to another page', async () => {
  const harness = createHarness([reclaimableWorker()], {
    total: 2,
    nextCursor: 'cursor_2',
  })
  const event = { type: 'agent_end', messages: [] }

  await invoke(harness, 'agent_end', event)
  assert.equal(harness.sent.length, 1)
  assert.match(
    harness.sent[0]?.message.content ?? '',
    /"worker-list".*"--cursor","cursor_2"/,
  )

  harness.setWorkers([reclaimableWorker({ dispatchId: 'ctx_2' })])
  await invoke(harness, 'agent_end', event)
  assert.equal(harness.sent.length, 2)
  assert.match(harness.sent[1]?.message.content ?? '', /ctx_2/)
})
