# Diseño experimental E0: attach y transporte

**Fecha:** 2026-09-01

**Estado:** Aprobado para planificación

**Baseline:** `docs/specs/a4s-architecture-spec-v0.7.md`, §§44–46

## 1. Propósito

E0 debe responder empíricamente esta pregunta:

> ¿Puede `a4sd` direccionar de forma reproducible una extensión Pi exacta, entregar un envelope una sola vez lógicamente y reconocer su consumo tras una desconexión y reconexión del cliente?

E0 valida únicamente la frontera local `a4sd ↔ extensión Pi`: attach, framing, Delivery, ACK, deduplicación y reconexión. No invoca al modelo ni valida todavía input inbound, estados idle/busy o comportamiento en Herdr. Esos temas pertenecen a E1, E2 y a la aceptación integrada posterior.

El resultado de E0 es código ejecutable y evidencia reproducible, no una afirmación arquitectónica basada únicamente en diseño.

## 2. Decisiones aprobadas

1. `a4sd` permanece como proceso externo y autoridad del control plane.
2. Un driver determinista sustituye al Orchestrator durante E0.
3. Todo el PoC usa TypeScript sobre Node.js.
4. El IPC usa `node:net`:
   - Unix domain socket en macOS y Linux;
   - named pipe en Windows.
5. Los mensajes usan JSON con prefijo de longitud big-endian de cuatro bytes.
6. El transporte físico es at-least-once; el procesamiento lógico es at-most-once durante la vida del proceso Pi.
7. Cada escenario crítico debe completar 20/20 repeticiones.
8. E0 puede obtener `PASS-macOS`; Windows se informa como `NOT RUN` hasta ejecutarse realmente allí.
9. `pi-intercom` se usa como referencia empírica, no como dependencia ni como protocolo importado.

## 3. Fuera de alcance

E0 no incluye:

- SQLite ni persistencia tras reiniciar `a4sd`;
- reinicio durable del daemon;
- Worktree, WorkResult o Verification;
- Orchestrator Pi real;
- ejecución de un modelo;
- `sendMessage`, `sendUserMessage`, `steer` o `followUp`;
- estados idle/busy;
- reload o reemplazo de sesión Pi;
- cambio de owner o `binding_revision`;
- autenticación o autorización;
- heartbeat, compresión o negociación de features;
- HTTP, SSE, WebSocket o TCP localhost;
- soporte distribuido o entre máquinas;
- aprobación empírica de Windows sin ejecución en Windows.

## 4. Evidencia reutilizada de `pi-intercom`

La auditoría de `pi-intercom` 0.9.2 verificó que un broker TypeScript puede usar:

- Unix domain sockets en macOS/Linux;
- named pipes en Windows;
- framing JSON con prefijo de longitud;
- reconexión automática;
- IDs, deduplicación y receipts;
- turn triggering mediante APIs nativas de Pi.

A4S no adopta `pi-intercom` porque su API pública conecta sesiones y extensiones Pi, pero no expone una frontera estable para un daemon externo como `a4sd`. E0 reutiliza el patrón demostrado, no su implementación privada.

## 5. Arquitectura

```text
┌──────────────────────┐
│ Driver determinista  │
│ - crea trials        │
│ - inyecta fallos     │
│ - recopila evidencia │
└──────────┬───────────┘
           │ API interna de prueba
           ▼
┌──────────────────────┐       node:net       ┌──────────────────────┐
│        a4sd          │◄────────────────────►│ A4S Pi Extension     │
│ - listener IPC       │ socket / named pipe  │ - attach             │
│ - pending Delivery   │                      │ - reconnect          │
│ - ACK state          │                      │ - dedupe             │
│ - event log          │                      │ - ACK                │
└──────────────────────┘                      └──────────┬───────────┘
                                                        │ Extension API
                                                        ▼
                                             ┌──────────────────────┐
                                             │ Proceso Pi real      │
                                             │ sin turn de modelo   │
                                             └──────────────────────┘
```

El driver y el servidor comparten proceso para permitir fault injection determinista. La extensión vive dentro de un proceso Pi separado y solo se comunica con `a4sd` mediante el IPC real.

## 6. Componentes

### 6.1. Protocolo

Responsabilidades:

- codificar y decodificar frames;
- validar envelopes y payloads;
- imponer el límite de 64 KiB por frame;
- distinguir errores de framing y errores de protocolo;
- no depender de Pi, del daemon ni del driver.

### 6.2. `a4sd`

Responsabilidades durante E0:

