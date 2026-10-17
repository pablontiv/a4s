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

## Retención del historial global

[`dagu/base.yaml`](dagu/base.yaml) versiona `hist_retention_days: 7` para
`$DAGU_HOME/base.yaml` (por defecto `~/.dagu/base.yaml`). El operador instala
esta configuración global. Tras la limpieza de Dagu, los runs de más de siete
días dejan de estar disponibles para `dagu history` y `dagu retry`; conserva
fuera del historial la evidencia que necesites durante más tiempo.
## Instalación global de la estación

a4s versiona `dagu/LaunchAgent.plist`, `dagu/base.yaml` y las hojas propias de
`dagu/config.yaml`. Tras el merge, desde el clon primario limpio, el operador
instala o actualiza la configuración con el binario Dagu 2.20.1 en `PATH`:

```sh
package="$PWD/packages/omp-dagu"
export DAGU_HOME="$HOME/.dagu"
node "$package/bin/dagu-station-install.ts" \
  --launch-agent "$HOME/Library/LaunchAgents/local.dagu.server.plist" \
  --log-dir "$HOME/Library/Logs/Dagu"
```

El comando verifica la versión fijada en `package.json`, valida un DAG mínimo
que hereda la base en un home temporal y comprueba el plist con `plutil` en
macOS antes de escribir. Instala con `cmp`/`install -m 0644`: repetirlo con los
mismos parámetros y `PATH` conserva bytes y mtimes. El plist usa el binario
resuelto en `PATH`, `start-all`, `KeepAlive`, `ProcessType=Interactive` y el
`DAGU_HOME` elegido. El instalador también crea el directorio de logs.

La base y el plist renderizado son propios completos. En `config.yaml` solo
se gestionan `auth.mode=none`, `queues.enabled=true`, `host=127.0.0.1`,
`port=8080` y `coordinator.enabled=true`; el resto de claves y comentarios se
conservan. Las entradas de `queues.config` pertenecen a sus repositorios:
por ejemplo, `antojea-e2e: 4` y `antojea-e2e-device: 1` mantienen sus límites,
igual que cualquier otro valor que tengan al instalar. La validación aislada
comprueba los valores propios y mantiene intactas las rutas ajenas.

Para un ensayo aislado, usar `DAGU_HOME=$(mktemp -d)` y omitir `--launch-agent`:
el plist se escribe por defecto en `$DAGU_HOME/LaunchAgent.plist` y los logs
en `$DAGU_HOME/logs/service`. `--dagu-home DIR` tiene prioridad sobre la variable.
El instalador requiere Node.js >=22.19.0, las dependencias del paquete y
`dagu`, `which`, `cmp` e `install` en `PATH`.

Comprobación de deriva, con los mismos parámetros del comando de instalación:

```sh
node "$package/bin/dagu-station-install.ts" --check \
  --launch-agent "$HOME/Library/LaunchAgents/local.dagu.server.plist" \
  --log-dir "$HOME/Library/Logs/Dagu"
cmp "$package/dagu/base.yaml" "$DAGU_HOME/base.yaml"
```

`--check` devuelve 0 si los tres archivos coinciden byte a byte con el resultado
esperado y 1 si hay deriva, incompatibilidad de versión o error de validación.
La comparación de config usa la fusión y la del plist su render, no la plantilla
sin resolver.

### Acciones de estación (operador)

La activación se realiza en un punto seguro, tras revisar los runs activos.
Para actualizar un servicio ya cargado:

```sh
launchctl bootout "gui/$(id -u)/local.dagu.server"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.dagu.server.plist"
launchctl kickstart "gui/$(id -u)/local.dagu.server"
launchctl print "gui/$(id -u)/local.dagu.server"
curl -fsS http://127.0.0.1:8080/api/v1/health
```

Una primera instalación empieza en `bootstrap`. La aceptación en estación es
`state = running`, health `healthy`, el `cmp` de base sin diferencias y
`--check` con los tres archivos `unchanged`. El instalador deja estas acciones
de servicio al operador.

## Estado, progreso y despertar dirigido

La extensión observa los runs del repositorio mediante REST y SSE para el widget y un ledger durable de eventos para los avisos humanos y el éxito. Con UI muestra una línea por run en `aboveEditor` y conserva los toasts terminales. El despertar también funciona con `hasUI=false`. Resuelve el repositorio desde `origin`, incluso en linked worktrees, y descubre runs de las últimas 48 horas con `workspace=<repo>`, incluidos los que finalizaron entre barridos.

La herramienta `dagu_session_id` devuelve el ID persistente únicamente a la sesión principal. El coordinador lo pasa como `OMP_SESSION_ID` al encolar. Todo nodo con metadatos `humanTask` en waiting de `feature`, `poc` y `discovery` despierta al propietario, incluso con status global running. El succeeded final también despierta; feature y discovery conservan failed/aborted. Los avisos incluyen la compatibilidad:

