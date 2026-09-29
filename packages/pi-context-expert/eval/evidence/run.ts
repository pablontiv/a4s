import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractRuleSignals,
  selectEvidenceContext,
  stableDigest,
  stageCorpus,
  type JevAnswer,
  type JevClient,
  type JevQuestion,
  type JevRequest,
} from "../../src/index.ts";

interface EvidenceFixture {
  id: string;
  text: string;
  expectedRule: boolean;
  expectedBoundary: { start: number; end: number } | null;
  visibility: { choice: "hide" | "short" | "long" | "full"; confidence: number };
  candidateProbability: number;
  generalityLevel: number;
  authority: "explicit_user" | "repository_policy" | "team_convention" | "agent_inference" | "incidental";
}

interface FixtureResult {
  id: string;
  expectedRule: boolean;
  predictedRule: boolean;
  boundaryCovered: boolean | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(here, "..", "..", "fixtures", "evidence");
const names = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".json")).sort();
const results: FixtureResult[] = [];

for (const name of names) {
  const fixture = JSON.parse(await readFile(join(fixtureDirectory, name), "utf8")) as EvidenceFixture;
  const chunks = stageCorpus([{
    index: 0,
    role: "user",
    text: fixture.text,
    sourceDigest: stableDigest({ fixture: fixture.id }),
    redactionCount: 0,
  }], {
    branchId: stableDigest({ branch: "evidence-eval" }),
    compactionAttemptId: stableDigest({ fixture: fixture.id, attempt: "evidence-eval" }),
  });
  const chunk = chunks[0];
  if (!chunk) throw new Error(`fixture ${fixture.id} produced no corpus chunk`);
  if (fixture.expectedBoundary && fixture.expectedBoundary.end > chunk.text.length) {
    throw new Error(`fixture ${fixture.id} boundary exceeds sanitized text`);
  }

  const jev = fixtureJev(fixture);
  const projection = await selectEvidenceContext(chunks, jev);
  const extracted = await extractRuleSignals({
    projection,
    corpus: chunks,
    jev,
    compactionAttemptId: chunk.provenance.compactionAttemptId,
    observedAt: "2026-09-22T00:00:00.000Z",
    reason: "manual",
    willRetry: false,
  });
  const boundaryCovered = fixture.expectedBoundary === null
    ? null
    : extracted.sources.some((source) =>
      source.chunkId === chunk.id &&
      source.start <= fixture.expectedBoundary!.start &&
      source.end >= fixture.expectedBoundary!.end,
    );
  results.push({
    id: fixture.id,
    expectedRule: fixture.expectedRule,
    predictedRule: extracted.signals.length > 0,
    boundaryCovered,
  });
}

const truePositives = results.filter((item) => item.expectedRule && item.predictedRule).length;
const predictedPositives = results.filter((item) => item.predictedRule).length;
const expectedPositives = results.filter((item) => item.expectedRule).length;
const boundaries = results.filter((item) => item.boundaryCovered !== null);
const falseNegatives = results.filter((item) => item.expectedRule && !item.predictedRule).map((item) => item.id);
const report = {
  fixtures: results.length,
  precision: ratio(truePositives, predictedPositives),
  recall: ratio(truePositives, expectedPositives),
  boundaryCoverage: ratio(boundaries.filter((item) => item.boundaryCovered).length, boundaries.length),
  falseNegatives,
  results,
};
console.log(JSON.stringify(report, null, 2));

function fixtureJev(fixture: EvidenceFixture): JevClient {
  return {
    async evaluate(request: JevRequest): Promise<unknown> {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        answers[id] = fixtureAnswer(fixture, id, question);
      }
      return {
        model: request.model,
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

function fixtureAnswer(fixture: EvidenceFixture, id: string, question: JevQuestion): JevAnswer {
  if (id.startsWith("ladder_visibility_") && question.type === "choice") {
    return choice(question, fixture.visibility.choice, fixture.visibility.confidence);
  }
  if (id.startsWith("rule_candidate_") && question.type === "noul") {
    return { type: "noul", noul: fixture.candidateProbability };
  }
  if (id.startsWith("rule_generality_") && question.type === "score") {
    return score(question, fixture.generalityLevel);
  }
  if (id.startsWith("rule_authority_") && question.type === "choice") {
    return choice(question, fixture.authority, 1);
  }
  if (question.type === "noul") return { type: "noul", noul: 0 };
  if (question.type === "score") return score(question, question.criteria.length - 1);
  return choice(question, Object.keys(question.criteria)[0]!, 1);
}

function choice(question: Extract<JevQuestion, { type: "choice" }>, selected: string, confidence: number): JevAnswer {
  const options = Object.keys(question.criteria);
  const remainder = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  return {
    type: "choice",
    choice: selected,
    probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? confidence : remainder])),
    confidence,
  };
}

function score(question: Extract<JevQuestion, { type: "score" }>, selected: number): JevAnswer {
  return {
    type: "score",
    score: selected,
    legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: Object.fromEntries(question.criteria.map((_criterion, index) => [String(index), index === selected ? 1 : 0])),
    confidence: 1,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}