- escuchar en un endpoint IPC local;
- aceptar una conexión de extensión;
- validar attach;
- mantener Deliveries pendientes en memoria;
- entregar y redeliver después de reconnect;
- registrar ACKs idempotentes;
- emitir eventos estructurados;
- exponer al driver operaciones internas para crear Deliveries y activar fallos.

El CLI de `a4sd` es una capa delgada sobre el servidor reutilizable.

### 6.3. Extensión Pi

Responsabilidades:

- arrancar como extensión de una sesión Pi real;
- obtener `session_id` y `session_file` desde el contexto Pi;
- adjuntar owner, binding revision y referencia nativa;
- recibir Deliveries;
- registrar `delivery_id` antes de enviar ACK;
- no reprocesar un ID conocido;
- reconectar cuando se pierde el canal;
- cerrar timers y sockets en `session_shutdown`.

### 6.4. Driver E0

Responsabilidades:

- crear un `run_id` único;
- iniciar el servidor real;
- iniciar o coordinar el proceso Pi con la extensión;
- ejecutar los escenarios en orden;
- introducir desconexiones y pérdida de ACK deterministas;
- comprobar invariantes después de cada trial;
- escribir artifacts y calcular el veredicto.

El driver no representa un Orchestrator ni usa un modelo.

### 6.5. Evidencia

Responsabilidades:

- escribir JSONL append-only por ejecución;
- registrar environment y versiones;
- calcular agregados por escenario;
- producir un resumen machine-readable;
- no alterar el comportamiento del protocolo.

## 7. Layout propuesto

```text
src/
├── protocol/
│   ├── framing.ts
│   └── messages.ts
├── daemon/
│   ├── server.ts
│   ├── state.ts
│   └── cli.ts
├── pi-extension/
│   └── index.ts
└── e0/
    ├── driver.ts
    └── evidence.ts

test/
├── framing.test.ts
├── protocol.test.ts
└── e0.test.ts
```

Dependencias previstas:

- Node.js;
- TypeScript;
- `tsx` para ejecutar TypeScript;
- Pi Extension API;
- `node:test`.

No se incorpora framework web, base de datos ni librería de messaging.

## 8. Endpoint IPC

El driver crea un endpoint único por `run_id` y lo entrega a la extensión mediante `A4S_ENDPOINT`.

- macOS/Linux: socket bajo un directorio temporal del run;
- Windows: `\\.\pipe\a4s-e0-<run-id>`.

El servidor Unix elimina únicamente su propio socket stale antes de escuchar. Si existe un listener activo en el endpoint solicitado, el arranque falla sin reemplazarlo. Los named pipes no requieren eliminar un archivo del filesystem.

No existe descubrimiento global de endpoints en E0.

## 9. Framing

Cada frame contiene:

```text
┌───────────────────────────┬───────────────────────────┐
│ uint32 big-endian length  │ UTF-8 JSON payload        │
└───────────────────────────┴───────────────────────────┘
```

Reglas:

- tamaño máximo: 65,536 bytes de payload;
- el decoder admite header y payload fragmentados;
- el decoder admite varios frames en un mismo chunk;
- un payload superior al límite cierra la conexión;
- JSON inválido cierra la conexión;
- un frame vacío no es un envelope válido y cierra la conexión;
- no se interpreta ningún frame después de un error fatal de framing.

## 10. Envelope y mensajes

Envelope común:

```json
{
  "protocol_version": 1,
  "message_id": "M1",
  "type": "attach",
  "payload": {}
}
```

Reglas comunes:

- `protocol_version` debe ser `1`;
- `message_id` es no vacío y único por frame originado;
- `type` debe pertenecer al catálogo E0;
- `payload` debe satisfacer el schema del tipo;
- campos desconocidos se rechazan para mantener el experimento estricto.

### 10.1. `attach`

Extensión → `a4sd`:

```json
{
  "protocol_version": 1,
  "message_id": "M1",
  "type": "attach",
  "payload": {
    "owner_id": "W1",
    "binding_revision": 1,
    "native_ref": {
      "session_id": "<pi-session-id>",
      "session_file": "<absolute-session-file>"
    }
  }
}
```

Validaciones:

- `owner_id` debe coincidir con el owner esperado por el trial;
- `binding_revision` debe ser exactamente `1`;
- `session_id` debe ser no vacío;
- `session_file` debe ser una ruta absoluta no vacía;
- el primer mensaje de una conexión debe ser `attach`.

### 10.2. `attached`

`a4sd` → extensión:

