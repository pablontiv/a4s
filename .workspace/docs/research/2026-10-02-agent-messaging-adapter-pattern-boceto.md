# Boceto — Comunicación entre agentes Pi ↔ Claude vía Bus + Adaptador (synagent)

> Estado: **boceto / braindump**, no spec formal. El producto decidido se llama
> **synagent** (sinapsis + agent). La decisión está registrada en el ADR
> `0066-synagent-bus-mqtt-embebido-y-adaptadores-de-canal-por-harness`; el
> código promovido vive en `packages/synagent/`.
> Fecha: 2026-10-02 (actualizado 2026-10-04). Fuentes primarias citadas al final.

## 1. Qué queremos (y qué NO)

- **Queremos:** que agentes Pi y Claude puedan **comunicarse** — mandar y jalar mensajes — usando una **mensajería aislada** (hecha por nosotros o un tercero).
- **No queremos:** que la mensajería viva dentro del harness, ni que un agente sepa del otro. "Comunicación" = enviar + recibir contra algo externo. Nada más.

## 2. Decisión de diseño: dos componentes

El diseño se parte en dos piezas, y esto **es un patrón establecido** (no inventado):

1. **El Bus / cola** — el manejador + el contrato del mensaje. Es el backbone desacoplado.
2. **El Adaptador del agente** — un componente por harness (mod de Claude, extensión de Pi) que traduce entre el API del harness y el bus.

Mapa a *Enterprise Integration Patterns* (Hohpe & Woolf) y Hexagonal:

| Nuestra pieza | Patrón nombrado | Esencia |
|---|---|---|
| Bus / cola (manejador) | **Message Bus** | backbone que deja a apps separadas trabajar por mensajes, desacopladas |
| Contrato del mensaje | **Canonical Data Model** | formato común del bus → los adaptadores no se acoplan entre sí |
| Adaptador por agente | **Channel Adapter** | "messaging client" que conecta una app al bus vía su *application-supplied interface* |
| (visión global) | **Ports & Adapters / Hexagonal** | contrato = port; cada harness = adapter; swap de broker sin tocar el core |

**Implicación clave:** agregar un tercer harness = escribir **un Channel Adapter nuevo**. El bus y los demás adaptadores no cambian. El adaptador **solo** traduce harness ↔ contrato; no conoce al otro agente.

Esto además **coincide con el spec v0.9 del repo**: §6.5 Integration Boundary (adapters) = los Channel Adapters; el ACR (autoridad única de coordinación durable) = el Message Bus.

## 3. El contrato canónico mínimo (boceto)

Lo mínimo que cada mensaje lleva para que cualquier adaptador lo entienda sin conocer al emisor:

```yaml
message:
  id:            # idempotency key (dedupe / re-entrega segura)
  from:          # address lógico del emisor (NO confiable para autorizar)
  to:            # address lógico del destinatario
  kind:          # tipo (p. ej. prompt | steer | result | notify | ack)
  body:          # payload (texto plano en el piso más bajo)
  reply_to:      # opcional: address para responder
  ts:            # timestamp lógico del bus
```

Regla: el adaptador **solo** traduce entre este contrato y el API nativo del harness. Toda semántica durable (orden, retención, ACK) vive en el **bus**, no en el adaptador.

## 4. Responsabilidades del Channel Adapter (las dos básicas + 1)

1. **Enviar** — tomar salida del agente y publicarla al bus (según el contrato).
2. **Jalar** — leer del bus y **entregarla** al agente para que actúe.
3. (implícito) **Traducir** harness ↔ contrato en ambos sentidos.

El adaptador NO posee: durabilidad, ACK semántico fenceado, orden, re-entrega. Eso es del bus.
> Nota del spec (§8.5): un "delivered = encolado" transport-only **no** es ACK; el ACK semántico (binding_revision, idempotency, owner) lo exige el bus/ACR, no el transporte del adaptador.

## 5. Primitivas por harness (verificado, fuente primaria)