```text
[DAGU STATE] run=<run-id> status=waiting step=<step> <issue=<issue>|dag=<dag>> bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped> iteration=<approvalIteration>
[DAGU STATE] run=<run-id> status=succeeded <issue=<issue>|dag=<dag>> bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped>
```

Los checkpoints de disponibilidad añaden `cause=<prompt resuelto>` con `primary dirty: <archivos>` o `primary on <rama>, expected <base>`. Conservan el mismo run en Waiting y liberan la cola. El operador restaura PRIMARY limpio en BASE_BRANCH respetando sus cambios, consulta `dagu status --run-id <id> feature` y ejecuta `dagu human-task push-back feature --run-id <id> --step start_primary_unavailable --expected-iteration <iteración observada>` (para cierre: `close_primary_unavailable`; para PoC: DAG `poc`, paso `base_primary_unavailable`). El detector comprueba otra vez; limpiar por sí solo mantiene Waiting. El DAG sigue creando y retirando worktrees.

Los avisos se entregan ocultos con `customType: "dagu-state"`, `display: false` y `deliverAs: "aside"`. Solo el agente main con el `OMP_SESSION_ID` exacto recibe avisos; ISSUE es opcional. Se aceptan params CLI y JSON. Una FIFO por sesión reclama sincrónicamente un único turno autónomo cuando está idle y continúa tras `agent_end`; durante un turno activo entrega los avisos como asides en orden.

El primer barrido establece una línea base silenciosa. Después, el lector consulta `/api/v1/event-logs` DEFAULT de Dagu 2.20.1, con `paginationMode=cursor`, agota las páginas y emite en orden persistido. Cada ronda vuelve a la cabecera para observar ingestión eventual, incluido el succeeded que aún no sea visible al finalizar el run. Un HTTP 400 con cursor reinicia el recorrido conservando deduplicación. Los IDs de eventos y las claves `(dagName, dagRunId, step_id, approval_iteration)` evitan duplicados; una iteración omitida es cero. El éxito se deduplica por run/status. SSE actualiza el widget; el ledger recupera las aperturas rápidas omitidas por snapshots. El estado de entrega dura durante esa observación de sesión; reiniciar o cambiar sesión establece una nueva línea base.

El widget usa el mismo plegado que los HUD `TODO` y `Subagents` de OMP: título `Workflows` en negrita, filas en árbol y, plegado, tres runs más una fila `… N more — /workflows`. El comando `/workflows` alterna entre plegado y desplegado (hasta ocho runs, por el límite de diez líneas de OMP para widgets de extensión); `/workflows expand` y `/workflows collapse` fijan ese estado. `/workflows hide` retira el widget y `/workflows show` (o `/workflows` a secas) lo devuelve; el estado dura lo que el proceso OMP y se conserva al cambiar de sesión. Los runs se ordenan por completitud: primero los más cercanos a terminar. Cada línea identifica el tipo de workflow abreviado (`feat` para `feature`) y el issue, muestra el progreso por nodos, el paso actual y, cuando existe, su actividad. La CLI `gh` es opcional y añade el slug del título.

```text
Workflows
 └─ feat #227 widget-plegable ▱▱▱▱▱▱ 0/1 implement waiting · eval Probe (2s)
```

Cada fila usa `<tipo> <identidad> <barra> <done>/<total> <paso> <estado>[ · <actividad>]`; la compatibilidad se informa solo en `[DAGU STATE]`.

Si REST o las cabeceras SSE exceden su timeout, el widget conserva los runs conocidos y muestra `dagu · lento · reintentando en Ns`. Una conexión rechazada/reseteada o un HTTP 5xx muestra `dagu · sin conexión · reintentando en Ns`. Ambos estados usan el backoff existente (1–30 s); una ronda exitosa restaura la vista normal.

- Un paso de comando `running` consulta cada dos segundos `GET /api/v1/dag-runs/{name}/{dagRunId}/steps/{step}/log?tail=3` y muestra su última línea no vacía.
- Un `human.task` `triage`, `run_poc` o `implement` en `waiting` localiza la sesión coordinadora con `PRIMARY` y `OMP_SESSION_ID`, selecciona el transcript determinista `TriageReview<ISSUE>`, `Poc<ISSUE>` o `Implement<ISSUE>` y muestra `<herramienta> <intención> (<edad>s)`, sin nombre de tarea. La intención se toma de `i`, luego `title` y luego el argumento principal. Los reintentos `<Nombre>v<N>` son válidos y gana el archivo más reciente.
- La lectura del transcript está acotada a sus últimos 256 KiB y descarta líneas parciales. Logs, herramientas e intenciones se sanean y truncan antes de renderizar. Sin log o transcript disponible, la línea conserva el estado sin actividad.

