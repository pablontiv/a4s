import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

const reply = process.env.A4S_PI_TRIAGE_TEST_REPLY;
const modulesDir = process.env.A4S_PI_TRIAGE_TEST_NODE_MODULES;
const piModules = new Set(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (piModules.has(specifier) && context.parentURL?.endsWith('/worker/pi.mjs')) {
      assert.notEqual(reply, undefined, 'test with no provider must not load Pi');
      if (modulesDir) return nextResolve(pathToFileURL(`${modulesDir}/${specifier}/dist/index.js`).href, context);
    }
    return nextResolve(specifier, context);
  },
});

Socket.prototype.connect = () => { throw new Error('Network forbidden in worker tests'); };
let called = false;
globalThis.fetch = async (url, options) => {
  assert.ok(!called, 'expected a single provider request');
  called = true;
  assert.equal(new URL(url).hostname, 'api.anthropic.com');
  assert.equal(new URL(url).pathname, '/v1/messages');
  assert.equal(new Headers(options.headers).get('x-api-key'), 'test-only-key');
  const request = JSON.parse(options.body);
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.tools?.length ?? 0, 0);
  assert.match(JSON.stringify(request.system), /synthetic A4S issue/);
  assert.match(JSON.stringify(request.messages), /Issue fixture-1/);

  // Deliberately noisy transport: the worker must keep stdout parseable.
  console.log('mock provider request');
  if (reply === 'http-error') {
    return Response.json({ type: 'error', error: { type: 'api_error', message: 'mock transport failure' } }, { status: 500 });
  }

  const events = [
    { type: 'message_start', message: { id: 'test', type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: process.env.A4S_PI_TRIAGE_TEST_STOP ?? 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
};
