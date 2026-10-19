# Extensión Pi unificada de compaction

**Estado:** diseño aprobado para planificación
**Fecha:** 2026-09-22
**Paquete destino:** `@a4s/pi-rule-compiler`
**Baseline de runtime:** Pi `0.87.0`

## Propósito

Evolucionar `@a4s/pi-rule-compiler` hacia la única extensión Pi que decide
cuándo compactar, cómo proyectar contexto y qué evidencia durable extraer. La
extensión integra la capacidad Pi y el harness de evaluación de
`kunchenguid/compact-adviser` como un fork A4S con provenance y licencia MIT.

El resultado para quien opera Pi es una compaction incremental y verificable:
primero conserva el comportamiento semántico existente; después puede sugerir
o, con consentimiento explícito, iniciar compaction; finalmente puede mostrar
la cantidad de contexto necesaria para una query concreta y extraer reglas a
partir de esa misma selección.

## Intención y criterios de éxito

Decisiones aprobadas por el owner:

- Existe una sola extensión de compaction, no un paquete Adviser independiente.
- El primer item de backlog refactoriza la compaction existente y deja Evidence
  / RuleSignals explícitamente inactivo; `keep|truncate|drop`, summary,
  recovery y el comportamiento fail-closed conservan su resultado actual.
- Trigger ofrece `hint` por defecto y `auto` sólo con consentimiento explícito.
- Ladder y Evidence comparten un corpus de chunks sanitizados persistido en
  CustomEntries de Pi.
- Evidence formula una query especial al Ladder para encontrar reglas; no lee
  ciegamente todo el corpus ni depende de una proyección de otra query.
- `short` y `long` se construyen con spans fuente que Jev selecciona y código
  determinista renderiza; no se introduce resumen generativo libre.
- `basic` sigue siendo la estrategia por defecto y Evidence vuelve como
  `off|ladder`, por defecto `off`.

La entrega completa tendrá éxito cuando una instalación de la extensión pueda:

1. conservar la compaction `basic` actual sin cambio observable;
2. ofrecer hints y auto opt-in que usan esa misma compaction;
3. recuperar contexto por query mediante `hide|short|long|full`, sin eliminar
   chunks recuperables ni exponer contenido sin sanitizar; y
4. producir RuleSignals auditables mediante la query conservadora de Evidence.

## No objetivos

- No crear una base de datos, daemon ni control plane externos.
- No incorporar implementaciones Claude Code, Codex o Grok de compact-adviser.
- No reintroducir resumen generativo libre ni fallback nativo cuando falla la
  compaction Jev.
- No activar Evidence por defecto al terminar esta iniciativa.
- No aceptar ADR 0022 tal como está: la visibilidad query-aware no se calcula
  anticipadamente durante compaction. El ADR queda `proposed` hasta que una
  decisión sucesora o su actualización documente retrieval por query.

## Arquitectura

La extensión mantiene tres módulos explícitos sobre un mismo lifecycle Pi.

```text
Trigger ──────── decide hint | auto | off
   │                         │
   └─────────────────────────┼──► session_before_compact
                             │          │
Corpus sanitizado ◄──────────┘          ├── basic: compaction actual
   │                                    └── ladder: staging de corpus
   ├── Ladder(query) ─► niveles + spans ─► renderer determinista
   └── Evidence(query de reglas) ───────► RuleSignals / receipts
```

### Trigger

Trigger se ejecuta después de `agent_settled` y primero comprueba gates
locales: modo interactivo, idle, contexto mínimo, cooldown, editor vacío,
credencial disponible y ausencia de trabajo pendiente. Sólo entonces consulta
Jev. `hint` muestra una sugerencia fuera del contexto del modelo. `auto` exige
una confirmación persistida y llama `ctx.compact()`; esa llamada entra en el
mismo `session_before_compact` de la extensión, por lo que no existe una
segunda autoridad de compaction.

La versión Pi 0.87 añade boundaries accionables y difiere trabajo solicitado
desde `agent_settled` hasta completar sus handlers. El plan debe demostrar con
un contrato Pi real cuál boundary permite mostrar el hint sin reentrancia antes
de usar `agent_before_settle` u optimizar el timing actual.

### Corpus

Un `CorpusChunk` representa un fragmento fuente sanitizado y tiene id estable,
digest, rol, posición, límites de tamaño, provenance de sesión/compaction y el
texto sanitizado necesario para recuperar spans. Se persiste sólo después de
que Pi confirme la compaction, como CustomEntry namespaced en la rama actual.

El corpus es append-only y recuperable por reload o navegación de rama. Los
details de compaction sólo almacenan receipts y referencias verificables;
no transportan el corpus entero. Ningún chunk contiene secretos reconocidos,
thinking raw, imágenes ni credenciales.

### Ladder

Ladder recibe una query concreta y el corpus de la rama. Jev devuelve, por
chunk, un nivel `hide|short|long|full` y, para `short`/`long`, referencias a
spans fuente. El validador exige cobertura, ids y rangos válidos; el renderer
ordena y recorta spans de forma determinista. Una `VisibilityProjection` es
recalculable, ligada al digest de query y corpus, y no cambia el corpus.