```json
{
  "protocol_version": 1,
  "message_id": "M2",
  "type": "attached",
  "payload": {
    "in_reply_to": "M1",
    "owner_id": "W1",
    "binding_revision": 1
  }
}
```

Después de `attached`, `a4sd` puede enviar Deliveries pendientes.

### 10.3. `delivery`

`a4sd` → extensión:

```json
{
  "protocol_version": 1,
  "message_id": "M3",
  "type": "delivery",
  "payload": {
    "delivery_id": "D1",
    "owner_id": "W1",
    "binding_revision": 1,
    "kind": "probe",
    "body": {
      "nonce": "<trial-nonce>"
    }
  }
}
```

### 10.4. `delivery_ack`

Extensión → `a4sd`:

```json
{
  "protocol_version": 1,
  "message_id": "M4",
  "type": "delivery_ack",
  "payload": {
    "delivery_id": "D1"
  }
}
```

Un ACK repetido para una Delivery ya reconocida produce el mismo estado final y no es error.

### 10.5. `error`

Cualquiera de los peers puede emitir:

```json
{
  "protocol_version": 1,
  "message_id": "M5",
  "type": "error",
  "payload": {
    "in_reply_to": "M1",
    "code": "INVALID_ATTACH",
    "message": "owner_id does not match the expected owner"
  }
}
```

Códigos E0:

- `UNSUPPORTED_PROTOCOL`;
- `INVALID_ENVELOPE`;
- `ATTACH_REQUIRED`;
- `INVALID_ATTACH`;
- `STALE_BINDING`;
- `UNEXPECTED_MESSAGE`.

Los errores de framing no generan `error` porque el peer no puede confiar en la delimitación del stream.

## 11. Semántica de Delivery

La Delivery sigue esta máquina mínima:

```text
PENDING ──send/redeliver──► PENDING ──ACK──► ACKNOWLEDGED
```

Invariantes:

1. `a4sd` no elimina una Delivery antes de registrar su ACK.
2. Una conexión nueva recibe todas las Deliveries `PENDING` del owner adjuntado.
3. La extensión añade `delivery_id` a su dedupe set antes de emitir ACK.
4. Una Delivery conocida no vuelve a procesar su body.
5. Una Delivery conocida sí puede producir otro ACK.
6. El estado físico es at-least-once.
7. El efecto lógico durante la vida del proceso Pi es at-most-once.

El dedupe set es in-memory. Reload, reemplazo o reinicio del proceso Pi quedan fuera de E0.

## 12. Reconexión

La extensión reconecta mientras el mismo proceso y runtime Pi permanecen activos.

Backoff E0:

```text
100 ms → 250 ms → 500 ms → 1,000 ms → 1,000 ms máximo
```

No se usa jitter porque E0 tiene un solo cliente. Una conexión exitosa reinicia el backoff.

Después de reconectar:

1. la extensión vuelve a enviar `attach` con el mismo owner y binding revision;
2. `a4sd` responde `attached`;
3. `a4sd` redeliver todas las Deliveries pendientes;
4. la extensión deduplica y vuelve a reconocer cuando corresponda.

Reiniciar `a4sd`, cambiar `binding_revision` o reemplazar la sesión no forman parte de E0.

## 13. Error handling

- Listener activo en el endpoint solicitado: `a4sd` falla al arrancar.
- Socket Unix stale propio: se elimina antes de `listen`.
- Desconexión antes de attach: se descarta la conexión sin alterar Deliveries.
- Mensaje distinto de attach como primer frame: `ATTACH_REQUIRED` y cierre.
- Versión incompatible: `UNSUPPORTED_PROTOCOL` y cierre.
- Owner incorrecto: `INVALID_ATTACH` y cierre.
- Binding revision distinta de `1`: `STALE_BINDING` y cierre.
- ACK desconocido: `UNEXPECTED_MESSAGE`; la conexión permanece abierta porque el framing sigue siendo confiable.
- Error fatal de framing: cierre inmediato.
- `session_shutdown`: la extensión cancela timers y cierra el socket sin iniciar otro reconnect.

## 14. Escenarios experimentales

Cada escenario se ejecuta 20 veces.

### S1. Flujo limpio

```text
attach → attached → delivery → process once → ACK
```

### S2. Delivery creada mientras el cliente está desconectado

```text
enqueue D1 → attach → attached → D1 → process once → ACK
```

### S3. Desconexión antes de registrar ACK

