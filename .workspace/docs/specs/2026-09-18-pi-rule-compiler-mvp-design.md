# Diseño MVP del compilador de reglas y compaction Jev para Pi

**Fecha:** 2026-09-18

**Estado:** Aprobado para implementación

**Decisión rectora:** ADR 0013

**Sustituye:** el diseño observer-only gobernado anteriormente por ADR 0012

**Baseline:** `a4s-architecture-spec-v0.9.md` y contratos Pi 0.84.4

## 1. Propósito

El MVP usa Jev como autoridad semántica de la compactación Pi y reutiliza la misma lectura para extraer señales de reglas. Código determinista, no un modelo generativo, ensambla el Markdown que sustituye el tramo compactado.

El flujo tiene dos responsabilidades separadas:

1. `session_before_compact` obtiene decisiones Jev `keep | truncate | drop`, construye una compaction custom y bloquea la compactación si Jev no puede producir un resultado válido;
2. después de `session_compact`, el runtime transforma automáticamente los `RuleSignal` confirmados en propuestas revisables, sin publicarlas como reglas ni activarlas. `/retro-rules` queda limitado a retry/recovery idempotente.

Pi conserva almacenamiento y lifecycle de sesión. Jev posee la decisión semántica de qué retener. Rootline conserva la autoridad documental y gentle-engram mantiene su memoria episódica sin interferencia.

## 2. Alcance

Incluye:

- workspace npm privado `packages/pi-rule-compiler/`;
- normalización y redacción previa a modelo/persistencia;
- digests SHA-256 estables sobre contenido sanitizado;
- estado completo o ventanas cronológicas que cubren cada mensaje exactamente una vez;
- preguntas TypeSafe de retención y reglas en la misma pasada;
- thresholds independientes para compaction y RuleSignal;
- compaction Markdown determinista, cronológica, acotada y auditable;
- cancelación cerrada sin summary nativo/generativo de respaldo;
- publicación de RuleSignals sólo después de `session_compact` exitoso;
- recuperación idempotente desde `CompactionEntry.details`;
- estado retro-pending durable y receipts de proposal;
- retro automático inmediato para manual/threshold y diferido a `agent_settled` cuando `willRetry=true`;
- `/retro-rules` como retry/recovery review-only;
- tests deterministas sin red.

No incluye:

- summary generativo con el modelo Pi actual;
- fallback a compactación nativa;
- dependencia directa de `pi-jev` o `fast-jev-compaction`;
- control plane, base de datos, daemon, UI propia o worker detached;
- publicación automática en Rootline;
- activación automática de reglas;
- mutación de gentle-engram;
- llamadas TypeSafe vivas en CI.

## 3. Componentes

```text
packages/pi-rule-compiler/src/
├── messages.ts       normalización de mensajes Pi
├── redaction.ts      redacción antes de modelo/persistencia
├── digest.ts         JSON canónico y SHA-256
├── state.ts          fitting conservador por tokens
├── questions.ts      preguntas fusionadas y batching
├── jev.ts            HTTP + validación estricta
├── signals.ts        thresholds, RuleSignals y decisiones keep/truncate/drop
├── observer.ts       ventanas y agregación de respuestas
├── scheduler.ts      concurrencia global y retry/backoff Jev
├── compaction.ts     summary determinista + details recuperables
├── storage.ts        validación de entries v2
├── retro.ts          síntesis/evaluación review-only
├── extension.ts      lifecycle Pi
└── index.ts          default extension export
```

Sólo `extension.ts` conoce el lifecycle de Pi. Los módulos de dominio no escriben archivos ni documentos gobernados.

## 4. Flujo autoritativo de compaction

```text
Pi prepara compaction
  ↓ session_before_compact
normalizar previousSummary + messagesToSummarize + turnPrefixMessages
  ↓ redactar y calcular digests
fit completo o ventanas cronológicas sin solape
  ↓ requests Jev en un scheduler global acotado bajo un deadline/AbortSignal
por mensaje, en el mismo grupo:
  ├── retention action Choice: keep | truncate | drop
  ├── immediate continuity Score
  ├── rule candidate Noul
  ├── rule generality Score
  └── rule authority Choice
  ↓ validación estricta y thresholds separados
pin boundary/newest + forzar keep para RuleSignal durable
  ↓
ensamblar Markdown cronológico dentro del budget explícito
  ↓
return { compaction: { summary, firstKeptEntryId, tokensBefore, details } }
  ↓
Pi persiste CompactionEntry
  ↓ session_compact
publicar RuleSignal custom entries + retro-pending marker idempotentes
  ├── manual/threshold sin retry → current-model synthesis + Jev stage 2
  └── willRetry=true → retornar sin demora; drenar en agent_settled
  ↓
publicar proposal receipt review-only
```