### 5.1 Claude — vía **mods**
- **Modelo de ejecución:** sandbox. El módulo no tiene Node ni red/fs propios; **todo acceso externo pasa por `$`**.
- **Enviar al bus:** `$.http.fetch(url, init)` (POST), `$.process.run([...])` (CLI/socket), o `$.fs.write(path, text)`. Disparado en hooks (`turn.finish`, `tool.call`, `command.run`) o en timer.
- **Jalar del bus:** `$.clock.every(ms, fn)` en background + dentro `$.http.fetch` (GET) / `$.process.run` / `$.fs.read`. Corre entre turnos.
- **Entregar al agente:** `$.prompt.submit({ text })` arranca un turno (o `asUser: true`).
- **Observar/interceptar:** evento `session.receive` (ve el mensaje antes que Claude; `{consumed}` para ocultarlo). Existe también mensajería nativa Claude↔Claude (`$.session.send`), pero es **efímera** (texto plano, colas 50/100, expira 5 min) — útil solo para Claude↔Claude, no como bus.
- **Límite:** **no hay listener/servidor entrante**; "jalar" es polling nuestro con el timer.

### 5.2 Pi — vía **extensiones**
- **Modelo de ejecución:** corre **dentro del proceso Pi, con permisos de SO completos** (Node/TS, npm, sockets, watchers, timers reales). Puede inspeccionar prompts, tool calls, archivos, credenciales, historial.
- **Forma:** módulo TS que exporta un factory default recibiendo `ExtensionAPI` (`pi`).
- **Enviar al bus:** IO directo (socket/HTTP/fs reales) desde la extensión. Para meter al agente: `pi.sendMessage()` / `pi.sendUserMessage()`.
- **Jalar del bus:** watchers/timers/sockets **reales** arrancados desde `session_start` (NO en el factory). No requiere polling artificial como Claude.
- **Entregar / cambiar contexto:** `pi.sendMessage/sendUserMessage`, `pi.appendEntry()`, control de sesión (tools/model/thinking).
- **Eventos (`pi.on()`):** `input`, `before_agent_start`, model/message/tool, `agent_end`, `agent_before_settle` (último punto accionable, puede append + pedir 1 continuación), `agent_settled` (final, solo notificación).
- **Otros:** `registerTool/registerCommand/registerShortcut/registerFlag`, `registerProvider/registerMcpServer/registerVirtualModel`, UI de terminal (`ctx.ui`, renderers), `pi.events` (hablar con otra extensión).
- **Limpieza:** cerrar recursos de sesión en `session_shutdown` idempotente.

### 5.3 Mapa primitiva → responsabilidad

| Responsabilidad | Claude (mod) | Pi (extensión) |
|---|---|---|
| Enviar al bus | `$.http.fetch` / `$.process.run` / `$.fs.write` | socket/HTTP/fs directo |
| Jalar del bus | `$.clock.every` + fetch/read (polling) | watcher/timer/socket real desde `session_start` |
| Entregar al agente | `$.prompt.submit({text})` | `pi.sendMessage` / `pi.sendUserMessage` / `appendEntry` |
| Observar entrada | `session.receive` | `pi.on('input'/'before_agent_start'...)` |

## 6. Hallazgos clave / correcciones hechas en el camino

- **Los mods NO están tan limitados como se pensó al inicio.** "no DOM / no Node" es literal pero **estrecho**: no es Node crudo, pero `$` sí da red (`$.http.fetch`), fs read/write (`$.fs`), procesos (`$.process`), timers (`$.clock`) e inyección de turno (`$.prompt.submit`). No hay muro de "sin red".
- **El único límite real del mod para "recibir":** no expone listener/servidor entrante → recibir = polling.
- **La extensión Pi es la más potente de las dos para IO:** in-process, permisos completos, sockets/timers reales. (Corrección: Pi **sí** tiene UI de terminal; afirmar lo contrario fue un error.)
- **Mod ≈ extensión Pi** como concepto: código externo que el harness carga y engancha a eventos para alterar comportamiento y añadir tools/commands/UI. Diferencia = sandbox (`$`) vs in-process (permisos completos).
- **Transporte ≠ mensajería.** El adaptador (mod/ext) es Channel Adapter = transporte + traducción. Durabilidad / ACK semántico / orden / re-entrega = responsabilidad del **bus** (alineado con §8.5 del spec: "delivered transport-only no satisface el contrato").

## 7. Abierto / por verificar

- RPC de Pi (`prompt`/`steer`/`follow_up` por stdin) como vía de entrada Claude→Pi: reportado por subagente, **no verificado línea por línea** contra pi.dev/docs RPC.
- Elección concreta del bus (broker tercero vs mínimo propio) — **resuelto en §9.6/§9.7** (broker MQTT embebido, aedes).
- Semántica exacta de retención/orden que exigiremos al bus (se deriva del contrato HARD del spec, §8.5 / §25.2).