El driver configura `a4sd` para que, al recibir el primer ACK de D1, cierre la conexión sin registrar el ACK. La llegada del frame prueba que la extensión ya registró D1 antes del corte.

```text
D1 → extension records D1 → lost ACK → disconnect
→ reconnect → D1 redelivery → no reprocess → ACK
```

### S4. Caída del canal conectado

```text
attached → server closes socket → extension reconnects
→ attach → attached → new Delivery → ACK
```

### S5. Frame duplicado

```text
D1 → D1 duplicate → one logical processing → idempotent ACKs
```

## 15. Pruebas de framing y protocolo

Las pruebas deterministas sin Pi cubren:

- header fragmentado;
- payload fragmentado;
- varios frames en un chunk;
- frame exactamente en el límite;
- frame superior al límite;
- JSON inválido;
- frame vacío;
- versión incompatible;
- attach ausente;
- attach inválido;
- binding stale;
- ACK repetido;
- ACK desconocido.

Las pruebas de path cubren selección de Unix socket y named pipe. No cuentan como ejecución empírica en Windows.

## 16. Instrumentación y artifacts

Cada run produce:

```text
artifacts/e0/<run-id>/
├── environment.json
├── events.jsonl
└── summary.json
```

### `environment.json`

Incluye:

- `run_id`;
- timestamp UTC de inicio;
- OS y versión;
- arquitectura;
- versión Node;
- versión Pi;
- commit A4S;
- endpoint y tipo de transporte;
- cantidad de trials por escenario.

### `events.jsonl`

Cada evento incluye:

- `run_id`;
- escenario y número de trial;
- timestamp wall-clock;
- tiempo monotónico desde el inicio del trial;
- componente;
- evento;
- `message_id` y `delivery_id` cuando existan;
- dirección del mensaje;
- resultado o error estructurado.

El log no incluye secretos ni contenido de modelo.

### `summary.json`

Incluye por escenario:

- trials planeados, ejecutados, pasados y fallidos;
- Deliveries creadas, enviadas, redelivered y reconocidas;
- cantidad de procesamientos lógicos;
- duplicados físicos observados;
- tiempo mínimo, máximo y mediano;
- errores no controlados;
- verdict.

## 17. Criterios de aceptación

E0 obtiene `PASS-<platform>` únicamente si:

```text
20/20 trials pasan en cada uno de S1–S5
0 Deliveries perdidas
0 procesamientos lógicos duplicados
100% de Deliveries pendientes terminan ACKNOWLEDGED
0 errores no controlados
100% de errores de framing/protocolo producen el resultado definido
```

Cualquier trial fallido produce `FAIL`; no se oculta mediante retry automático. Después de corregir un defecto, se ejecuta un run nuevo con otro `run_id` y se conservan ambos resultados.

El reporte distingue:

- `PASS-macOS`, `PASS-linux` o `PASS-windows`;
- `FAIL-<platform>`;
- `NOT RUN` para plataformas sin ejecución real.

## 18. Reporte versionado

Después de ejecutar E0 se crea:

```text
docs/experiments/e0-report.md
```

El reporte contiene:

- commit probado;
- environment;
- procedimiento exacto;
- hashes de artifacts;
- resumen de resultados;
- anomalías y runs fallidos previos;
- veredicto por plataforma;
- decisión: aprobar IPC, corregir y repetir o rechazar el enfoque.

Los artifacts completos no necesitan versionarse; sus hashes y el resumen sí.

## 19. Secuencia de implementación y ejecución

1. Implementar framing y sus pruebas.
2. Implementar schemas y validación de protocolo.
3. Implementar servidor/state in-memory.
4. Implementar extensión attach/reconnect/dedupe/ACK.
5. Implementar driver y fault injection.
6. Ejecutar pruebas deterministas sin Pi.
7. Ejecutar S1–S5 dentro de una sesión Pi real, 20 veces cada uno.
8. Generar artifacts y veredicto automático.
9. Ejecutar un smoke manual observable en Pi directo; la aceptación posterior en Herdr queda fuera de E0.
10. Redactar `docs/experiments/e0-report.md`.
11. Revisar la evidencia antes de diseñar E1.

## 20. Retención del código

Si E0 pasa, se consideran candidatos a permanecer:

```text
src/protocol/
src/daemon/server.ts
src/daemon/state.ts
src/daemon/cli.ts
src/pi-extension/
```

Permanecen explícitamente experimentales:

```text
src/e0/driver.ts
src/e0/evidence.ts
fault injection
```

Aprobar E0 no aprueba E1 ni promueve automáticamente el código a production-ready.
