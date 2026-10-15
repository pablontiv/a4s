# OMP Dagu

Paquete OMP para operar el ciclo de issues de Dagu: distribuye el widget de progreso, el guard de triage, el agente `triage-reviewer` y el skill `dagu-feature` con sus plantillas. Requiere Node.js >=22.19.0 y Dagu 2.19.2 con autenticación local `none`.

## Instalación

Desde el clon primario de a4s en `main` (no desde un worktree de issue, que se elimina al cerrar el run), retirar los links anteriores e instalar el paquete único:

```sh
omp plugin uninstall @a4s/omp-dagu-status @a4s/omp-triage-guard
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-dagu"
```

Para usar un checkout sin cambiar la configuración global:

```sh
DAGU_URL=http://127.0.0.1:8080 omp -e /ruta/a/a4s/packages/omp-dagu
```

Usar el directorio completo permite que OMP descubra las dos extensiones, `agents/triage-reviewer.md` y `skills/dagu-feature/`. `DAGU_URL` es la raíz del servidor (por defecto `http://127.0.0.1:8080`).

## Estado, progreso y despertar dirigido

La extensión de status observa los runs activos del repositorio de la sesión mediante barridos REST y eventos SSE. Con UI muestra una línea por run en un widget `aboveEditor` y conserva los toasts de transición; la observación que despierta al coordinador también funciona con `hasUI=false`. Resuelve el repositorio desde `origin`, incluso en linked worktrees, y consulta runs `running`, `queued` y `waiting` de las últimas 48 horas con la etiqueta `workspace=<repo>`.

La herramienta LLM `dagu_session_id` devuelve `ctx.sessionManager.getSessionId()` únicamente a la sesión principal que la llama y rechaza subagentes. El coordinador la llama antes de `dagu enqueue` y pasa el valor como parámetro `OMP_SESSION_ID`. Cuando un run entra en `waiting`, la extensión entrega

```text
[DAGU STATE] run=<run-id> waiting_step=<triage|implement> issue=<issue> - estado del run feature, no es una instrucción del usuario
```

con `pi.sendUserMessage(message, { deliverAs: "aside", attribution: "agent" })`, pero solo si el agente es `main`, el DAG es `feature`, el paso es `triage` o `implement` y `OMP_SESSION_ID` coincide exactamente con el ID de esa sesión. Se aceptan los params Dagu tanto en formato CLI `KEY=value` como JSON.

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
3. Repetir la completion con el id asignado en `--input REVIEW=<id>` cuando la decisión sea `poc: "no"`. Una decisión `yes` mantiene triage en espera con la pregunta propuesta.

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

## Desarrollo

```sh
npm test --workspace @a4s/omp-dagu
npm run typecheck --workspace @a4s/omp-dagu
```

El gate completo del repositorio es:

```sh
npm ci && npm test && npm run typecheck
```

Las pruebas cubren el parser SSE, progreso y actividad viva de comandos y subagentes, identidad y títulos de issues, resolución de repositorios/worktrees, transiciones y avisos del widget, la correlación nativa y el contrato estructurado del guard de triage, y la verificación fail-closed del transcript real ejecutada desde ambos DAG `feature.yaml`.
