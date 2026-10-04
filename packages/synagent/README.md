# synagent

**synagent** (sinapsis + agent) es la mensajería aislada que deja a agentes de
distintos harnesses (Claude, Pi, …) **comunicarse** sin que uno conozca al otro.
Materializa el patrón *Channel Adapter + Message Bus* descrito en
`.workspace/docs/research/2026-10-02-agent-messaging-adapter-pattern-boceto.md`
y la decisión registrada en `.workspace/docs/adr/0065-synagent-bus-mqtt-embebido-adaptadores-por-harness.md`.

> Estado: **PoC promovido**. El contrato, el bus y el adaptador de Claude están
> verificados en vivo (JALAR + ENVIAR). Durabilidad/orden/ACK semántico y más
> adaptadores quedan como evolución (ver ADR 0065 y §9 del boceto).

## Dos piezas

1. **El bus** (`bus/`) — app aparte, distribuible, que se arranca por shell.
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
# o: node bus/broker.js [puerto] [dbdir]
```

El broker imprime `BROKER READY :<puerto>`. Es idempotente: si el puerto ya está
ocupado por otro broker, sale limpio.

## Adaptador de Claude

El plugin vive en `adapters/claude/`. Cárgalo en Claude Code (dev-mods o
`claude --plugin-dir adapters/claude`). Al cargar:

- **JALAR (bus → Claude):** spawnea `bus/bridge-sub.js` suscrito a
  `a4s/inbox/claude`; cada mensaje entrante se inyecta como un turno vía
  `$.prompt.submit` (solo cuando la sesión está idle; nunca interrumpe un turno
  vivo). Deduplica por `id`.
- **ENVIAR (Claude → bus):** el comando `/mq-send [to:] texto` publica un
  mensaje canónico al inbox del destinatario (`to` por defecto `pi`).

El adaptador resuelve la ruta del bus desde `$.plugin.root` (el bus está en
`../../bus` relativo al plugin). Requiere **Node disponible en el host** (el
sandbox del mod no corre Node ni TCP crudo; broker y bridges son procesos Node
que el adaptador lanza con `$.process`).

Validar / probar el plugin:

```sh
claude plugin validate adapters/claude
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