SSE sigue aplicando inmediatamente las transiciones del run; el refresco periódico cubre actividad que SSE no emite por línea. Al cambiar de paso, terminar el run o recibir `session_shutdown`, se abortan la lectura y su temporizador. Las caídas de REST o SSE muestran una reconexión con backoff sin interrumpir la sesión.

```text
Workflows
 ├─ feat #182 actividad-real-del-step ▰▰▰▰▱▱ 4/6 gate running · > npm test
 ├─ feat #183 orden-del-widget ▰▱▱▱▱▱ 1/5 implement waiting · Implement183 · edit src/status/progress.ts (12s)
 └─ feat #184 plegado-del-widget ▱▱▱▱▱▱ 0/5 triage running
 … 2 more — /workflows
```

Las extensiones usan `fetch` y un parser SSE propios, sin dependencias runtime externas; el instalador de estación usa `yaml` para conservar la configuración compartida. La extensión solo observa y despierta; las acciones humanas y la reconciliación pertenecen a Dagu y al operador. Si la sesión de destino no está ejecutándose, no recibe aviso. Si el mismo ID de sesión está abierto a la vez en dos procesos OMP, ambos coinciden y ambos despiertan.

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

## Protección de recursos del ciclo

El guard OMP intercepta llamadas de la herramienta `bash` con `git worktree
remove`, `rm -r`/`rm -rf` y `git branch -d`/`-D`. Resuelve `cwd`, `cd`,
`git -C`, rutas absolutas/relativas y symlinks; consulta las histories JSON de
`feature` y `poc` con sus parámetros string. Para recursos de runs `queued`,
`running` o `waiting`, bloquea la llamada completa antes de ejecutarla:

```text
dagu-feature: <ruta|rama> belongs to active run <run-id> (<status>)
```

El checkout primario y su rama permanecen protegidos incluso sin propietario.
Una lectura de ownership fallida rechaza la eliminación gestionada con su causa.
Es una intercepción de comandos literales de `bash` en OMP, no una frontera de
aislamiento del sistema operativo: no interpreta expansiones del shell,
scripts externos, comandos construidos dinámicamente ni otras herramientas.

`admit` registra el propietario `(PRIMARY canónico, ISSUE)` en los metadatos Git.
Para recuperar un candidato retenido de un run terminal, reencola con ID sufijado
y los mismos ISSUE, BRANCH y OMP_SESSION_ID. `admit` conserva `previous-owner`
en el estado del nuevo run; `start_gate` valida y transfiere ambas identidades,
conservando HEAD y archivos. Sus reintentos reutilizan la identidad adoptada.

Admisión, creación y cleanup se serializan mediante un directorio-lock por issue,
retenido hasta terminar cada operación. El mismo run reutiliza la rama y el
worktree, incluidos commits y archivos existentes; un segundo propietario activo
recibe un diagnóstico. Un traspaso terminal valida y conserva el candidato y su
rama. Un lock que permanece tras terminar el proceso requiere inspección del
operador antes de recuperarlo.

`close_gate` y `handler_on.exit` ejecutan fuera de las tool calls del coordinador:
comprueban identidad canónica, ubicación gestionada y propietario antes de borrar.
La repetición converge localmente, incluido un cierre parcialmente completado.
Para un recurso terminal, leer primero `dagu status --run-id <id> feature`
(o `poc`), inspeccionar el HEAD y los archivos retenidos, conservar/publicar los
commits necesarios y recuperar mediante el mismo ciclo o un run con sufijo.
Cuando el operador decide retirar un recurso terminal o sin dueño, las llamadas
literales de eliminación quedan disponibles; el primario sigue protegido.


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

