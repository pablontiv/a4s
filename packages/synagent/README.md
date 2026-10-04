# synagent

**synagent** (sinapsis + agent) es la mensajería aislada que deja a agentes de
distintos harnesses (Claude, Pi, …) **comunicarse** sin que uno conozca al otro.
Materializa el patrón *Channel Adapter + Message Bus* descrito en
`.workspace/docs/research/2026-10-02-agent-messaging-adapter-pattern-boceto.md`
y la decisión registrada en `.workspace/docs/adr/0066-synagent-bus-mqtt-embebido-y-adaptadores-de-canal-por-harness.md`.

> Estado: **PoC promovido**. El contrato, el bus y el adaptador de Claude están
> verificados en vivo (JALAR + ENVIAR). Durabilidad/orden/ACK semántico y más
> adaptadores quedan como evolución (ver ADR 0066 y §9 del boceto).

## Dos piezas

1. **El bus** (`bus/`) — app aparte que se arranca por shell. `bus/` contiene
   **solo** `broker.cjs`; los bridges viven dentro del plugin.
   Broker MQTT embebido (**aedes**, provider) con persistencia **LevelDB**
   (classic-level, provider). No requiere Docker ni un manejador de base de
   datos instalado.
2. **Los adaptadores** (`adapters/<harness>/`) — un borde fino por harness que
   traduce entre el API del harness y el contrato canónico del bus. Hoy:
   `adapters/claude/` (plugin de Claude Code).

Agregar un harness = escribir **un adaptador nuevo**; el bus y los demás
adaptadores no cambian.

## Contrato canónico

Cada mensaje lleva: `id`, `from`, `to`, `kind` (`prompt | steer | result |
notify | ack`), `body`, `reply_to?`, `ts`. El adaptador **solo** traduce; la
semántica durable (orden, retención, ACK) es del bus.

Los inbox/outbox se emulan con topics MQTT: `a4s/inbox/<address>`. Mi inbox = lo
que suscribo; mi outbox = publicar al inbox del destinatario.

## Arrancar el bus

```sh
npm run bus                 # escucha en :1884, persistencia LevelDB en bus/mqtt-db
# o: node bus/broker.cjs [puerto] [dbdir]
```

El broker imprime `BROKER READY :<puerto>`. Es idempotente: si el puerto ya está
ocupado por otro broker, sale limpio.

### Seguridad

El broker escucha **solo en loopback (127.0.0.1)** y **no tiene auth, TLS ni
ACL**. Exponerlo a otras interfaces permitiría que cualquier host de la red
inyecte prompts publicando en `a4s/inbox/<address>`. Un uso en red requiere
`authenticate`/`authorizePublish` y TLS (fuera del alcance de este PoC).

## Adaptador de Claude

El plugin vive en `adapters/claude/`. Cárgalo en Claude Code (dev-mods o
`claude --plugin-dir packages/synagent/adapters/claude`). Al cargar:

- **JALAR (bus → Claude):** spawnea `bridge/bridge-sub.cjs` suscrito a
  `a4s/inbox/claude`; cada mensaje entrante se inyecta como un turno vía
  `$.prompt.submit` (solo cuando la sesión está idle; nunca interrumpe un turno
  vivo). Deduplica por `id`.
- **ENVIAR (Claude → bus):** el comando `/mq-send [to:] texto` publica un
  mensaje canónico al inbox del destinatario (`to` por defecto `pi`); lo publica
con `bridge/bridge-pub.cjs`.

Los bridges (`bridge-sub.cjs` y `bridge-pub.cjs`) viven dentro del plugin, en
`adapters/claude/bridge/`. El adaptador los resuelve desde `$.plugin.root` como
`$.plugin.root/bridge`, así que el plugin es **autocontenido**: tiene su propio
`package.json` (dependencia `mqtt`) y `package-lock.json` versionado, y se puede
copiar/instalar fuera de este layout del repo. Requiere **Node disponible en el
host** (el sandbox del mod no corre Node ni TCP crudo; broker y bridges son
procesos Node que el adaptador lanza con `$.process`).

### Desarrollo en el repo

Para trabajar sobre el adaptador dentro del repo, cárgalo en el sitio (dev-mods o
`claude --plugin-dir packages/synagent/adapters/claude`).

### Instalar desde un marketplace (GitHub)

El repo es un **marketplace**: `.claude-plugin/marketplace.json` en la raíz lista
el plugin `synagent-adapter-mqtt` con source `./packages/synagent/adapters/claude`.

```sh
claude plugin marketplace add pablontiv/a4s
claude plugin install synagent-adapter-mqtt@a4s
```

La instalación copia el directorio del plugin y provisiona su dependencia `mqtt`
(instala con `--ignore-scripts`; `mqtt` es JS puro, así que basta; requiere el
`package-lock.json` versionado, que está presente).

**El broker NO se instala.** Es la app aparte del bus: sigues arrancándolo tú
(`npm run bus` desde el repo, o donde lo alojes) y apuntas el adaptador a él con
`brokerUrl`.

### Configuración: `brokerUrl`

El plugin declara el campo `userConfig` `brokerUrl` (por defecto
`mqtt://127.0.0.1:1884`). Para otro broker, cámbialo con `/plugin configure` o al
instalar:

```sh
claude plugin install synagent-adapter-mqtt@a4s --config brokerUrl=mqtt://host:1884
```

### Semántica de entrega

La entrega al modelo es **at-most-once**: el adaptador reserva el `id` de cada
mensaje **antes** de llamar a `$.prompt.submit` (el set de dedup es acotado,
~últimos 1000 ids). Esto evita reinyectar el mismo turno, pero puede perder uno
si la entrega falla tras reservar. MQTT da QoS1/retained/sesión persistente
hasta el bridge, pero mqtt.js hace auto-ACK del mensaje QoS1 al retornar el
handler, así que la redelivery de la sesión persistente **no** protege ante una
caída del adaptador a mitad del manejo. La re-suscripción en hot-reload depende
de que el takeover por `clientId` de MQTT expulse al bridge anterior; no es una
muerte garantizada del proceso viejo.

Validar / probar el plugin:

```sh
claude plugin validate packages/synagent/adapters/claude
```

## Pruebas del paquete

```sh
npm test        # núcleo del adaptador (node:test) + round-trip del bus (aedes en memoria)
npm run typecheck
```

El núcleo puro (`adapters/claude/hooks/adapter.ts`) se typecheckea y testea como
código normal. `register.ts` (glue del runtime de Claude Code) se excluye del
typecheck del repo y se valida con `claude plugin validate`.

## Qué NO hace este PoC

No provee ACK semántico fenceado, retención configurable, replay histórico tipo
log/offsets ni event sourcing. MQTT da **entrega** (QoS, retained, sesiones
persistentes), no replay. El log/event sourcing queda como evolución **aditiva**
(ver §9.9 del boceto): un *log sink* suscrito a todos los topics, sin cambiar los
adaptadores.
