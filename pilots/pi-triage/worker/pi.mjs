import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const PROVIDER = 'anthropic';
const MODEL = 'claude-haiku-4-5-20251001';
const SYSTEM_PROMPT = [
  'You triage one synthetic A4S issue for a small proof of concept (PoC).',
  'This pilot covers the case where a PoC is warranted.',
  'Return only one JSON object with exactly poc, question and reason.',
  'poc must be "yes". question is one concrete verification question and',
  'reason briefly explains why the PoC can answer it. Write both in Spanish.',
].join(' ');

function parseDecision(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Pi returned invalid triage JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
      || value.poc !== 'yes' || typeof value.question !== 'string' || !value.question.trim()
      || typeof value.reason !== 'string' || !value.reason.trim()) {
    throw new Error('Pi triage must contain only poc="yes", question and reason (nonempty strings)');
  }
  return { poc: value.poc, question: value.question.trim(), reason: value.reason.trim() };
}

export async function triageWithPi(issue, key) {
  const cwd = import.meta.dirname;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({ type: 'api_key', key }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel(PROVIDER, MODEL);
  if (!model) throw new Error(`Pi SDK is missing the configured model ${PROVIDER}/${MODEL}`);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime,
    model,
    tools: [],
    thinkingLevel: 'off',
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      cacheWarming: 'off',
      retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30000 } },
    }),
    // Explicitly empty resources; do not discover operator/project files.
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => SYSTEM_PROMPT,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    },
  });

  try {
    if (modelFallbackMessage || session.model?.provider !== PROVIDER || session.model?.id !== MODEL
        || session.getActiveToolNames().length !== 0) {
      throw new Error('Pi did not honor the explicit model and tool selection');
    }
    await session.prompt(`Issue ${issue}: Verify that Dagu can consume the Pi triage worker's single-line JSON result while keeping diagnostics separate. Propose a concrete PoC verification.`).catch(() => {
      // Provider exceptions can contain credentials or raw model output.
      throw new Error(`Pi prompt failed for ${PROVIDER}/${MODEL}`);
    });
    const last = session.messages.at(-1);
    if (last?.role !== 'assistant' || last.stopReason !== 'stop') {
      throw new Error(`Pi did not finish triage successfully for ${PROVIDER}/${MODEL}`);
    }
    return parseDecision(session.getLastAssistantText());
  } finally {
    session.dispose();
  }
}
