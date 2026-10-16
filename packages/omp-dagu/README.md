# OMP Dagu

Paquete OMP para operar el ciclo de issues de Dagu: distribuye el widget de progreso, el guard de triage, el agente `triage-reviewer` y el skill `dagu-feature` con sus plantillas. Requiere Node.js >=22.19.0 y Dagu 2.20.1 con autenticación local `none`.

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

Tras el merge de un cambio que mueve o renombra un paquete OMP, los symlinks
`~/.omp/plugins/node_modules/@a4s/*` siguen apuntando a las rutas del clon
primario y pueden quedar colgando. Volver a enlazarlos es configuración del
operador: el coordinador propone los comandos de instalación anteriores y el
operador los ejecuta.

## Estado, progreso y despertar dirigido

La extensión de status observa los runs activos del repositorio de la sesión mediante barridos REST y eventos SSE. Con UI muestra una línea por run en un widget `aboveEditor`; no muestra toasts de espera y conserva los toasts terminales para `succeeded`, `failed` y `aborted`. La observación que despierta al coordinador también funciona con `hasUI=false`. Resuelve el repositorio desde `origin`, incluso en linked worktrees, y consulta runs `running`, `queued` y `waiting` de las últimas 48 horas con la etiqueta `workspace=<repo>`.

La herramienta LLM `dagu_session_id` devuelve `ctx.sessionManager.getSessionId()` únicamente a la sesión principal que la llama y rechaza subagentes. El coordinador la llama antes de `dagu enqueue` y pasa el valor como parámetro `OMP_SESSION_ID`. `feature` despierta en `triage`, `implement`, `start_primary_unavailable`, `close_primary_unavailable`, `failed` y `aborted`; `poc` despierta en `base_primary_unavailable`; `discovery` despierta en `discover`, `validate`, `consolidate`, `approve`, `failed` y `aborted`. Los avisos incluyen la compatibilidad del bundle:

```text
[DAGU STATE] run=<run-id> status=<waiting|failed|aborted> step=<step> <issue=<issue>|dag=discovery> bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped>
```

Los checkpoints de disponibilidad añaden `cause=<prompt resuelto>` con `primary dirty: <archivos>` o `primary on <rama>, expected <base>`. Conservan el mismo run en Waiting y liberan la cola. El operador restaura PRIMARY limpio en BASE_BRANCH respetando sus cambios, consulta `dagu status --run-id <id> feature` y ejecuta `dagu human-task push-back feature --run-id <id> --step start_primary_unavailable --expected-iteration <iteración observada>` (para cierre: `close_primary_unavailable`; para PoC: DAG `poc`, paso `base_primary_unavailable`). El detector comprueba otra vez; limpiar por sí solo mantiene Waiting. El DAG sigue creando y retirando worktrees.

El aviso se entrega oculto al chat con `pi.sendMessage({ customType: "dagu-state", content: message, display: false }, { deliverAs: "aside" })`: inicia o continúa el turno del modelo sin renderizar una línea en la conversación. Solo se emite si el agente es `main`, `OMP_SESSION_ID` coincide exactamente con el ID de esa sesión y el run está en un checkpoint soportado; los avisos de `feature` y `poc` requieren `ISSUE`. En estados terminales, `step` identifica el nodo fallido o abortado que alcanzó el run. Se aceptan los params Dagu tanto en formato CLI `KEY=value` como JSON.

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

OMP resuelve `skill://dagu-feature` y sus plantillas desde `skills/dagu-feature/` dentro del paquete. `SKILL.md`, `feature.yaml`, `poc.yaml`, `discovery.yaml`, `reconcile.yaml` y `dagu-feature-bootstrap.yaml` permanecen juntos para conservar sus enlaces relativos y las rutas `$SKILL_DIR/<archivo>` del bootstrap.

`skill://dagu-feature` es la única guía de coordinación de issues con subagentes.
En a4s hay dos copias de cada DAG del ciclo: la plantilla distribuida
`packages/omp-dagu/skills/dagu-feature/<dag>.yaml` y la renderizada
`.workspace/dagu/dags/<dag>.yaml`. Al cambiar el ciclo, mantener ambas copias
coherentes, conservando en el render los parámetros y la identidad del bundle
que aplica el bootstrap.

