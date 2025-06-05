# OMP Dagu

OMP package for the Dagu issue lifecycle: progress widget, admission and quality guards, `triage-reviewer` and `plan-reviewer` agents, and the `dagu-feature`, `backlog-breakdown`, and `discovery` skills and templates. Requires Node.js >=22.19.0 and official Dagu `2.20.1` with local authentication `none`.

## Runtime distribution

`daguFeature.dagu` is the exact output required from `dagu version`: `2.20.1`.
CI derives the version from the package manifest and downloads the official
release from `https://github.com/dagu-org/dagu/releases/download/v${version}`.
It verifies the selected `dagu_${version}_linux_amd64.tar.gz` archive against
the upstream `checksums.txt` before extraction; the parallel live lanes use
that same runtime. For a local Darwin arm64 runtime, select the official
`dagu_2.20.1_darwin_arm64.tar.gz` archive from the same release. Each archive
contains the executable `dagu` at its root.

After downloading the selected archive and upstream `checksums.txt` into the
same directory, select only that archive's checksum (Darwin arm64 shown):

```sh
asset="dagu_2.20.1_darwin_arm64.tar.gz"
awk -v asset="$asset" '$2 == asset { print; found=1 } END { if (!found) { print "Missing checksum for " asset > "/dev/stderr"; exit 1 } }' checksums.txt > checksum.txt
```

Then run `sha256sum --check --strict checksum.txt` on Linux or
`shasum -a 256 --check checksum.txt` on macOS before extraction, and require
the executable's `version` output to equal the manifest pin exactly.

This distribution restoration does not repair the known upstream Dagu 2.20.1
state-repair race. Global installation, service activation and production queue
resumption remain separate operator-authorized actions under the station
procedure below.

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

Usar el directorio completo permite que OMP descubra las dos extensiones, los agentes distribuidos en `agents/` y los skills de `skills/`. `DAGU_URL` es la raíz del servidor (por defecto `http://127.0.0.1:8080`).

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
instala o actualiza la configuración con el binario oficial Dagu `2.20.1` en `PATH`:

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
`port=8080` y `coordinator.enabled=true`. Cada repositorio es dueño de su
concurrencia: el bootstrap deriva su entrada `queues.config` desde la etiqueta
`dagu-feature-queue-concurrency=<n>` versionada en sus renders. El instalador de
estación conserva esas entradas, sus metadatos, el resto de claves y comentarios.
La validación aislada mantiene intactas las rutas ajenas.

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

### Concurrencia propiedad del repositorio

El formulario del bootstrap incluye `QUEUE_CONCURRENCY`, entero ≥ 1 introducido
como texto. Por los defaults estáticos de Dagu 2.20.1, usa `type: string`,
`default: ""` y patrón `^([1-9][0-9]*)?$`: vacío conserva el valor sellado
mostrado en el prompt, o 1 sin sello. Para a4s se responde **8**, preservando la capacidad efectiva instalada.
`feature.yaml`, `poc.yaml` y `discovery.yaml` versionan el mismo
valor junto al sello del bundle. La entrada global se deriva exclusivamente de
ese valor: `config.yaml` nunca se edita a mano.

El paso `reconcile` fusiona solo la entrada de la cola del repo, conservando
`queues.enabled`, otras claves y otras colas. Si cambia, identifica con
`launchctl print` el servicio activo `gui/$UID/local.dagu.server`, comprueba en su
plist `dagu start-all` y el mismo `DAGU_HOME`, y ejecuta
`launchctl kickstart -k gui/$UID/local.dagu.server`. Si no puede determinar ese
mecanismo falla antes de escribir y pide instalar/cargar el servicio correcto.
Una entrada idéntica no reinicia. Los runs que esperan tareas humanas conservan
su estado persistido. `confirm` imprime
`queue=<repo> max_concurrency=<n> changed=yes|no`.

`dagu-feature-bundle <repo>` compara cada sello con la entrada global y señala
deriva como `compat=incompatible action=re-run-bootstrap`; se reconcilia
repitiendo el bootstrap y adoptando sus renders.

### Acciones de estación (operador)

Una primera instalación activa el plist con `launchctl bootstrap` y comprueba
`state = running`, health `healthy`, el `cmp` de base sin diferencias y
`--check` con los tres archivos `unchanged`. Para actualizar una estación activa,
el operador usa la aplicación drenada descrita a continuación, con los mismos
parámetros `--launch-agent` y `--log-dir` de su instalación.

## Configuración de estación y reinicio drenado

El mismo instalador aplica los archivos versionados y por defecto **difiere el
reinicio**, incluso si el historial parece inactivo. La aplicación con `--apply`
mantiene la instalación idempotente del plist/base y la comprobación aislada de
Dagu 2.20.1. `--repo-dag <render>` identifica la cola y capacidad versionadas que
ya derivó el bootstrap; el instalador requiere que coincidan con config y usa ese
valor para sus probes. `--check` compara sin aplicar y es excluyente con `--apply`.

Escribir el archivo no recarga la concurrencia del scheduler activo. Después del
merge, el operador aplica la configuración con hooks de estación explícitos:

```sh
node /ruta/al/clon/primario/packages/omp-dagu/bin/dagu-station-install.ts \
  --dagu-home "$DAGU_HOME" --apply --repo-dag .workspace/dagu/dags/feature.yaml \
  --admission-close "$CLOSE_ADMISSION" \
  --restart-command "$RESTART_SERVICE" \
  --admission-open "$OPEN_ADMISSION"
```

Los tres valores son comandos de shell aprovisionados por el operador para esa
estación. Se ejecutan con el mismo `DAGU_HOME` y `DAGU_RESTART_SIGNAL=TERM`.
Su contrato es:

1. `CLOSE_ADMISSION` coordina y espera la detención de **todos** los productores:
   sesiones OMP, CLI/API, automatizaciones y nuevos triggers programados, también
   los del propio scheduler. Mantiene esa exclusión hasta `OPEN_ADMISSION`.
   Un archivo de lock del instalador serializa instaladores, pero la coordinación
   de productores es responsabilidad de este hook; un `true` solo es válido en
   un entorno ya aislado sin productores ni schedules.
2. El instalador espera `dagu history --status running --format json --limit 1`
   y la consulta equivalente `--status queued`, ambas vacías. Los runs ya
   encolados terminan con el scheduler anterior. Una lectura aislada `running=0`
   con admisión abierta no establece seguridad.
3. `RESTART_SERVICE` envía **TERM** al servicio `start-all` drenado y espera que
   su reemplazo esté listo con el mismo home/config. En launchd, la operación
   de señal es `launchctl kill SIGTERM "gui/$(id -u)/local.dagu.server"`; el hook
   además debe esperar el nuevo PID y su readiness. La activación/instalación
   del LaunchAgent y estos hooks pertenecen al operador.
4. Con admisión todavía cerrada, el instalador encola N+1 runs de prueba con IDs
   únicos en la cola del render de `--repo-dag`: verifica N `running` retenidos
   en una barrera y uno `queued`, libera la barrera y espera todos `succeeded`.
   Imprime `verified next enqueue queue=<repo> max_concurrency=<n> succeeded=<n+1>`
   antes de ejecutar `OPEN_ADMISSION`. Retira las definiciones de prueba exitosas;
   el historial de Dagu conserva la evidencia.

`--timeout-seconds` (600 por defecto) acota cada espera/comando. Ante un fallo
después de empezar a cerrar admisión, esta queda cerrada: el operador inspecciona
historial, servicio y salida del instalador antes de abrirla explícitamente.
El directorio `<DAGU_HOME>/.station-install.lock` conserva las barreras liberadas;
si quedaron probes encolados, conservarlo hasta que terminen.
Después de recuperar la estación y completar sus probes, retirar ese directorio
permite repetir la aplicación. Un segundo instalador falla mientras exista.