Si cualquier paso anterior falla, el hook devuelve `{ cancel: true }`. Nunca devuelve `undefined` ni permite que Pi genere un summary nativo.

## 5. Fuente y ventanas

El conjunto coherente usa exclusivamente `preparation` y conserva este orden:

1. `previousSummary`, si existe;
2. `messagesToSummarize`;
3. `turnPrefixMessages`.

El digest global incluye posición, rol y texto sanitizado. El planner crea ventanas de hasta 96 mensajes por defecto. Si una ventana no cabe bajo el presupuesto Jev aun con excerpts mínimos, la divide recursivamente sin solape; un único mensaje todavía infittable cancela compaction.

Cada request admite hasta 120 preguntas sólo si el estimador conserva margen bajo los límites Jev 1.13 vigentes: máximo guardado de 60.000 tokens por request y 30.000 para state más la pregunta más larga, frente a límites del servicio de 64k/32k. El hook completo tiene un deadline default de 180 segundos.

Invariantes:

- cada índice fuente aparece en exactamente una ventana;
- cada mensaje recibe exactamente un Choice de retención y un Score de continuidad;
- las preguntas de regla del mismo mensaje elegible viajan en el mismo grupo;
- `user`, `toolResult`, `bashExecution` y `custom` pueden portar evidencia con autoridad; `assistant`, summaries y roles desconocidos no reciben tripletas de regla, pero sí retención;
- cada grupo pertenece a un único request;
- todos los requests repiten el mismo state dentro de su ventana;
- todos los requests de todas las ventanas comparten un único scheduler, con concurrencia default 1;
- `429` y `529` reintentan hasta tres veces, respetan `Retry-After` hasta 30 segundos y usan backoff 500ms→5s cuando el header no es utilizable;
- cola, espera y request activo obedecen el mismo AbortSignal/deadline.

## 6. Preguntas y decisiones

### 6.1. Compaction

Por mensaje:

- **action Choice:** `keep`, `truncate`, `drop`;
- **continuity Score:** cuatro niveles desde “sin valor futuro” hasta “objetivo, restricción, decisión o estado de frontera esencial”.

Thresholds iniciales independientes:

```text
keep probability >= 0.55
truncate probability >= 0.45
drop probability >= 0.70
continuity keep >= 0.667
continuity truncate >= 0.333
Choice confidence >= 0.20
truncate excerpt <= 240 chars
```

La decisión es conservadora:

1. cualquier pin o RuleSignal seleccionado fuerza `keep`;
2. continuidad alta o Choice keep suficientemente fuerte produce `keep`;
3. `drop` requiere probabilidad, confidence y continuidad baja;
4. continuidad media o probabilidad truncate produce `truncate`;
5. ambigüedad restante produce `truncate`, no `drop`.

### 6.2. Pins

Se fuerzan de forma independiente del modelo:

- `previousSummary`;
- primero y último de `messagesToSummarize`;
- primero y último de `turnPrefixMessages`;
- cuatro mensajes compactados más nuevos por defecto;
- cualquier mensaje que supera los thresholds de RuleSignal.

Los pins son sobre fronteras reales de `preparation`, no sobre fronteras artificiales de ventana.

### 6.3. Reglas

Por mensaje no vacío:

- candidate Noul;
- generality Score;
- authority Choice: `explicit_user | repository_policy | team_convention | agent_inference | incidental`.

Thresholds RuleSignal:

```text
candidate probability >= 0.72
generality normalized >= 0.50
authority probability >= 0.55
authority confidence >= 0.20
authority ∈ {explicit_user, repository_policy, team_convention}
```

Los thresholds de reglas y compaction viven en objetos/schemas distintos. Calibrar uno no cambia el otro.

## 7. Summary determinista

`compaction.ts` produce Markdown estructurado sin llamada generativa:

```text
# Jev-authoritative compaction

## Message N · role=… · action=… · forced=…
> excerpt sanitizado

## Compaction audit
- source digest
- counts keep/truncate/drop
- model Jev exacto
```

Propiedades:

- mensajes retenidos en índice cronológico original;
- mensajes `drop` ausentes del cuerpo;
- excerpts `truncate` limitados por su threshold;
- budget default de 160.000 caracteres, calibrado para sesiones de aproximadamente 1.000 mensajes sin perder candidatos retenidos;
- si el cuerpo excede budget, un límite común de excerpt se reduce por búsqueda determinista;
- cada truncación por budget queda registrada;
- si el envelope mínimo no cabe, compaction se cancela;
- `firstKeptEntryId` y `tokensBefore` se copian exactamente de Pi.

## 8. Schemas y provenance

### 8.1. `MessageCompactionDecision`

Schema `a4s.message-compaction-decision/v1`:

- índice/digest/rol fuente;
- action final;
- pins `boundary | newest | rule_candidate`;
- continuity score/confidence;
- Choice, confidence y distribución completa;
- excerpt sanitizado seleccionado.

### 8.2. RuleSignal batch v2

Custom type `a4s.pi-rule-compiler.rule-signals.v2`, schema `a4s.rule-signal-batch/v2`:

- source/state digest de ventana;
- attempt ID global;
- índice y número total de ventanas;
- índices/digests/excerpts sanitizados;
- respuestas agregadas de uso;
- decisiones de compaction por mensaje;
- RuleSignals;
- thresholds efectivos separados.

### 8.3. Compaction details

`CompactionEntry.details` usa `a4s.jev-compaction-details/v1` y contiene:

- attempt/source digest, modelo y timestamp;
- `firstKeptEntryId`, `tokensBefore`;
- digest, longitud y budget del summary;
- decisiones completas y truncaciones por budget;
- scheduler: límites, requests lógicos, attempts, retries y concurrencia máxima observada;
- RuleSignal batches validados de todas las ventanas.

No contiene API keys, thinking raw, imágenes ni valores privados reconocidos.

### 8.4. Pending retro y proposal receipts

El custom type `a4s.pi-rule-compiler.retro-pending.v1`, schema `a4s.retro-pending/v1`, conserva `attemptId`, timestamp, source digests, reason y si el trabajo se difirió hasta `agent_settled`. El proposal `a4s.rule-proposal-batch/v1` conserva un `idempotencyKey`, attempt IDs y batch digests; esos receipts permiten distinguir pending real de replay ya completado.

## 9. Lifecycle de persistencia e idempotencia

RuleSignals y retro-pending no se agregan durante `session_before_compact`.

- **before:** el resultado y batches quedan pendientes en memoria y embebidos en `details` retornados;
- **success (`session_compact`):** se leen los details que Pi acaba de persistir, se agregan los batches ausentes y, cuando existen señales, un marker retro-pending;
- **manual/threshold sin retry:** el mismo handler ejecuta current-model synthesis + Jev stage 2 y agrega el proposal receipt;
- **success con `willRetry=true`:** el handler retorna tras persistir batches y marker; `agent_settled` drena el pending después del retry nativo de Pi;
- **retro failure:** no revierte compaction ni elimina batches/marker;
- **compaction failure:** se borra el pending pre-success y no se publica nada;
- **shutdown:** se borra sólo estado in-memory;
- **reload:** `session_start` inspecciona `CompactionEntry.details`, recupera batches/markers ausentes y los receipts existentes impiden duplicación.

La deduplicación de RuleSignal usa el source digest de ventana validado. La deduplicación retro usa batch digests e `idempotencyKey`; markers son append-only y un proposal receipt los vuelve lógicamente completos. Si el proceso cae después de que Pi persista compaction pero antes de publicar cualquier artefacto, los details son el receipt recuperable. Repetir success, reload, `agent_settled` o `/retro-rules` no duplica batches ni proposals.

Una segunda llamada before para el mismo attempt todavía pendiente reutiliza exactamente la compaction ya evaluada y no repite Jev. Después de failure, el retry vuelve a evaluar.

## 10. Fallos

| Fallo | Resultado del hook |
| --- | --- |
| `TYPESAFE_API_KEY` ausente | `{ cancel: true }` |
| timeout/abort, incluso en cola o backoff | `{ cancel: true }` |
| `429`/`529` después del retry acotado | `{ cancel: true }` |
| API/HTTP Jev no retryable | `{ cancel: true }` |
| response malformed | `{ cancel: true }` |
| state o mensaje infittable | `{ cancel: true }` |
| cobertura incompleta/duplicada | `{ cancel: true }` |
| summary mínimo excede budget | `{ cancel: true }` |
| error interno | `{ cancel: true }` |