## 8. Estado: PoC que ya materializa este boceto

> Añadido 2026-10-02, tras construir una prueba de concepto.

Existe un PoC funcional del **Channel Adapter de Claude** (como mod) que implementa este boceto:

- **Contrato (§3):** el tipo `CanonicalMessage` es un calco de los 7 campos (`id/from/to/kind/body/reply_to/ts`); `kind` = enum `prompt | steer | result | notify | ack`. `parseCanonical` exige los 6 obligatorios.
- **Responsabilidades (§4):** ENVIAR (`/bus-send` → `$.fs.write` al outbox), JALAR (`$.clock.every` en background + `/bus-poll` → `$.fs.list/read`, filtro `to == claude`, dedupe por `id` vía `$.store`, entrega con `$.prompt.submit`), TRADUCIR (núcleo puro, sin `$`).
- **Primitivas Claude (§5.1):** confirmadas **en vivo** — el mod cargó vía hot-reload y un mensaje del `inbox/` se materializó como un turno real de la sesión.
- **Bus emulado:** filesystem (`outbox/` + `inbox/`), aislado fuera del harness (§1).

Verificado: `claude plugin validate` PASS, tests 6/6 PASS, `tsc` limpio, ciclo de bus observado end-to-end (entrega solo `to == claude`, ignora lo demás, idempotente). Un test en vivo destapó y corrigió una carrera de deduplicación (reservar el `id` en el store **antes** de entregar + guard de poll en curso).

Límites / pendiente: la validación de lectura es estructural mínima (no valida aún el enum de `kind` ni los tipos); recibir = **polling** (no hay listener entrante, §6); durabilidad, orden y ACK semántico siguen siendo responsabilidad del **bus**, no del adaptador (§4; §8.5 del spec). El PoC es **disposable y vive fuera del repo** (experimento); volverlo durable requiere una task propia y versionar el contrato como artefacto (spec/ADR), no dejarlo solo en este boceto.

## 9. Evolución de arquitectura y decisiones (brain dump consolidado)

> Añadido 2026-10-03, tras la exploración posterior al PoC. El boceto (§1–§8) es **diseño**; esta sección recoge **decisiones**. Si crece, se parte a un ADR.

### 9.1 Protocolos: son interfaces, no buses
- MCP, ACP (IBM/BeeAI, **superseded por A2A**, ago-2025), ACP-Zed y A2A son **interfaces de acceso/transporte entre agentes**, no brokers durables. La durabilidad sigue siendo del bus (§4, §8.5).
- **Probe MCP (experimental):** un server Python sobre SQLite como bus pasó 10/10 (handshake, send, dedupe por `id`, receive, idempotencia at-most-once, addressing). Probó que "MCP sobre DB embebida" habla el protocolo; se **descarta como stack final** (§9.7), pero validó el modelo.

### 9.2 Empaquetado y distribución
- Confirmado en doc (code.claude.com/plugins/components): un **plugin de Claude Code puede empaquetar un server/binario** y declararlo (`.mcp.json` o key `mcpServers`), con `${CLAUDE_PLUGIN_ROOT}` sustituido en `command`/`args`/`env` → ruta estable. El estado (DB) **no** va en `PLUGIN_ROOT` sino en la ruta de *persistent-data*.
- **Inversión del modelo (decisión):** el **BUS es la app que se distribuye** e **instala cada adaptador**. Los adaptadores son bordes finos per-harness que apuntan al bus; no son dueños del bus. (Refuerza §2.)

### 9.3 Suscripción en el mod (corrección a §5.1/§6)
- **Rectificación:** el límite "recibir = polling" (§5.1, §6) es **incompleto**. El mod SÍ admite **push**, por dos vías:
  - **Subprocess de por vida** (`$.process.spawn`): el hijo corre entre turnos y su stream se consume con `for await`. Puede **suscribirse** al bus (MQTT/SSE/socket) y empujar.
  - **`watchPaths` (en `session.start`) + evento `FileChanged`** (add/change/unlink).
- **Invariante que permanece:** el push llega **al mod**, pero inyectar al modelo es `$.prompt.submit`, que **solo arranca turno con la sesión idle**. No se interrumpe un turno vivo → EDA real **hasta el borde**; solo ese borde es no-interrumpible.

