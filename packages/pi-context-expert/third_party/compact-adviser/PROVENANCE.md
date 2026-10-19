# Trigger and Pi integration provenance

## compact-adviser

- Upstream URL: https://github.com/kunchenguid/compact-adviser.git
- Audited commit: `ef216af7cb639947bb4642fdf063117f12a91fc6`
- Upstream tag: `compact-adviser-v0.1.12`
- License: MIT
- License copy: `packages/pi-context-expert/third_party/compact-adviser/LICENSE`

The repository derives Trigger code from this upstream version.

Derived code:

- `packages/context-expert/core/trigger.ts`

The derived code includes the Trigger timing, the bounded recent conversation,
the exact `done` and `shape` questions, response validation, scoring, and the
interpolated floor.

Synchronized Claude copy:

- `packages/context-expert/adapters/claude/core/trigger.ts`

The Claude copy is generated from the canonical core. The `check-core` command
verifies byte equality. The Claude hook in
`packages/context-expert/adapters/claude/hooks/register.ts` integrates the
shared Trigger core with the Claude lifecycle. It is host integration code. It
is not a second copy of the upstream Trigger implementation.

The Pi files consume the shared core. They do not contain another copy of the
compact-adviser Trigger implementation.

## fast-jev-compaction-pi

- Upstream URL: https://github.com/zaycruz/fast-jev-compaction-pi
- Audited commit: `1499833c088753798c5e406856a170b9f5669d28`
- Upstream tag: `v0.6.0`
- License: MIT

The repository adapts integration patterns from this upstream version. It does
not copy source code from this project.

Adapted integration patterns:

- Convert real Pi session messages at the host boundary.
- Keep Pi's native compaction lifecycle authoritative.
- Return `undefined` when custom compaction fails so Pi can run its native
  fallback once.
- Preserve Pi's compaction boundary and token metadata in the host result.
- Use Pi's native model registry and credential transport.

Files that implement these adapted patterns:

- `packages/pi-context-expert/src/binding.ts`
- `packages/pi-context-expert/src/extension.ts`

## fast-jev-compaction

The shared compaction core continues to incorporate code from
https://github.com/tamaratran/fast-jev-compaction under the MIT License.
`packages/context-expert/NOTICE` and
`packages/context-expert/adapters/claude/NOTICE` retain that source record and
its exact license text.
