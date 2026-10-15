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

Cada mensaje lleva `id`, `from`, `to`, `kind` (`prompt | steer | result |
notify | ack`), `body`, `reply_to?` y `ts`. `from` y `to` son direcciones v1;
`reply_to` es un id de mensaje, no una dirección.

## Direccionamiento v1 (ADR 0068; identidad por ADR 0069)

Topología jerárquica versionada, con la regla `topic == "synagent/" + versión +
"/" + to`:

| Dirección (`to`) | Topic | Alcance |
| --- | --- | --- |
| `<proyecto>/<instancia>` | `synagent/v1/<proyecto>/<instancia>` | un agente (buzón directo) |
| `<proyecto>/all` | `synagent/v1/<proyecto>/all` | todo el proyecto |
| `all` | `synagent/v1/all` | global (activo por defecto) |

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
- **steer** solo tiene sentido a destino directo; un `steer` a broadcast se
  rechaza en el envío y en la recepción.
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
  `synagent/v1/<proyecto>/all` y global `synagent/v1/all`. Cada mensaje entrante
  se inyecta como un turno vía `$.prompt.submit`. Deduplica por `id`.
- **ENVIAR (Claude → bus):** la herramienta `synagent_send` (invocada por el
  modelo) publica un mensaje canónico v1 al destino. `/mq-send <to>: texto` queda
  como atajo de depuración. Si la identidad no se resuelve, el adaptador queda
  inactivo y pide configurar el proyecto.

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
`synagent/v1/<proyecto>/<instancia>`, y uno transitorio (`clean: true`) a los
broadcasts de proyecto `synagent/v1/<proyecto>/all` y global
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

El modelo usa la herramienta `synagent_send` con `to`, `body`, `kind?` y
`reply_to?` cuando el usuario pide mensajear a otro agente o proyecto. Conserva
mayúsculas y puntos en destinos válidos. `/mq-send` es solo un atajo explícito
de depuración:

```text
/mq-send <to>: texto        (debug; to = dirección v1, o token cualificado con tu proyecto)
/synagent-settings
/synagent status
/synagent enable|disable
/synagent resume
/synagent set broker-url <mqtt://loopback:puerto>
/synagent set global <true|false>
/synagent set default-peer <address>
```

`/synagent-settings` muestra los valores efectivos de usuario. Permite editar
cada valor, restablecerlo a su valor heredado o cancelar sin cambios.
`enabled` y `global` usan una selección booleana. `broker-url` y
`default-peer` usan entradas validadas.

Todos los subcomandos de configuración persisten en el ámbito de usuario.
Los cambios de `enabled`, `broker-url` o `global` ejecutan una reconfiguración MQTT.
Un cambio de `default-peer` no reinicia MQTT. Al cambiar los topics durables, el adaptador
elimina las suscripciones obsoletas antes de usar las nuevas. Reintenta esa
limpieza al reconectar. El cambio descarta mensajes aún no enviados de la
configuración anterior. Una entrega ya pasada a Pi no se puede cancelar.
Permanece como barrera de orden hasta que la sesión se asienta.

### Configuración nativa de Pi y omp

| Clave | Default | Ámbito de escritura |
| --- | --- | --- |
| `enabled` | `true` | usuario |
| `broker-url` | `mqtt://127.0.0.1:1884` | usuario |
| `global` | `true` | usuario |
| `default-peer` | `claude` | usuario |

El archivo de usuario es `<agent-dir>/synagent.json`. El adaptador usa el valor
no vacío de `PI_CODING_AGENT_DIR` como `<agent-dir>`. En su defecto usa
`~/.pi/agent` en Pi y `~/.omp/agent` en omp.

El archivo contiene un objeto JSON plano con una o más de las cuatro claves.
Este ejemplo muestra el formato completo:

```json
{
  "enabled": true,
  "broker-url": "mqtt://127.0.0.1:1884",
  "global": true,
  "default-peer": "claude"
}
```

El adaptador resuelve cada clave por separado: archivo de usuario, valores
legacy de usuario (Pi) y default. `SYNAGENT_BROKER_URL`, cuando no está vacío,
sobrescribe `broker-url` solo para el proceso y nunca se persiste; se valida con
la misma restricción loopback. Los cambios de archivo se conservan al arrancar
otra sesión.

En Pi, si falta `synagent.json`, el adaptador migra las cuatro claves
`a4s.synagent.*` conocidas desde el `settings.json` de usuario. Conserva el
archivo original y valida los valores antes de migrarlos. La escritura usa
un archivo temporal y un cambio de nombre atómico, crea los directorios
necesarios y aplica modo `0600` al archivo de usuario.

Mientras el broker no tenga autenticación, el adaptador acepta únicamente URLs
`mqtt://` de loopback sin credenciales. Si la URL configurada no cumple esa
restricción, muestra un warning y usa el default seguro
`mqtt://127.0.0.1:1884`. Los tokens v1 son sensibles a mayúsculas y admiten
puntos (`[A-Za-z0-9][A-Za-z0-9._-]{0,255}`). Rechazan `/`, `+` y `#` dentro de
cada token.

### Entrega en Pi

Los mensajes recibidos se validan y se encolan en orden de llegada. Como la API
pública `sendUserMessage` de Pi retorna `void`, el adaptador no finge esperar su
procesamiento interno: invoca como máximo un mensaje, confirma su aceptación
al observar el `message_start` de usuario con su marcador y libera el siguiente
solo cuando Pi emite `agent_settled`. Un turno ajeno no puede liberar esa
barrera. El harness conserva la autoridad sobre la planificación de turnos.

