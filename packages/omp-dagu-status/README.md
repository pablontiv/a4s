# OMP Dagu Status

Extensión de OMP que observa los runs de Dagu del repositorio de la sesión y muestra su progreso en un widget `aboveEditor`, debajo de los todos. Una línea por run, hasta diez líneas; la barra de status conserva su contenido. Requiere Node.js >=22.19.0 y Dagu 2.19.2 con autenticación local `none`.

## Instalación

Para una sesión con el checkout actual:

```sh
DAGU_URL=http://127.0.0.1:8080 omp -e /ruta/a/a4s/packages/omp-dagu-status
```

Para cargarla habitualmente desde un clon permanente:

```sh
omp plugin link /ruta/a/a4s/packages/omp-dagu-status
```

`DAGU_URL` es la raíz del servidor (por defecto `http://127.0.0.1:8080`). El paquete usa `fetch` y un parser SSE propios, sin dependencias runtime externas. La conexión es de solo lectura y la sesión sigue funcionando durante una caída del servidor.

## Identidad, descubrimiento y progreso

En `session_start` y al cambiar de sesión se resuelve el repo desde `git remote get-url origin` (HTTPS o SSH). Sin origin, se usa el nombre del padre de `git rev-parse --path-format=absolute --git-common-dir`: funciona también dentro de linked worktrees cuyo directorio tiene otro nombre. Fuera de Git o sin UI, la extensión permanece inactiva.

El descubrimiento usa **REST en el mismo servidor que SSE**, en lugar de `dagu history`. Cada ~30 s solicita `GET /api/v1/dag-runs` con `status=1&status=5&status=7` (running, queued, waiting), `fromDate` Unix en segundos de las últimas 48 h y `labels=workspace=<repo>`. Recorre `nextCursor` y comprueba también las etiquetas devueltas. Los parámetros y las etiquetas se verificaron contra un servidor aislado Dagu 2.19.2; el [OpenAPI de esa versión](https://raw.githubusercontent.com/dagucloud/dagu/v2.19.2/api/v1/api.yaml) describe el contrato. Así, `DAGU_HOME` y el historial de otra instalación local no afectan al widget.

Los cambios llegan por `GET /api/v1/events/stream?topic=dagrun:<dag>/<runId>`, repitiendo `topic` para cada run. La suscripción multiplexada se verificó en vivo: el evento `control` confirma todos los topics; los eventos `message` contienen `payload.dagRunDetails`. Cada conexión agrupa hasta 20 topics, el límite predeterminado de Dagu 2.19.2; todos comparten renderizado y deduplicación de avisos. Se renuevan las conexiones al redescubrir y al terminar un run, conservando topics anteriores hasta recibir su estado final para cubrir la carrera entre listado y suscripción. El apagado aborta las peticiones, las esperas y los temporizadores.

Ejemplo:

```text
dagu · #157 ▰▰▱▱▱▱ 2/5 gate running
```

La identidad visible sale de `ISSUE=` en params (también JSON); sin issue se muestra el id del run. El avance cuenta nodos `succeeded` y `skipped`. El paso actual es el nodo `running`, o el `waiting` prioritario cuando el run espera una acción humana. El primer estado observado de cada run establece una línea base silenciosa, tanto al iniciar la sesión como al descubrir runs nuevos. `notify` avisa una vez por transición posterior a `waiting` (incluye el paso), `succeeded`, `failed` o `aborted`. Completar el detalle inicial de un resumen REST en espera mantiene esa línea base. Los snapshots repetidos y las reconexiones conservan la deduplicación.

Cuando termina el último run se retira el widget. Si falla REST/SSE, aparece `dagu · sin conexión · reintentando en Ns`, con backoff de 1, 2, 4, 8, 16 y hasta 30 s; la recuperación es automática. El descubrimiento sin runs vuelve a comprobar el servidor a los 30 s. La extensión observa únicamente; las acciones humanas y las transiciones de reconciliación pertenecen a Dagu y al operador.

## Desarrollo

El wildcard `packages/*` registra este workspace en la raíz. Los scripts raíz incluyen sus tests y su typecheck:

```sh
npm ci && npm test && npm run typecheck
```

Las pruebas cubren framing SSE con chunks parciales/UTF-8/CRLF y datos multilínea, progreso, selección de paso, extracción de issue, deduplicación de avisos y resolución real de repositorios/worktrees. Para un smoke interactivo se utiliza un `DAGU_HOME=$(mktemp -d)`, `DAGU_COORDINATOR_ENABLED=false dagu start-all --host 127.0.0.1 --port 18080`, y `DAGU_URL=http://127.0.0.1:18080 omp -e /ruta/a/a4s/packages/omp-dagu-status`. Un DAG `type: chain` con `labels: [workspace=a4s]` y tres `sleep 5` permite observar las transiciones. Al finalizar, se cierran omp y el servidor y se elimina ese home temporal.
