# Local evaluation

All shipped fixtures are synthetic and contain no real session text, credentials, or private chunks. Local session captures, derived corpora, and result artifacts belong under `eval/local/` or `fixtures/evidence/local/`; both paths are ignored.

## Trigger

Keep local Trigger fixtures under `eval/local/trigger/`. Each fixture supplies only gate booleans, context-token counts, and a synthetic Jev `compact|wait` answer.

Report gate coverage, hint precision, auto precision, and false auto actions. The repository does not ship an upstream compact-adviser eval fixture because the audited `pi/` and `eval/` trees at the pinned commit were empty.

## Evidence

Run the deterministic offline Evidence eval from the repository root:

```sh
npm run eval:evidence --workspace @a4s/pi-context-expert
```

It executes the real conservative Evidence selection and RuleSignal gates with a fixture-only Jev client. The checked-in cases are:

- `fixtures/evidence/true-rule.json`
- `fixtures/evidence/non-rule.json`
- `fixtures/evidence/uncertain-candidate.json`

The JSON report includes precision, recall, source-boundary coverage, false-negative fixture IDs, and per-fixture outcomes. The uncertain candidate deliberately receives a low-confidence `hide`; the conservative profile must elevate it before extraction. This command makes no Pi, TypeSafe/Jev, or model-provider call.
