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
3. **Protocolo** (`protocol.ts`): validación, serialización y presentación del
   contrato canónico. El plugin Claude conserva una copia mínima compatible en
   `hooks/adapter.ts` porque el marketplace instala solo su directorio.

Agregar otro harness requiere un adaptador nuevo; no modifica el bus ni los
adaptadores existentes.

## Contrato canónico

Cada mensaje lleva `id`, `from`, `to`, `kind` (`prompt | steer | result |
notify | ack`), `body`, `reply_to?` y `ts`. Los inbox se representan con topics
MQTT `a4s/inbox/<address>`: cada adaptador se suscribe a su address y publica al
del destinatario.

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

- **JALAR (bus → Claude):** spawnea `bridge/bridge-sub.cjs` suscrito a
  `a4s/inbox/claude`; cada mensaje entrante se inyecta como un turno vía
  `$.prompt.submit` cuando la sesión está idle. Deduplica por `id`.
- **ENVIAR (Claude → bus):** `/mq-send [to:] texto` publica un mensaje canónico
  al inbox del destinatario; `to` por defecto es `pi`.

Los bridges viven en `adapters/claude/bridge/` y se resuelven desde
`$.plugin.root`, por lo que el plugin es autocontenido. Tiene `package.json` y
`package-lock.json` propios y requiere Node en el host.

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

### Configuración: `brokerUrl`

El plugin declara `brokerUrl` en `userConfig`, con default
`mqtt://127.0.0.1:1884`. Puede cambiarse con `/plugin configure` o al instalar:

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

Al iniciar una sesión abre un cliente MQTT persistente (`clean: false`) y se
suscribe con QoS 1 a `a4s/inbox/<address>`. El `clientId` deriva del ID estable
de la sesión Pi, por lo que dos sesiones no se expulsan entre sí. Si comparten
la misma address, MQTT entrega el mensaje a ambas; usa addresses distintas
cuando deba existir un único destinatario. En `session_shutdown` cancela sus
listeners y cierra la conexión idempotentemente sin borrar la suscripción
durable.

### Comandos Pi

```text
/mq-send [to:] texto
/synagent status
/synagent enable|disable
/synagent resume
/synagent set broker-url <mqtt://loopback:puerto>
/synagent set address <address>
/synagent set default-peer <address>
```

`/synagent` persiste cambios en el scope global de settings de Pi. Los cambios
de `enabled`, `broker-url` o `address` reinician solo la conexión MQTT. Al
cambiar de address, el adaptador elimina la suscripción anterior antes de usar
la nueva y reintenta esa limpieza al reconectar. El cambio descarta mensajes
aún no enviados de la configuración anterior. Una entrega ya pasada a Pi no se
puede cancelar y permanece como barrera de orden hasta `agent_settled`.

### Settings propios

| Key | Default |
| --- | --- |
| `a4s.synagent.enabled` | `true` |
| `a4s.synagent.broker-url` | `mqtt://127.0.0.1:1884` |
| `a4s.synagent.address` | `pi` |
| `a4s.synagent.default-peer` | `claude` |

No usa variables de entorno. Mientras el broker no tenga autenticación, el
adaptador acepta únicamente URLs `mqtt://` de loopback sin credenciales. Las
addresses rechazan separadores y comodines MQTT.

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