Los cuatro renders de a4s adoptan el bundle `0.3.8` desde
`pablontiv/a4s@fe5d444e9c9133d5bac3d2aeef054fee56d01fdb`, mediante
`bootstrap-a4s-v0-3-8`, para Dagu `2.20.1` (#271). La adopción actualiza
los renders y su documentación sin modificar las plantillas distribuidas.

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
`[DAGU STATE] run=<id> status=waiting step=<paso> dag=discovery bundle=<version|unstamped> extension=<version> compat=<ok|incompatible|unstamped> iteration=<n>`.

### Versión, sello y compatibilidad

La versión de `package.json` identifica el bundle completo. Cada DAG generado
lleva en la primera línea el sello con versión, repositorio y SHA fuente, run de
bootstrap y versión de Dagu, además de la etiqueta
`dagu-feature-bundle=<version>`. La extensión compara esa etiqueta con su propia
versión: exige el mismo major y, mientras sea `0`, también el mismo minor. Un
DAG sin etiqueta queda `unstamped`; una versión fuera de la regla queda
`incompatible`. Ambos estados se muestran como advertencia en el aviso `[DAGU STATE]` y no bloquean runs.

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

## Entrega y candidato de feature

`implement` entrega archivos dentro del worktree asignado (modificados, nuevos,
borrados, renombrados y binarios), más `SUMMARY` y `MESSAGE` convencional en el
formulario. Dagu valida PRIMARY/worktree canónicos, rama y propietario run/sesión,
rechaza escapes externos por symlink conservando la entrega, y hace staging y
commit con un índice privado. El acceso directo de la TUI a Git y al store de
Dagu hace esta separación **advisory**, no una barrera de seguridad.

El estado por run (`<git-dir>/dagu-feature/runs/<RUN>`) conserva `base`, el patch
binario `diff.patch` y `candidate.json` con SHA, árbol, resumen, mensaje e
iteración. Repetir la captura recupera el mismo SHA y número de commits; las
fechas Git se derivan del run y la iteración. Una corrección sustituye el
candidato por un único commit sobre la base y archiva la evidencia anterior en
`historical/<SHA>/`. Tras un conflicto Dagu prepara la base nueva y deja los
archivos para resolver en el mismo worktree y rama; el implementador entrega
esos archivos resueltos y Dagu los captura.

`checkpoint_push` compara dependencias localmente. `gate` ejecuta todas las
verificaciones declaradas en `GATE` y registra su comando y SHA en `gate.json`.
Una corrección o rebase exige renovar esa evidencia; `push` publica únicamente
el candidato actual con evidencia vigente y worktree limpio. `auto_merge` vuelve
a comprobar ese vínculo antes de solicitar la fusión del SHA probado.

## Desarrollo

```sh
npm test --workspace @a4s/omp-dagu
npm run typecheck --workspace @a4s/omp-dagu
```

Las pruebas vivas usan Dagu 2.20.1 del `PATH`, un `DAGU_HOME` temporal y un
puerto HTTP propio por fixture. Además, cada instancia genera un único
`randomUUID()` y deriva los IDs `recovery-<healthy|gate|start_gate|push>-<uuid>`,
manteniendo el nombre de DAG `feature`. Enqueue, REST, status, completion,
push-back y handlers comparten exactamente ese ID.

En Unix, el socket de control de Dagu 2.20.1 pertenece al namespace global del
host: [`sock.Addr`](https://github.com/dagu-org/dagu/blob/v2.20.1/internal/cmn/sock/addr.go)
deriva `/tmp/@dagu_feature_<hash>.sock` de `(nombre del DAG, run-id)`, con los
primeros seis caracteres de `md5(nombre + run-id)`. Los homes y puertos propios
aíslan el store y HTTP; el sufijo por instancia separa las identidades de los
sockets entre suites concurrentes.

`concurrent recovery fixtures keep distinct run identities` ejecuta ambos
fixtures simultáneamente para los cuatro modos, comprueba checkpoints,
iteraciones y SHA propios, y registra homes, puertos, pares DAG/run y sockets.
Cada fixture retira solo su servicio, home y repositorios temporales; tras
cerrar uno, el otro completa normalmente su run. La cola operativa por
repositorio conserva su concurrencia de uno.

Las integraciones reales requieren `dagu` en `PATH` con la versión indicada por
`daguFeature.dagu` en `package.json`. Comprueba `command -v dagu` y `dagu version`
antes de ejecutarlas localmente; los guards locales de disponibilidad omiten los
casos protegidos cuando falta el runtime. Los fixtures usan homes temporales y
puertos propios, independientes del servicio de la estación.

La matriz de CI instala Dagu únicamente para `@a4s/omp-dagu`: descarga el tarball
oficial Linux amd64 y `checksums.txt` de la release fijada, registra y verifica
SHA-256, e instala el ejecutable en un directorio temporal publicado en
`GITHUB_PATH`. Un paso posterior registra la ruta y exige que `dagu version`
coincida exactamente con el pin antes de ejecutar el comando de tests habitual.
Los fallos de descarga, checksum o versión detienen el job y se reflejan en
`validate`; las integraciones vivas aplicables se ejecutan con ese runtime.

El gate completo del repositorio es:

```sh
npm ci && npm test && npm run typecheck
```

Las pruebas cubren el parser SSE, progreso y actividad viva de comandos y subagentes, identidad y títulos de issues, resolución de repositorios/worktrees, transiciones y avisos del widget, la correlación nativa y el contrato estructurado del guard de triage, y la verificación fail-closed del transcript real ejecutada desde ambos DAG `feature.yaml`.
