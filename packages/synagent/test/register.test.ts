// Cobertura del GLUE de runtime del adaptador Claude (register.ts), el punto más
// frágil: el nombre exacto del tool MCP, que los args se leen ESPARCIDOS en `e`
// (no en e.input), el topic v1 publicado, y que prompt.compose usa la clave
// `text`. Un error aquí dejaría synagent_send como no-op silencioso con el resto
// de la suite en verde. register.ts importa `claude-code` solo como tipo (se
// borra en runtime), así que se puede cargar bajo tsx con un `$` falso.
// (Excluido del tsc del paquete en tsconfig: su único import de valor es ./adapter.)
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { register } from '../adapters/claude/hooks/register.ts'

type Hook = (...a: unknown[]) => unknown
type Entry = { event: string; matcher: unknown; hook: Hook }

function collectHooks(options: Record<string, unknown> = {}) {
  const entries: Entry[] = []
  const on = (event: string, a: unknown, b?: unknown): void => {
    const hook = (b ?? a) as Hook
    const matcher = b ? a : undefined
    entries.push({ event, matcher, hook })
  }
  ;(register as unknown as (on: unknown, options: unknown) => void)(on, options)
  const get = (event: string): Hook => {
    const found = entries.find(e => e.event === event)
    assert.ok(found, `hook no registrado: ${event}`)
    return found.hook
  }
  return { entries, get }
}

function makeEngine() {
  const runCalls: string[][] = []
  const toolRegistered: Array<Record<string, unknown>> = []
  const commandRegistered: string[] = []
  const statuses: string[] = []
  const $ = {
    plugin: { root: '/fake/plugin' },
    // Sin `env`: si register.ts leyera una variable de entorno, fallaría aquí
    // (identidad debe venir solo de $.session.*, ADR 0069).
    session: {
      id: async () => 'sess-test-1',
      repo: async () => ({ remote: 'https://github.com/pablontiv/a4s.git', root: '/fake', internal: true, name: 'pablontiv/a4s' }),
      cwd: async () => '/fake/cwd',
    },
    clock: { now: async () => 1000 },
    store: (() => {
      const m = new Map<string, unknown>()
      return { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => void m.set(k, v) }
    })(),
    process: {
      run: async (argv: readonly string[]) => {
        runCalls.push([...argv])
        if (argv[0] === 'git') return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: '{"published":true}', stderr: '' }
      },
      // bridge-sub: iterable asíncrono que termina de inmediato (sin mensajes).
      spawn: () => (async function* () {})(),
    },
    tool: { register: async (def: Record<string, unknown>) => void toolRegistered.push(def) },
    command: { register: async (def: { name: string }) => void commandRegistered.push(def.name) },
    prompt: { submit: async () => {} },
    ui: { status: (s: string) => void statuses.push(s) },
  }
  return { $, runCalls, toolRegistered, commandRegistered, statuses }
}

test('register: session.start resuelve identidad y registra synagent_send + /mq-send', async () => {
  const eng = makeEngine()
  const { get } = collectHooks({ project: 'a4s', instance: 'claude-1' })
  const next = async (e: unknown) => e
  await get('session.start')(eng.$, {}, next)

  assert.ok(eng.toolRegistered.some(d => d.name === 'synagent_send'), 'synagent_send debe registrarse')
  assert.ok(eng.commandRegistered.includes('mq-send'), '/mq-send debe registrarse')
})

test('register: tool.call enruta por el nombre MCP exacto, lee args de e y publica v1', async () => {
  const eng = makeEngine()
  const { get } = collectHooks({ project: 'a4s', instance: 'claude-1' })
  const next = async (e: unknown) => e
  await get('session.start')(eng.$, {}, next)

  const toolHook = get('tool.call')
  // Args ESPARCIDOS en e (no en e.input): así los entrega el engine.
  const e = { tool: 'mcp__synagent-adapter-mqtt__synagent_send', to: 'a4s/pi-1', body: 'hola pi', kind: 'prompt' }
  const res = (await toolHook(eng.$, e, next)) as { result: string }
  assert.match(res.result, /^enviado /, 'debe confirmar el envío')

  const pub = eng.runCalls.find(c => c.some(a => a.includes('bridge-pub.cjs')))
  assert.ok(pub, 'debe invocar bridge-pub')
  assert.equal(pub.includes('synagent/v1/a4s/pi-1'), true, 'topic v1 == synagent/v1/<to>')
  const payload = pub.find(a => a.startsWith('{') && a.includes('"to":"a4s/pi-1"'))
  assert.ok(payload, 'payload canónico con to v1')
})

test('register: tool.call ajeno pasa de largo con next', async () => {
  const eng = makeEngine()
  const { get } = collectHooks({ project: 'a4s', instance: 'claude-1' })
  const next = async (e: unknown) => ({ passed: true, e })
  await get('session.start')(eng.$, {}, (x: unknown) => x)

  const res = await get('tool.call')(eng.$, { tool: 'Bash', command: 'ls' }, next)
  assert.deepEqual(res, { passed: true, e: { tool: 'Bash', command: 'ls' } })
})