Los diagnósticos son frases fijas menores de 240 caracteres, no incluyen contenido ni responses, e indican explícitamente que el fallback nativo está deshabilitado. La indisponibilidad es visible y recuperable al reintentar después de restaurar Jev o ajustar budget.

Un fallo al publicar signals después de success no revierte la compaction: los batches permanecen recuperables en details y se reintentan en reload.

## 11. Privacidad

La redacción ocurre antes de estado, digests, summary y persistencia. Cubre bloques `<private>`, claves PEM, Authorization, API keys/tokens/passwords, tokens comunes/JWT, URL credentials, emails y usernames de home paths.

Thinking e imágenes raw se omiten. Los digests se calculan sobre contenido ya sanitizado. El API key sólo existe en memoria para el header HTTP. Summary, details, custom entries y diagnósticos nunca incluyen secretos raw reconocidos.

## 12. Retro automático y `/retro-rules`

El pipeline retro es único e idempotente:

1. seleccionar markers/batches pendientes no cubiertos por proposal receipts;
2. sintetizar hasta ocho candidatos en JSON normalizado mediante `ctx.modelRegistry.complete(ctx.model, …)`, con budget de salida default 8.192 tokens;
3. validar estrictamente scope, trigger, obligation, exceptions, source refs y proposed check;
4. ejecutar una segunda llamada Jev con evidence-relation Choice, support/generality/enforceability Scores y authority/rule-class Choices mediante el mismo scheduler acotado;
5. agregar proposal custom entry con idempotency receipt y mostrar resumen.

`session_compact` lo ejecuta automáticamente para manual/threshold sin retry. Cuando `willRetry=true`, `agent_settled` lo ejecuta después de que Pi termina el retry. `/retro-rules` primero espera idle y sólo reintenta/reconcilia pending; no es un paso normal obligatorio.

Ningún camino escribe Rootline ni activa reglas. Modelo o Jev ausente conserva signals y marker, falla cerrado y no revierte la compaction exitosa.

## 13. Observabilidad

Cada compaction conserva:

- attempt/source/window/state/message digests;
- modelo exacto `jev-1.13.0`;
- reason y `willRetry`;
- conteos de requests/tokens/redactions;
- attempts/retries, límites y concurrencia máxima observada del scheduler;
- decisiones, distribuciones, scores y pins;
- keep/truncate/drop counts;
- summary budget/longitud/digest;
- RuleSignals y thresholds efectivos;
- marker retro-pending, política de defer y proposal receipt/idempotency key.

La UI sólo recibe conteos de éxito o códigos acotados de fallo.

## 14. Criterios de aceptación

1. El hook devuelve compaction custom en éxito y nunca `undefined`.
2. Toda clase de fallo declarada devuelve `{ cancel: true }`; no existe fallback nativo/generativo.
3. Cada mensaje compactado se evalúa exactamente una vez, incluso con ventanas.
4. Requests Jev de todas las ventanas pasan por un único scheduler global; concurrencia, retry/backoff y `Retry-After` permanecen acotados por el deadline.
5. Cada request respeta los budgets guardados 60k/30k; el aumento a 120 preguntas no rebasa los límites Jev 64k/32k.
6. Keep/truncate/drop respetan thresholds independientes; newest/boundary y RuleSignals fuerzan keep.
7. Summary es cronológico, sanitizado, determinista, acotado y auditable.
8. Pi recibe exactamente `firstKeptEntryId` y `tokensBefore` de preparation.
9. RuleSignals y retro-pending sólo se publican después de success; compaction failure publica cero artefactos.
10. Details permiten recuperación tras crash/reload sin pérdida ni duplicación de batches o proposals.
11. Manual/threshold sin retry ejecuta current-model + Jev stage 2 desde `session_compact`; `willRetry=true` difiere hasta `agent_settled`.
12. Retro failure preserva signals/pending y `/retro-rules` sólo reintenta/reconcilia de forma idempotente.
13. Tests usan fakes y cubren success, cancelación, decisiones, budgets, scheduler global, retry/abort, 1.000 mensajes, lifecycle, recovery, replay y retro automático/diferido.
14. Un fork live de la sesión real confirma compaction custom Jev y retro automático sin fallback nativo.
15. Rootline, tests, typecheck, diff y diagnósticos aplicables pasan.