Para cada entrega confirmada, el adaptador captura en `message_end` el último
contenido assistant con bloques `text` no vacíos. Un texto previo a una tool se
reemplaza por el texto final posterior; `toolCall`, `thinking` y `toolResult` no
son resultados. El filtro de vacío no recorta el contenido conservado. La
captura se asocia al ID, generación, token y marcador de esa entrega, y se
congela en el siguiente `message_start` de usuario. Por eso un `followUp`
procesado en el mismo ciclo no contamina el resultado que `agent_settled`
entrega al motor. Un resultado sin texto queda sin `a4s.delivery.text`.

Si una entrega no alcanza `message_start`, o una ya aceptada no se asienta, en
30 segundos mantiene la barrera y muestra una advertencia. Esto también cubre
un mensaje interceptado por otro input handler y evita confundir un fallo con
un preflight o turno lento. El operador puede ejecutar `/synagent resume` para
liberar la cola explícitamente, aceptando orden best-effort desde ese punto. El
adaptador reserva cada `id` antes de encolarlo y conserva los últimos 1000 IDs
en entradas privadas de la sesión:

- si Pi está idle, inicia un turno normal;
- `kind=steer` interrumpe un turno activo con `deliverAs: "steer"`;
- los demás mensajes se encolan con `deliverAs: "followUp"`.

La entrega al modelo es **at-most-once**. Puede perderse un mensaje si el
proceso cae después de reservar su ID y antes de entregarlo.

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

La entrega libera el siguiente mensaje cuando omp emite `agent_end`, salvo
que el evento indique `willContinue: true`. El adaptador comparte el motor de
sesión con Pi, pero usa las señales y la configuración propias de omp.

El archivo global es `~/.omp/agent/synagent.json` y el archivo de proyecto es
`<ctx.cwd>/.omp/synagent.json`. Un valor no vacío de `PI_CODING_AGENT_DIR`
sustituye `~/.omp/agent` como directorio del archivo global. Cada clave se
resuelve desde el archivo de proyecto confiable, el archivo global y su
default, en ese orden.

## Seguridad

El broker escucha solo en loopback y no implementa auth, TLS ni ACL. Cualquier
proceso local puede publicar, falsificar `from` y enviar incluso mensajes
`steer`; esos campos no prueban identidad. Exponer el broker a otra interfaz
permitiría inyección remota de prompts. Uso remoto requiere añadir
autenticación, autorización de topics y TLS antes de admitir URLs no locales.

## Pruebas

```sh
npm test --workspace @a4s/synagent
npm run typecheck --workspace @a4s/synagent
npm test --workspace @a4s/synagent-bus
```

La comprobación viva permanente requiere Pi 1.0.3 y credenciales ya disponibles
para un modelo real. Arranca dos sesiones RPC, un broker propio en `18224` y
directorios de sesión/estado temporales; carga solo el adaptador del checkout,
espera cada acuse RPC y no modifica ni copia la configuración o credenciales
globales:

```sh
SYNAGENT_PI_MODEL=openai-codex/gpt-6.1-sol \
  npm run verify:pi-delivery-capture --workspace @a4s/synagent
```

El script ejecuta tres entregas con texto previo, tool bash y texto final. En la
segunda encola un `followUp` al comenzar la tool y comprueba que el diagnóstico
conserva `FINAL_124_TWO`, no `USER_AFTER_124_TWO`. También correlaciona el ID
publicado en el bus, el marcador observado en destino y el hash diagnóstico.
`SYNAGENT_LIVE_ROOT` conserva la evidencia en una ruta elegida; si se omite, el
script imprime la ruta temporal que creó.

Las pruebas de este workspace incluyen el protocolo compartido, los bridges
reales y un recorrido MQTT bidireccional del adaptador Pi contra Aedes con el
peer emulado. El workspace del bus prueba por separado la CLI persistente, el
bin global empacado y la integración Herdr.

## Límites actuales

Synagent no ofrece ACK semántico fenceado, replay histórico, event sourcing ni
alta disponibilidad. MQTT aporta QoS, retención y sesiones persistentes; esas
garantías no convierten el bus en un log reproducible.

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
incluidos sobres desconocidos, `correlation_id` y mensajes que no sean JSON.
El archivo se abre en append; uno nuevo se crea con permisos `0600`. Contiene
el contenido completo del bus, potencialmente privado: el operador elige su
ruta y retención. La captura comienza al confirmar la suscripción; no recupera
historial del broker. QoS 1 puede producir recepciones duplicadas, que se
conservan en el archivo y la vista.

La terminal muestra un snapshot agrupado por enlaces `id`/`reply_to` y por
`correlation_id` cuando exista. Los enlaces transitivos unen las cadenas,
incluso si el padre llega después del hijo. Las cadenas se ordenan por su
primera recepción y los mensajes de cada cadena conservan el orden de
recepción, sin ordenar por el reloj del emisor. Los mensajes sin enlaces
tienen su propia cadena; el payload se muestra escapado para la terminal.
Cada recepción redibuja la vista interactiva; al redirigir stdout se escriben
snapshots sucesivos. La vista en vivo incluye solo las recepciones de esa
invocación y conserva sus mensajes en memoria.

`--replay ARCHIVO` imprime un único snapshot con el mismo agrupador y
renderer, leyendo todas las líneas capturadas y sin conectar al broker ni
leer settings. Para un archivo nuevo, coincide con el último snapshot de su
captura en vivo; si se reutiliza un archivo, replay incluye también sus
capturas anteriores. La reproducción es una vista local del JSONL, no un
reenvío de mensajes ni un replay histórico del bus.
