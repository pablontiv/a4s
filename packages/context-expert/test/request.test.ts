import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JevRequestError, parseJevResponse } from '../core/index.js';

test('request: el error HTTP conserva código y estado sin copiar el cuerpo', () => {
  const canary = 'REMOTE_BODY_PROMPT_URL_HEADERS_TOKEN';
  let caught: unknown;

  try {
    parseJevResponse(503, false, JSON.stringify({ canary }));
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof JevRequestError);
  assert.equal(caught.code, 'http_status');
  assert.equal(caught.status, 503);
  assert.equal(caught.message, 'Jev request failed');
  const exposed = `${caught.name} ${caught.message} ${JSON.stringify(caught)}`;
  assert.doesNotMatch(exposed, new RegExp(canary));
});

test('request: normaliza el estado HTTP al construir el error', () => {
  for (const status of [99, 600, Number.NaN]) {
    const error = new JevRequestError('http_status', status);
    assert.equal(error.status, undefined);
    assert.equal(error.message, 'Jev request failed');
  }

  const valid = new JevRequestError('http_status', 418);
  assert.equal(valid.status, 418);
  assert.equal(valid.message, 'Jev request failed');
});

test('request: las respuestas inválidas usan categorías seguras', () => {
  assert.throws(
    () => parseJevResponse(200, true, 'REMOTE_INVALID_JSON'),
    (error: unknown) =>
      error instanceof JevRequestError && error.code === 'invalid_json' && error.status === 200,
  );
  assert.throws(
    () => parseJevResponse(200, true, '{"remote":"REMOTE_INVALID_SHAPE"}'),
    (error: unknown) =>
      error instanceof JevRequestError && error.code === 'invalid_response' && error.status === 200,
  );
});
