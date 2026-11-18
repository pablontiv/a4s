# Supervisor Pi del triage (carril 3/4)

Extensión Pi para el proveedor **Pi nativo** de T3. No instala ni arranca Dagu, no usa OMP/Tern y no lee la configuración de la estación. Solo opera sobre `pi-triage-slice`, `fixture-1` e IDs concretos con prefijo `pi-slice-` (letras ASCII, dígitos, `_` y `-` después del prefijo, empezando con una letra o dígito). El veredicto se registra en el fixture; ni `APPROVE` ni `REJECT` ejecutan una PoC.

## 1. Preparar un sandbox descartable (cuando lo autorice el operador)

En la máquina donde corre T3, usa Node ≥22.19, el binario **Dagu 2.26.0** (no un wrapper de estación), y las tres piezas del piloto en el checkout integrado: `.workspace/dagu/pilot/pi-triage-slice.yaml`, su compañero `pi-triage-slice.mjs` y `pilots/pi-triage/worker/triage.mjs`.

1. Crea un directorio nuevo y privado. Usa rutas absolutas canónicas (por ejemplo, resuelve el `mktemp -d` con `pwd -P`). Dentro, crea `dagu/` y `state/`, ambos `0700` y de tu usuario. Crea el archivo regular vacío `dagu/.a4s-pi-triage-slice`. En `dagu/dags/` copia juntos **solo** el YAML y su `.mjs`. No uses symlinks para el marcador, los archivos del DAG/worker ni el directorio de estado.
2. Pide un puerto efímero libre en `127.0.0.1`. Por ejemplo: `node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'`. Usa uno en `32768–65535`. Si otro proceso toma ese puerto antes que Dagu, elige otro; no apuntes la extensión al proceso que esté escuchando.
3. Crea `dagu/config.yaml` con el contenido siguiente (sustituye `49173` y la ruta de `base_config`). Usa solo el config base de este sandbox, sin contextos remotos, túnel, credenciales ni `paths` hacia fuera de su home.

   ```yaml
   host: 127.0.0.1
   port: 49173
   auth: {mode: none}
   scheduler: {port: 0}
   coordinator: {enabled: false}
   features: {unexpectedStopDetection: none}
   paths: {base_config: "/absolute/sandbox/dagu/base.yaml"}
   ```

   Crea ese `dagu/base.yaml` con este único `env`. Dagu 2.26.0 no garantiza propagar variables arbitrarias de su proceso a los pasos, por eso no basta con exportar la variable en la shell.

   ```yaml
   env:
     - A4S_PI_TRIAGE_FIXTURE: "1"
   ```

4. En una shell normal, define `DAGU_BIN`, `SLICE_HOME`, `PORT` y `SLICE_PATH` con esos valores explícitos. `SLICE_PATH` es la lista de directorios **elegidos** con `node`, shell y utilidades del fixture, no una copia de `$PATH`. Usa el entorno siguiente tanto para comprobar rutas como para arrancar el servidor **y** el scheduler del sandbox (este último consume la reanudación tras `decide`):

   ```sh
   slice_dagu () {
     env -i PATH="$SLICE_PATH" HOME="$SLICE_HOME" DAGU_HOME="$SLICE_HOME" \
       XDG_CONFIG_HOME="$SLICE_HOME/xdg-config" XDG_DATA_HOME="$SLICE_HOME/xdg-data" \
       XDG_CACHE_HOME="$SLICE_HOME/xdg-cache" XDG_STATE_HOME="$SLICE_HOME/xdg-state" \
       TMPDIR="$SLICE_HOME" DAGU_SKIP_EXAMPLES=true A4S_PI_TRIAGE_FIXTURE=1 \
       "$DAGU_BIN" "$@"
   }
   slice_dagu version  # debe ser exactamente 2.26.0
   slice_dagu config --context local --dagu-home "$SLICE_HOME" --config "$SLICE_HOME/config.yaml"
   # Continúa solo si DAGs, runs, logs, cola y demás stores están dentro de SLICE_HOME.
   slice_dagu start-all --context local --dagu-home "$SLICE_HOME" --config "$SLICE_HOME/config.yaml" \
     --host 127.0.0.1 --port "$PORT" --dags "$SLICE_HOME/dags"
   ```

