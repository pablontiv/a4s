# OMP Dagu

Paquete OMP para operar el ciclo de issues de Dagu: distribuye el widget de progreso, el guard de triage, el agente `triage-reviewer` y el skill `dagu-feature` con sus plantillas. Requiere Node.js >=22.19.0 y Dagu 2.26.0 con autenticación local `none`.

## Instalación

Desde el clon primario de a4s en `main` (no desde un worktree de issue, que se elimina al cerrar el run), retirar los links anteriores e instalar el paquete único:

```sh
omp plugin uninstall @a4s/omp-dagu-status @a4s/omp-triage-guard
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-dagu"
```

To load a checkout without changing global settings:

```sh
omp -e /path/to/a4s/packages/omp-dagu
```

Loading the whole directory lets OMP discover both extensions, `agents/triage-reviewer.md`, and `skills/dagu-feature/`.
The widget and bundle inspection CLI read the station URL from `<repo root>/.workspace/config/dagu.json`, next to `refine.json`:

```json
{ "daguUrl": "http://127.0.0.1:8080" }
```

The file or key may be omitted to use `http://127.0.0.1:8080`; trailing slashes are removed.
Malformed JSON, non-object files, and non-string `daguUrl` values fail with the config file path.
The widget resolves the root with `git rev-parse --show-toplevel` from the session cwd, falling back to that cwd outside Git.
A linked worktree uses its own root's config. `DAGU_URL` and `DAGU_HOME` do not configure either consumer.
Subagent activity uses only the session directory supplied by OMP; without it, transcript activity remains empty rather than guessing profile paths.

## Estación aislada de 14 pasos

The isolated station runs as the user unit `dagu-14steps.service`, with its Dagu CLI/service home at `~/.dagu-14steps` and HTTP endpoint at `http://127.0.0.1:8090`. Set `"daguUrl": "http://127.0.0.1:8090"` in each repository/worktree's `.workspace/config/dagu.json` for the widget and bundle inspector. Each role starts with `a4s-14steps <supervisor|coordinator|researcher>`; `a4s-14steps dagu ...` still selects the CLI's service home through the launcher's environment, independently of the plugin config.

Command mode (`a4s-14steps <cmd...>`) preserves the caller's working directory; run worktree gates from that worktree. No-argument, role and flag forms start OMP in the primary clone. Without an explicit role, `dagu_session_id` stays inactive; `a4s-14steps --help` prints OMP's usage.

La rama base es `dagu-14steps`, el valor predeterminado de `BASE_BRANCH` en los DAGs estampados.

El run conserva su rama y worktree hasta que `close_gate` termina correctamente. Si falla, corregir la causa y recuperar el mismo run con `dagu retry --run-id <run-id> --step close_gate feature`. `await_merge` usa HTTP autenticado y jq nativos cada 60 segundos; `reconcile` aplica las transiciones REST de revisión y reporta sobrantes como `LEFTOVER`, sin bloquear otros runs.

**Reconstrucción:**

