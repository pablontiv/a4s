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
- Referencia golden: tag `dagu-golden-v1`, run de aceptación `a4s-issue-955` (#955, PR #956).

### Roles

These are top-level OMP sessions, not spawnable agents in `agents/`. Here, **coordinator** means the OMP role below, not the Dagu `coordinator:` service in `station/config.yaml` or the Pi Orchestrator in `agents/common/AGENTS.md`.

| Role | Where | Outbound channels | Authority |
|---|---|---|---|
| Supervisor | Always in PRIMARY; the operator launches `a4s-14steps supervisor` | `tern new tab` / `tern close` for owned coordinator and researcher tabs; confirmed messages to those sessions; plain text to the operator | Operates PRIMARY and the station, creates issues, launches coordinators, and authorizes push/PR on the operator's behalf. |
| Coordinator | One new Tern tab per issue, launched with `a4s-14steps coordinator` | `[coordinator <issue>]` notifications to the supervisor; `task` to subagents; Dagu | Enqueue and `human.task` only; no `ask`, `tern new` or `tern close`. |
| Researcher | Its own Tern tab, launched with `a4s-14steps researcher`, replacing side/discussion sessions | `[researcher]` handoffs to the supervisor; read-only subagents | Read-only research; iterates with the operator in its own tab, hands off only after explicit operator approval, and never creates issues. |

Leaf subagents (`triage-reviewer`, `Implement<ISSUE>`, `Poc<ISSUE>`) keep their existing roles. Native DAG actions own worktree lifecycle, polling and state; the scheduled reconciler posts review transitions to the local API. CI still runs `validate`.

`--a4s-role` activates `dagu_session_id` only for `coordinator`. Supervisor, researcher, no role and unknown roles remove it on session start and switch, even when `--tools` lists it; an unknown role also reports the valid roles. The role comes from the launch, including when resuming a session.

This is a convention aid, not access control: any session can read `$PI_SESSION_ID` and run `dagu enqueue` or call the station API. Possible future mitigations are a bypassable `tool_call` guard and Dagu-side authentication; both are out of scope.

#### Channels and delivery confirmation

Every inter-session message, in every direction, uses `packages/omp-dagu/scripts/tern-notify.sh <pane> <line>`, never a raw `tern send`. Allowed routes are supervisor → coordinator/researcher with `[supervisor]`, coordinator → its supervisor with `[coordinator <issue>]`, and researcher → its supervisor with `[researcher]`. No direct researcher/coordinator or cross-coordinator channel.

Use artifact-first delivery: one concise line, `<prefix> <intent>: <absolute artifact path>`. Put the payload under `${XDG_STATE_HOME:-$HOME/.local/state}/a4s/handoffs/`, outside the repository (including PRIMARY) and outside `/tmp`, so research stays read-only and the evidence survives. Create that directory as needed. Inline text is only for trivial one-line notices. A coordinator's notification is already one line; its full Turn status report remains in its own session `.jsonl` and needs no duplicate artifact.

```sh
# Run from PRIMARY; substitute the recipient pane and an existing absolute artifact path.
packages/omp-dagu/scripts/tern-notify.sh "$recipient_pane" \
  "[supervisor] review handoff: $artifact"
```

The helper appends a unique `[msg <epoch>-<rand>]` token, pastes the line, presses Enter, resolves the recipient's `omp_session_file` through `tern inspect --json`, and waits up to **120 seconds** for receipt. It checks only top-level `type=="message"` entries with `message.role=="user"`, joins decoded text content parts (also accepting string content), and compares the **full** decoded text, including the token, without trimming or stripping tags. Assistant, tool and custom entries do not confirm receipt.

- `0`: confirmed — the user message equals the sent line exactly.
- `1`: contaminated — a user message contains the token but includes different text.
- `2`: unconfirmed — no user message with the token was observed before the timeout, or delivery/inspection failed.

On `1` or `2`, **never resend blindly**: the message may already have arrived. Report the result to the operator in the sender's own pane. Never clear or edit another pane's editor.

**Residual channel risks:** partial operator editor text is concatenated with the pasted line into one submitted user message. Confirmation detects that contamination only after submission; it cannot prevent the operator's text from reaching the recipient. In the [PASS probe](https://github.com/pablontiv/a4s/issues/965#issuecomment-6891533774) on Tern 0.9.18 / OMP 18.20.2, a busy pane recorded the message **immediately** with `steering:true` and could background its active tool to handle it; delivery was not deferred until turn end. Keep the 120-second confirmation bound, but do not treat a busy session as a passive mailbox. Offline fixtures verify matching, not live scheduling.

For offline transport tests, `TERN_BIN` overrides the `tern` executable and `TERN_NOTIFY_TIMEOUT` overrides the timeout in whole seconds (default `120`).

#### Launch prompts

The supervisor launches a **new** coordinator tab from PRIMARY for each issue, naming its own pane explicitly in the enqueue prompt. Only one feature run may be active or enqueued at a time (queue concurrency is one). After the current run is `Succeeded`, its post-run acceptance checks pass, and its coordinator tab has been closed, automatically launch the next unpaused operator-approved issue in approval order, without waiting for another message. Approval means explicit operator acceptance of that named issue or its plan; creating an issue is not approval. If acceptance fails, launch nothing and report the failure.

```sh
primary=$(git rev-parse --show-toplevel)
supervisor_pane=$TERN_PANE
issue=965 # Replace with the issue to enqueue.
tern new tab --cwd "$primary" --json -- a4s-14steps coordinator \
  "Enqueue issue #$issue as run a4s-issue-$issue using dagu-feature. Supervisor pane: $supervisor_pane. Follow SKILL.md exactly and handle every checkpoint yourself. This is the only input you will get. When an operator decision is required, end your turn with the question in plain text. Report in the Turn status format. You are the coordinator for this issue: enqueue and human.task only; use task for leaf work. Do not use ask, tern new or tern close. When emitting a Turn status report, notify only supervisor pane $supervisor_pane via $primary/packages/omp-dagu/scripts/tern-notify.sh $supervisor_pane \"[coordinator $issue] <one-line summary>\"; never notify on silent checkpoint turns. On exit 1 or 2, report delivery failure in your own pane and do not resend."
```

The coordinator ends a decision turn with the question in its Turn status and the confirmed notification above; the supervisor relays the question to the operator rather than polling the coordinator pane.

The operator can freeze research. While frozen, the supervisor rejects every handoff, including approved handoffs, and launches no researcher. Otherwise, concurrent researchers remain allowed. A researcher must identify queued issues its findings would change; the supervisor pauses those issues until the operator decides.

The supervisor launches a researcher with a concrete question and its own pane as the only handoff target:

```sh
primary=$(git rev-parse --show-toplevel)
supervisor_pane=$TERN_PANE
question='Replace with the research question.'
tern new tab --cwd "$primary" --json -- a4s-14steps researcher \
  "Research this question: $question. You are a read-only researcher, not a coordinator. Do not modify PRIMARY or the station, create issues, enqueue runs, complete Dagu human tasks, push, or open PRs. Use only read-only subagents. Separate observed evidence with sources (file:line, runtime, station or run observations) from [INFERENCE]. Identify any queued issues your findings would change. Present findings to the operator and keep iterating in this tab. Notify the supervisor only after the operator explicitly approves the handoff; quote that approval in the artifact. Write your handoff artifact under \${XDG_STATE_HOME:-\$HOME/.local/state}/a4s/handoffs/, outside the repo and /tmp. Send one line with $primary/packages/omp-dagu/scripts/tern-notify.sh $supervisor_pane \"[researcher] handoff: <absolute artifact path>\". On exit 1 or 2, report delivery failure in your own pane and do not resend. Finish with an explicit account of anything pending."
```

#### Reality-check and session closure

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

## Estado, progreso y despertar dirigido

La extensión de status observa los runs activos del repositorio de la sesión mediante barridos REST y eventos SSE. Con UI muestra una línea por run en un widget `aboveEditor`; no muestra toasts de espera y conserva los toasts terminales para `succeeded`, `failed` y `aborted`. La observación que despierta al coordinador también funciona con `hasUI=false`. Resuelve el repositorio desde `origin`, incluso en linked worktrees, y consulta runs `running`, `queued` y `waiting` de las últimas 48 horas con la etiqueta `workspace=<repo>`.

La herramienta LLM `dagu_session_id`, activa solo para `--a4s-role coordinator`, devuelve `ctx.sessionManager.getSessionId()` únicamente a la sesión principal que la llama y rechaza subagentes. El coordinador la llama antes de `dagu enqueue` y pasa el valor como parámetro `OMP_SESSION_ID`. Cuando un run entra en `waiting` en `triage` o `implement`, o pasa a `failed` o `aborted`, la extensión entrega:

```text
[DAGU STATE] run=<run-id> status=<waiting|failed|aborted> step=<step> issue=<issue> bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped>
```

El aviso se entrega oculto al chat con `pi.sendMessage({ customType: "dagu-state", content: message, display: false }, { deliverAs: "aside" })`: inicia o continúa el turno del modelo sin renderizar una línea en la conversación. Solo se emite si el agente es `main`, el DAG es `feature`, existe `ISSUE` y `OMP_SESSION_ID` coincide exactamente con el ID de esa sesión. En estados terminales, `step` identifica el nodo fallido o abortado que alcanzó el run. Se aceptan los params Dagu tanto en formato CLI `KEY=value` como JSON.

REST y SSE alimentan una sola máquina de transiciones. El primer barrido tras `session_start` o `session_switch` establece una línea base silenciosa para los runs que ya existen. Un run descubierto en un barrido posterior ya esperando sí despierta; un barrido REST recupera una transición que SSE haya perdido; snapshots repetidos no duplican el aviso; y una reentrada real `running → waiting`, incluso al mismo paso, vuelve a avisar.

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

El gate requiere `DAGU_BIN` o `dagu` en `PATH` y ejecuta las pruebas nativas sin skips; CI instala Dagu 2.26.0 con checksum fijado. Los tests usan homes temporales y un puerto libre, sin reutilizar el `DAGU_HOME`, `DAGU_URL`, `DAGU_PORT` ni otras opciones `DAGU_*` heredadas de la estación. El contrato nativo usa el servidor y scheduler reales para compartir el estado de revisión entre `feature` y `reconcile-run` y completar/push-back de tareas humanas.