5. Rellena dos copias privadas de [`supervisor.example.json`](supervisor.example.json) (`0600`): una con `access: "supervise"`, otra con `access: "observe"`. Solo cambia `access` entre ambas. `apiPort` debe ser el del servidor anterior. `dagFile` apunta al YAML copiado y `workerEntry` al `.mjs` de confianza. `pathDirs` corresponde a `SLICE_PATH`. Ambos perfiles verifican el marcador, el home y el estado privados y que la respuesta REST corresponda al run, parámetros y logs del sandbox. La configuración y el binario los selecciona el operador, nunca el modelo.

El puerto loopback y los directorios privados aíslan el piloto de la estación, no de otros procesos de tu usuario. No publiques la API sin autenticación. Usa una sola instancia escritora y no manipules el run en paralelo con Dagu UI/CLI, ni hagas `retry`, `resume` manual o `push-back`. Si el servidor o las rutas cambian, pausa la tarea hasta configurar un sandbox nuevo; no uses la estación como fallback.

## 2. Cargar en T3 (instrucciones, no configuración aplicada)

En los ajustes del proveedor **Pi nativo** de la máquina anterior, usa dos instancias dedicadas, una manual y otra de consulta. Selecciona el binario Pi y un modelo ya autenticado en el proveedor correspondiente. No cambies el modo RPC, la sesión ni la selección de modelo mediante flags: T3 gestiona ese ciclo. Si necesitas aislar las preferencias Pi del operador, usa un `PI_CODING_AGENT_DIR` dedicado configurado con el proveedor autorizado; no copies credenciales a Dagu ni al JSON del supervisor.

En **Environment variables** de cada instancia, pon `A4S_PI_TRIAGE_SUPERVISOR_CONFIG` con la ruta absoluta de **su** JSON. En **Launch arguments**, añade los tokens siguientes (la ruta es un único argumento):

```text
--no-approve --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files
--extension /absolute/checkout/pilots/pi-triage/supervisor/index.ts
--tools factory_start,factory_status,factory_decide
```

Para la instancia de consulta, reemplaza el último argumento por `--tools factory_status`. Para una bandeja de decisiones con un clic (sección 4), usa `--tools factory_status,factory_request_decision`; así el modelo no tiene `factory_decide` y solo puede pedir los botones. No la uses si la sesión habilita herramientas ajenas al piloto. Aun si se expusieran `factory_start` o `factory_decide` accidentalmente, el perfil `observe` los deniega. Mantén el perfil manual en **Supervised**. La aprobación genérica de herramienta de T3, si aparece, no sustituye el diálogo `Confirmación del operador · triage A4S` de la extensión; solo este diálogo autoriza enviar el POST. Pi usa su API pública `ctx.ui.confirm`, que T3 presenta en el compositor por RPC. Sin diálogo interactivo, con cancelación o tras 60 segundos, no se aplica la decisión.

## 3. Turnos manuales y tarea de lectura

Usa el mismo ID de run en todos los pasos siguientes; `pi-slice-demo-01` es un ejemplo, no `latest`. Nunca redefinas ese ID para un run distinto.

1. **Inicio manual**, en una conversación T3 con la instancia `supervise`: «Llama una vez a `factory_start` para `pi-slice-demo-01`. Luego consulta el mismo ID con `factory_status` y reporta si `decide` espera, con la pregunta y el motivo. No completes nada.»
2. **Decisión manual**, una vez revisado el triage: «Consulta ahora `factory_status` para `pi-slice-demo-01`. Solo si está en `awaiting_decision`, presenta `factory_decide` con el token devuelto y mi propuesta `REJECT` [o `APPROVE`]. No repitas la llamada.» Comprueba que el diálogo muestre el ID, `DECISION`, la espera y la evidencia correctos antes de confirmarlo. Puedes denegarlo sin cambiar el run. Consulta luego el estado: `completed` significa que se completó el paso; el veredicto del DAG se comprueba cuando aparece `verdict` desde `decision.json`.
3. **Tarea recurrente**, en T3 → **Settings → Scheduled tasks**: elige este proyecto/worktree, la instancia Pi `observe` y una frecuencia adecuada (p. ej. cada 15 minutos). En **Destination** elige **One thread, fresh session each run**: las entregas comparten el mismo hilo y cada ejecución vuelve a consultar sin usar el contexto de la anterior. Elige el hilo fijo de observación si ya existe; si no, la primera ejecución crea el destino que usarán las demás. No elijas **New thread each run**. Pega [`observe.prompt.md`](observe.prompt.md) sustituyendo el ID de ejemplo por el ID literal. Guarda y usa **Run now** sobre esa misma tarea para comprobar, antes de dejarla recurrente, que solo llama una vez a `factory_status`, no pide UI y vuelve al mismo hilo en el siguiente disparo. El texto y el perfil son los mismos en **Run now** y en la recurrencia.
4. Al terminar el piloto, pausa la tarea, detén el `start-all` que lanzaste y elimina únicamente el sandbox descartable si ya no necesitas su evidencia.

