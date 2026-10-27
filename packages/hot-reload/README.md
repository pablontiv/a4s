# A4S Hot Reload

Private workspace package `@a4s/hot-reload`; its version is in `package.json`.
Use the Node.js requirement in the repository root `package.json` `engines.node`. Retained A4S
extension shims import `hotReload` from this package. The implementation and its
generation/lifecycle behavior are preserved by the package-identity cutover.

```ts
import { hotReload } from "@a4s/hot-reload";
import extension from "./index.ts";

export default function reloadable(pi: Parameters<typeof extension>[0]): Promise<void> {
  return hotReload(pi, extension, new URL("./index.ts", import.meta.url));
}
```

## Runtime contract

Restart native OMP when changing the helper, shim, or package binding. The A4S
wrapper intercepts user `/reload-plugins` input and imports the wrapped
implementation through its canonical raw filesystem path with a fresh query.
It retains stable host dispatchers, shuts down the preceding generation, and
starts the replacement. Import/factory failures retain the preceding generation.
Lifecycle handlers have a 2000 ms timeout. The implementation defers a busy
request until idle after `agent_end`.

Native OMP's builtin `/reload-plugins` separately refreshes resource discovery;
the wrapper leaves that builtin intact. Resource rediscovery is independent of
implementation reload. Bare-specifier dependencies, newly introduced local
modules, registered metadata/schema changes, and removed registrations require
a restart as described by the [Orca consumer](../orca-integration/README.md).

## Verification recorded for issue #421

Runtime observations for [issue #421](https://github.com/pablontiv/a4s/issues/421)
cover separate scenarios; they are not one combined invocation.

The retained 2026-10-20 native OMP ACP/RPC idle exercise recorded
fresh generation B import, A `session_shutdown` before B `session_start`,
exactly one B callback per subsequent probe, and retention of B after a
throwing import. ACP materialized the session and RPC exercised the wrapper
input interception, since ACP handles the builtin command first. Both
processes exited 0. These observations are reused from prior native quality
findings and durable issue evidence; the historical raw summary is no longer
available for fresh inspection.

On 2026-10-21, the then-installed native OMP recorded `/reload-plugins` arriving while
a real model turn waited in a real tool (`idle=false`). Reload remained
deferred through tool release and genuine `agent_end`; only afterwards,
at idle, did A shut down and B start. The subsequent probe had one B callback.
The persisted native parent and child transcripts retain actual model/tool
and lifecycle events. This run used the unchanged candidate `hotReload` and
actual unchanged Orca factory through a temporary generation-instrumentation
wrapper, not `reloadable.ts` as its direct entry.

A separate unchanged-entry native OMP idle exercise statically
imported and invoked the physical candidate Orca `src/reloadable.ts` default
export. It recorded the returned entry, eight host event registrations,
genuine `session_start`, and wrapper input callbacks for `/reload-plugins`
at idle. The prompt succeeded without invoking an agent; the process exited
0. Candidate helper, Orca factory, and entry bytes remained unchanged. This
outer host observer does not expose internal shutdown/start calls, and this
run independently proves neither a changed generation nor failed-import
retention.

Separately, the active exercise's builtin catalog lacked the temporary
`a4s-421-native-discovery` skill before reload and contained it afterwards.
That is builtin resource rediscovery, not evidence of a module import.


Direct internal source-object emission and a single combined
changed-implementation/direct-entry/busy-turn invocation remain **UNOBSERVED**
stronger variants, not additional acceptance requirements. Detailed commands,
hashes and transcripts remain in private retained evidence. These bounded,
compositionally observed scenarios do not constitute an overall
issue #418 or global integration PASS.

## Development

```sh
npm test --workspace @a4s/hot-reload
npm run typecheck --workspace @a4s/hot-reload
```

The root workspace scripts and CI dependency fan-out include this canonical
package and all retained consumers. Distribution remains private/local.

See the [source catalog](../../docs/architecture/catalog.md) and
[private-install runbook](../../docs/operations/private-install.md) for ownership
and the distinction between entry reinvocation, builtin resource rediscovery and
loading newly introduced lifecycle modules in a new process.