test('register: prompt.compose añade una sección con la clave `text`', async () => {
  const eng = makeEngine()
  const { get } = collectHooks({ project: 'a4s', instance: 'claude-1' })
  await get('session.start')(eng.$, {}, (x: unknown) => x)

  const next = async () => ({ sections: [{ id: 'otra', scope: 'session', text: 'x' }] })
  const r = (await get('prompt.compose')(eng.$, {}, next)) as {
    sections: Array<{ id: string; scope: string; text: string }>
  }
  const section = r.sections.find(s => s.id === 'synagent')
  assert.ok(section, 'debe añadir la sección synagent')
  assert.equal(typeof section.text, 'string', 'la sección usa la clave `text`')
  assert.match(section.text, /synagent_send/)
})

test('register: brokerUrl no-loopback se rechaza y cae al default', async () => {
  const eng = makeEngine()
  const { get } = collectHooks({ project: 'a4s', instance: 'claude-1', brokerUrl: 'mqtt://evil.example.com:1884' })
  await get('session.start')(eng.$, {}, (x: unknown) => x)
  assert.ok(eng.statuses.some(s => /no loopback/.test(s)), 'debe avisar del rechazo')
})

// Bridge controlable: queda VIVO (parkea en next()) hasta que register llama a
// return(); así `started` no se resetea solo y podemos ejercitar el reinicio por
// cambio de session id (/clear). Registra en `returned` cuando lo detienen.
function controllableBridge(onReturn: () => void): AsyncIterable<unknown> & { return: (v?: unknown) => Promise<IteratorResult<unknown>> } {
  let resolveNext: ((r: IteratorResult<unknown>) => void) | null = null
  let done = false
  const iterator = {
    next(): Promise<IteratorResult<unknown>> {
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise(res => { resolveNext = res })
    },
    return(value?: unknown): Promise<IteratorResult<unknown>> {
      if (!done) {
        done = true
        onReturn()
        if (resolveNext) { resolveNext({ value: undefined, done: true }); resolveNext = null }
      }
      return Promise.resolve({ value, done: true })
    },
    [Symbol.asyncIterator]() { return this },
  }
  return iterator
}

test('register: /clear (session id nuevo sin session.start) re-resuelve identidad y re-suscribe', async () => {
  const sid = { id: 'sess-A' }
  const spawnArgs: string[][] = []
  const returned: number[] = []
  const bridges: Array<{ return: (v?: unknown) => Promise<IteratorResult<unknown>> }> = []
  const $ = {
    plugin: { root: '/fake/plugin' },
    session: {
      id: async () => sid.id,
      repo: async () => ({ remote: 'https://github.com/pablontiv/a4s.git', root: '/fake', internal: true, name: 'pablontiv/a4s' }),
      cwd: async () => '/fake/cwd',
    },
    clock: { now: async () => 1000 },
    store: (() => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => void m.set(k, v) } })(),
    process: {
      run: async (argv: readonly string[]) => (argv[0] === 'git' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: '{}', stderr: '' }),
      spawn: (req: { argv: readonly string[] }) => {
        const idx = spawnArgs.length
        spawnArgs.push([...req.argv])
        const b = controllableBridge(() => returned.push(idx))
        bridges.push(b)
        return b
      },
    },
    tool: { register: async () => {} },
    command: { register: async () => {} },
    prompt: { submit: async () => {} },
    ui: { status: () => {} },
  }
  const { get } = collectHooks({ project: 'a4s' })
  const next = async (e: unknown) => e

  // Arranque normal para sess-A: el bridge queda vivo (no termina solo).
  await get('session.start')($, {}, next)
  await new Promise(r => setTimeout(r, 0)) // deja correr la IIFE del bridge
  assert.ok(spawnArgs[0]?.includes('synagent/v1/a4s/sess-A'), 'bridge inicial suscribe al buzón de sess-A')

  // Simula /clear: el session id cambia y NO se dispara session.start; el
  // siguiente prompt.submit debe detectar el cambio, re-resolver y re-suscribir.
  sid.id = 'sess-B'
  await get('prompt.submit')($, {}, next)
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(returned, [0], 'el bridge de sess-A se detuvo (return())')
  assert.ok(spawnArgs[1]?.includes('synagent/v1/a4s/sess-B'), 're-suscribe al buzón de sess-B')
  assert.ok(!spawnArgs[1]?.includes('synagent/v1/a4s/sess-A'), 'ya no usa el buzón viejo')

  // La identidad publicada y la sección de prompt reflejan sess-B.
  const compose = get('prompt.compose')
  const r = (await compose($, {}, async () => ({ sections: [] }))) as { sections: Array<{ id: string; text: string }> }
  assert.match(r.sections.find(s => s.id === 'synagent')!.text, /a4s\/sess-B/, 'la sección muestra la dirección nueva')

  // Limpieza: detener el bridge vivo para no filtrar estado ni handles.
  await bridges[bridges.length - 1]?.return()
})