## 4. Bandeja con un clic (webhook de Dagu → T3)

`factory_request_decision({runId})` consulta el run y, solo si está en `awaiting_decision`, muestra al operador un único diálogo `select` con la tarjeta (run, pregunta, motivo, espera) y los botones **Aprobar / Rechazar / Después**. El clic es la autorización: el modelo pide el diálogo pero nunca elige el valor. Con Aprobar o Rechazar se reutiliza `decide`, que vuelve a validar el token contra Dagu antes y después y hace un único POST. Con Después, sin respuesta en 15 minutos, con cancelación o con un fallo de la UI, devuelve `deferred` y no envía nada. Responde con `decidedBy: "operator-click"`.

Para despertar la bandeja sin polling, se usó en un experimento local:

- **Dagu 2.26.0:** `handler_on.wait` (y `handler_on.failure`) en una copia del DAG, que hace POST con `{source, event, dagName, runId}` al webhook de una tarea programada de T3.
- **T3:** una tarea `webhook` ligada al hilo de la bandeja, con `freshSession`, un filtro `body.source` y un `dedupe.coalesceKey` de `{{body.event}}:{{body.runId}}`. El prompt debe usar plantillas `{{body.runId}}`: T3 no anexa el payload solo, y envuelve esos valores como datos no confiables. `coalesceWindowSeconds` retrasa cada entrega hasta que se cierra la ventana (mínimo 10 s).
- **Sin T3 Connect**, `schedule_task` no devuelve `webhookUrl`; el endpoint local `http://127.0.0.1:<puerto>/api/hooks/<taskId>/<token>` sí funciona y el token se copia desde Settings. Trátalo como secreto.
- **Límite conocido:** una pregunta pendiente bloquea el hilo; la siguiente tarjeta espera en cola hasta que se responde la anterior.

## Resultados y límites

- `factory_status({runId})`: GET del run específico. Produce `snapshot` y evidencia validada (`triage`, `verdict`), o `not_found`. `awaiting_decision` exige run y paso `decide` en `waiting`, evidencia válida y `startedAt` registrado. El token liga DAG, run, paso, timestamp y evidencia; es un comprobante de frescura, no una credencial ni autorización.
- `factory_decide({runId, decision, token})`: consulta antes de pedir confirmación y vuelve a consultar justo después. `denied` no envía POST. `already_resolved` y `stale` son distintos; con `stale` hay que volver a consultar y revisar, no reintentar automáticamente. En 2.26.0, `/human-tasks/decide/complete` **no ofrece CAS por `startedAt`**; hay una ventana entre el GET y el POST. El piloto no repite/reabre `decide` y Dagu arbitra conflictos de completado.
- Si la lectura falla no se escribe. Si falla la respuesta **después** de intentar `start` o enviar el POST, `unconfirmed` significa que el efecto es desconocido: consulta y reconcilia con la evidencia antes de una nueva acción humana. Un HTTP 503 de completion puede haber guardado el input sin encolar la reanudación. No hay replay ni reanudación automática del supervisor.

Pruebas con dobles, sin servicios habituales ni proveedor:

```sh
node --test pilots/pi-triage/supervisor/supervisor.test.mjs
```

Referencias del host: [Pi Extensions](https://pi.dev/docs/extensions), [Pi RPC Extension UI](https://pi.dev/docs/rpc-extension-ui), [proveedor Pi en T3](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md) y [tareas programadas de T3](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md).
