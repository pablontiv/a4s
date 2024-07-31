import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrcaModelRouter } from '../src/index.ts'

interface HookResult {
  block?: boolean
  reason?: string
  systemPrompt?: string | string[]
}

type ModelValue = { provider: string; id: string }

interface RouterContext {
  cwd: string
  models: {
    resolve(spec: string): ModelValue | undefined
  }
}

type Handler = (
  event: Record<string, unknown>,
  context: RouterContext,
) => Promise<HookResult | void> | HookResult | void

interface RouterHarness {
  context: RouterContext
  handlers: Map<string, Handler>
  setRunId(next: string | null): void
  setFailure(next: Error | undefined): void
  setModel(spec: string, next: string | undefined): void
}


function createHarness(): RouterHarness {
  const handlers = new Map<string, Handler>()
  let runId: string | null = 'run_1'
  let failure: Error | undefined
  const models = new Map<string, string>([
    ['@task', 'openai-codex/gpt-6.1-sol'],
    ['@plan', 'anthropic/claude-fable-5-1'],
    ['@slow', 'anthropic/claude-opus-5'],
    ['@smol', 'anthropic/claude-haiku-5-5'],
  ])
  const context: RouterContext = {
    cwd: '/workspace',
    models: {
      resolve(spec) {
        const selected = models.get(spec) ?? (spec.includes('/') ? spec : undefined)
        if (!selected) return undefined
        const separator = selected.indexOf('/')
        return {
          provider: selected.slice(0, separator),
          id: selected.slice(separator + 1),
        }
      },
    },
  }
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler)
      return () => {}
    },
    async exec() {
      if (failure) throw failure
      const payload = { ok: true, result: { run: runId ? { id: runId } : null } }
      return { stdout: JSON.stringify(payload), stderr: '', code: 0, killed: false }
    },
  }

  createOrcaModelRouter({ isOrcaPane: () => true })(api as never)
  return {
    context,
    handlers,
    setRunId(next: string | null) {
      runId = next
    },
    setFailure(next: Error | undefined) {
      failure = next
    },
    setModel(spec: string, next: string | undefined) {
      if (next) models.set(spec, next)
      else models.delete(spec)
    },
  }
}

async function invoke(
  harness: RouterHarness,
  eventName: string,
  event: Record<string, unknown>,
): Promise<HookResult | undefined> {
  const handler = harness.handlers.get(eventName)
  assert.ok(handler, `${eventName} handler was not registered`)
  return (await handler(event, harness.context)) ?? undefined
}

test('does not register routing hooks outside an Orca pane', () => {
  const events: string[] = []
  createOrcaModelRouter({ isOrcaPane: () => false })({
    on(name: string) {
      events.push(name)
    },
  } as never)
  assert.deepEqual(events, [])
})

test('injects live concrete models resolved from OMP roles only for a bound coordinator', async () => {
  const harness = createHarness()
  const result = await invoke(harness, 'before_agent_start', {
    type: 'before_agent_start',
    prompt: 'continue',
    systemPrompt: ['base'],
  })

  assert.ok(Array.isArray(result?.systemPrompt))
  const directive = result.systemPrompt.at(-1)
  assert.match(directive ?? '', /implementation \(@task\): --agent omp --model openai-codex\/gpt-6\.1-sol/)
  assert.match(directive ?? '', /runtime retries use retry\.fallbackChains\.default/)

  harness.setModel('@task', 'openai-codex/gpt-next')
  const updated = await invoke(harness, 'before_agent_start', {
    type: 'before_agent_start',
    prompt: 'continue',
    systemPrompt: ['base'],
  })
  assert.ok(Array.isArray(updated?.systemPrompt))
  assert.match(updated.systemPrompt.at(-1) ?? '', /implementation \(@task\): --agent omp --model openai-codex\/gpt-next/)

  harness.setRunId(null)
  const inactive = await invoke(harness, 'before_agent_start', {
    type: 'before_agent_start',
    prompt: 'continue',
    systemPrompt: ['base'],
  })
  assert.equal(inactive, undefined)
})

test('blocks fresh workers that would inherit an agent default', async () => {
  const harness = createHarness()
  const missingModel = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_missing_model',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_1 --agent omp --json' },
  })
  assert.equal(missingModel?.block, true)
  assert.match(missingModel?.reason ?? '', /--model/)

  const missingAgent = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_missing_agent',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_1 --model openai-codex/gpt-6.1-sol' },
  })
  assert.equal(missingAgent?.block, true)
  assert.match(missingAgent?.reason ?? '', /--agent/)

  const embeddedFlags = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_embedded_flags',
    toolName: 'bash',
    input: {
      command: 'orca orchestration worker-start --spec "use --agent omp --model openai-codex/gpt-6.1-sol" --task task_1',
    },
  })
  assert.equal(embeddedFlags?.block, true)
})

test('allows a concrete OMP route, blocks an alias, and permits terminal reuse', async () => {
  const harness = createHarness()
  const alias = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_alias',
    toolName: 'bash',
    input: {
      command: 'orca orchestration worker-start --spec "Fix parser; add tests" --agent omp --model @slow --json',
    },
  })
  assert.equal(alias?.block, true)
  assert.match(alias?.reason ?? '', /@slow currently resolves to anthropic\/claude-opus-5/)

  const explicitModel = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_explicit_model',
    toolName: 'bash',
    input: {
      command: 'orca orchestration worker-start --spec "Fix parser; add tests" --agent omp --model anthropic/claude-opus-5 --json',
    },
  })
  assert.equal(explicitModel, undefined)

  const reuse = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_reuse',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_2 --terminal term_1 --json' },
  })
  assert.equal(reuse, undefined)
})

test('permits worker-start help and command text that is not executed', async () => {
  const harness = createHarness()
  const help = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_help',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --help' },
  })
  assert.equal(help, undefined)

  const echoed = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_echo',
    toolName: 'bash',
    input: { command: 'echo \"orca orchestration worker-start --agent omp\"' },
  })
  assert.equal(echoed, undefined)
})

test('fails closed for fresh starts when coordinator state cannot be verified', async () => {
  const harness = createHarness()
  harness.setFailure(new Error('orca unavailable'))
  const result = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_failed',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_1 --agent omp' },
  })
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /orca unavailable/)
})

test('fails closed when an OMP role cannot be resolved', async () => {
  const harness = createHarness()
  harness.setModel('@task', undefined)

  const prompt = await invoke(harness, 'before_agent_start', {
    type: 'before_agent_start',
    prompt: 'continue',
    systemPrompt: ['base'],
  })
  assert.ok(Array.isArray(prompt?.systemPrompt))
  assert.match(prompt.systemPrompt.at(-1) ?? '', /@task did not resolve/)

  const start = await invoke(harness, 'tool_call', {
    type: 'tool_call',
    toolCallId: 'call_unresolved',
    toolName: 'bash',
    input: { command: 'orca orchestration worker-start --task task_1 --agent omp --model @task' },
  })
  assert.equal(start?.block, true)
  assert.match(start?.reason ?? '', /could not resolve the OMP model policy/)
})
