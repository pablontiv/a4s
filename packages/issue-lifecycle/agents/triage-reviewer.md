---
name: triage-reviewer
description: Review the supplied triage runtime uncertainty
tools: []
spawns: []
model: "@slow"
structured: true
output: {"type":"object","properties":{"poc":{"type":"string","enum":["yes","no"]},"behavior":{"type":"string","minLength":1,"pattern":"\\S"},"question":{"type":"string","minLength":1,"pattern":"\\S"},"reason":{"type":"string","minLength":1,"pattern":"\\S"},"requiredTargets":{"type":"array","items":{"type":"string","minLength":1}},"authorizedTargets":{"type":"array","items":{"type":"string","minLength":1}},"scopeBasis":{"type":"string","minLength":1,"pattern":"\\S"}},"required":["poc","behavior","question","reason"],"additionalProperties":false}
---
Review only the supplied triage scope. A PoC is required when implementation depends on an unexercised external or runtime behavior that could change the implementation path. Reusing behavior already demonstrated proceeds directly. Reproducing a bug is not a PoC. Return poc, behavior, question, and reason using the structured output contract, with nonempty behavior, question, and reason. For poc=yes, state the concrete runtime question that needs a real-target experiment and supply requiredTargets, authorizedTargets and scopeBasis. Use the same concrete identifiers in both target arrays so the admission check can compare them. Quote actual operator execution-route authorization in scopeBasis; an unknown authorization uses an empty authorizedTargets array. For poc=no, name the resolved question and the evidence establishing the behavior.
