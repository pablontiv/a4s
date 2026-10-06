# synagent

**synagent** (sinapsis + agent) es la mensajería aislada que permite que agentes
de distintos harnesses se comuniquen sin conocerse entre sí. Materializa el
patrón *Channel Adapter + Message Bus* del boceto
`.workspace/docs/research/2026-10-02-agent-messaging-adapter-pattern-boceto.md`
y el ADR 0066.

## Componentes

1. **Bus** (`../synagent-bus/`): paquete instalable separado
   `@a4s/synagent-bus`, con broker MQTT Aedes, persistencia LevelDB y plugin
   Herdr. Los bridges de Claude viven dentro de su propio plugin.
2. **Adaptadores** (`adapters/<harness>/`): bordes finos que traducen el API de
   cada harness al contrato canónico. Incluye el plugin de Claude Code y la
   extensión Pi.
3. **Protocolo** (`protocol.ts`): contrato canónico compartido — gramática de
   direcciones, mapa dirección→topic, plan de suscripción, enrutado y resolución
   de proyecto/instancia. El plugin Claude lleva una **copia generada** en
   `hooks/adapter.ts` (regenerable con `adapters/claude/scripts/sync-protocol.mjs`
   y anclada por un test de paridad) porque el marketplace instala solo su
   directorio.

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

- **proyecto**: token determinista; setting del host > nombre canónico del repo
  del remoto `origin` (nunca el basename del cwd ni una variable de entorno).
  Falla explícito si no hay fuente válida.
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
[`../synagent-bus/README.md`](../synagent-bus/README.md).

## Adaptador de Claude Code

El plugin vive en `adapters/claude/`. Cárgalo en Claude Code con dev-mods o con:

```sh
claude --plugin-dir packages/synagent/adapters/claude
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
| `project` | derivado | Token de proyecto v1 (si vacío: nombre del repo del remoto `origin`). |
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
pi -e packages/synagent/adapters/pi/index.ts
```

O instalarse desde el checkout:

```sh
pi install ./packages/synagent
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

El proyecto sale primero de `a4s.synagent.project`; si está vacío, se deriva del
`remote.origin.url` canónico leído en el `ctx.cwd` de la sesión, nunca del cwd
del proceso ni de su basename. Si no resuelve, muestra un warning y queda
inactivo, sin suscripciones ni publicación; los intentos de envío piden
configurar el proyecto. El estado de `/synagent status` muestra `inactive=true`;
se remedia con `/synagent set project <token>` o configurando
`remote.origin.url`.

### Envío y comandos Pi

El modelo usa la herramienta `synagent_send` con `to`, `body`, `kind?` y
`reply_to?` cuando el usuario pide mensajear a otro agente o proyecto. Conserva
mayúsculas y puntos en destinos válidos. `/mq-send` es solo un atajo explícito
de depuración:

```text
/mq-send <to>: texto        (debug; to = dirección v1, o token cualificado con tu proyecto)
/synagent status
/synagent enable|disable
/synagent resume
/synagent set broker-url <mqtt://loopback:puerto>
/synagent set project <token>
/synagent set global <true|false>
/synagent set default-peer <address>
```

`/synagent set project` persiste en el scope de proyecto de settings de Pi;
los demás subcomandos `set` persisten en el scope global. Los cambios de
`enabled`, `broker-url`, `project` o `global` reinician solo la conexión MQTT.
Al cambiar de topics durables, el adaptador elimina las
suscripciones obsoletas antes de usar las nuevas y reintenta esa limpieza al
reconectar. El cambio descarta mensajes aún no enviados de la configuración
anterior. Una entrega ya pasada a Pi no se puede cancelar y permanece como
barrera de orden hasta `agent_settled`.

### Settings propios

| Key | Default |
| --- | --- |
| `a4s.synagent.enabled` | `true` |
| `a4s.synagent.broker-url` | `mqtt://127.0.0.1:1884` |
| `a4s.synagent.project` | remoto `origin` del `ctx.cwd` de sesión |
| `a4s.synagent.global` | `true` |
| `a4s.synagent.default-peer` | `claude` |

No existe setting de instancia y el adaptador no lee variables de entorno
`SYNAGENT_*`. Mientras el broker no tenga autenticación, acepta únicamente URLs
`mqtt://` de loopback sin credenciales. Si la URL configurada no cumple esa
restricción, muestra un warning y usa el default seguro
`mqtt://127.0.0.1:1884`. Los tokens v1 son sensibles a
mayúsculas y admiten puntos (`[A-Za-z0-9][A-Za-z0-9._-]{0,255}`); rechazan `/`,
`+` y `#` dentro de cada token.

### Entrega en Pi

Los mensajes recibidos se validan y se encolan en orden de llegada. Como la API
pública `sendUserMessage` de Pi retorna `void`, el adaptador no finge esperar su
procesamiento interno: invoca como máximo un mensaje, confirma su aceptación
al observar el `message_start` de usuario con su marcador y libera el siguiente
solo después de `agent_settled`. Un turno ajeno no puede liberar esa barrera. Pi
conserva la autoridad sobre la planificación de turnos. Si una entrega no
alcanza `message_start`, o una ya aceptada no alcanza `agent_settled`, en 30
segundos mantiene la barrera y muestra una advertencia. Esto también cubre un
mensaje interceptado por otro input handler y evita confundir un fallo con un
preflight o turno lento. El operador puede ejecutar `/synagent resume` para
liberar la cola explícitamente, aceptando orden best-effort desde ese punto. El
adaptador reserva cada `id` antes de encolarlo y conserva los
últimos 1000 IDs en entradas privadas de la sesión:

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
SHA-256 determinista. El mismo cálculo se puede usar en el adaptador Claude.

El JSONL no contiene body, payload, prompt, respuesta, transcript, token,
topic, dirección, URL, client ID, entorno, argv ni ID de sesión crudo. El
nombre de instancia deriva de un digest del ID de sesión. El escritor aplica
`0700` a sus directorios y `0600` al archivo. Rechaza rutas de instancia y
archivos que sean symlinks o tipos no regulares. Usa `O_NOFOLLOW` cuando el
sistema lo ofrece. Si no garantiza la ruta o los permisos, omite el registro.
Nunca usa stdout o stderr como fallback.

El escritor es best-effort. Un fallo de creación, formato o escritura no
detiene el adaptador. Cada archivo tiene una cuota fija de 16 MiB. El escritor
deja de escribir antes de superar la cuota. No borra ni rota datos. La cuota
limita el consumo de disco. No ofrece retención. El cierre solicita `fsync`,
pero un fallo posterior no cambia una línea ya escrita. Las defensas cubren a
otros usuarios y paths hostiles preexistentes.
No cubren un proceso malicioso con el mismo UID. También existe una ventana
TOCTOU donde faltan APIs portables para cerrarla.

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

Las pruebas de este workspace incluyen el protocolo compartido, los bridges
reales y un recorrido MQTT bidireccional del adaptador Pi contra Aedes con el
peer emulado. El workspace del bus prueba por separado la CLI persistente, el
bin global empacado y la integración Herdr.

## Límites actuales

Synagent no ofrece ACK semántico fenceado, replay histórico, event sourcing ni
alta disponibilidad. MQTT aporta QoS, retención y sesiones persistentes; esas
garantías no convierten el bus en un log reproducible.