- Instalar el binario del release de Dagu v2.26.0 en `~/.local/opt/dagu-2.26.0/`.
- Copiar `station/config.yaml` a `~/.dagu-14steps/config.yaml`, `station/dagu-14steps.service` a `~/.config/systemd/user/dagu-14steps.service` y `station/a4s-14steps` a `~/.local/bin/a4s-14steps` con modo `0755`. Luego ejecutar `systemctl --user daemon-reload && systemctl --user enable --now dagu-14steps`.
- Ejecutar el [bootstrap](skills/dagu-feature/SKILL.md#1-bootstrap) desde el clon primario, con el entorno de `a4s-14steps` y `SKILL_DIR=/home/shared/harness/a4s/packages/omp-dagu/skills/dagu-feature` absoluto (una ruta relativa falla en `detect`). Responder `GATE=bash scripts/gate.sh`, `REQUIRED_CHECK=validate` y `TEST_PATHS=(^|/)(test|tests)/|\.test\.(ts|cjs)$`.
- Configurar GitHub con rama predeterminada `dagu-14steps`, status check requerido `validate` y auto-merge habilitado. El servicio obtiene `GH_TOKEN` con `gh auth token` al arrancar y falla si no puede; el usuario del servicio debe estar autenticado. Reiniciar tras rotar el token. Solo el sub-DAG de polling lo declara como secreto de entorno; no escribirlo en YAML, params o logs.
- Añadir `/poc/` y `/.workspace/legacy-worktrees/` al `.git/info/exclude` local.
- Referencia golden: el `dagu-golden-vN` más reciente; criterio y rollback en [Golden tags](#golden-tags).

## Communication protocol

### Rules

These rules are authoritative. The sections below define how to apply them.

1. Four channels exist: operator ↔ supervisor, operator ↔ researcher, supervisor ↔ coordinator and supervisor ↔ researcher. No other channel exists.
2. Every inter-agent message goes through `tern-notify.sh` with delivery confirmation.
3. Every inter-agent message is one line with the absolute path of an artifact that holds the detail; only a trivial single-sentence notice may go inline.
4. An unconfirmed delivery is never resent blindly; the sender reports it in its own pane. No agent edits another session's editor.
5. All decisions known at a blocking point travel together in one message. The supervisor relays them to the operator and never polls the coordinator's pane.
6. No agent uses `ask` forms; decisions are requested in plain text.
7. The researcher waits for the operator's handoff instruction, never asks for or offers it, and quotes it in the handoff artifact. A handoff without that quote is invalid.
8. Researcher output is input, not truth: the supervisor checks every claim against live state before acting and returns false findings to the researcher.
9. The researcher investigates every unknown through read-only subagents without waiting to be asked.
10. The supervisor processes every handoff completely and closes it as issue proposals or a recorded no-action; the operator only decides. The supervisor closes each session it launched once its work is done and nothing is pending.
11. Every launch carries an artifact with every decision already made; nothing is enqueued while a decision is open.
12. Independent work is split across parallel subagents.
13. Every inter-agent message separates verified facts from inferences.

### Roles

These are top-level OMP sessions, not spawnable agents in `agents/`. Here, **coordinator** means the OMP role below, not the Dagu `coordinator:` service in `station/config.yaml` or the Pi Orchestrator in `agents/common/AGENTS.md`.

| Role | Where | Outbound channels | Authority |
|---|---|---|---|
| Supervisor | Always in PRIMARY; the operator launches `a4s-14steps supervisor` | `tern new tab` / `tern close` for owned coordinator and researcher tabs; confirmed messages to those sessions; plain text to the operator | Operates PRIMARY and the station, creates issues, launches coordinators, and authorizes push/PR on the operator's behalf. |
| Coordinator | One new Tern tab per issue, launched with `a4s-14steps coordinator` | `[coordinator <issue>]` notifications to the supervisor; `task` to subagents; Dagu | Enqueue and `human.task` only; no `ask`, `tern new` or `tern close`. |
| Researcher | Its own Tern tab, launched with `a4s-14steps researcher`, replacing side/discussion sessions | `[researcher]` handoffs to the supervisor; plain text to the operator; read-only subagents | Read-only research; iterates with the operator in its own tab, waits for the operator's handoff instruction without asking for or offering it, and never creates issues. |

Leaf subagents (`triage-reviewer`, `Implement<ISSUE>`, `Poc<ISSUE>`) keep their existing roles. Native DAG actions own worktree lifecycle, polling and state; the scheduled reconciler posts review transitions to the local API. CI still runs `validate`.

`--a4s-role` activates `dagu_session_id` for `coordinator` and `supervisor`. Researcher, no role and unknown roles remove it on session start and switch, even when `--tools` lists it; an unknown role also reports the valid roles. The role comes from the launch, including when resuming a session.

This is a convention aid, not access control: any session can read `$PI_SESSION_ID` and run `dagu enqueue` or call the station API. Possible future mitigations are a bypassable `tool_call` guard and Dagu-side authentication; both are out of scope.

### Pinned role cards

`src/status/index.ts` appends the matching card to the **received** `before_agent_start.systemPrompt` array before every prepared request, preserving the host policy and earlier extensions. This reapplies after compaction and uses the current launch's `--a4s-role`, including on resume. No role or an unknown role adds no card. The cards live in code; `test/status.test.ts` requires an exact match with these cards inside this canonical section, so edits must update both together.

#### supervisor

```text
[a4s supervisor communication protocol]
Stay in PRIMARY; operate the station and launch only operator-approved work. Close only owned idle tabs with nothing pending.
Send [supervisor] only to coordinators/researchers through tern-notify.sh; never use raw tern send or cross-coordinator channels.
Artifact-first for every inter-session message and launch: fixed role instruction plus one absolute artifact path; inline only trivial single-sentence notices.
Batch all decisions known at a blocking point; sweep before launch and never enqueue with a known decision open.
Record unforeseen conservative decisions; obtain operator approval before irreversible choices.
Never use ask forms; request decisions in plain text.
Require quoted operator handoff approval, verify load-bearing claims against live state, return false findings to the researcher, and pause affected queued issues.
Process every handoff completely into issue proposals or a recorded no-action; the operator only decides.
Split independent work across parallel subagents; separate verified facts from [INFERENCE] in every inter-agent message.
On tern-notify exits 1/2, report in your own pane and never resend blindly or edit a recipient editor; exit 3 rejects before any paste.
```

#### coordinator

```text
[a4s coordinator communication protocol]
Enqueue and human.task only; use task for leaf work. Never use ask, tern new or tern close.
Send [coordinator <issue>] only to your supervisor through tern-notify.sh when emitting Turn status; silent checkpoint turns send nothing.
Artifact-first for every inter-session message and launch: fixed role instruction plus one absolute artifact path; inline only trivial single-sentence notices.
Batch all decisions known at a blocking point; sweep before launch and never enqueue with a known decision open.
Record unforeseen conservative decisions; obtain operator approval before irreversible choices.
Follow dagu-feature; report Done, Pending, Blockers and decisions, and Proposals. Keep full Turn status reports in your session .jsonl.
Split independent work across parallel subagents; separate verified facts from [INFERENCE] in every inter-agent message.
On tern-notify exits 1/2, report in your own pane and never resend blindly or edit a recipient editor; exit 3 rejects before any paste.
```

#### researcher

```text
[a4s researcher communication protocol]
Read-only; never modify PRIMARY or the station, create issues, enqueue runs, complete Dagu human tasks, push, or open PRs. Use only read-only subagents.
Role rule: whenever you do not know something, investigate it through read-only subagents without waiting to be asked, including OMP config (cfg://, ~/.omp), docs, sessions and handoffs; acknowledging an unknown without investigating it is a role error.
Artifact-first for every inter-session message and launch: fixed role instruction plus one absolute artifact path; inline only trivial single-sentence notices.
Batch all decisions known at a blocking point; sweep before launch and never enqueue with a known decision open.
Record unforeseen conservative decisions; obtain operator approval before irreversible choices.
Never use ask forms; request decisions in plain text.
Wait for the operator's handoff instruction; never ask for or offer it. Only then send [researcher] through tern-notify.sh to your supervisor, quoting that approval in the artifact.
Split independent work across parallel subagents; separate verified facts from [INFERENCE] in every inter-agent message.
Identify affected queued issues and finish with an explicit account of anything pending.
On tern-notify exits 1/2, report in your own pane and never resend blindly or edit a recipient editor; exit 3 rejects before any paste.
```

### Operator decisions

Batch **every decision known at a blocking point** into one artifact or message; never send one decision per message. Include the recommended choices, alternatives and already-made decisions so the operator can answer the whole batch. The artifact-first exception below permits only trivial single-sentence inline notices.

Before launching a session or enqueueing work, sweep the task, inputs and dependencies for known decisions. Obtain all required answers first and record them in the launch artifact: **no enqueue while a known decision is open**. For an unforeseen decision, take and record the conservative option unless it is irreversible; stop and obtain operator approval before an irreversible choice.

Never use `ask` forms: a pending form swallows pasted notifications. Request decisions in plain text. A researcher investigates unknowns proactively through read-only subagents, including OMP config; it waits for the operator's handoff instruction and never asks for or offers that handoff.

### Channels and delivery confirmation

Every inter-session message, in every direction, uses `packages/omp-dagu/scripts/tern-notify.sh <pane> <line>`, never a raw `tern send`. Allowed routes are supervisor → coordinator/researcher with `[supervisor]`, coordinator → its supervisor with `[coordinator <issue>]`, and researcher → its supervisor with `[researcher]`. No direct researcher/coordinator or cross-coordinator channel. The operator talks to the supervisor and to researchers in their own tabs, never to coordinators.

Use artifact-first delivery for **every inter-session message, launch prompts included**: one concise line, `<prefix> <intent>: <absolute artifact path>`. Put the question or task, inputs, supervisor pane, authorization and pre-made decisions under `${XDG_STATE_HOME:-$HOME/.local/state}/a4s/handoffs/`, outside the repository (including PRIMARY) and outside `/tmp`, so research stays read-only and the evidence survives. Create that directory as needed and use an absolute path. Inline text is only for trivial single-sentence notices. A coordinator's full Turn status report remains in its own session `.jsonl` and needs no duplicate artifact; a multi-sentence notification must point to that absolute transcript path or a handoff artifact.

```sh
# Run from PRIMARY; substitute the recipient pane and an existing absolute artifact path.
packages/omp-dagu/scripts/tern-notify.sh "$recipient_pane" \
  "[supervisor] review handoff: $artifact"
```

The helper appends a unique `[msg <epoch>-<rand>]` token, pastes the line, presses Enter, resolves the recipient's `omp_session_file` through `tern inspect --json`, and waits up to **120 seconds** for receipt. It checks only top-level `type=="message"` entries with `message.role=="user"`, joins decoded text content parts (also accepting string content), and compares the **full** decoded text, including the token, without trimming or stripping tags. Assistant, tool and custom entries do not confirm receipt.

- `0`: confirmed — the user message equals the sent line exactly.
- `1`: contaminated — a user message contains the token but includes different text.
- `2`: unconfirmed — no user message with the token was observed before the timeout, or delivery/inspection failed.
- `3`: rejected — after removing a `[coordinator N] `-style prefix, the payload has more than one sentence and no absolute artifact path; nothing is pasted and no Tern command runs.

The guard recognizes a sentence boundary as `.`, `!` or `?`, optionally followed by closing quotes/brackets, then whitespace and more text (even an unfinished second sentence). Abbreviations can therefore require an artifact. A path starts with `/` at the beginning of the payload or after whitespace, a quote, backtick or `(`; URLs, relative paths and `~/` do not qualify. This is a lexical check, not a check that the artifact exists.

On `1` or `2`, **never resend blindly**: the message may already have arrived. Report the result to the operator in the sender's own pane. Never clear or edit another pane's editor. On `3`, report the rejection in your own pane; the original notification was not sent.

**Residual channel risks:** partial operator editor text is concatenated with the pasted line into one submitted user message. Confirmation detects that contamination only after submission; it cannot prevent the operator's text from reaching the recipient. In the [PASS probe](https://github.com/pablontiv/a4s/issues/965#issuecomment-6891533774) on Tern 0.9.18 / OMP 18.20.2, a busy pane recorded the message **immediately** with `steering:true` and could background its active tool to handle it; delivery was not deferred until turn end. Keep the 120-second confirmation bound, but do not treat a busy session as a passive mailbox. Offline fixtures verify matching, not live scheduling.

For offline transport tests, `TERN_BIN` overrides the `tern` executable and `TERN_NOTIFY_TIMEOUT` overrides the timeout in whole seconds (default `120`).

### Launch prompts

The supervisor launches a **new** coordinator tab from PRIMARY for each issue. First write the task artifact with the issue/run IDs, the supervisor pane (`$TERN_PANE`), inputs, authorization, all pre-made decisions, and the required acceptance checks; finish the decision sweep before launch. Only one feature run may be active or enqueued at a time (queue concurrency is one). After the current run is `Succeeded`, its post-run acceptance checks pass, and its coordinator tab has been closed, automatically launch the next unpaused operator-approved issue in approval order, without waiting for another message. Approval means explicit operator acceptance of that named issue or its plan; creating an issue is not approval. If acceptance fails, launch nothing and report the failure.

```sh
primary=$(git rev-parse --show-toplevel)
artifact="${XDG_STATE_HOME:-$HOME/.local/state}/a4s/handoffs/coordinator-965.md"
# Write the artifact above first; substitute the approved issue's existing absolute artifact path.
tern new tab --cwd "$primary" --json -- a4s-14steps coordinator \
  "You are the coordinator. Read and execute this task artifact under the Communication protocol and dagu-feature: $artifact"
```

The coordinator handles every checkpoint through `dagu-feature`, emits the full Turn status in its own session and notifies only the supervisor pane named in the artifact. At a blocking point it includes the entire decision batch, not one question per notification. The supervisor relays that batch to the operator rather than polling the coordinator pane.

Concurrent researchers are allowed. A researcher must identify queued issues its findings would change; the supervisor pauses those issues until the operator decides.

The supervisor launches a researcher with an existing artifact containing the concrete question, inputs, pre-made decisions and its own pane as the only handoff target. The fixed role rule stays in the launch user message as the standing user request to investigate OMP config:

```sh
primary=$(git rev-parse --show-toplevel)
artifact="${XDG_STATE_HOME:-$HOME/.local/state}/a4s/handoffs/researcher-question.md"
# Write the artifact above first; substitute its existing absolute path.
tern new tab --cwd "$primary" --json -- a4s-14steps researcher \
  "You are a read-only researcher. Role rule: whenever you do not know something, investigate it through read-only subagents without waiting to be asked, including OMP config (cfg://, ~/.omp), docs, sessions and handoffs; acknowledging an unknown without investigating it is a role error. Read and investigate this question artifact under the Communication protocol: $artifact"
```

### Reality-check and session closure

1. A handoff without a quoted operator approval is invalid. The supervisor does not act on it and tells the operator.
2. Researcher output is **input, not truth**. Before creating an issue, changing PRIMARY or the station, or steering a coordinator, the supervisor checks every load-bearing claim in the approved handoff against live state: cited `file:line` still says that, and runtime, station and run state match. Verify each `[INFERENCE]` or carry it into the issue as an open question.
3. The supervisor sends stale or false findings back to the researcher as a `[supervisor]` artifact. The researcher revises them with the operator and hands off again only after a new explicit operator approval, quoted in the artifact. The supervisor re-checks that approved handoff once, then fixes any remaining minor corrections in the issue text instead of returning them to the researcher.
4. The supervisor presents the issue drafts to the operator and creates the issues only after the operator approves them.
5. Every research ends in issue(s) or a recorded **no action**. In both cases, the supervisor closes the researcher tab after the session checks below.

When a run reaches `Succeeded`, the supervisor checks the existing acceptance contract:

- All required DAG steps and verification guards completed successfully (the merged path skips the recovery-only `merge_review`).
- The PR is merged with `validate` green.
- The issue is closed.
- PRIMARY is clean and equal to `origin/dagu-14steps`.
- The run's worktree and local/remote branch are gone.

Then it reads the coordinator's final report, checks that the owned session is idle and leaves nothing pending, and closes that tab with `tern close <pane>`. When research ends in issues or a recorded **no action**, it likewise checks that the owned researcher session is idle and its last report leaves nothing pending, then closes that researcher tab with `tern close <pane>`. Retain each session's `.jsonl` as evidence.

Tab closure stays deliberately outside `close_gate`: the DAG runs under `systemd` and must not depend on Tern or OMP, the same coupling removed in #954.

## Golden tags

`dagu-golden-vN` is an annotated tag on the `dagu-14steps` commit the station ran (installed bundle and launcher), not on the merge a run produced. It marks a stable version only when runs launched on that commit covered both lifecycle paths: one no-PoC run, and one PoC PASS plus its promoted run. Each must reach `Succeeded`, pass the post-run acceptance above, and need no intervention beyond the coordinator's human tasks: no supervisor stop or abort, no out-of-band human-task completion, no fix merged mid-run.

After that acceptance, the supervisor proposes the tag to the operator; the tag message lists the commit, runs and PRs. It creates and pushes the tag only after operator approval. Published tags are never moved or rewritten. Rollback reinstalls the bundle and launcher from the latest golden tag.

## Estado, progreso y despertar dirigido

La extensión de status observa los runs activos del repositorio de la sesión mediante barridos REST y eventos SSE. Con UI muestra una línea por run en un widget `aboveEditor`; no muestra toasts de espera y conserva los toasts terminales para `succeeded`, `failed` y `aborted`. La observación que despierta al coordinador también funciona con `hasUI=false`. Resuelve el repositorio desde `origin`, incluso en linked worktrees, y consulta runs `running`, `queued` y `waiting` de las últimas 48 horas con la etiqueta `workspace=<repo>`.

The LLM tool `dagu_session_id` is available to the main session under `--a4s-role coordinator` or `supervisor`; subagents cannot use it. Pass its result as `OMP_SESSION_ID` when starting a run. Coordinators keep their existing `feature` triage/implementation and failure wakes. A supervisor receives one hidden aside per waiting role `escalation`, `feature` `decide`, or `poc` `decide`, without a coordinator session:

```text
[DAGU STATE] run=<run-id> status=<waiting|failed|aborted> step=<step> issue=<issue> bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped>
```

Supervisor waiting notices also include `dag=<name>`.

The notice uses `pi.sendMessage({ customType: "dagu-state", content: message, display: false }, { deliverAs: "aside" })`, starting or continuing the model turn without adding a visible chat line. It requires agent `main`, an `ISSUE`, and an exact `OMP_SESSION_ID` match. Terminal notices identify the failed/aborted node. Params may use CLI `KEY=value` or JSON.

REST and SSE share one transition state. Supervisor startup delivers already-waiting tasks; coordinator startup remains a silent baseline. Waiting-task deduplication uses the run, step identity and step start timestamp, so repeated snapshots do not duplicate an aside, parallel tasks each wake once, and a fresh wait after push-back wakes again. Deduplication is in-process: restarting the supervisor re-delivers an outstanding wait.

Cada línea del widget identifica el DAG y el issue, muestra el progreso por nodos, el paso actual y, cuando existe, su actividad. La CLI `gh` es opcional y añade el slug del título.

- Un paso de comando `running` consulta cada dos segundos `GET /api/v1/dag-runs/{name}/{dagRunId}/steps/{step}/log?tail=3` y muestra su última línea no vacía.
- Un `human.task` `triage`, `run_poc` o `implement` en `waiting` localiza la sesión coordinadora con `PRIMARY` y `OMP_SESSION_ID`, y muestra el subagente determinista `TriageReview<ISSUE>`, `Poc<ISSUE>` o `Implement<ISSUE>`, su última herramienta, intención (o argumento principal) y antigüedad. Los reintentos `<Nombre>v<N>` son válidos y gana el archivo más reciente.
- La lectura del transcript está acotada a sus últimos 256 KiB y descarta líneas parciales. Logs, herramientas e intenciones se sanean y truncan antes de renderizar. Sin log o transcript disponible, la línea conserva el estado sin actividad.

SSE sigue aplicando inmediatamente las transiciones del run; el refresco periódico cubre actividad que SSE no emite por línea. Al cambiar de paso, terminar el run o recibir `session_shutdown`, se abortan la lectura y su temporizador. Las caídas de REST o SSE muestran una reconexión con backoff sin interrumpir la sesión.

```text
dagu · feature #182 actividad-real-del-step ▰▰▱▱▱▱ 2/5 gate running · > npm test
dagu · feature #182 actividad-real-del-step ▰▱▱▱▱▱ 1/5 implement waiting · Implement182 · edit src/status/activity.ts (12s)
```

El paquete usa `fetch` y un parser SSE propios, sin dependencias runtime externas. La extensión solo observa y despierta; las acciones humanas y la reconciliación pertenecen a Dagu y al operador. Si la sesión de destino no está ejecutándose, no recibe aviso. Si el mismo ID de sesión está abierto a la vez en dos procesos OMP, ambos coinciden y ambos despiertan.

## Guard de triage y agente

El paquete distribuye `triage-reviewer` con `structured: true`, el JSON Schema de la decisión, `tools: []`, `spawns: []` y modelo `@slow`.

1. Intentar completar `triage` con `POC=no`. El guard responde `TRIAGE_REVIEW_REQUIRED` con el marcador de generación y la plantilla fija.
2. Ejecutar `task agent=triage-reviewer` con el alcance, el marcador completo y la plantilla.
3. Repeat the completion with the allocated id in `--input REVIEW=<id>` when the decision is `poc: "no"`. A `yes` keeps triage waiting with its proposed question. Another rejected `POC=no` completion emits a fresh `REQUEST` marker within the same generation: launch a new reviewer with that marker, the fixed prompt, and corrected scope or new evidence. The latest valid bound review decides; use its allocated id, not an earlier reviewer's.

La aprobación pertenece a un DAG, run y generación; se consume tras una completion exitosa y se conserva si la completion falla. Volver a triage exige otra revisión. El guard exige que la completion de triage esté sola en su tool call. `POC=yes` pasa directamente.

El DAG aplica la misma autorización aunque el guard no esté cargado. Para
`POC=no`, `REVIEW` es el nombre simple del subagente `TriageReview<ISSUE>` (o
`TriageReview<ISSUE>v<N>` al reintentar) lanzado como `triage-reviewer` por la
sesión coordinadora indicada por `OMP_SESSION_ID`. Antes de comentar el issue o
copiar estado, `triage_decision` localiza un único transcript JSONL, comprueba su
sesión padre, agente, marcador `DAG=feature RUN=<run>`, inicio posterior al
`triage.startedAt` actual y `poc=no` en el último yield. REST, parámetros,
transcript o campos inválidos hacen fallar el step sin efectos externos.

Con `@a4s/omp-cross-family-review` cargado, `triage-reviewer` conserva la selección cross-family; `reviewer` sigue disponible para code review.

## Skill dagu-feature

OMP resuelve `skill://dagu-feature` y `skill://dagu-feature/feature.yaml` desde `skills/dagu-feature/` dentro del paquete. `SKILL.md`, `feature.yaml`, `poc.yaml`, `reconcile.yaml` y `dagu-feature-bootstrap.yaml` permanecen juntos para conservar sus enlaces relativos y las rutas `$SKILL_DIR/<archivo>` del bootstrap.

### Versión, sello y compatibilidad

La versión de `package.json` identifica el bundle completo. Cada DAG generado
lleva en la primera línea el sello con versión, repositorio y SHA fuente, run de
bootstrap y versión de Dagu, además de la etiqueta
`dagu-feature-bundle=<version>`. La extensión compara esa etiqueta con su propia
versión: exige el mismo major y, mientras sea `0`, también el mismo minor. Un
DAG sin etiqueta queda `unstamped`; una versión fuera de la regla queda
`incompatible`. Ambos estados se muestran como advertencia y no bloquean runs.

To inspect one or more clones, the station's reconciler, and the exact required Dagu version:

```sh
node /path/to/a4s/packages/omp-dagu/bin/dagu-feature-bundle.ts /path/to/clone
```

With no paths, the command inspects the current directory's Git toplevel.
It selects `daguUrl` from the first successfully inspected repository's `.workspace/config/dagu.json`, or from the cwd if none resolves.
Repository `feature.yaml` and `poc.yaml` stamps are read locally; the reconciler stamp comes only from the verbatim JSON `spec` returned by `GET <daguUrl>/api/v1/dags/reconcile/spec`.
HTTP 404 means `unstamped`; any other non-200 response, invalid spec response, or transport failure prints `reconcile.yaml ... compat=unreachable`.
The command exits nonzero if any DAG, reconciler, or local `dagu version` is incompatible, unstamped, or unreachable.
Node.js >=22.19 runs this TypeScript file directly; use its real package path because Node rejects type stripping for `.ts` files under `node_modules`.

El bootstrap verifica que el paquete fuente esté limpio, que su `HEAD` pertenezca
a la rama remota por defecto y que `dagu version` produzca exactamente la versión
declarada. Dagu rechaza puntos en los run IDs, por lo que la actualización usa
`bootstrap-<repo>-v<version-with-hyphens>`; por ejemplo,
`bootstrap-backscroll-v0-2-0` para la versión `0.2.0`. Después reutiliza los
valores actuales mostrados por `answers`, abre el issue de adopción y encola el
`feature.yaml` staged. El commit de adopción incluye los trailers
`Dagu-Feature-Bundle`, `Dagu-Feature-Source` y `Dagu-Feature-Bootstrap` que
imprime `confirm`.

## Headless triage pre-pilot (#920)

`.workspace/dagu/dags/triage-pilot.yaml` is an opt-in root/child pair, not a replacement for the installed `feature` flow or a bootstrap/bundle template. Use an isolated `DAGU_HOME` with Dagu 2.26.0; F1 already shipped separately. Do not enqueue it on either operator station until the R28 binding decision and the five-issue headless-versus-TUI pilot are authorized. No operator acceptance is recorded here.

The root takes `ISSUE`, the supervisor's `OMP_SESSION_ID`, absolute `REPO` and private `STATE_ROOT` paths, `MODEL`, and the issue/research context in `SCOPE`. `STATE_ROOT` must be owned by the current user with mode 0700. Every run/push-back generation gets fresh role directories. A failed child reaches the root `escalation` human task; push-back requires feedback and starts a fresh generation.

`scripts/triage-role.py` runs triage and, only for `poc=no`, an independent reviewer. Roles load no extensions, context files, rules, skills or tools; their explicit config sets `features.unexpectedStopDetection` to `none`. The launcher preserves a nonzero role exit, extracts the last single-line JSON object before Dagu's `output_schema`, and then performs a separate semantic check. Missing JSON, schema errors, disagreement or stale identity fail the child. `poc=yes` bypasses reviewer artifacts, but not the triage identity/schema checks.

R28 remains an operator decision: the pre-pilot keeps the researched run+generation binding, first-prompt marker, unique fresh reviewer transcript and private session directory. Tests reject duplicate transcripts and each stale dimension independently. This does **not** establish authenticated native task/agent parentage or bind the decision to an independently authenticated final reviewer yield; the existing coordinator/native triage guard remains unchanged. Recommended operator choice: authorize only the isolated pilot under that stated limitation, not a production cutover.

`scripts/role-guard.py` requires Linux pidfds and a working systemd user manager and fails closed otherwise. Each role runs in a private user-service cgroup with a subreaper, launcher pidfd, `KillMode=control-group`, a one-second stop limit, `TasksMax=128`, and a runtime ceiling. The deadlines are `omp --max-time 120s` < guard 135s + stop 1s < role step 150s < root `dag.run` 330s; both roles plus the semantic check fit within 330s. The cgroup test covers normal exit 7, launcher SIGKILL, guard SIGKILL and runtime expiry while detached/double-forked, late-forking, TERM-ignoring descendants exist. This is not containment against privileged/same-UID cgroup migration, user-manager failure or uninterruptible kernel tasks.

### Observed RPC ownership

On 2026-11-16 at 05:00 UTC, an isolated Dagu 2.26.0 parent/child run (`issue-920-rpc-live`) successfully owned one real OMP 18.20.3 RPC child for its entire lifetime. `scripts/probe-role-rpc.py`, under the same cleanup guard, used `anthropic/claude-haiku-4-5` and a host-owned tool gate to keep the role busy. All eleven command IDs were acknowledged individually; `steer` and `follow_up` appeared in their respective queues and then in assistant replies. `abort` returned an acknowledgement, an `aborted` prompt result and host-tool cancellation. The session ID/file stayed unchanged, stdin EOF exited 0, and both Dagu runs succeeded in 5.7 seconds. The test home was removed after recording these results.

This proves that a Dagu step can own and drain the RPC channel; it does not add a supervisor transport/daemon, retire Tern, or complete the live-issue pilot. To reproduce after authorization, run the probe inside `role-guard.py --runtime-seconds 135 --log <private-path> --`, in an isolated Dagu child step with a 150-second timeout and a longer parent `dag.run`. Pass `--model <available-model> --state <private-directory>` to the probe; it writes its assertions and command/event evidence there.

The RPC contract and cleanup behavior were checked against the installed-version source directories `~/.opensrc/repos/github.com/can1357/oh-my-pi/v18.20.3` and `~/.opensrc/repos/github.com/dagu-org/dagu/v2.26.0`, not an unversioned repository snapshot.


## Desarrollo

```sh
DAGU_BIN=$(command -v dagu) npm test --workspace @a4s/omp-dagu
npm run typecheck --workspace @a4s/omp-dagu
```

El gate completo del repositorio es:

```sh
bash scripts/gate.sh
```

Las pruebas cubren el parser SSE, progreso y actividad viva de comandos y subagentes, identidad y títulos de issues, resolución de repositorios/worktrees, transiciones y avisos del widget, la correlación nativa y el contrato estructurado del guard de triage, y la verificación fail-closed del transcript real ejecutada desde ambos DAG `feature.yaml`.

The gate requires `DAGU_BIN` or `dagu` on `PATH`; CI pins Dagu 2.26.0 by checksum. Native tests use temporary homes and free ports, without inheriting station `DAGU_*` settings. The real-server contract exercises review state and human-task complete/push-back. Linux cgroup/role-child integration tests additionally require a working systemd user manager and explicitly skip where it is unavailable. The supervisor wake integration starts its own station and runs the actual extension's UI-context observer without any coordinator. The live RPC probe is opt-in and is not run by the gate.
