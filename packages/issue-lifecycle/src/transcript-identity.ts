/** Transcript rows shared by native role evidence and planning review. */
export interface TranscriptRow {
  type?: string;
  id?: string;
  timestamp?: string;
  model?: string;
  resolvedModelIsFallback?: boolean;
  agent?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    content?: unknown;
    errorMessage?: string;
  };
}

export interface ModelChangeEntry {
  event: string | undefined;
  timestamp: string | undefined;
  model: string | undefined;
  resolvedModelIsFallback: boolean;
}

/** Effective session, final assistant and ordered model changes from one transcript. */
export interface EffectiveTranscriptIdentity {
  session: string;
  event: string;
  provider: string;
  model: string;
  attempts: Array<{
    event: string | undefined;
    timestamp: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    stopReason: string | undefined;
    error: string | undefined;
  }>;
  fallbacks: ModelChangeEntry[];
}

/** Reviewer identity stored beside an accepted or revised planning verdict. */
export interface PlanningReviewer {
  agent: string;
  session: string;
  provider: string;
  model: string;
  fallbacks: ModelChangeEntry[];
}

/**
 * Provider and model come from the final assistant message. `session_init.resolvedModel`
 * is not consulted: a fallback refresh can leave that field on the original declaration.
 */
export function effectiveTranscriptIdentity(rows: readonly TranscriptRow[]): EffectiveTranscriptIdentity {
  const sessions = rows.filter(row => row.type === "session");
  const assistants = rows.filter(row => row.type === "message" && row.message?.role === "assistant");
  const final = assistants.filter(row => row.message?.stopReason === "stop" || row.message?.stopReason === "toolUse").at(-1);
  if (sessions.length !== 1 || !sessions[0]?.id || !final?.id || !final.message?.provider || !final.message.model) {
    throw new Error("Missing native session/effective assistant identity");
  }
  return {
    session: sessions[0].id,
    event: final.id,
    provider: final.message.provider,
    model: final.message.model,
    attempts: assistants.map(row => ({
      event: row.id,
      timestamp: row.timestamp,
      provider: row.message?.provider,
      model: row.message?.model,
      stopReason: row.message?.stopReason,
      error: row.message?.errorMessage,
    })),
    fallbacks: rows.filter(row => row.type === "model_change").map(row => ({
      event: row.id,
      timestamp: row.timestamp,
      model: row.model,
      resolvedModelIsFallback: row.resolvedModelIsFallback === true,
    })),
  };
}

/** Planning `reviewer` object: agent plus the shared effective identity. */
export function planningReviewer(rows: readonly TranscriptRow[]): PlanningReviewer {
  const identity = effectiveTranscriptIdentity(rows);
  const agent = rows.find(row => row.type === "session_init")?.agent;
  if (!agent) throw new Error("Missing native session/effective assistant identity");
  return {
    agent,
    session: identity.session,
    provider: identity.provider,
    model: identity.model,
    fallbacks: identity.fallbacks,
  };
}