`context_with_system` proyecta el contexto antes de una petición futura al
modelo. Si Ladder o su validación falla en este camino, la extensión no aplica
ninguna omisión adicional: Pi conserva su contexto normal. Esto es distinto
del fallo durante `session_before_compact`, que sigue cancelando la compaction
sin fallback nativo.

### Evidence

Evidence es una query Ladder de primera clase: “identificar material que puede
originar una regla durable”. Su perfil es conservador: un chunk potencialmente
relevante o incierto se eleva antes de que la extracción descarte evidencia.
Después de recibir spans adecuados, el extractor valida candidate, generality
y authority, y persiste RuleSignals con digest y spans fuente.

La proyección de una tarea ordinaria nunca define qué RuleSignals existen. Los
RuleSignals son artefactos durables independientes que pueden enriquecer una
query futura, pero no fijan permanentemente la visibilidad de sus chunks.

## Configuración

```text
compaction.strategy = basic | ladder       # default: basic
trigger.mode        = off | hint | auto
evidence.strategy  = off | ladder         # default: off
```

`auto` requiere acknowledgement explícito. `evidence.strategy=ladder` es
inválido si `compaction.strategy` no es `ladder`. Los valores inválidos o una
cancelación preservan el valor previo. Las claves y diagnósticos muestran sólo
fuente/presencia, nunca secretos ni texto de chunks.

## Entregas incrementales

### 1. Refactor de compaction con Evidence apagado

Extraer un núcleo de compaction que conserva los fixtures y resultados
observables de `basic`. Sustituir extracción, publicación y retro de reglas
por un no-op explícito y testeado. No borrar código ni dejar bloques
comentados como mecanismo de control.

### 2. Actualización a Pi 0.87

Alinear `@earendil-works/pi-coding-agent` y `@earendil-works/pi-ai` a
`0.87.0` en workspace, pares y lockfile. Actualizar fakes y contratos que
cambien con `ContextEditEntry`, boundaries de turno y el scheduling de
`agent_settled`.

### 3. Ingestión de Trigger

Importar sólo la implementación Pi y el eval harness de compact-adviser, desde
un commit upstream completo registrado localmente junto con su licencia MIT y
provenance. Adaptar Trigger al paquete existente, sin proveedor TypeSafe
adicional ni segundo hook de compaction. Entregar `hint`, `off` y `auto`
confirmado, con compaction `basic` y Evidence apagado.

### 4. Corpus durable

Introducir el esquema de CustomEntries, staging in-memory, receipts, límites,
redacción y recovery. El corpus aún no altera el contexto que Pi entrega al
modelo.

### 5. Ladder por query

Añadir `context_with_system`, proyecciones tipadas, selección Jev de nivel y
spans, renderer determinista y fallback al contexto Pi normal ante fallo.
`basic` sigue default y `ladder` es opt-in.

### 6. Evidence mediante Ladder

Sustituir el no-op por la query conservadora de Evidence, restaurar
RuleSignals, pending markers, retro y propuestas review-only. Activarlo sólo
con `evidence.strategy=ladder`.

Cada entrega es una rama/commit verificable, deja la extensión instalable y no
depende de que una fase posterior exista.

## Fallos y recovery

| Momento | Fallo | Resultado |
| --- | --- | --- |
| Trigger | gates o Jev no disponibles | Sin hint ni auto; Pi no cambia. |
| Compaction `basic`/staging ladder | Jev, timeout, validación, presupuesto o abort | `{ cancel: true }`; no corpus ni Evidence publicados. |
| Publicación tras éxito Pi | proceso detenido | receipts y reload reconstruyen corpus/artefactos idempotentemente. |
| Proyección Ladder por query | Jev, schema o spans inválidos | No omisión adicional; Pi usa el contexto normal. |
| Evidence Ladder | selección insuficiente o fallo Jev | No RuleSignal nuevo; corpus permanece recuperable. |

## Pruebas y gates

- Golden fixtures demuestran igualdad de decisiones, summary y fallos de
  `basic` antes y después de la fase 1.
- Contratos de Pi 0.87 cubren hooks, `ctx.compact`, abort, reload, branch,
  `context_with_system` y ausencia de reentrancia desde `agent_settled`.
- Trigger cubre gates locales, hint, acknowledgement auto, cooldown y que no
  filtra información hacia el modelo.
- Corpus cubre redacción previa a digest/persistencia, límites, receipts,
  recovery y aislamiento entre ramas.
- Ladder cubre niveles, spans con límites válidos, rendering cronológico,
  fallback y que ningún fallo reduce el contexto normal.
- Evidence cubre reglas verdaderas, no-reglas y casos ambiguos. Un fixture de
  candidato incierto prueba que Evidence pide elevación y no se pierde bajo
  `hide`.
- El eval harness usa sesiones/corpus/resultados locales ignorados; reporta
  precisión, recall, cobertura de fronteras y falsos negativos de Evidence.
- `npm test`, `npm run typecheck`, tests Python aplicables, Rootline y
  `git diff --check` deben pasar en cada entrega.

## Provenance y decisiones relacionadas

La importación conserva la licencia MIT de compact-adviser y registra URL,
commit y alcance exacto en un registro de provenance dentro del paquete. No se
sincroniza upstream. ADR 0013 continúa gobernando la compaction `basic`.
ADR 0022 queda propuesto y debe ser reemplazado o actualizado con la semántica
de retrieval por query antes de que se active la fase 5.
