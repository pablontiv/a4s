# synagent

**synagent** (sinapsis + agent) es la mensajería aislada que permite que agentes
de distintos harnesses se comuniquen sin conocerse entre sí. Materializa el
patrón *Channel Adapter + Message Bus* del boceto
`.workspace/docs/research/2026-10-02-agent-messaging-adapter-pattern-boceto.md`
y el ADR 0066.

## Componentes

1. **Bus** (`../bus/`): paquete instalable separado
   `@a4s/synagent-bus`, con broker MQTT Aedes, persistencia LevelDB y plugin
   Herdr. Los bridges de Claude viven dentro de su propio plugin.
2. **Adaptadores** (`adapters/<harness>/`): bordes finos que traducen el API de
   cada harness al contrato canónico. Incluye el plugin de Claude Code y
   las extensiones independientes de Pi y omp.
3. **Protocolo** (`protocol.ts`): contrato canónico compartido — gramática de
   direcciones, mapa dirección→topic, plan de suscripción, enrutado y resolución
   de proyecto/instancia. El plugin Claude lleva una **copia generada** en
   `hooks/adapter.ts` (regenerable con `adapters/claude/scripts/sync-protocol.mjs`
   y anclada por un test de paridad) porque el marketplace instala solo su
   directorio.
4. **Diagnostics** (`diagnostics.ts`): fuente canónica de los registros privados.
   `adapters/claude/scripts/sync-diagnostics.mjs` genera `adapters/claude/diagnostics.ts`
   y `adapters/claude/bridge/diagnostics.cjs` para mantener autocontenido el plugin.
   Desde `packages/synagent/core`, `npm run sync-diagnostics` regenera ambos;
   `npm run sync-diagnostics -- --check` verifica los artefactos sin escribir.
   El gate de tests ejecuta ese check y la misma suite funcional sobre la fuente
   y ambas variantes. El generador usa el borrado de tipos de Node (compatible con
   Node 26), sin depender del compilador de TypeScript. El logging de Claude
   sigue diferido: los bridges conservan su stdout de mensajes canónicos.

Agregar otro harness requiere un adaptador nuevo; no modifica el bus ni los
adaptadores existentes.

## Contrato canónico

Cada sobre lleva `id`, `from`, `to`, `kind`, `body`, `reply_to?`,
`correlation_id?`, `causation_id?`, `deadline?` y `ts`. `from` y `to` son
direcciones v1. `reply_to`, `correlation_id` y `causation_id` contienen IDs de
mensajes. `deadline`, cuando existe, es un epoch Unix absoluto en milisegundos:

| Clase | Kinds | Emisor |
| --- | --- | --- |
| Pedido de trabajo | `task.request`, `task.redirect` | usuario o LLM mediante `synagent_send` |
| Cancelación | `task.cancel` | usuario o LLM mediante `synagent_send` |
| Evento de tarea | `task.delivered`, `task.completed`, `task.expired` | adaptador de destino |
| Evento informativo | `note.published` | usuario o LLM mediante `synagent_send` |

Todo comando raíz lleva su propio `id` como `correlation_id`. El adaptador de
destino publica `task.delivered` al confirmar el marcador de entrega y
`task.completed` al asentarse el turno. Ambos vuelven al `from` del pedido con
`reply_to` igual a su ID, conservan el ID raíz en `correlation_id` y usan el ID
del pedido como `causation_id`. Un pedido vencido produce `task.expired` con la
misma correlación y un body JSON con `event`, `deadline` y `expired_at`.
Solo `task.request` y `task.redirect` producen eventos; una cancelación o un
evento nunca produce otro evento. `task.delivered` es un acuse mecánico y se
consume sin turno; `task.completed` y `task.expired` se inyectan al emisor.

## Direccionamiento v1 (ADR 0068; identidad por ADR 0069)

Topología jerárquica versionada, con la regla `topic == "synagent/" + versión +
"/" + to`:

