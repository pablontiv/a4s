import type { JevAnswer, JevQuestion, JevRequest } from "../src/types.ts";

export function validJevResponse(
  request: JevRequest,
  override?: (id: string, question: JevQuestion) => JevAnswer | undefined,
): Record<string, unknown> {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = override?.(id, question) ?? validAnswer(question);
  }
  return {
    model: request.model,
    answers,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

export function validAnswer(question: JevQuestion): JevAnswer {
  if (question.type === "noul") return { type: "noul", noul: 0.9 };

  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const selected = options[0];
    if (!selected) throw new Error("choice fixture needs an option");
    return {
      type: "choice",
      choice: selected,
      probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])),
      confidence: 1,
    };
  }

  const top = question.criteria.length - 1;
  return {
    type: "score",
    score: top,
    legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: Object.fromEntries(question.criteria.map((_criterion, index) => [String(index), index === top ? 1 : 0])),
    confidence: 1,
  };
}

export function choiceAnswer(options: readonly string[], selected: string, confidence = 1): JevAnswer {
  if (!options.includes(selected)) throw new Error("selected choice is absent");
  return {
    type: "choice",
    choice: selected,
    probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])),
    confidence,
  };
}

export function scoreAnswer(criteria: readonly string[], selectedLevel: number, confidence = 1): JevAnswer {
  if (!Number.isInteger(selectedLevel) || selectedLevel < 0 || selectedLevel >= criteria.length) {
    throw new Error("invalid score fixture level");
  }
  return {
    type: "score",
    score: selectedLevel,
    legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: Object.fromEntries(
      criteria.map((_criterion, index) => [String(index), index === selectedLevel ? 1 : 0]),
    ),
    confidence,
  };
}
