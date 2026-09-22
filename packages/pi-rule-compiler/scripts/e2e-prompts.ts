/**
 * Pi 0.87's production compaction estimator counts text as ceil(chars / 4).
 * Four 30k-plus-character prompts leave more than 22.5k estimated tokens in
 * the newest three prompts, while retaining an older prompt for compaction to summarize.
 */
const PROMPT_COUNT = 4;
const CHARS_PER_PROMPT = 30_001;
export const PRODUCTION_KEEP_RECENT_TOKENS = 20_000;
export const CONSERVATIVE_PROMPT_CONTENT_TOKEN_FLOOR = 30_000;

export function estimatePiContentTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function createCompactionE2ePrompts(runId: string): readonly string[] {
  return Array.from({ length: PROMPT_COUNT }, (_, index) => {
    const prefix = `benign synthetic compaction input ${index + 1}/${PROMPT_COUNT} for E2E run ${runId}. Reply only with acknowledged. `;
    const padding = "calm observation ";
    return `${prefix}${padding.repeat(Math.ceil((CHARS_PER_PROMPT - prefix.length) / padding.length)).slice(0, CHARS_PER_PROMPT - prefix.length)}`;
  });
}
