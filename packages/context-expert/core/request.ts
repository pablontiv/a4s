// Part of @a4s/context-expert core (host-neutral Jev compaction).
// Derived from fast-jev-compaction (MIT, Copyright (c) 2025):
//   https://github.com/tamaratran/fast-jev-compaction  — see ../NOTICE
// A4S restructures src/ into a reusable core consumed by both the Claude mod
// and the Pi extension adapters through the HostBinding contract (binding.ts).

import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export type JevRequestErrorCode = 'http_status' | 'invalid_json' | 'invalid_response' | 'request_too_large';

/** Expone solo datos seguros sobre un fallo de respuesta HTTP. */
export class JevRequestError extends Error {
  readonly code: JevRequestErrorCode;
  readonly status: number | undefined;

  constructor(code: JevRequestErrorCode, status?: number) {
    super('Jev request failed');
    this.name = 'JevRequestError';
    this.code = code;
    this.status =
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
  }
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxBodyBytes?: number;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const body = JSON.stringify({
    model: params.model ?? DEFAULT_MODEL,
    state,
    questions,
  });
  if (
    params.maxBodyBytes !== undefined &&
    new TextEncoder().encode(body).byteLength > params.maxBodyBytes
  ) {
    throw new JevRequestError('request_too_large');
  }
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body,
  };
}

/** Valida la respuesta sin copiar contenido remoto en el error. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) throw new JevRequestError('http_status', status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevRequestError('invalid_json', status);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new JevRequestError('invalid_response', status);
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
