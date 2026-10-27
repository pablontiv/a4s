# @a4s/context-management

Private, host-neutral TypeScript library for Jev-scored transcript compaction and
adaptive trigger decisions. The package's public entrypoint is `core/index.ts`;
consumers use a TypeScript-aware runtime such as `tsx` and the Node.js requirement
in the repository root `package.json` `engines.node`, including standalone installs.
Distribution stays local to this repository and its private consumers.

## Public API

- `compact(messages, asker, options)` scores tool calls and results, fits the
  scoring state to its token budget, and rebuilds the transcript. Scores select
  a verbatim **keep**, a **truncated result** with the call retained, or **drop**
  of both call and result. The first message and the configured recent messages
  are pinned. Untouched messages preserve object identity.
- `reductionRatio(result)` reports the fraction of transcript characters removed.
- `Message`, tool-call/result types, state fitting and decision helpers let
  consumers represent and inspect neutral transcripts.
- `JevAsker` accepts an explicit scoring implementation. `JevClient`,
  `compactMessages`, request builders/parsers and `JevRequestError` provide an
  optional HTTP client. `JevClient` uses an explicit `apiKey` or
  `TYPESAFE_API_KEY`; endpoint, model and fetch implementation are configurable.
- `HostBinding` and `runCompaction` map a consumer's transcript into neutral
  messages and assemble the result into its own output type.
- Trigger state, bounded recent conversation, judgment parsing, scoring and
  adaptive policy evaluation are reusable decision APIs. Consumers own when to
  invoke them and how to act on the resulting decision.

The library has zero runtime dependencies. Core transformation with an explicit
`JevAsker` runs offline; the HTTP client is opt-in.

## Consumer example

Install from the checkout in a private consumer:

```sh
npm install /absolute/path/to/a4s/packages/context-management
npm install --save-dev tsx typescript @types/node
```

```ts
import {
  compact, reductionRatio, type JevAsker, type Message,
} from '@a4s/context-management';

const messages: Message[] = [
  { role: 'user', text: 'Keep the original task.', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'read', tool: 'Read', input: { path: 'large.txt' } },
  ] },
  { role: 'user', text: '', toolUses: [], toolResults: [
    { tool_use_id: 'read', text: 'large tool output '.repeat(200) },
  ] },
];
const asker: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map(key => [
      key, { noul: key.startsWith('call_') ? 0.9 : 0.1 },
    ])) };
  },
};
const result = await compact(messages, asker, {
  preserveRecentMessages: 0,
  truncateHeadChars: 40,
});
console.log(result.decisions, reductionRatio(result));
```

This deterministic example exercises the real transformation while keeping the
scoring policy explicit. Application consumers can supply their own `JevAsker`
or configure `JevClient` for HTTP scoring. Transformation/request errors propagate
to the consumer, which owns recovery policy.

## Development

From the repository root:

```sh
npm test --workspace @a4s/context-management && npm run typecheck --workspace @a4s/context-management
```

The scripts run `tsx --test test/*.test.ts` and
`tsc --noEmit -p tsconfig.json`. The retained behavioral core, request and trigger
suites import `@a4s/context-management`, so the same public entrypoint is executed
and typechecked by consumers.

### Observed consumer smoke (2026-10-20)

A throwaway, external ESM consumer at
`/tmp/a4s-context-consumer-426-shlS16` installed this library through a `file:`
dependency and only `tsx`, TypeScript and Node types as development tools:

```sh
npm install --ignore-scripts --offline --no-audit --no-fund
./node_modules/.bin/tsc --noEmit --strict --target es2023 --module nodenext --moduleResolution nodenext --types node --skipLibCheck consumer.ts && ./node_modules/.bin/tsx consumer.ts
```

The command exited 0. It imported `compact`, `reductionRatio`, `runCompaction`
and their types from the public package entrypoint. An explicit deterministic
`JevAsker` scored three real tool-call/result pairs at 0.9/0.1. Observed output:

```json
{"actions":["keep","drop_result","drop_call"],"firstMessagePreserved":true,"keptPairPreserved":true,"charsBefore":13930,"charsAfter":4842,"reductionRatio":0.6524048815506102,"truncatedResultChars":130,"messagesBefore":8,"messagesAfter":6,"allKeepReductionRatio":0,"allKeepIdentity":true,"bindingOutput":8,"scoringRequests":1}
```

The consumer asserted truncated head retention and size reduction, verbatim
first-message and kept-pair identity, removal of the dropped pair, all-keep
no-op identity, and neutral binding execution. The targeted package command
above also exited 0: 15 tests passed and core/consumer typechecking passed.
This smoke installed only the host-neutral library and its TypeScript tooling;
scoring used the explicit deterministic asker rather than an external model.

## Attribution

The retained transformation/request/state implementation derives from
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction).
Trigger timing and bounded conversation derive from
[`compact-adviser`](https://github.com/kunchenguid/compact-adviser.git). A4S adds
adaptive policy bands and a deterministic ceiling. The exact upstream source
revisions, both MIT licenses and derived paths are preserved in [`NOTICE`](./NOTICE).