La ruta mantenida es **drenaje + TERM de start-all**, demostrada con capacidad
1→2 en la [PoC de #255](https://github.com/pablontiv/a4s/issues/255).
La alternativa scheduler-only SIGKILL no está adoptada: la PoC preservó hijos
al matar únicamente un PID, pero el operador aún debe demostrar que launchd
preserva los ejecutores bajo su gestión de grupos. La evidencia se limita a
runs locales de Dagu 2.20.1, no a workers distribuidos ni reinicios del host.
Este cambio de paquete no aplica nada a la estación.

## Estado, progreso y despertar dirigido

La extensión observa los runs del repositorio mediante REST y SSE para el widget y un ledger durable de eventos para los avisos humanos y el éxito. Con UI muestra una línea por run en `aboveEditor` y conserva los toasts terminales. El despertar también funciona con `hasUI=false`. Resuelve el repositorio desde `origin`, incluso en linked worktrees, y descubre runs de las últimas 48 horas con `workspace=<repo>`, incluidos los que finalizaron entre barridos.

La herramienta `dagu_session_id` devuelve el ID persistente únicamente a la sesión principal. El coordinador lo pasa como `OMP_SESSION_ID` al encolar. Todo nodo con metadatos `humanTask` en waiting de `feature`, `poc`, `discovery` y `planning` despierta al propietario, incluso con status global running. El succeeded final también despierta; feature, discovery y planning conservan failed/aborted. Los avisos incluyen la compatibilidad:

```text
[DAGU STATE] run=<run-id> status=waiting step=<step> <issue=<issue>|dag=<dag>> bundle=<version|unstamped> extension=<version> main=<version|unknown|n/a> compat=<ok|stale|incompatible|unstamped> iteration=<approvalIteration>
[DAGU STATE] run=<run-id> status=succeeded <issue=<issue>|dag=<dag>> bundle=<version|unstamped> extension=<version> main=<version|unknown|n/a> compat=<ok|stale|incompatible|unstamped>
```

El primario se mantiene exactamente en `origin/$BASE_BRANCH`: `admit` y PoC
`base` hacen fetch y fast-forward del primario limpio antes de comparar HEAD y
la versión del manifiesto con origin. Si siguen distintos, fallan con
`cause=primary_behind|primary_ahead|version_stale`, SHAs y versiones observadas
y esperadas; `admit` lo hace antes de tomar el lock.

En los avisos, bundle y extensión con el mismo major/minor son `compat=ok`,
incluida una diferencia de patch; distinto major/minor da `incompatible` y una
etiqueta ausente da `unstamped`. Se compara además la extensión con `main=`
solo cuando PRIMARY distribuye `packages/omp-dagu/package.json`: una versión
distinta da `stale`; un manifiesto ilegible o inválido da `main=unknown` y `stale`.
Los repositorios consumidores sin ese manifiesto muestran `main=n/a`.
Un aviso stale emite una notificación `warning` con instrucciones de reiniciar
OMP y re-sellar los renders, mientras el coordinador continúa el turno.
El reinicio carga la versión de main desde disco. La admisión sigue exigiendo
versiones exactamente iguales, incluido el patch.

Los checkpoints de disponibilidad añaden `cause=<prompt resuelto>` con `primary dirty: <archivos>` o `primary on <rama>, expected <base>`. Conservan el mismo run en Waiting y liberan la cola. El operador restaura PRIMARY limpio en BASE_BRANCH respetando sus cambios, consulta `dagu status --run-id <id> feature` y ejecuta `dagu human-task push-back feature --run-id <id> --step start_primary_unavailable --expected-iteration <iteración observada>` (para cierre: `close_primary_unavailable`; para PoC: DAG `poc`, paso `base_primary_unavailable`). El detector comprueba otra vez; limpiar por sí solo mantiene Waiting. El DAG sigue creando y retirando worktrees.

### Limpieza verificada y recuperación

`close_gate` y `handler_on.exit` comparten el contrato de limpieza del run:
PRIMARY y worktree canónicos, rama y propietario registrados por `start_gate`,
head actual y candidato probado. Retiran un worktree limpio con
`git worktree remove` cuando el candidato está contenido en la base remota
recién actualizada, o cuando el PR está MERGED con ese mismo candidato probado
y su commit efectivo de squash está confirmado en la base. Los archivos sucios,
la mera publicación y las consultas ambiguas conservan recursos y diagnóstico.
El borrado de refs exige el mismo propietario y SHA; el remoto usa un lease.
El cierre mergeado verifica además PRIMARY limpio exactamente en la base remota.

Cleanup evidence lives in `<git-dir>/dagu-feature/runs/<RUN>/`: `resource.json`,
`tested-sha`, `cleanup-head`, `cleanup-proof.json`, `cleanup-phase` and
`cleanup-diagnostic`. Repeating the cleanup script with the original parameters
recognizes resources already removed and rechecks integration and ownership
before each pending removal. The operator resolves cleanup diagnostics while
preserving changes and evidence; recovery and explicit ownership transfer are
described in `skills/dagu-feature/SKILL.md`.

Scheduled reconciliation discovers waiting feature runs and fans them out through
`tick` to `reconcile-run`. It observes PR state and required CI checks for the
current head, then completes or pushes back the paired `await_ci` and
`await_merge` checkpoints using the observed iteration. Pending checks preserve
the wait; ambiguous evidence remains visible for the owner to resolve.

La adopción fija `GATE`, `REBASE_RESOLVER`, `REQUIRED_CHECK` y el `PRIMARY` canónico en los renders de feature/PoC. Feature deriva `BRANCH=dagu/issue-$ISSUE`. La primera admisión rechaza esos cinco nombres como parámetros antes de modificar el repositorio. Encola feature con `ISSUE`, `PR_NUMBER` opcional y `OMP_SESSION_ID`; `BASE_BRANCH` conserva su default. Bootstrap declara los cambios de política. La promoción PoC usa el mismo contrato y conserva la sesión. Los consumidores consultan el spec encolado para resolver PRIMARY, incluido el historial del reconciliador.

Los avisos se entregan ocultos con `customType: "dagu-state"`, `display: false` y `deliverAs: "aside"`. Solo el agente main con el `OMP_SESSION_ID` exacto recibe avisos; ISSUE es opcional. Se aceptan params CLI y JSON. Una FIFO por sesión reserva sincrónicamente un único despertar autónomo cuando está idle. La admisión del host es asíncrona: `agent_start` vuelve a drenar la FIFO y entrega el resto del lote como asides dentro de ese mismo turno autónomo. Durante el turno activo, los avisos posteriores siguen llegando en orden en los límites de paso soportados por el host; `agent_end` libera la reserva para el siguiente despertar idle.

El primer barrido establece una línea base silenciosa. Después, el lector consulta `/api/v1/event-logs` DEFAULT de Dagu 2.20.1, con `paginationMode=cursor`, agota las páginas y emite en orden persistido. Cada ronda vuelve a la cabecera para observar ingestión eventual, incluido el succeeded que aún no sea visible al finalizar el run. Un HTTP 400 con cursor reinicia el recorrido conservando deduplicación. Los IDs de eventos y las claves `(dagName, dagRunId, step_id, approval_iteration)` evitan duplicados; una iteración omitida es cero. El éxito se deduplica por run/status. SSE actualiza el widget; el ledger recupera las aperturas rápidas omitidas por snapshots. El estado de entrega dura durante esa observación de sesión; reiniciar o cambiar sesión establece una nueva línea base.

El widget usa el mismo plegado que los HUD `TODO` y `Subagents` de OMP: título `Workflows` en negrita, filas en árbol y, plegado, tres runs más una fila `… N more — /workflows`. El comando `/workflows` alterna entre plegado y desplegado (hasta ocho runs, por el límite de diez líneas de OMP para widgets de extensión); `/workflows expand` y `/workflows collapse` fijan ese estado. `/workflows hide` retira el widget y `/workflows show` (o `/workflows` a secas) lo devuelve; el estado dura lo que el proceso OMP y se conserva al cambiar de sesión. Los runs se ordenan por completitud: primero los más cercanos a terminar. Cada línea identifica el tipo de workflow abreviado (`feat` para `feature`) y el issue, muestra el progreso por nodos, el paso actual y, cuando existe, su actividad. La CLI `gh` es opcional y añade el slug del título.

```text
Workflows
 └─ feat #227 widget-plegable ▱▱▱▱▱▱ 0/1 implement running · eval Probe (2s)
```

Cada fila usa `<tipo> <identidad> <barra> <done>/<total> <paso> <estado>[ · <actividad>]`; la compatibilidad se informa solo en `[DAGU STATE]`.

Si REST o las cabeceras SSE exceden su timeout, el widget conserva los runs conocidos y muestra `dagu · lento · reintentando en Ns`. Una conexión rechazada/reseteada o un HTTP 5xx muestra `dagu · sin conexión · reintentando en Ns`. Ambos estados usan el backoff existente (1–30 s); una ronda exitosa restaura la vista normal.

- Un paso de comando `running` consulta cada dos segundos `GET /api/v1/dag-runs/{name}/{dagRunId}/steps/{step}/log?tail=3` y muestra su última línea no vacía.
- El `human.task` `run_poc` en `waiting` localiza la sesión coordinadora con `PRIMARY` y `OMP_SESSION_ID`, selecciona el transcript `Poc<ISSUE>` (incluidos reintentos `v<N>`) y muestra `<herramienta> <intención> (<edad>s)`. La intención se toma de `i`, luego `title` y luego el argumento principal; gana el archivo más reciente.
- La lectura del transcript está acotada a sus últimos 256 KiB y descarta líneas parciales. Logs, herramientas e intenciones se sanean y truncan antes de renderizar. Sin log o transcript disponible, la línea conserva el estado sin actividad.

SSE sigue aplicando inmediatamente las transiciones del run; el refresco periódico cubre actividad que SSE no emite por línea. Al cambiar de paso, terminar el run o recibir `session_shutdown`, se abortan la lectura y su temporizador. Las caídas de REST o SSE muestran una reconexión con backoff sin interrumpir la sesión.

```text
Workflows
 ├─ feat #182 actividad-real-del-step ▰▰▰▰▱▱ 4/6 gate running · > npm test
 ├─ feat #183 orden-del-widget ▰▱▱▱▱▱ 1/5 implement running
 └─ feat #184 plegado-del-widget ▱▱▱▱▱▱ 0/5 triage running
 … 2 more — /workflows
```

Las extensiones usan `fetch` y un parser SSE propios, sin dependencias runtime externas; el instalador de estación usa `yaml` para conservar la configuración compartida. La extensión solo observa y despierta; las acciones humanas y la reconciliación pertenecen a Dagu y al operador. Si la sesión de destino no está ejecutándose, no recibe aviso. Si el mismo ID de sesión está abierto a la vez en dos procesos OMP, ambos coinciden y ambos despiertan.

### Status timeout fixture verification

From `packages/omp-dagu`, run:

```sh
A4S_LIVE_DAGU=0 npx --no-install tsx --test test/status-timeout.test.ts
```

The six scenarios cover discovery, run details and SSE headers: an 8000 ms
response succeeds, while a 15001 ms response is aborted by the client's
15000 ms network deadline. The fixture resolves its workspace with the existing
repository resolver before mocking time, using the same checkout cwd as the
status observer. Its run labels therefore match both canonical origins such as
`a4s` and issue-clone origins such as `issue-337`.

Expected-request readiness has a separate 10000 ms real-time deadline, captured
before Node's `setTimeout` mock is enabled. A missing request reports its phase,
expected path, workspace, cwd and observed requests. The readiness timer is
cleared on success or failure; session shutdown aborts pending fake fetches and
closes the simulated SSE stream. Isolated verification of either origin should
complete all six scenarios within a 30-second external process bound.

## Trabajos semánticos Dagu → OMP

Los comandos `dagu-role-jobs stage triage|implement|quality_review` arrancan obligaciones
autorizadas sin un turno del coordinador. Reutilizan el registro nativo OMP,
sus prompts, roles, arrays completos de modelos y fallback de sesión. Conflictos
usa `task` con alcance sobre archivos retenidos; `validation` es decisión humana.
`quality_review` une explícitamente dos role-jobs nativos QA/reviewer.
`quality_admit` consume sus recibos autoritativos con `dagu-role-jobs admit-quality`,
escribe `quality.json` verificado y sella la admisión antes de la transición.
El servicio requiere Bun y el runtime OMP instalado
(`OMP_ROLE_RUNTIME` permite seleccionar su raíz).

El contrato estable **schemaVersion 1** conserva
`<git-common>/dagu-feature/runs/<run>/role-jobs/<id>/{job,result}.json` y los
artefactos nativos. El id es SHA-256 del JSON canónico con claves ordenadas:

```json
{"repo":"<PRIMARY canónico>","worktree":"<worktree canónico>","lane":"feature","dag":"feature","run":"<run>","stage":"quality_review","role":"qa","sha":"<40 hex>","iteration":0,"attempt":"<intento actual>"}
```

`result.json` contiene `schemaVersion`, `id`, `binding`, identidad de ejecutor
`{host,pid,processStartedAt}`, estado `completed|failed|interrupted`,
`readyAt`, `startedAt`, `finishedAt`, `readyToStartMs`, `output` o `error`, y
`native` cuando existe: sesión/transcript, sello de prefijo `bytes`/`digest`,
evento emisor, proveedor/modelo efectivos, intentos, fallbacks y routing completo.
`routing.json`, `assignment.json`, `native-result.json` y `<id>.jsonl` retienen
las evidencias, incluida la versión OMP y el hash de su ejecutor.
`IMPLEMENTER` y el `REVIEW` de triage transportan ids de trabajo. La admisión
actual enlaza el recibo nativo del implementer con el SHA/iteración del candidato
mediante `candidate.json.implementation` (HEAD de entrada y digest del resultado).
Conserva el modelo/familia efectivos; QA/reviewer tienen sesiones frescas distintas,
enlazadas al trabajo autorizado y su evento emisor. #517 consume esta evidencia
semántica. Un `verdict=FAIL` conserva ejecución completada,
jamás aceptación de calidad. Las observaciones #277 mantienen el recibo inicial.
[SKILL](skills/dagu-feature/SKILL.md#role-job-receipt-contract-schemaversion-1).

El verificador de triage informa el PRIMARY canónico, el recibo exacto del
role-job y su transcript nativo. Los rechazos conservan la causa y
`VERIFIER=FAIL` antes de escribir estado o publicar el comentario de triage.

La revisión se vincula por el marcador exacto `Authorized Dagu role job <id>.`
y el recibo sellado (repositorio, run, SHA, iteración e intento), no por el nombre
del agente ni por el texto del criterio. `triage-reviewer` sigue siendo el agente
registrado por defecto y conserva su criterio y routing OMP; el executor inyecta
el esquema canónico de `src/triage/schema.ts`, idéntico al de su definición.
El verificador valida todos sus campos y conserva diagnósticos
`TRIAGE_REVIEW_INVALID: field=... expected=... observed=...`.
El recibo de trabajo sustituye la correlación de tareas del coordinador:
la revisión actual pertenece al paso nativo y a su intento autorizado.

SQLite en `$DAGU_HOME/role-jobs.sqlite` serializa claims y recupera resultados
entre procesos. Su capacidad es **sesiones activas de este boundary por
DAGU_HOME canónico**, configurable con `A4S_ROLE_JOB_CAPACITY` (por defecto 4)
y fijada en el primer claim; configuraciones posteriores deben coincidir.
Es independiente de las colas Dagu y de los semáforos locales de OMP/proveedor,
no un límite global de otras sesiones del host. Roles mutantes excluyen el
worktree afectado; otras obligaciones avanzan dentro de su capacidad.
La duplicación reutiliza la ejecución viva o el resultado durable. Reiniciar
el scheduler conserva el trabajador vivo. Un propietario ausente se diagnostica
`interrupted`, retiene evidencia y libera su plaza. Tras inspeccionar efectos,
se reintenta el mismo paso con `dagu retry --run-id <run> --step triage|implement
--downstream feature`: el nuevo `startedAt` nativo identifica el intento.

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

OMP resolves `skill://dagu-feature` and its templates from the package's `skills/dagu-feature/`. `SKILL.md`, `feature.yaml`, `poc.yaml`, `discovery.yaml`, `planning.yaml`, `reconcile.yaml`, and `dagu-feature-bootstrap.yaml` stay together for relative links and bootstrap's `$SKILL_DIR/<file>` paths.

`dagu-feature` coordinates issue execution with subagents; `backlog-breakdown` owns issue creation and session-level Sprint Planning owns new-work selection. Distributed templates and adopted `.workspace/dagu/dags/<dag>.yaml` renders have separate publication stages: template changes ship in the package PR; the operator subsequently bootstraps and adopts stamped renders. Documentation of the new contract does not establish deployment to a primary checkout or consumer repository.

Para la adopción de a4s, `TEST_PATHS` es
`(^|/)(test|tests)/|\.test\.(ts|cjs)$`.
El formulario de bootstrap también transporta `REBASE_RESOLVER` (vacío para
recuperación manual). a4s declara
`node packages/omp-dagu/bin/dagu-bundle-rebase.mjs`, ejecutado en el worktree
cuando Git detiene el rebase por conflictos, con base, upstream y candidato
verificados en `DAGU_REBASE_BASE`, `DAGU_REBASE_UPSTREAM` y
`DAGU_REBASE_CANDIDATE`. El comando stagea metadatos inequívocos: manifiesto,
entrada workspace del lock, literal histórico de identidad y nuevo bloque del
CHANGELOG. Calcula el parche consecutivo sobre la base actual y conserva una
intención explícita compatible de major/minor. Sale `0` con índice completamente
resuelto, `2` con conflictos que debe resolver `implement`; otros códigos fallan
el paso. Se conservan los diagnósticos de Git y los conflictos funcionales,
incluidos los de esos mismos archivos. Antes del gate se archiva la evidencia
del SHA anterior y se actualizan candidato, base y patch; gate y push acreditan
el SHA normalizado. `package.json` es la autoridad única de la identidad exportada.


Los cuatro renders de a4s adoptan el bundle `0.3.8` desde
`pablontiv/a4s@fe5d444e9c9133d5bac3d2aeef054fee56d01fdb`, mediante
`bootstrap-a4s-v0-3-8`, para Dagu `2.20.1` (#271). La adopción actualiza
los renders y su documentación sin modificar las plantillas distribuidas.

Todo cambio en esas cinco plantillas o en `SKILL.md` exige una versión del
paquete mayor que la de la base del PR (`git merge-base origin/main HEAD`) y
una sección `## <versión>` en `CHANGELOG.md`; `npm test` lo comprueba,
incluyendo cambios locales rastreados y obteniendo main y su historia en CI
shallow. En 0.x, subir el minor indica ruptura de compatibilidad. Tras un merge
que toca `packages/omp-dagu/skills/**` o `packages/omp-dagu/CHANGELOG.md`,
`close_gate` encola automáticamente el bootstrap del primario:

```sh
skill_dir="$PRIMARY/packages/omp-dagu/skills/dagu-feature"
version=$(jq -r .version "$PRIMARY/packages/omp-dagu/package.json")
dagu enqueue --run-id "bootstrap-a4s-v${version//./-}" "$skill_dir/dagu-feature-bootstrap.yaml" -- \
  PRIMARY="$PRIMARY" SKILL_DIR="$skill_dir"
```

Este comando también sirve para recuperar el re-sello. El operador reinicia OMP
tras el merge del paquete, completa `answers` con los valores instalados y
comprueba `render`/`confirm`. El bootstrap deja los renders sellados en staging
Git; una issue de adopción los entrega mediante el ciclo normal. Sus cabeceras y
labels quedan en la versión de main con el SHA real del source y el ID del
bootstrap; una sesión nueva y los renders adoptados muestran las tres versiones
iguales y `compat=ok`.

## Discovery

Bootstrap renders `.workspace/dagu/dags/discovery.yaml`. Its `workspace=<repo>` label identifies the coordinating workspace; `PRIMARY` selects the adopted repository to inspect.

```sh
node packages/omp-dagu/bin/dagu-feature-bundle.ts enqueue \
  --run-id "discovery-<id>" .workspace/dagu/dags/discovery.yaml -- \
  LENSES="0,1,2" SOURCE="<request-context>" LIVE_TARGET="" \
  PRIMARY="/absolute/path/to/repository" OMP_SESSION_ID="<dagu_session_id>"
```

`snapshot` prints the persistent output directory. The coordinator supplies per-lens findings at `discover`, independent verdicts at `validate`, and consolidated units at `consolidate`. Deterministic checks validate these artifacts. Discovery hands off absolute `breakdown-units.jsonl` to `planning.yaml`, using rows `{id,title,dag:"feature",labels:[classification],body,source:"discovery",findings}`. Classification labels come from the discovery schema; the body retains the discovery marker and provenance.

The shared backend owns independent plan review, operator approval, and issue creation. Discovery preserves per-lens findings and temporal history for subsequent runs and records the backend run ID. It does not schedule new feature/PoC work.

## Backlog breakdown and sprint ownership

[`backlog-breakdown`](skills/backlog-breakdown/SKILL.md) operates `planning.yaml`, the single issue-creation backend for refinement and discovery. Refinement owns corrections to its source units; explicit push-back reimports the corrected source.

Upstream preparation and native `check_plan` share the package's canonical schema and validator:

```sh
node packages/omp-dagu/bin/dagu-feature-bundle.ts validate-planning-units \
  --input "/absolute/path/to/units.jsonl" --snapshot "/absolute/path/to/validated-units.jsonl" \
  --findings "/absolute/path/to/findings.md"
```

Validation reports all independent mechanical failures as JSONL ordered by `line`, `field`, and `rule`, with `expected` and explicit `observed` values (`{"missing":true}` for missing fields). Invalid input exits nonzero; only valid input produces an exact-byte snapshot. The independent semantic reviewer still owns completeness, duplication and judgment.

```sh
node packages/omp-dagu/bin/dagu-feature-bundle.ts enqueue \
  --run-id "<repo>-breakdown-<slug>" .workspace/dagu/dags/planning.yaml -- \
  UNITS_FROM="/absolute/path/to/units.jsonl" SOURCE=refine \
  PRIMARY="/absolute/path/to/primary" OMP_SESSION_ID="<dagu_session_id>"
```

`init` initializes durable run artifacts; `import_units` imports the required absolute `UNITS_FROM`; `check_plan` validates units; `review` requests an independent `plan-reviewer`; and `check_review` validates that review. The operator approves all or selected unit IDs at `approve`, including every referenced same-snapshot target. `materialize` creates/reuses issues and records `issues.jsonl`. Optional `revision: {issue: 444, fields: ["title","body","labels"]}` applies only the listed fields from the canonical root; an empty list binds identity only. Marker reuse leaves existing fields unchanged. Typed relationships become native blocked-by and sub-issue edges, preserving existing edges and diagnosing a different existing parent. Durable `materialization-<run>-<iteration>.json` and its exact units snapshot retain mappings, partial progress, intended state and grouped complete remote verification; mismatches fail rather than publish a success. Source and findings remain provenance in new issue bodies. Before explicit push-back from `review` or `approve`, inspect the current run-wide iteration; the rewind returns to `import_units`.

Sprint Planning in the coordinating session alone selects, ranks, and enqueues new work. Definition of Done and yes/no sprint-goal checks are planning/review content. A completed feature run proves its merged candidate and verified cleanup; it does not by itself prove the sprint goal. Review evaluates that evidence without adding a lifecycle gate. Reports enter refinement only with operator authorization; an FYI is not authorization.

PoC requires an existing `ISSUE`. `QUESTION` is optional when the issue supplies `## PoC`. The feature-to-PoC and successful-PoC-to-feature continuations remain lifecycle transitions, preserving the coordinating session rather than selecting new backlog work. Human approval checkpoints retain their existing owners.

### Versión, sello y compatibilidad

La versión de `package.json` identifica el bundle completo. Cada DAG generado
lleva en la primera línea el sello con versión, repositorio y SHA fuente, run de
bootstrap y versión de Dagu, además de la etiqueta
`dagu-feature-bundle=<version>`. La admisión exige el mismo major y, mientras
sea `0`, también el mismo minor entre paquete, DAG, reconciliador y extensión.
Identidades ilegibles, sellos/labels ambiguos, versiones incompatibles o renders
que no corresponden a su commit fuente se rechazan antes de crear el run, con
diagnóstico `DAGU_ADMISSION_REJECTED` y acción bootstrap/adopción/recarga.

El guard de OMP transforma `dagu enqueue` en bash al CLI del paquete, después
del cual el shell resuelve sus argumentos efectivos. Las promociones internas
usan `dagu-feature-bundle enqueue`: instalar ese binario en el `PATH` del servicio.
Fuera de OMP, usar explícitamente
`node /real/checkout/packages/omp-dagu/bin/dagu-feature-bundle.ts enqueue --run-id <id> <repo>/.workspace/dagu/dags/feature.yaml -- ISSUE=<n> OMP_SESSION_ID=<session>`.
`admit` reserva un ID de verificación y escribe el recibo sin crear un run.

Cada admisión guarda `sourceVersion`, `deploymentFingerprint` (SHA-256 de JSON
canónico con claves ordenadas) y `runReceipt` en
`$(git rev-parse --path-format=absolute --git-path dagu-feature/runs/<run>)/receipt.json`
(0600). La base `initial` conserva identidades/versiones/rutas/orígenes/digests,
relaciones fuente-render, DAG exacto, runtime/modelos, ejecución y estado externo;
los datos dinámicos pendientes tienen estado y causa explícitos. El CLI encola
los bytes admitidos, no una ruta de despliegue mutable.

El observador de estado agrega hechos REST/transiciones e incidentes de error o
timeout con DAG/run/intento. `dagu-feature-bundle observe <run> '<JSON>'` permite
agregar hechos resueltos por runtime/modelos (`dag`, `run`, `attempt`, `category`,
`kind`, `data`); las categorías son `deployment`, `runtimeAndModels`, `execution`
y `eventsAndExternalState`. Los nuevos hechos completan los pendientes sin
alterar el snapshot ni la huella inicial; un redeploy solo rige nuevas admisiones.
Recargar OMP tras cambiar la extensión: un digest cargado distinto del instalado
se rechaza hasta la recarga.

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
borrados, renombrados y binarios), más `SUMMARY`, `MESSAGE` convencional e
`IMPLEMENTER` (id del trabajo nativo cuya asignación incluye `FEATURE_IMPLEMENT RUN=<run>`).
Dagu valida PRIMARY/worktree canónicos, rama y propietario run/sesión,
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

`checkpoint_push` compara dependencias y conserva el candidato en
`refs/dagu/checkpoints/issue-N` con lease explícito, manteniendo el head del PR.
`gate` ejecuta todas las verificaciones declaradas en `GATE` y registra su comando
y SHA en `gate.json`. Una corrección o rebase exige renovar esa evidencia.

El cuerpo completo de `gate` se serializa por PRIMARY con un lock advisory del
kernel en `<git-common-dir>/dagu-feature/gate.lock`, antes de comprobar candidato,
rama y limpieza y hasta publicar `gate.json`/SHA. Python 3 con `fcntl` debe estar
en el PATH del servicio; bootstrap comprueba esa dependencia. El descriptor se
hereda al ejecutar Bash y sus descendientes: la exclusión dura hasta que todos
cierran sus copias, también tras error, cancelación o SIGKILL. El inode permanece
estable; el JSON run/PID que contiene es diagnóstico, no autoridad de ownership.
Un waiter sigue Running y conserva candidato y ticket; su log muestra
`gate: waiting ... holder={"run": "...", "pid": ...}` y después `gate: acquired`.
El mismo límite cubre completar human tasks, push-back, retries y el retorno
BEHIND/DIRTY de `await_merge` a `rebase`. La capacidad declarada de la cola se
conserva (`a4s=8`); pasos ajenos al gate siguen avanzando.

Después, `quality_prepare` genera una solicitud SHA/run/iteración/intento y
`quality_review` arranca `qa` y `reviewer` independientemente del coordinador.
Cada obligación recibe el marcador SHA/run/iteración/intento exacto y el contrato
estructurado de [SKILL.md](skills/dagu-feature/SKILL.md#effective-qa-and-review).
QA ejecuta la aceptación indicada y reviewer inspecciona el mismo candidato;
sus resultados retienen los comandos, hallazgos y modelos realmente usados.
La admisión consume los recibos del boundary y valida familias, fallbacks
efectivos y evidencia del candidato. Exige bytes/digest del artefacto nativo,
salida estructurada y bindings actuales por obligación; QA y reviewer pueden
compartir familia entre sí, pero no con el implementer. Dos PASS avanzan el join;
cualquier FAIL devuelve sus hallazgos al mismo ticket.

`quality.json` contiene dos veredictos independientes con procedencia y hashes
de transcript; `quality_admit` los valida y `quality_transition` hace push-back
a `implement` con la iteración observada y hallazgos ante FAIL. Dos PASS vigentes
permiten publicar. La secuencia gate → QA/review → admisión precede a cada
actualización de la rama del PR, también tras correcciones y rebases; se renuevan
ambas evidencias para el nuevo candidato/intento. `auto_merge` comprueba ese SHA.
Este control es **advisory mientras la TUI tenga acceso al store de Dagu**.
`push` publica el SHA validado explícito con lease de la rama y worktree limpio.
`pr` reutiliza el PR abierto y verifica rama y SHA; `auto_merge` comprueba el
mismo SHA antes de solicitar su fusión. La salida reconoce el checkpoint exacto
antes de retirar recursos locales limpios. Para recuperar en una copia limpia:

```sh
git fetch origin refs/dagu/checkpoints/issue-N
git branch dagu/issue-N FETCH_HEAD
```

El cierre tras merge retira también el checkpoint durable con lease.

## Optional consumer blocker reporting

Bootstrap offers optional `A4S_BLOCKER_REPORTING=ask|auto`. The
`__A4S_BLOCKER_REPORTING__` placeholder fixes the choice in the installed
`feature.yaml` environment; `read_default` recovers it on the next adoption.
An empty response preserves the previous choice, defaulting to `ask` initially.
`auto` requires explicit opt-in; `ask` requires consent before publication.
Runtime parameters preserve this fixed policy. The
[`Optional consumer blocker reporting`](skills/dagu-feature/SKILL.md#optional-consumer-blocker-reporting)
procedure uses private files on the same host, the identified native A4S owner,
scoped authorization, and a URL receipt verified and read by the consumer.

## Validación opcional del repositorio

Bootstrap pregunta `VALIDATION` (opcional, vacía por defecto) y adopción fija
el procedimiento en el default y enum del DAG. Cambiarlo exige una adopción;
un override distinto al encolar se rechaza antes de crear el run. Para a4s el
valor sigue vacío. El flujo es `gate → recover_gate → quality_prepare → quality_review → quality_admit → quality_transition → validation → push`:
vacío omite la espera, gate fallido espera en recuperación y la rama PoC conserva `POC=no` en push.

Con procedimiento declarado, el aviso visible de la extensión y la tarea en
Dagu muestran repo, run, paso, SHA probado, procedimiento y comandos exactos.
Tras ejecutar el procedimiento, completar con `APPROVED=yes` y
`TESTED_SHA=<tested_sha>`. Push exige coincidencia con candidato y gate antes de
publicar; `validation.json` conserva SHA y procedimiento. Los formularios de
Dagu 2.20.1 son estáticos: otro SHA bien formado completa la tarea pero falla
push sin publicar y conserva el run en `recover_push` para inspección.
Un candidato modificado requiere repetir gate, QA/review y validación. Rechazar con `dagu human-task push-back feature --run-id
<run> --step validation --expected-iteration <iteración observada> --input
REASON='<motivo>'`: Dagu conserva el motivo y devuelve a implement. Leer la
iteración actual en `dagu status`; corrección o rebase repite gate y validación.

**Límite de autoridad:** `dagu human-task` carece de autenticación. Registra una
decisión atribuida al operador mediante datos del sistema operativo; no demuestra
su identidad ni la ejecución del smoke. REST con `auth.mode: none` tampoco
autentica. El acceso directo a Git/store hace el contrato advisory.

El [ejemplo backscroll del skill](skills/dagu-feature/SKILL.md#example-backscroll-smoke-parallel-installation)
instala el binario del SHA probado en un `GOBIN` temporal paralelo, verifica
`vcs.revision`/`vcs.modified` con `go version -m` y ejecuta el smoke sobre una copia
consistente creada con `sqlite3 "$live_db" ".backup '$sandbox/copy.db'"`, con
HOME, XDG y configuración/base backscroll aislados. La instalación y base de
producción permanecen intactas. Es solo un ejemplo: este cambio mantiene la
adopción y CI de backscroll bajo su propio control.

## Desarrollo

```sh
npm test --workspace @a4s/omp-dagu
npm run typecheck --workspace @a4s/omp-dagu
```

`npm test` (también desde la raíz) ejecuta las pruebas en proceso, sin invocar
el binario Dagu ni arrancar sus servicios. Los casos reales usan exclusivamente
el comando explícito:

```sh
npm run test:live --workspace @a4s/omp-dagu
```

Este script activa `A4S_LIVE_DAGU=1` y ejecuta `test/live/*.test.ts` y los casos
reales protegidos que comparten archivo con pruebas en proceso en `test/`.
El gate compartido consulta `dagu version` únicamente con esa variable activa
y exige el pin `daguFeature.dagu` de `package.json`. El comando predeterminado
fija la variable a `0`, incluso si el entorno del llamador la tenía activa.

Las pruebas vivas usan el runtime fijado del `PATH`, un `DAGU_HOME` temporal y un
puerto HTTP propio por fixture. Además, cada instancia genera un único
`randomUUID()` y deriva los IDs `recovery-<healthy|gate|start_gate|push>-<uuid>`,
manteniendo el nombre de DAG `feature`. Enqueue, REST, status, completion,
push-back y handlers comparten exactamente ese ID.

When `test/live/poc-template.test.ts` fails, its fixture stops the server before
preserving the original error, last HTTP URL/status/body, stdout/stderr, and only
the isolated Dagu home's `data/` and `logs/`. It reports a unique private
subdirectory under `A4S_DAGU_DIAGNOSTICS_DIR` (in CI:
`${{ runner.temp }}/dagu-poc-diagnostics`; locally, the temporary directory
`a4s-dagu-poc-diagnostics`), then removes the temporary runtime. Successful runs
only clean up. Evidence-retention failures are reported without replacing the
original error.

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
`daguFeature.dagu` en `package.json`. El gate compartido omite los casos reales
si falta ese runtime o su versión difiere. Los fixtures usan homes temporales y
puertos propios, independientes del servicio de la estación.

CI starts the ordinary workspace tests/typechecks and an independent six-lane
live matrix after workspace selection. The live matrix runs only when
`@a4s/omp-dagu` is selected. The ordinary `@a4s/omp-dagu` fixture tests also
require the pinned runtime. That workspace runner and all six live runners use
Node 22 and share the same Dagu installation and version-check commands: download
the pinned Linux amd64 release and `checksums.txt`, verify SHA-256, publish the
temporary binary directory through `GITHUB_PATH`, and check the exact
`dagu version` before testing. Other ordinary workspaces do not install Dagu.

Five lanes partition `feature-template.test.ts` by native Node test-name patterns:
template PoC closure, rendered-DAG PoC closure, concurrent recovery, validation
and admission, and the exhaustive complement of those groups. Patterns include
descendants; the complement automatically includes new feature cases. The sixth
lane runs `test/live/*.test.ts` and the shared test files listed by `test:live`.
Keep that explicit shared-file list aligned with the local script when adding
coverage. The local `npm test` and `npm run test:live` interfaces are unchanged.

The required `validate` check waits for workspace selection and both matrices.
Every selected matrix must succeed, including all its lanes; failures and
cancellations fail validation. A matrix may be skipped only when its workspaces
were not selected. Runtime download, checksum and version failures also propagate
to `validate`. The parallel layout targets five-minute required CI; actual
GitHub Actions elapsed time, rather than local lane timings, determines that result.

El gate completo del repositorio es:

```sh
npm ci && npm test && npm run typecheck
```

Las pruebas cubren SSE, progreso, identidad de repositorios/worktrees, transiciones, trabajos semánticos multiproceso, capacidad compartida, recuperación y verificación fail-closed de resultados/transcripts nativos.
