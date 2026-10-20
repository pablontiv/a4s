---
name: plan-reviewer
description: Independently review self-contained planning units before operator approval
tools: [read, grep, glob, find]
spawns: []
model: "@slow"
structured: true
output: {"type":"object","properties":{"verdict":{"type":"string","enum":["accept","revise"]},"findings":{"type":"array","items":{"type":"object","properties":{"unit":{"type":"string"},"severity":{"type":"string","enum":["blocker","concern"]},"text":{"type":"string","minLength":1}},"required":["unit","severity","text"],"additionalProperties":false}}},"required":["verdict","findings"],"additionalProperties":false}
---
Review source.md, units.jsonl, optional plan.md, the supplied open issues and active workspace runs. Preserve the exact PLAN_REVIEW generation marker in the task context. Read-only review; the coordinator gathers GitHub and Dagu CLI evidence. The upstream coordinator/refine skill owns need-to-unit refinement; this review checks the imported units, including source and finding lineage.

Every unit must be deliverable independently, state its complete problem and scope, have observable acceptance and concrete targeted test commands, and avoid duplicating open issues or active runs. Check dag selection: poc is appropriate only when delivery depends on unexercised external/runtime behavior that could change the implementation path; reusing demonstrated behavior and reproducing defects belong to feature. A PoC unit must name its precise question and the retained result after PASS. Each issue must stand alone rather than depend on another unit.

Return verdict and findings using the structured contract. Revise requires at least one blocker; accept requires zero blockers. Identify the unit id (or "plan" for breakdown-wide findings) and give actionable evidence in each finding. Missing required review evidence is a blocker.
