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

## Direccionamiento v1 (ADR 0068)

Topología jerárquica versionada, con la regla `topic == "synagent/" + versión +
"/" + to`:

| Dirección (`to`) | Topic | Alcance |
| --- | --- | --- |
| `<proyecto>/<instancia>` | `synagent/v1/<proyecto>/<instancia>` | un agente (buzón directo) |
| `<proyecto>/all` | `synagent/v1/<proyecto>/all` | todo el proyecto |
| `all` | `synagent/v1/all` | global (opt-in) |

- **proyecto**: token determinista; `SYNAGENT_PROJECT` > config > `owner-repo`
  del remoto `origin` (nunca el basename del cwd).
- **instancia**: token legible ligado a la tarea/sesión; `SYNAGENT_INSTANCE` >
  config > generado y persistido (un *resume* conserva el id, un *fork* obtiene
  otro). El id no es el tipo de agente: puede haber varias instancias Claude o
  Pi por proyecto.
- **steer** solo tiene sentido a destino directo; un `steer` a broadcast se
  rechaza en el envío y en la recepción.
- **global** es opt-in: un adaptador no recibe `synagent/v1/all` salvo que lo
  active.

### Cutover dual-read / single-write

Durante la transición cada adaptador **suscribe y acepta** tanto el esquema
legacy (`a4s/inbox/<address>`) como v1, pero **publica solo v1**. El dedupe por
`id` es compartido entre los topics/clientes. La retirada de legacy será un paso
posterior (unsubscribe durable explícito con un gate observable).

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
  y al legacy `a4s/inbox/claude`, y uno transitorio (`clean=true`) al broadcast de
  proyecto `synagent/v1/<proyecto>/all` (y al global si se activa). Cada mensaje
  entrante se inyecta como un turno vía `$.prompt.submit`. Deduplica por `id`.
- **ENVIAR (Claude → bus):** la herramienta `synagent_send` (invocada por el
  modelo) publica un mensaje canónico v1 al destino. `/mq-send <to>: texto` queda
  como atajo de depuración. Si la identidad no se resuelve, el adaptador opera
  **legacy-only** (solo JALAR de `a4s/inbox/claude`) y `synagent_send` pide
  configurar proyecto/instancia.

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
| `project` | derivado | Token de proyecto v1 (si vacío: `SYNAGENT_PROJECT` > git remote). |
| `instance` | generado | Token de instancia v1 (si vacío: `SYNAGENT_INSTANCE` > generado-persistido). |
| `global` | `false` | Suscribirse al broadcast global `synagent/v1/all`. |

También lee los env `SYNAGENT_PROJECT` y `SYNAGENT_INSTANCE`. Se configura con
`/plugin configure` o al instalar:

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
`synagent/v1/<proyecto>/<instancia>` y al legacy `a4s/inbox/<address>`
(dual-read), y uno transitorio (`clean: true`) al broadcast de proyecto
`synagent/v1/<proyecto>/all` (y al global si se activa). Dos sesiones no se
expulsan entre sí. En `session_shutdown` cancela sus listeners y cierra ambas
conexiones idempotentemente sin borrar la suscripción durable. Si la identidad
no se resuelve, opera **legacy-only** sobre `a4s/inbox/<address>`.

### Comandos Pi

```text
/mq-send <to>: texto        (to = dirección v1, o un token que se cualifica con tu proyecto)
/synagent status
/synagent enable|disable
/synagent resume
/synagent set broker-url <mqtt://loopback:puerto>
/synagent set address <address>        (dirección LEGACY para dual-read)
/synagent set project <token>
/synagent set instance <token>
/synagent set global <true|false>
/synagent set default-peer <address>
```

`/synagent` persiste cambios en el scope global de settings de Pi. Los cambios
de `enabled`, `broker-url`, `address`, `project`, `instance` o `global` reinician
solo la conexión MQTT. Al cambiar de topics durables, el adaptador elimina las
suscripciones obsoletas antes de usar las nuevas y reintenta esa limpieza al
reconectar. El cambio descarta mensajes aún no enviados de la configuración
anterior. Una entrega ya pasada a Pi no se puede cancelar y permanece como
barrera de orden hasta `agent_settled`.

### Settings propios

| Key | Default |
| --- | --- |
| `a4s.synagent.enabled` | `true` |
| `a4s.synagent.broker-url` | `mqtt://127.0.0.1:1884` |
| `a4s.synagent.address` (legacy, dual-read) | `pi` |
| `a4s.synagent.project` | derivado |
| `a4s.synagent.instance` | generado-persistido |
| `a4s.synagent.global` | `false` |
| `a4s.synagent.default-peer` | `claude` |

Lee los env `SYNAGENT_PROJECT` y `SYNAGENT_INSTANCE` para la identidad v1.
Mientras el broker no tenga autenticación, el adaptador acepta únicamente URLs
`mqtt://` de loopback sin credenciales. Las direcciones rechazan comodines MQTT
y mayúsculas (tokens `[a-z0-9][a-z0-9_-]{0,63}`).

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