Para la adopción de a4s, `TEST_PATHS` es
`(^|/)(test|tests)/|\.test\.(ts|cjs)$`.

Todo cambio en esas cinco plantillas o en `SKILL.md` exige una versión del
paquete mayor que la de la base del PR (`git merge-base origin/main HEAD`) y
una sección `## <versión>` en `CHANGELOG.md`; `npm test` lo comprueba,
incluyendo cambios locales rastreados y obteniendo main y su historia en CI
shallow. En 0.x, subir el minor indica ruptura de compatibilidad. Después del
merge, el operador ejecuta bootstrap para sellar los renders con la versión y
la identidad real del source y del run de bootstrap.

## Discovery

El bootstrap renderiza `.workspace/dagu/dags/discovery.yaml`. Su label
`workspace=<repo>` corresponde al workspace coordinador que recibe los avisos
OMP; `PRIMARY` puede apuntar a otro repositorio adoptado, cuyo slug y rama por
defecto se derivan en el run.

```sh
dagu enqueue --run-id "discovery-<id>" .workspace/dagu/dags/discovery.yaml -- \
  LENSES="0,1,2" POLICY="defecto" SOURCE="<origen>" LIVE_TARGET="" \
  PRIMARY="/ruta/al/repo" OMP_SESSION_ID="<dagu_session_id>"
```

`snapshot` imprime el out-dir persistente fuera del repositorio. En `discover`
se escribe un `findings-<lente>.jsonl` por lente; en `validate`,
`verdicts.jsonl`; y en `consolidate`, `units.jsonl`. Los validadores jq fallan
cerrados después de cada espera. `approve` usa el formulario `APPROVED=all` o
una lista de ids separada por comas y permite push-back a `consolidate`; hasta
esa aprobación no hay escrituras en GitHub.

`materialize` reutiliza issues por el marcador
`<!-- discovery-unit: <id> -->` y registra el resultado en `issues.jsonl`.
`dispose` aplica `POLICY`, omite run ids de `feature` existentes y conserva por
lente el último `findings.jsonl` y `temporal.jsonl`, de modo que la próxima
ejecución calcula `nuevo`, `persistente`, `resuelto` o `regresion`.

La extensión despierta `OMP_SESSION_ID` en las esperas `discover`, `validate`,
`consolidate` y `approve` con
`[DAGU STATE] run=<id> status=waiting step=<paso> dag=discovery bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped>`.

### Versión, sello y compatibilidad

La versión de `package.json` identifica el bundle completo. Cada DAG generado
lleva en la primera línea el sello con versión, repositorio y SHA fuente, run de
bootstrap y versión de Dagu, además de la etiqueta
`dagu-feature-bundle=<version>`. La extensión compara esa etiqueta con su propia
versión: exige el mismo major y, mientras sea `0`, también el mismo minor. Un
DAG sin etiqueta queda `unstamped`; una versión fuera de la regla queda
`incompatible`. Ambos estados se muestran como advertencia y no bloquean runs.

Para inspeccionar uno o más clones, el reconciliador instalado y la versión
exacta de Dagu requerida:

```sh
node /ruta/a/a4s/packages/omp-dagu/bin/dagu-feature-bundle.ts /ruta/al/clon
```

Sin rutas, el comando usa el toplevel Git del directorio actual. Sale con código
distinto de cero si algún DAG, el reconciliador o Dagu no es compatible. Node.js
>=22.19 ejecuta directamente ese archivo TypeScript; se documenta la ruta real
del paquete porque Node rechaza el type stripping de archivos `.ts` bajo
`node_modules`.

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
npm test --workspace @a4s/omp-dagu
npm run typecheck --workspace @a4s/omp-dagu
```

El gate completo del repositorio es:

```sh
npm ci && npm test && npm run typecheck
```

Las pruebas cubren el parser SSE, progreso y actividad viva de comandos y subagentes, identidad y títulos de issues, resolución de repositorios/worktrees, transiciones y avisos del widget, la correlación nativa y el contrato estructurado del guard de triage, y la verificación fail-closed del transcript real ejecutada desde ambos DAG `feature.yaml`.