### 9.4 Framing EDA
- El PoC era **message-driven dirigido** (cola con addressing `to`), no pub/sub. Objetivo revisado: **pub/sub** (publishers + N subscribers, con push).

### 9.5 Realidad de almacenamiento
- **libSQL/Turso = almacenamiento, no pub/sub.** Sin realtime nativo (intentado y abandonado; llegaría en Limbo, sin ETA). Tiene **CDC** (log consultable) + sync periódico `push()`/`pull()`. Conclusión: **nada "empuja" desde el DB**; "pub/sub sobre DB embebida" = o sondeo interno rápido con API push-like, o un **proceso delante** que emite.

### 9.6 Investigación de brokers → elección
- **Constraint:** pub/sub con push + **cualquier DB embebida/local** (SQLite/Bolt/Badger/Level) + **sin Docker ni manejador de DB instalado** + librería o binario único.
- **Shortlist** (evidencia en §10): **mochi-mqtt** (Go, MIT, Badger/Pebble, MQTT push), **Mercure** (Go, SSE, BoltDB, AGPL-3.0), **aedes** (Node, MIT, LevelDB, MQTT push), **Honker** (Rust/SQLite, offsets + replay, **alpha**), nanomq (C). **MQTT** elegido como modelo: pub/sub estándar, con cliente en todos los lenguajes.

### 9.7 Stack — DECISIÓN: un solo lenguaje (todo TS/Node)
- **Prioridad:** un solo lenguaje. Como el **mod es obligatoriamente TS** (sandbox del harness), se alinea todo a TS/Node.
- **Bus/broker:** **aedes** (broker MQTT embebido en Node, MIT, persistencia **LevelDB** embebida).
- **Bridge:** cliente **mqtt.js** (Node) lanzado por el mod con `$.process.spawn`; suscribe y empuja a `$.prompt.submit`; publica para enviar.
- **Mod:** adaptador en TS.
- **Fuera del stack:** Python (el MCP del probe) y Go. El **MCP queda opcional** (solo si se quiere que *el modelo* llame send/receive como tools dentro de un turno).
- **Matiz asumido:** broker y bridge corren como **procesos Node spawneados por el mod** (el sandbox no corre Node ni TCP crudo); "todo TS" es a nivel de código, no dentro del sandbox. Requiere **Node disponible en el host**.

### 9.8 Invariantes permanentes
- El mod es **TS** (forzado). Durabilidad/orden/retención **en el bus**. Entrega al modelo **gated por idle**. Adaptador **per-harness**; bus = backbone neutral/distribuible.

### 9.9 Pendiente
- **MQTT da entrega** (QoS, retained, sesiones persistentes) **pero no replay histórico tipo log/offsets**. El **event sourcing** queda como **evolución aditiva** (no rediseño), en escalera:
  - **Fase 1 (ahora):** MQTT/EDA — entrega pub/sub. Suficiente para enviar/recibir.
  - **Fase 2 (aditiva):** un *log sink* — un suscriptor extra que escucha todos los topics y **anexa cada mensaje** a un store append-only. Da auditoría + replay + agentes que se ponen al día. **Los adaptadores no cambian** (la retención es del bus, §8.5).
  - **Fase 3 (si se requiere):** tratar ese log como **fuente de verdad** y reconstruir estado por replay = event sourcing (CQRS encima si hace falta).
  - **Por qué es barato:** la durabilidad es del **bus**, no del adaptador (§8.5), y el contrato §3 ya es *event-shaped* (`id`/`ts`/`from`/`to`/`kind`/`body`).
  - **Disciplina a cuidar SÍ O SÍ desde ya:** los mensajes deben ser **hechos autoexplicativos**, no comandos sueltos que pierdan contexto — para que un replay futuro pueda reconstruir la conversación sin información faltante. Mantener esa higiene al definir los `kind` y al poblar `body`. (Si se omite ahora, migrar a event sourcing después obliga a reinterpretar o descartar historial.)
- **Spike aedes: EJECUTADO y verificado EN VIVO (2026-10-04)** — ver §9.10. (Corrección a una nota previa: NO hace falta reiniciar la sesión; la recarga en caliente re-dispara `session.start`/`prompt.submit`. Lo que parecía "pide restart" era en realidad una colisión de nombre de comando entre adaptadores, §9.10.)
- **ADR: hecho** — `0066-synagent-bus-mqtt-embebido-y-adaptadores-de-canal-por-harness` (estado `proposed`).
- Sigue abierto: RPC/protocolo de Pi (§7); adaptador de Pi; fases aditivas (log sink, event sourcing).