| Dirección (`to`) | Topic | Alcance |
| --- | --- | --- |
| `<proyecto>/<instancia>` | `synagent/v1/<proyecto>/<instancia>` | un agente (buzón directo) |
| `<proyecto>/all` | `synagent/v1/<proyecto>/all` | todo el proyecto |
| `all` | `synagent/v1/all` | global (activo por defecto) |
| sesión fallida | `synagent/v1/dlq/<proyecto>/<instancia>` | cola de mensajes muertos de esa sesión |

### Identidad desde origin

Synagent deriva el token de proyecto de `remote.origin.url` del repositorio
del cwd de la sesión: el último segmento del remoto, sin `.git`, debe ser un
token v1 válido. Pi, omp y Claude comparten esta resolución y muestran
`source=origin`. Si falta un origin válido, el adaptador queda inactivo y la
remediación pide configurar `remote.origin.url`, por ejemplo:

```sh
git remote add origin git@github.com:Example/Project.git
```

- **proyecto**: nombre canónico del repo del remoto `origin`, determinista
  para todos los hosts que trabajan en ese repo.
- **instancia**: id de sesión **nativo** del harness (`$.session.id()` en Claude,
  `getSessionId()` en Pi), único por sesión — un *resume* conserva el id, un
  *new*/*fork* obtiene otro. No se persiste ni se deriva de entorno: se arranca
  un adaptador por sesión, así que persistir el id haría colisionar sesiones
  distintas. El id no es el tipo de agente: puede haber varias instancias Claude
  o Pi por proyecto.
- **`task.redirect`** solo tiene sentido a destino directo; un redirect a
  broadcast se rechaza en el envío y en la recepción.
- **global** está activo por defecto: ambos adaptadores reciben
  `synagent/v1/all`; se puede desactivar explícitamente con su setting `global`.
- Los adaptadores solo se suscriben a topics v1. No crean ni usan suscripciones
  legacy `a4s/inbox/<address>`.

## Arrancar el bus

Instálalo globalmente o ejecútalo desde el monorepo:

```sh
npm install --global @a4s/synagent-bus
synagent-bus

npm run bus -- 0 --db /tmp/synagent-dev-db
```

El default es `mqtt://127.0.0.1:1884`; el estado vive en la ruta de estado del
usuario para cada SO, no dentro del checkout. El proceso imprime
`BROKER READY :<puerto>` cuando listener y LevelDB están realmente listos. El
broker es una aplicación separada: ningún adaptador lo arranca. Instalación,
overrides de estado y uso del space Herdr `Synagent`/tab `Bus` se documentan en
[`../bus/README.md`](../bus/README.md).

## Adaptador de Claude Code

El plugin vive en `adapters/claude/`. Cárgalo en Claude Code con dev-mods o con:

```sh
claude --plugin-dir packages/synagent/core/adapters/claude
```

- **JALAR (bus → Claude):** spawnea `bridge/bridge-sub.cjs` con dos clientes —
  uno durable (`clean=false`) suscrito a su buzón directo `synagent/v1/<proyecto>/<instancia>`
  y uno transitorio (`clean=true`) a los broadcasts de proyecto
  `synagent/v1/<proyecto>/all` y global `synagent/v1/all`. Reserva y deduplica
  cada `id`; consume `task.delivered` sin crear un turno e inyecta los demás
  mensajes, incluido `task.completed`, mediante `$.prompt.submit`.
- **ENVIAR (Claude → bus):** la herramienta `synagent_send` (invocada por el
  modelo) publica `task.request`, `task.redirect` o `note.published`.
  `/mq-send <to>: texto` publica un `task.request` como atajo de depuración. Si la identidad
  no se resuelve, el adaptador queda inactivo y pide configurar el proyecto.

Los bridges viven en `adapters/claude/bridge/` y se resuelven desde
`$.plugin.root`, por lo que el plugin es autocontenido. Tiene su propio
`package.json`; el repositorio mantiene un único lockfile en la raíz y el
marketplace instala las dependencias declaradas por el plugin. Requiere Node en
el host.

### Instalar desde un marketplace (GitHub)

El repo es un marketplace: `.claude-plugin/marketplace.json` lista el plugin
`synagent-adapter-mqtt`.

```sh
claude plugin marketplace add pablontiv/a4s
claude plugin install synagent-adapter-mqtt@a4s
```

La instalación provisiona `mqtt` desde el `package.json` del plugin. El broker
no forma parte del plugin Claude: sigue siendo la aplicación separada
`@a4s/synagent-bus`.

### Configuración (`userConfig`)

| Clave | Default | Uso |
| --- | --- | --- |
| `brokerUrl` | `mqtt://127.0.0.1:1884` | URL loopback del broker. |
| `global` | `true` | Suscribirse al broadcast global `synagent/v1/all`; `false` lo desactiva. |

La instancia **no** es configurable: sale del id de sesión nativo
(`$.session.id()`), una por sesión. El adaptador **no lee variables de entorno**.
Se configura con `/plugin configure` o al instalar:

```sh
claude plugin install synagent-adapter-mqtt@a4s --config brokerUrl=mqtt://host:1884
```

### Semántica de entrega

La entrega al modelo es at-most-once: el adaptador reserva el `id` antes de
llamar a `$.prompt.submit`. MQTT QoS1 protege el transporte hasta el bridge,
pero no evita perder un mensaje si el adaptador cae después de reservarlo.

## Adaptador de Pi

La extensión vive en `adapters/pi/index.ts` y usa `mqtt.js` directamente, sin
polling ni subprocesos bridge. Puede cargarse para una sesión con:

```sh
pi -e packages/synagent/core/adapters/pi/index.ts
```

O instalarse desde el checkout:

```sh
pi install ./packages/synagent/core
```

Al iniciar una sesión abre **dos** clientes MQTT: uno durable (`clean: false`,
`clientId` derivado del ID de sesión) suscrito a su buzón directo
`synagent/v1/<proyecto>/<instancia>` y a su cola
`synagent/v1/dlq/<proyecto>/<instancia>`, y uno transitorio (`clean: true`) a
los broadcasts de proyecto `synagent/v1/<proyecto>/all` y global
`synagent/v1/all`. La instancia es
exactamente `ctx.sessionManager.getSessionId()`: conserva mayúsculas y puntos.
Un *reload* o *resume* conserva esa identidad nativa; *new* y *fork* la
re-resuelven y vuelven a vincular el adaptador. Dos sesiones no se expulsan
entre sí. En
`session_shutdown` cancela sus listeners y cierra ambas conexiones
idempotentemente sin borrar la suscripción durable.

El proyecto se deriva de `remote.origin.url` leído en el `ctx.cwd` de la sesión.
Si no resuelve, muestra un warning y queda inactivo, sin suscripciones ni
publicación. Los intentos de envío piden configurar `remote.origin.url`.
`/synagent status` muestra la identidad y `source=origin`, o `inactive=true`
con la remediación correspondiente.

### Envío y comandos Pi

El modelo usa `synagent_send` con `to`, `body`, `kind?`, `reply_to?`,
`correlation_id?` y `causation_id?` cuando el usuario pide mensajear a otro
agente o proyecto. El kind predeterminado es `task.request`; también admite
`task.redirect`, `task.cancel` y `note.published`. El schema de la herramienta
no expone `deadline`: para pedidos de trabajo lo calcula el adaptador desde
`request-ttl`. Los eventos de tarea quedan reservados al adaptador. Conserva
mayúsculas y puntos en destinos válidos. `/mq-send` es solo un atajo explícito
de depuración:

```text
/mq-send <to>: texto        (debug; to = dirección v1, o token cualificado con tu proyecto)
/synagent-settings
/synagent status
/synagent pending
/synagent dlq
/synagent dlq retry <id>
/synagent cancel <request-id>
/synagent enable|disable
/synagent resume
/synagent set broker-url <mqtt://loopback:puerto>
/synagent set global <true|false>
/synagent set default-peer <address>
/synagent set request-ttl <segundos>
```

`/synagent pending` muestra el registro persistido de pedidos de la sesión con
estado `pendiente`, `entregado`, `completo`, `vencido` o `cancelado`.
`/synagent cancel` publica `task.cancel` al destino original únicamente si el
pedido sigue pendiente.

`/synagent dlq` muestra el índice persistido de mensajes muertos con su `id`,
causa, hora, harness, estado y payload textual. `/synagent dlq retry <id>`
publica ese payload sin reconstruirlo una sola vez en el buzón directo de la
misma sesión. La marca de reintento se persiste antes de publicar: ningún
registro se reinyecta automáticamente ni admite un segundo reintento.

`/synagent-settings` muestra los valores efectivos de usuario. Permite editar
cada valor, restablecerlo a su valor heredado o cancelar sin cambios.
`enabled` y `global` usan una selección booleana. Los demás valores usan
entradas validadas.

Todos los subcomandos de configuración persisten en el ámbito de usuario.
Los cambios de `enabled`, `broker-url` o `global` ejecutan una reconfiguración
MQTT. Cambiar `default-peer` o `request-ttl` no reinicia MQTT. Al cambiar los
topics durables, el adaptador elimina las suscripciones obsoletas antes de usar
las nuevas y reintenta esa limpieza al reconectar. El cambio descarta mensajes
aún no enviados de la configuración anterior. Una entrega ya pasada al host no
se puede cancelar y permanece como barrera de orden hasta que la sesión se
asienta.

### Configuración nativa de Pi y omp

| Clave | Default | Ámbito de escritura |
| --- | --- | --- |
| `enabled` | `true` | usuario |
| `broker-url` | `mqtt://127.0.0.1:1884` | usuario |
| `global` | `true` | usuario |
| `default-peer` | `claude` | usuario |
| `request-ttl` | sin valor | usuario |

El archivo de usuario es `<agent-dir>/synagent.json`. El adaptador usa el valor
no vacío de `PI_CODING_AGENT_DIR` como `<agent-dir>`. En su defecto usa
`~/.pi/agent` en Pi y `~/.omp/agent` en omp.

El archivo contiene un objeto JSON plano. Este ejemplo muestra todos los
valores configurables:

```json
{
  "enabled": true,
  "broker-url": "mqtt://127.0.0.1:1884",
  "global": true,
  "default-peer": "claude",
  "request-ttl": 5
}
```

El adaptador resuelve cada clave por separado: archivo de usuario, valores
legacy de usuario (Pi) y default. `request-ttl` acepta segundos positivos,
incluidos decimales; sin esa clave los pedidos no llevan `deadline`.
`SYNAGENT_BROKER_URL`, cuando no está vacío, sobrescribe `broker-url` solo para
el proceso y nunca se persiste; se valida con la misma restricción loopback.
Los cambios de archivo se conservan al arrancar otra sesión.

En Pi, si falta `synagent.json`, el adaptador migra las cinco claves
`a4s.synagent.*` conocidas desde el `settings.json` de usuario. Conserva el
archivo original y valida los valores antes de migrarlos. La escritura usa un
archivo temporal y un cambio de nombre atómico, crea los directorios necesarios
y aplica modo `0600` al archivo de usuario.

Mientras el broker no tenga autenticación, el adaptador acepta únicamente URLs
`mqtt://` de loopback sin credenciales. Si la URL configurada no cumple esa
restricción, muestra un warning y usa el default seguro
`mqtt://127.0.0.1:1884`. Los tokens v1 son sensibles a mayúsculas y admiten
puntos (`[A-Za-z0-9][A-Za-z0-9._-]{0,255}`). Rechazan `/`, `+` y `#` dentro de
cada token.

### Entrega en Pi

Los mensajes recibidos se validan y se encolan en orden de llegada.
`task.cancel` se consume y retira el pedido correlacionado si sigue en la cola
propia; `task.delivered` se consume sin abrir un turno. `task.completed`,
`task.expired`, `note.published` y los pedidos se inyectan. Como la API pública
`sendUserMessage` de Pi retorna `void`, el adaptador invoca como máximo un
mensaje, confirma su aceptación al observar el `message_start` de usuario con
su marcador y libera el siguiente solo cuando Pi emite `agent_settled`. Un
turno ajeno no puede liberar esa barrera.

Para cada entrega confirmada, el motor compartido captura en `message_end` el
último contenido assistant con bloques `text` no vacíos. Un texto previo a una
tool se reemplaza por el texto final posterior; `toolCall`, `thinking` y
`toolResult` no son resultados. El filtro de vacío conserva el contenido
exacto. La captura se asocia al ID, generación, token y marcador, y se congela
en el siguiente `message_start` de usuario. Por eso un `followUp` procesado en
el mismo ciclo no contamina el resultado.

Cuando la entrega es un pedido, la confirmación publica `task.delivered` y el
asentamiento publica `task.completed` con el texto capturado como `body`. Una
entrega sin texto produce un body vacío. Entregar un evento o una cancelación no
publica eventos adicionales.

Si una entrega no alcanza `message_start`, o una ya aceptada no se asienta, en
30 segundos mantiene la barrera, publica el payload original en la DLQ con
causa `DELIVERY_TIMEOUT` y muestra una advertencia. Esto también cubre un
mensaje interceptado por otro input handler y evita confundir un fallo con un
preflight o turno lento. El operador puede ejecutar `/synagent resume` para
liberar la cola explícitamente, aceptando orden best-effort desde ese punto.

Antes de encolar un mensaje inyectable, el motor guarda una entrada privada
`synagent-pending` con el mensaje canónico completo, su payload textual original,
el id de sesión receptor y un marcador estable. Un *resume* de esa misma sesión
rehidrata los pendientes aceptables en orden. Los pedidos con deadline
permanecen en esta cola mientras el host está ocupado, fuera de su cola opaca
`followUp`; el motor compara `Date.now() >= deadline` otra vez inmediatamente
antes de `sendUserMessage`. Si vencieron, guarda su id como consumido, no los
inyecta y publica `task.expired`. Una cancelación hace la misma transición
consumida sin publicar otro evento. Vencimiento y cancelación son estados
canónicos, no fallos DLQ, y ninguno se rehidrata después de un reinicio.

Un JSON no parseable se publica con `INVALID_JSON`; un sobre JSON que no cumple
el contrato, con `INVALID_MESSAGE`; y una excepción de `sendUserMessage`, con
`DELIVERY_DISPATCH_FAILED`. Cada registro contiene `id`, el `payload` textual
sin modificar, `cause`, `time` ISO 8601 y `harness`, y se publica con QoS 1. El
topic DLQ se filtra antes de `parseCanonical`, por lo que sus registros nunca
entran en la entrega canónica. El índice privado `synagent-dlq` sobrevive al
resume; `synagent-dlq-retry` conserva la decisión de reintentar una sola vez.

`message_start` confirma únicamente el turno de usuario que contiene el
marcador y entonces guarda `synagent-delivered`; los reenvíos de ids pendientes
o confirmados se descartan y se diagnostican. Los ids confirmados se limitan a
los 1000 más recientes, sin expulsar pendientes. Un turno de usuario ya
persistido con el marcador también confirma la entrega aunque falte la entrada
final. `task.delivered`, que no abre un turno, se marca consumido directamente.

El emisor guarda cada pedido y cada cambio de estado en entradas
`synagent-request` de la sesión. Cualquier mensaje correlacionado mediante
`reply_to` actualiza el registro; un timer local marca `vencido` un pedido aún
pendiente cuando pasa su deadline. La última entrada por id reconstruye
`/synagent pending` al reanudar la sesión.

La garantía de recuperación cubre el corte demostrado: `SIGKILL` después de
persistir `synagent-pending` y antes del `message_start`, seguido por *resume*
de la misma sesión. `appendEntry` no promete `fsync`; la garantía no cubre
pérdida de energía ni convierte el procesamiento del modelo en una transacción.
Una caída entre `message_start`, la persistencia del turno de usuario y
`synagent-delivered` queda limitada por lo que el host haya hecho durable.

- si Pi está idle, inicia un turno normal;
- `kind=task.redirect` vigente interrumpe un turno activo con `deliverAs: "steer"`;
- un `task.request` con deadline espera en la cola propia mientras Pi está ocupado;
- los demás mensajes inyectables se encolan con `deliverAs: "followUp"`.

El deadline usa el reloj del emisor para construir el epoch y el del destino
para compararlo. El vencimiento se observa al intentar drenar la cola, no como
una notificación puntual. MQTT QoS 1 puede redeliver, la deduplicación reserva
el id, la cola mantiene FIFO y un fallo al publicar `task.expired` se informa
pero no vuelve inyectable el pedido descartado.

### Diagnóstico operacional de Pi

El adaptador Pi escribe JSONL fuera de stdout y stderr. La ruta por defecto es
`${A4S_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/a4s}/log/synagent/pi/<instancia>/operational.jsonl`.
`A4S_STATE_ROOT` cambia la raíz completa. Cada línea usa el contrato
`a4s.log/1`. Los campos siguen nombres de OTel para recurso, scope, severidad,
correlación y error.

El adaptador registra solo hitos útiles para RCA. Incluye ciclo de vida,
identidad, conexión MQTT, resultado de mensaje y barrera de entrega. Registra
profundidad de cola, generación, rol, operación, tipo de mensaje, alcance,
modo y timeout cuando aplican. El ID de mensaje se correlaciona con un digest
SHA-256 determinista. `synagent.pi.delivery.settled` añade el resultado exacto
de la entrega en `a4s.delivery.text` cuando existe, incluidos sus espacios; este
campo contiene salida del modelo y debe tratarse como contenido sensible. El
mismo cálculo de digest se puede usar en el adaptador Claude.

Fuera de esa captura explícita, el JSONL no contiene body, payload, prompt,
transcript, token, topic, dirección, URL, client ID, entorno, argv ni ID de
sesión crudo. El nombre de instancia deriva de un digest del ID de sesión. El
escritor aplica `0700` a sus directorios y `0600` al archivo. Rechaza rutas de
instancia y archivos que sean symlinks o tipos no regulares. Usa `O_NOFOLLOW`
cuando el sistema lo ofrece. Si no garantiza la ruta o los permisos, omite el
registro. Nunca usa stdout o stderr como fallback.

El escritor es best-effort. Un fallo de creación, formato o escritura no
detiene el adaptador. Cada archivo tiene una cuota fija de 16 MiB. El escritor
deja de escribir antes de superar la cuota. No borra ni rota datos. La cuota
limita el consumo de disco. No ofrece retención. El cierre solicita `fsync`,
pero un fallo posterior no cambia una línea ya escrita. Las defensas cubren a
otros usuarios y paths hostiles preexistentes.
No cubren un proceso malicioso con el mismo UID. También existe una ventana
TOCTOU donde faltan APIs portables para cerrarla.

## Adaptador de omp

El adaptador independiente vive en `adapters/omp/index.ts`. El manifiesto del
paquete declara `omp.extensions: ["./adapters/omp/index.ts"]` para cargarlo en
omp; Pi conserva su propia entrada `pi.extensions`.

La entrega libera el siguiente mensaje cuando omp emite un `agent_end` terminal;
`willContinue: true` conserva la barrera. omp usa la misma captura por
`message_end` que Pi: empieza al confirmar el marcador, conserva el último
texto assistant no vacío y congela la ventana en el siguiente
`message_start` de usuario. Por ello publica los mismos `task.delivered` y
`task.completed` mecánicos con la misma correlación, sin leer el historial de
la sesión.

El archivo global es `~/.omp/agent/synagent.json` y el archivo de proyecto es
`<ctx.cwd>/.omp/synagent.json`. Un valor no vacío de `PI_CODING_AGENT_DIR`
sustituye `~/.omp/agent` como directorio del archivo global. Cada clave se
resuelve desde el archivo de proyecto confiable, el archivo global y su
default, en ese orden.

## Seguridad

El broker escucha solo en loopback y no implementa auth, TLS ni ACL. Cualquier
proceso local puede publicar, falsificar `from` y enviar incluso
`task.redirect`; esos campos no prueban identidad. Exponer el broker a otra
interfaz permitiría inyección remota de prompts. Uso remoto requiere añadir
autenticación, autorización de topics y TLS antes de admitir URLs no locales.

## Pruebas

```sh
npm test --workspace @a4s/synagent
npm run typecheck --workspace @a4s/synagent
npm test --workspace @a4s/synagent-bus
```

La comprobación viva permanente requiere omp 18.11.0, Pi 1.0.3 y las
credenciales ya disponibles en sus directorios reales. Arranca dos sesiones
RPC por host y un broker propio en `18326`, con DB
`/tmp/synagent-impl-126/db`; carga exclusivamente los adaptadores del checkout
y usa `SYNAGENT_BROKER_URL` sin modificar ni copiar configuración o
credenciales. Antes de enviar comprueba con `lsof` que cada sesión conecta a
`18326` y ninguna conecta a `1884`:

```sh
SYNAGENT_OMP_MODEL=anthropic/claude-haiku-5-5 \
SYNAGENT_PI_MODEL=openai-codex/gpt-6.1-sol \
  npm run verify:delivery-events --workspace @a4s/synagent
```

Para cada host, el script hace que A envíe un `task.request` real a B, exige una
tool bash en B y comprueba en el bus `task.delivered` y `task.completed`, su
`correlation_id`, el body final, la inyección del completed en A y cero llamadas
de B a `synagent_send`. Después lanza pedidos mutuos y comprueba una secuencia
finita de dos comandos, dos delivered y dos completed, sin eventos causados por
eventos. `SYNAGENT_LIVE_ROOT` cambia la raíz de evidencia temporal.

La comprobación viva de recuperación requiere los mismos hosts y credenciales.
Arranca un broker propio en `18327` con DB
`/tmp/synagent-impl-127/db`, verifica con `lsof` el aislamiento de cada proceso
antes de enviar, deja una entrega pendiente durante `sleep 120`, mata el grupo
del host con `SIGKILL`, reanuda el mismo archivo y exige una sola inyección. Un
reenvío del id confirmado debe producir `message.duplicate` sin otro turno:

```sh
SYNAGENT_OMP_MODEL=anthropic/claude-haiku-5-5 \
SYNAGENT_PI_MODEL=openai-codex/gpt-6.1-sol \
  npm run verify:delivery-recovery --workspace @a4s/synagent
```

La comprobación viva de vencimiento y cancelación usa el broker propio `18328`
y DB `/tmp/synagent-impl-128/db`. Para cada host ocupa el destino con una tool
real, envía desde otra sesión con `request-ttl=5`, exige `task.expired` con
`reply_to`, ausencia de inyección y `estado=vencido` en `/synagent pending`.
Después cancela otro pedido durante la ocupación y exige que tampoco se
inyecte. Verifica con `lsof` que cada proceso conecta únicamente a `18328` antes
de enviar. El script usa los directorios reales solo para la autenticación,
guarda los bytes y permisos exactos de `synagent.json`, configura temporalmente
el TTL y restaura el archivo al cerrar:

```sh
SYNAGENT_OMP_MODEL=anthropic/claude-haiku-5-5 \
SYNAGENT_PI_MODEL=openai-codex/gpt-6.1-sol \
  npm run verify:request-lifecycle --workspace @a4s/synagent
```

La comprobación viva de DLQ usa omp 18.11.0, Pi 1.0.3 y el broker propio
`18329`. Crea con `mkdtemp` una raíz de evidencia privada (`0700`) bajo el
directorio temporal del sistema, imprime su ruta real y guarda allí la DB.
`SYNAGENT_LIVE_ROOT` permite elegir explícitamente otra raíz. Para cada host
publica JSON inválido y fuerza de forma determinista una excepción de
`sendUserMessage` desde una extensión de verificación temporal creada de forma
exclusiva (`0600`); el adaptador de producción no contiene un disparador. Exige
ambos registros QoS 1 con payload intacto, ejecuta `/synagent dlq`, reintenta el
fallo de despacho una vez y comprueba una sola republicación e inyección. Antes
de enviar, `lsof` filtrado por PID exige que el proceso use solo `18329` y nunca
`1884`. Usa los directorios reales únicamente para autenticación y no modifica
sus archivos:

```sh
SYNAGENT_OMP_MODEL=anthropic/claude-haiku-5-5 \
SYNAGENT_PI_MODEL=openai-codex/gpt-6.1-sol \
  npm run verify:dlq --workspace @a4s/synagent
```

Las pruebas de este workspace incluyen el protocolo compartido, los bridges
reales y un recorrido MQTT bidireccional del adaptador Pi contra Aedes con el
peer emulado. El workspace del bus prueba por separado la CLI persistente, el
bin global empacado y la integración Herdr.

## Límites actuales

`task.delivered` confirma que el adaptador de destino aceptó el turno;
`synagent-pending` recupera el corte acotado documentado arriba y MQTT aporta
QoS, retención y sesiones persistentes. Synagent no es un log reproducible ni
ofrece replay histórico, event sourcing, procesamiento transaccional o alta
disponibilidad.

## Observador del bus (CLI de solo lectura)

Desde la raíz del repo, después de `npm ci`:

```sh
npm run observer --workspace @a4s/synagent -- --output /tmp/synagent.jsonl
# Otra terminal: intercambiar un pedido y su respuesta entre sesiones.
# Ctrl-C termina la captura; también admite SIGTERM.
npm run observer --workspace @a4s/synagent -- --replay /tmp/synagent.jsonl
```

El modo en vivo se suscribe a `synagent/#` con QoS 1, sesión limpia y sin
reconexión automática. Solo recibe: no publica mensajes, presencia ni will.
Los acuses MQTT de recepción no son publicaciones. Un fallo de conexión,
suscripción o escritura termina el comando con error. El cliente no impone
ACL: las garantías de acceso del broker son independientes.

Por defecto lee `broker-url` de la configuración de usuario de **omp**,
`~/.omp/agent/synagent.json`, y finalmente usa `mqtt://127.0.0.1:1884`.
`PI_CODING_AGENT_DIR` sustituye el directorio de usuario, como en los
adaptadores. La CLI solo lee settings. `--host pi` selecciona los settings de
usuario de Pi, incluidos sus settings legacy.
`--broker-url mqtt://127.0.0.1:1884` sobrescribe el broker para esa captura;
admite las mismas URLs loopback que los adaptadores. `--help` muestra las
opciones.

Cada recepción añade una línea JSON con `{topic, received_at, payload}`:
`received_at` es la hora local ISO 8601 y `payload` es el texto UTF-8 original,
incluidos sobres desconocidos, IDs de correlación/causación y mensajes que no
sean JSON.
El archivo se abre en append; uno nuevo se crea con permisos `0600`. Contiene
el contenido completo del bus, potencialmente privado: el operador elige su
ruta y retención. La captura comienza al confirmar la suscripción; no recupera
historial del broker. QoS 1 puede producir recepciones duplicadas, que se
conservan en el archivo y la vista.

La terminal muestra un snapshot agrupado por enlaces `id`/`reply_to`/
`causation_id` y por `correlation_id` cuando exista. Los enlaces transitivos
unen las cadenas, incluso si el padre llega después del hijo. Las cadenas se
ordenan por su primera recepción y los mensajes de cada cadena conservan el
orden de recepción, sin ordenar por el reloj del emisor. Los mensajes sin
enlaces tienen su propia cadena; el payload se muestra escapado para la
terminal.
Cada recepción redibuja la vista interactiva; al redirigir stdout se escriben
snapshots sucesivos. La vista en vivo incluye solo las recepciones de esa
invocación y conserva sus mensajes en memoria.

`--replay ARCHIVO` imprime un único snapshot con el mismo agrupador y
renderer, leyendo todas las líneas capturadas y sin conectar al broker ni
leer settings. Para un archivo nuevo, coincide con el último snapshot de su
captura en vivo; si se reutiliza un archivo, replay incluye también sus
capturas anteriores. La reproducción es una vista local del JSONL, no un
reenvío de mensajes ni un replay histórico del bus.