### 9.10 synagent: spike ejecutado, verificado en vivo y graduado (2026-10-04)

- **Nombre del producto:** **synagent** (sinapsis + agent) = el bus + los adaptadores de canal.
- **Verificado EN VIVO, sin reiniciar la sesión**, el ciclo completo con bus MQTT real:
  - **Bus** = app de shell: broker **aedes** + persistencia **LevelDB** en `:1884`. Spike previo: 8/8 (addressing, fan-out a N consumidores, QoS1, entrega a sesión persistente offline).
  - **JALAR (bus → Claude):** publicar a `a4s/inbox/claude` → el bridge suscriptor (`$.process.spawn`, `clean:false`) lo recibe por push → el mod lo lee entre turnos → `$.prompt.submit` lo **materializa como un turno real** (gated por idle). Observado: apareció un turno `[bus:prompt] de pi …` que nadie tecleó.
  - **ENVIAR (Claude → bus):** `/mq-send pi: hola pi` → `command.run` → publisher one-shot publica el mensaje canónico a `a4s/inbox/pi` (PUBACK QoS1); un suscriptor simulando a `pi` lo recibió.
- **Causa raíz corregida (lección reutilizable):** al cargar dos adaptadores que registraban el mismo comando (`/bus-send`), `$.command.register` del segundo **lanzaba** ("refused: ya registrado por otro plugin"); como el registro se hacía con `await` **antes** de abrir la suscripción, la excepción abortaba todo el arranque y el bridge nunca spawneaba — lo que se leyó erróneamente como "hace falta restart". **Fix:** (1) abrir la suscripción (lo core) **primero** y aislar `command.register` en `try/catch` no-fatal; (2) **arranque perezoso** — llamar al arranque desde `session.start` y desde el primer `prompt.submit`, con un flag de módulo, porque un mod añadido a mitad de sesión re-ejecuta `register` pero el reload sí re-dispara los hooks; (3) nombre de comando propio por adaptador (`/mq-send`). Regla general: en un mod, lo core va antes y aislado de llamadas que pueden fallar.
- **Graduación al repo:** `packages/synagent/` — `bus/` (broker + bridges; aedes/mqtt/classic-level como *providers*) y `adapters/claude/` (plugin: `.claude-plugin/` + `hooks/`). El núcleo puro `adapter.ts` se typecheckea y testea como paquete (node:test); `register.ts` se excluye del typecheck y se valida con `claude plugin validate`. El adaptador resuelve la ruta del bus desde `$.plugin.root`. Verificado: typecheck limpio, tests 9/9 (núcleo + round-trip del bus), `claude plugin validate` PASS.

## 10. Fuentes

- Claude mods (primaria): code.claude.com/docs/en/plugins/mods/{overview,api,events,reference}.md ; code.claude.com/docs/en/cross-session-messaging
- Claude plugins (empaquetado + MCP): code.claude.com/docs/en/plugins/components.md
- Pi extensions (primaria): pi.dev/docs/latest/extensions
- Patrón: enterpriseintegrationpatterns.com — Channel Adapter, Message Bus, Messaging Bridge ; jmgarridopaz.github.io/content/hexagonalarchitecture.html
- Almacenamiento (libSQL/Turso): turso.tech/blog/introducing-change-data-capture-in-turso-sqlite-rewrite ; docs.turso.tech/tursodb/cdc ; news.ycombinator.com/item?id=43537577 (Turso: sin realtime nativo)
- Brokers investigados: github.com/mochi-mqtt/server ; github.com/dunglas/mercure ; github.com/moscajs/aedes ; github.com/russellromney/honker ; github.com/nanomq/nanomq
- Repo: `.workspace/docs/specs/a4s-architecture-spec-v0.9.md` §6.5, §8.5, §25.2
- synagent (código promovido): `packages/synagent/` (bus + `adapters/claude/`) ; `packages/synagent/README.md`
- Decisión: `.workspace/docs/adr/0066-synagent-bus-mqtt-embebido-y-adaptadores-de-canal-por-harness.md`
- Claude mods (plugin root para rutas estables): `$.plugin.root` en los tipos del engine (`claude-code` d.ts)
