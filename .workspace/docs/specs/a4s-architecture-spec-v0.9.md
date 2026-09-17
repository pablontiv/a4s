# A4S — Mission Control for Agentic Work

## Especificación arquitectónica v0.9

**Estado:** diseño normativo aprobado para validación experimental
**Fecha:** 2026-09-17
**Sustituye:** `a4s-architecture-spec-v0.7.md` como diseño vigente
**Decisiones rectoras:** ADR 0001, ADR 0009 y ADR 0010

---

## 1. North Star

A4S convierte la coordinación frágil de agentes mediante terminales en trabajo durable, estructurado y verificable.

Pi es el harness validado por el perfil inicial y Herdr es su host terminal. A4S conserva compromisos, ownership, interacciones, resultados y evidencia a través del tiempo y de los procesos. Un segundo harness permanece fuera de alcance hasta existir evidencia que justifique la abstracción.

v0.9 reorganiza esa North Star en tres niveles distintos:

```text
Portfolio attention
  → Mission Control global, no agentic en v0.9

Project coordination
  → un Project Orchestrator agentic por repositorio

Change execution
  → una Mission con Execution Cell propia
```

La centralización global es de **atención, estado y control**, no de razonamiento semántico.

---

## 2. Corrección arquitectónica respecto a v0.7

v0.7 colocaba una sesión `orch-main` con scope global entre el humano y todos los demás actores.

```text
Human ↔ orch-main ↔ Project Orchestrators ↔ Workers
```

La operación reportada por el owner sobre más de ocho proyectos y la reducción de fatiga percibida durante el uso de Firstmate motivan una hipótesis, todavía no una medición controlada:

1. cada proyecto necesita ownership semántico estable;
2. cada cambio necesita ejecución aislada y accountable;
3. una superficie global de atención puede reducir cambios de contexto y compromisos olvidados.

La fase E9-A (§27.1) debe medir esa hipótesis contra el baseline actual.

v0.9 conserva los dos primeros y reemplaza el meta-Orchestrator global obligatorio por Mission Control:

```text
Human Operator
      │
      ▼
Mission Control
      │
      ├───────────────┬────────────────┐
      ▼               ▼                ▼
Project A          Project B         Project C
Orchestrator       Orchestrator      Orchestrator
      │
      ▼
Mission / Execution Cell
```

Mission Control no interpreta código, no crea conclusiones semánticas y no adquiere ownership de los proyectos.

---

## 3. Evidencia y disciplina de alcance

A4S distingue:

```text
DECISIÓN NORMATIVA
  Regla aprobada para la arquitectura.

COMPORTAMIENTO VERIFICADO
  Propiedad observada en código, documentación primaria o experimento.

HIPÓTESIS
  Propiedad que aún necesita validación operacional.
```

Reglas:

1. una UI no demuestra que exista control durable;
2. un ticket visible no demuestra que su respuesta haya llegado al owner correcto;
3. un heartbeat prueba observación reciente, no progreso semántico;
4. una Delivery acknowledged no prueba que el trabajo se ejecutó;
5. `done`, idle o proceso ausente no son outcomes de Mission;
6. un WorkResult no cierra una Mission;
7. sólo Verification o una decisión humana autorizada produce cierre aceptado;
8. A4S no mantiene dos autoridades del mismo lifecycle;
9. antes de construir una capacidad ya disponible en un runtime, se aplica ADR 0009;
10. en v0.9 cualquier LLM de portfolio es read-only/propose-only y nunca obtiene autoridad de mutación;
11. cualquier relajación de esa prohibición requiere un ADR que sustituya ADR 0010.

---

## 4. Problema que v0.9 resuelve

El problema global no es falta de inteligencia para coordinar proyectos. Es atención fragmentada:

```text
muchos proyectos
+ múltiples sesiones y worktrees
+ preguntas dispersas
+ findings sin integrar
+ outcomes que requieren revisión
+ estado runtime ambiguo
```

El resultado buscado es:

```text
una superficie global de atención
+ ownership semántico local por proyecto
+ ejecución aislada por cambio
+ interacciones durables y correlacionadas
+ cierre verificable
```

Mission Control debe responder dos preguntas:

1. ¿qué está ocurriendo en cada proyecto y Mission?
2. ¿qué requiere atención humana ahora?

No pretende comprender todo el contenido de todos los proyectos en un único contexto LLM.

---

## 5. Principio rector

> Centralizar la atención sin centralizar el razonamiento de los proyectos.

En A4S v0.9:

```text
Human Operator owns portfolio intent and final authority.
Mission Control owns no project semantics.
Project Orchestrators own semantic coordination per project.
Missions hold change objectives and durable outcomes.
Project Orchestrators remain accountable for their Missions.
Execution Cells own isolated execution context.
Workers own implementation actions under delegated scope.
Verifier owns declared checks and evidence outcomes.
The Authoritative Coordination Runtime owns durable coordination truth.
Harnesses own turns, tools and native sessions.
```

### 5.1. Authoritative Coordination Runtime

`Authoritative Coordination Runtime` (ACR) significa el runtime único elegido conforme a ADR 0009 para poseer el lifecycle durable de trabajo. Puede ser:

- un runtime externo adoptado mediante adapter; o
- un núcleo A4S mínimo, sólo después de que incident replay pruebe un gap esencial.

La spec define el contrato lógico, no autoriza por sí sola construir el segundo caso.

Cada perfil de conformidad MUST declarar qué store autoritativo posee cada recurso HARD. Cualquier estado mantenido fuera de ese store es cache, proyección o receipt especializado y no puede convertirse en una segunda autoridad.

---

## 6. Planos de la arquitectura

### 6.1. Mission Control Plane

Superficie humana global compuesta por:

- portfolio read models;
- Attention Inbox;
- agent/Mission status projections;
- resultados esperando revisión;
- command surface tipada;
- audit trail;
- notificaciones y acknowledgement humano.

No es fuente de verdad. Toda tarjeta y columna es una proyección reemplazable de recursos durables.

### 6.2. Project Orchestration Plane

Un Project Orchestrator agentic por proyecto:

- conoce arquitectura, convenciones y decisiones del repo;
- mantiene continuidad semántica del proyecto;
- crea y modifica Missions dentro de su autoridad;
- descompone trabajo top-level;
- coordina integración con default branch;
- resuelve escalaciones locales;
- interpreta resultados y findings;
- crea Attention Tickets sólo cuando necesita autoridad humana.

### 6.3. Mission Execution Plane

Cada feature, bug, refactor o investigación vive en una Mission durable y una Execution Cell:

```text
Mission
  ├── primary Worktree
  ├── lead Worker binding
  ├── HarnessSession actual
  ├── subagents especializados
  ├── Escalations
  ├── WorkResults
  └── Verifications
```

### 6.4. Verification Plane

Ejecuta checks declarados, conserva evidencia y produce outcomes verificables.

No interpreta objetivos abiertos ni sustituye decisiones humanas no mecanizables.

### 6.5. Integration Boundary

Adapters conectan A4S con harnesses y hosts:

- bind/rebind de sesión;
- input estructurado;
- herramientas por rol;
- observaciones nativas;
- WorkResult y Escalation;
- opaque native references cuando se requieran.

PTY y screen parsing no son protocolo autoritativo.

---

## 7. Modelo de autoridad

### 7.1. Human Operator

Posee:

- intención de portfolio;
- prioridad cross-project;
- decisiones irreversibles o de alto impacto;
- resolución de Attention Tickets;
- aceptación explícita de criterios no mecanizables;
- override, pause, cancel, reassign y supersession autorizados.

Toda decisión queda asociada a identidad, timestamp, evidencia visible y resource version.

### 7.2. Mission Control

Mission Control puede:

- leer proyecciones globales;
- crear trabajo por orden humana;
- resolver Attention Tickets;
- enviar steering tipado;
- solicitar pause/cancel/reassign;
- mostrar evidencia y consecuencias;
- reconocer notificaciones.

Mission Control no puede:

- inventar decisiones semánticas;
- cerrar Missions por inferencia;
- alterar un proyecto fuera de autoridad humana;
- tratar telemetría como estado durable;
- bypassar al Project Orchestrator para cambios normales;
- escribir directamente en terminales como protocolo.

### 7.3. Project Orchestrator

Es una identidad durable con scope de un proyecto.

No es el pane, proceso ni sesión actual.

```yaml
id: orch-project-a
project_id: project-a
mailbox_id: mb-orch-project-a
harness_session_id: HS-orch-project-a
binding_revision: 3
```

Su contexto operativo se asocia al proyecto y default branch, pero ownership semántico no implica permiso para escribir directamente en default branch.

Cambios de producto entran mediante Missions y resultados verificados.

### 7.4. Mission ownership

El Project Orchestrator owner conserva accountability de la Mission.

La Execution Cell recibe autoridad delegada sobre:

- objetivo;
- worktree;
- write scope;
- herramientas permitidas;
- acceptance criteria;
- presupuesto y límites declarados.

### 7.5. Worker y subagentes

Una Mission tiene como máximo un lead Worker binding actual.

Los subagentes pueden investigar, implementar, testear o revisar dentro de autoridad delegada. No adquieren ownership global ni project-level por existir.

### 7.6. Verifier

El Verifier ejecuta políticas ya declaradas.

Puede emitir:

```text
PASS
FAIL
PENDING_HUMAN
ERROR
```

No crea acceptance criteria ni transforma error de infraestructura en failure semántico.

---

## 8. Recursos v0.9

### 8.1. Project

```yaml
id: project-a
repo: github.com/example/project-a
default_branch: main
```

Es el dominio de ownership semántico por repositorio. `ProjectOrchestrator.project_id` es el foreign key canónico y UNIQUE; `Project.orchestrator` es una relación derivada.

### 8.2. Mission

`Mission` es el término de producto v0.9 para una unidad de cambio durable. Corresponde al `WorkUnit` de v0.7.

```yaml
id: M42
project_id: project-a
kind: feature

title: Refresh token rotation
objective: >
  Implementar rotación de refresh tokens manteniendo
  compatibilidad con clientes existentes.

constraints:
  - preserve existing token clients

acceptance_criteria:
  - text: existing auth tests pass
    check:
      command: go test ./internal/auth/...
      exit_code: 0
  - text: no plaintext refresh token persistence
    check: null

status: OPEN
priority: normal
integration_required: true
supersedes: null
```

Estados persistidos:

```text
OPEN
COMPLETED
FAILED
CANCELLED
```

La relación con Project determina el Orchestrator accountable. `ExecutionCell.mission_id` es el foreign key canónico y UNIQUE; Mission no persiste una referencia inversa editable.

Running, waiting, blocked, verifying, ready-for-integration, stale y unknown son vistas derivadas.

### 8.3. Execution Cell

Materialización durable de ownership de ejecución para una Mission.

```yaml
id: EC-M42
mission_id: M42
primary_worktree_id: WT-M42
execution_condition: ENABLED
hold_reason: null
lead_worker_binding:
  harness_session_id: HS-M42
  revision: 2
```

`mission_id` es UNIQUE y autoritativo para la relación uno-a-uno. `execution_condition` es `ENABLED | HELD`; un hold impide nuevos dispatches e inputs de ejecución, pero no afirma que un efecto ya iniciado se detuvo. La Cell persiste aunque la sesión actual desaparezca.

### 8.4. HarnessSession

Binding de un owner durable a una sesión nativa direccionable.

No es proceso, pane, turn ni lifecycle de trabajo.

### 8.5. Mailbox y Delivery

Toda identidad durable que recibe input posee Mailbox.

Delivery conserva intención durable en dos estados:

```text
PENDING
  ├── zero or more DeliveryAttempts
  └── semantic acceptance by current binding
        ↓
ACKNOWLEDGED
```

Cada `DeliveryAttempt` registra binding revision, timestamp y transport outcome. Una pérdida de conexión no necesita revertir Delivery: mientras no exista ACK válido permanece `PENDING` y puede redeliverarse.

El ACK MUST incluir `delivery_id`, `owner_id`, `binding_revision`, `acceptance_kind` e idempotency key. Sólo el binding actual puede reconocerlo.

Para kickoff, steering y respuestas, ACK prueba que el adapter correlacionó el input con el boundary nativo declarado por el perfil. No prueba turn start, completion ni éxito. El ACK de E0 es transport-only y no satisface este contrato.

### 8.6. Escalation

Solicitud Worker → Project Orchestrator.

```yaml
id: E42
mission_id: M42
source_binding_revision: 2
reason: architecture_decision
status: PENDING
```

Lifecycle:

```text
PENDING
  ├── RESOLVED
  ├── REJECTED
  └── CANCELLED
```

Sólo el Project Orchestrator owner o una decisión humana correlacionada puede producir un outcome terminal. El Project Orchestrator puede resolverla localmente o elevarla mediante AttentionTicket.

### 8.7. AttentionTicket

Primitive global de atención humana.

```yaml
id: ATT-418

source:
  kind: escalation
  id: E42
  version: 4

type: DECISION
status: OPEN
priority: high

summary: Choose token rotation compatibility policy
decision_needed: >
  Preserve existing refresh tokens for 30 days or
  invalidate all tokens at deployment?

options:
  - id: preserve
    impact: backward compatible, larger migration window
  - id: invalidate
    impact: simpler implementation, forces re-login

evidence:
  - artifact://analysis/auth-compatibility

risk: high
reversible: false
deadline: null
```

Tipos iniciales:

```text
QUESTION
DECISION
APPROVAL
RISK
CONFLICT
VERIFICATION_FAILED
RESULT_READY
STALE_WORK
BUDGET_EXCEEDED
OPERATOR_ACTION
```

Lifecycle:

```text
OPEN
  ↓
ACKNOWLEDGED
  ├── RESOLVING
  │     ├── RESOLVED
  │     └── OPEN      command failed safely
  ├── SUPERSEDED
  └── EXPIRED
```

Sólo puede existir un ticket activo por `(source kind, source id, source version, type)`. Project y Mission se derivan del recurso fuente y no son foreign keys editables del Ticket.

`attention.resolve` exige expected Ticket version y expected source version. El ACR conserva un command receipt durable antes de aplicar la mutación fuente. Si source y Ticket no comparten transacción, el target operation usa la misma idempotency key y el reconciler completa `RESOLVING → RESOLVED` sólo después de observar el outcome autoritativo.

`AttentionTicket` no duplica el lifecycle de su recurso fuente.

### 8.8. WorkResult

Propuesta estructurada e inmutable del Worker:

```yaml
id: WR-M42-2
mission_id: M42
binding_revision: 2
revision: abc123
submitted_at: ...
summary: Implemented refresh token rotation.
artifacts: []
checks_run: []
followups: []
```

La creación es el único transition: `SUBMITTED`. Una nueva propuesta crea otro WorkResult y puede superseder la anterior por referencia; nunca la muta. No posee autoridad de cierre.

### 8.9. Verification

```text
WorkResult SUBMITTED
  ↓
Verification PENDING
  ├── PASS              verified proposal; Mission remains OPEN
  ├── FAIL              Mission remains OPEN
  ├── PENDING_HUMAN
  │     ├── PASS        authorized manual acceptance
  │     └── FAIL        authorized rejection
  └── ERROR             retryable infrastructure outcome
```

`ERROR` no implica work failure. Toda Verification referencia exactamente un WorkResult, la definición/version de sus checks y la evidencia producida.

### 8.10. IntegrationResult

Prueba la incorporación del resultado verificado al outcome declarado del proyecto.

```yaml
id: IR-M42-1
mission_id: M42
work_result_id: WR-M42-2
verification_id: V-M42-2
target: refs/heads/main
target_revision: def456
status: PASSED
post_integration_checks: []
```

Lifecycle:

```text
PENDING
  ├── PASSED
  ├── CONFLICT
  └── ERROR
```

Para Missions de código con `integration_required: true`, sólo `IntegrationResult PASSED` autoriza `Mission COMPLETED`. `Verification PASS` produce la condición derivada `READY_FOR_INTEGRATION`. Una Mission no-code puede declarar `integration_required: false`; en ese caso la policy aprobada define qué Verification terminal permite completion.

### 8.11. Event Journal

Registra operaciones de dominio y decisiones con:

- actor;
- owner;
- resource version;
- correlation ID;
- idempotency key;
- timestamps;
- evidencia relevante.

Observaciones runtime se distinguen de eventos de dominio.

### 8.12. Canonical relations and resource authority

Cada perfil de conformidad declara la implementación física, pero conserva estas relaciones lógicas canónicas:

| Relación o recurso | Campo/store canónico | Derivado o cache |
| --- | --- | --- |
| Project → Orchestrator | `ProjectOrchestrator.project_id` UNIQUE | `Project.orchestrator` |
| Mission → Project | `Mission.project_id` | accountable Orchestrator |
| Mission → Execution Cell | `ExecutionCell.mission_id` UNIQUE | `Mission.execution_cell` |
| Cell → primary Worktree | `ExecutionCell.primary_worktree_id` | worktree views |
| current Worker | `ExecutionCell.lead_worker_binding` + revision | agent fleet row |
| Attention routing | `AttentionTicket.source` + source version | Project/Mission columns |
| Mission lifecycle | store autoritativo del ACR | boards y counters |
| Delivery lifecycle | store autoritativo del ACR | inbox badges |
| Verification/Integration | records inmutables del ACR | result queues |

Un reverse lookup nunca es una segunda columna mutable. Si un runtime externo ya posee el recurso, A4S conserva sólo su canonical reference, receipts imprescindibles y proyecciones.

---

## 9. Mission Control read models

### 9.1. Portfolio

Por proyecto:

- Project Orchestrator health/freshness;
- Missions abiertas;
- Missions esperando verificación;
- Attention Tickets abiertas;
- stale/unowned work;
- coste y duración cuando exista evidencia.

### 9.2. Attention Inbox

Ordena por:

- riesgo;
- prioridad;
- deadline;
- reversibilidad;
- tiempo esperando;
- proyecto y Mission.

Deduplica síntomas correlacionados sin ocultar evidencia original.

### 9.3. Mission Board

Vistas sugeridas:

```text
Ready
Active
Waiting
Verification
Done
```

Son columnas derivadas, no estados adicionales de Mission.

### 9.4. Agent Fleet

Muestra:

- owner/Mission actual;
- harness/model;
- working/waiting/blocked/settled como observación;
- último evento y freshness;
- tool actual cuando el harness lo reporta;
- subagentes;
- worktree;
- pregunta interactiva pendiente.

### 9.5. Result and Verification Queue

Separa:

- resultados recibidos;
- checks pendientes;
- failures;
- criterios no mecanizables;
- outcomes listos para integración.

---

## 10. Command surface humana

Operaciones iniciales:

```text
attention.acknowledge
attention.resolve
mission.create
mission.steer
mission.cancel
execution.hold
execution.resume
execution.rebind
verification.accept_manual
project.orchestrator.rebind
```

`mission.create` usa un client request ID, idempotency key y expected Project version; el ACR asigna Mission ID o valida uno aportado por el cliente. Las demás mutaciones incluyen:

```text
operator identity
resource id
expected resource version o binding revision
idempotency key
reason cuando aplique
```

`execution.hold` muta sólo `ExecutionCell.execution_condition`; no afirma haber detenido efectos iniciados. `execution.rebind` reemplaza el lead Worker e incrementa revision. Supersession crea una nueva Mission con `supersedes` y cancela la anterior mediante una operación explícita del Project Orchestrator; no existe un update ambiguo de owner.

La UI debe mostrar consecuencias antes de acciones destructivas o irreversibles.

### 10.1. Transition guards

| Recurso | Operación | Actor autorizado | Guard principal | Efecto |
| --- | --- | --- | --- | --- |
| Mission | create | Human vía Mission Control o Project Orchestrator | expected Project version + idempotency | nueva Mission OPEN |
| Mission | cancel/fail | Project Orchestrator o Human autorizado | expected Mission version | terminal outcome explícito |
| ExecutionCell | hold/resume | Project Orchestrator o Human autorizado | expected Cell version | condición HELD/ENABLED |
| ExecutionCell | rebind | Project Orchestrator o Human autorizado | expected binding revision | revision + 1; writer previo stale |
| Escalation | resolve/reject/cancel | Project Orchestrator o Human correlacionado | expected Escalation version | terminal outcome |
| AttentionTicket | resolve | Human Operator | expected Ticket + source version | command receipt + source mutation |
| Verification | run/manual disposition | Verifier o Human autorizado | immutable WorkResult/check version | PASS/FAIL/PENDING_HUMAN/ERROR |
| IntegrationResult | record | Project Orchestrator/integration service | PASS Verification + target version | PASSED/CONFLICT/ERROR |
| Mission | complete | ACR policy | accepted IntegrationResult o no-integration policy | COMPLETED |

---

## 11. Flujo: intake y Mission normal

```text
Human Operator
  ↓ Mission Control
mission.create(project-a, objective, criteria)
  ↓
Project Orchestrator A
  ↓ semantic decomposition and authorization
Mission M42 + Execution Cell
  ↓
primary Worktree ensured
  ↓
lead Worker bound
  ↓
work.kickoff Delivery
  ↓
Worker executes with local planning/subagents
  ↓
WorkResult
  ↓
Verification PASS
  ↓ READY_FOR_INTEGRATION
Project Orchestrator integrates verified revision
  ↓
IntegrationResult PASSED
  ↓
Mission COMPLETED
  ↓
Mission Control projects completion
```

Mission Control no interviene si no existe excepción.

---

## 12. Flujo: escalación local

```text
Worker
  ↓ escalation.create
Project Orchestrator
  ↓ resolves within project authority
Delivery to Execution Cell
  ↓
Worker continues
```

No se crea AttentionTicket.

---

## 13. Flujo: atención humana

```text
Worker
  ↓ Escalation E42
Project Orchestrator cannot resolve with current authority
  ↓ attention.create(source=E42)
AttentionTicket ATT-418 OPEN
  ↓ Mission Control
Human acknowledges and resolves
  ↓ attention.resolve(ticket version, source version)
ATT-418 RESOLVING + durable command receipt
  ↓ idempotent source operation
E42 RESOLVED
  ↓ Delivery to current Mission binding
  ↓ reconciler observes authoritative outcome
ATT-418 RESOLVED
```

Una respuesta humana no se entrega mediante texto no correlacionado.

---

## 14. Flujo: steering

```text
Human opens Mission M42
  ↓ mission.steer(expected_version=N)
ACR records Command
  ↓ routes through Project Orchestrator ownership
Delivery PENDING to current Mission binding
  ↓ adapter correlates native acceptance
ACK(owner, binding_revision, acceptance_kind)
  ↓
Delivery ACKNOWLEDGED
```

Steering no cambia objetivo, constraints o acceptance criteria silenciosamente. Esos cambios son mutaciones versionadas de Mission.

---

## 15. Flujo: verificación no mecánica

```text
WorkResult submitted
  ↓
mechanical checks PASS
  ↓
criterion check=null
  ↓
Verification PENDING_HUMAN
  ↓ AttentionTicket
Human inspects evidence
  ├── accept → Verification PASS
  ├── reject → Verification FAIL + Mission OPEN + feedback
  └── request evidence → Verification PENDING_HUMAN

If integration is required:
  Verification PASS → READY_FOR_INTEGRATION
  IntegrationResult PASSED → Mission COMPLETED
```

---

## 16. Flujo: Project Orchestrator ausente

La identidad del Project Orchestrator persiste aunque su proceso no esté presente.

```text
Project Orchestrator process = ABSENT
mailbox pending > 0
```

Esto no falla el proyecto ni las Missions.

Política inicial:

- Mission Control muestra ausencia y freshness;
- Deliveries permanecen pendientes;
- el operador puede rebind/reabrir la sesión exacta;
- no existe retry semántico automático;
- writes del binding anterior quedan stale después de rebind.

---

## 17. Cross-project coordination

v0.9 no introduce un meta-Orchestrator LLM obligatorio.

Un Project Orchestrator puede emitir un finding o solicitud cross-project tipada. Inicialmente:

- solicitudes mutantes se convierten en AttentionTicket humano;
- consultas informativas pueden usar Query tipada;
- ninguna respuesta transfiere ownership implícitamente;
- el proyecto destino conserva decisión final.

Automatizar negociación entre Project Orchestrators es FUTURE y requiere evidencia.

---

## 18. Project Orchestrator residency

Project Orchestrator es identidad durable, no requisito de proceso siempre residente.

Perfiles válidos:

```text
resident
  sesión presente y recibe Deliveries

on-demand
  sesión se abre al llegar work/attention relevante

external
  runtime existente materializa la identidad mediante adapter
```

v0.9 debe medir coste, latencia y confiabilidad antes de fijar un perfil por defecto.

---

## 19. Optional Portfolio Copilot

Mission Control puede incorporar un LLM opcional para:

- resumir Attention Tickets;
- agrupar posibles duplicados;
- explicar impacto;
- sugerir prioridad;
- detectar relaciones cross-project;
- redactar respuestas o steering;
- responder preguntas read-only sobre el portfolio.

En v0.9 nunca puede:

- emitir comandos de dominio;
- cerrar Tickets o Missions;
- cambiar prioridades;
- cancelar trabajo;
- aprobar efectos externos;
- reasignar ownership;
- modificar constraints;
- decidir Verification;
- enviar steering.

Sólo produce análisis, agrupaciones y drafts que un humano puede descartar o convertir en un comando propio. Cualquier mutation authority futura requiere un ADR que sustituya ADR 0010; no puede habilitarse mediante configuración ordinaria.

---

## 20. Reconciliation

Sólo se crea un reconciler cuando existe desired state claro.

Reconciliation inicial:

### 20.1. Binding reconciliation

```text
one durable owner in the ACR
vs
current attached HarnessSession
```

### 20.2. Delivery reconciliation

```text
PENDING Delivery in the ACR
vs
binding-fenced semantic acceptance and DeliveryAttempts
```

### 20.3. Worktree reconciliation

```text
desired primary Worktree
vs
observed filesystem/Git state
```

### 20.4. Attention reconciliation

```text
unresolved source resource in the ACR
vs
unique active AttentionTicket, command receipt and observed source outcome
```

### 20.5. Verification reconciliation

```text
declared acceptance criteria
vs
available evidence and check outcomes
```

No controller realiza juicio LLM.

---

## 21. Failure semantics

### 21.1. Runtime absence

No implica work failure.

### 21.2. Stale observation

Una observación expirada se degrada a `UNKNOWN`. Cada perfil MUST declarar `freshness_ttl` por fuente y calcular freshness con reloj monotónico local sobre `observed_at`; clock skew remoto se conserva como diagnóstico, no como extensión silenciosa del TTL. Nunca mantiene indefinidamente una apariencia de working/healthy.

### 21.3. Alert duplication

Eventos correlacionados pueden agruparse, pero evidencia y recursos fuente permanecen accesibles.

### 21.4. Human timeout

Un AttentionTicket expirado sigue la política declarada:

- remain blocked;
- safe default;
- escalate notification;
- cancel only if explicitly configured.

Nunca inventa una respuesta humana.

### 21.5. Mid-effect interruption

A4S registra la última evidencia, no repite automáticamente efectos ambiguos y crea AttentionTicket cuando se requiere decisión.

### 21.6. Verification failure

Mantiene Mission `OPEN` salvo cierre explícito autorizado como `FAILED`.

---

## 22. Concurrencia e idempotencia

Toda mutación durable incluye:

```text
resource id
expected resource version o binding revision
idempotency key
actor/owner
correlation id cuando aplique
```

Reglas:

1. repeated idempotency key devuelve el mismo resultado lógico;
2. stale Worker no puede mutar Mission;
3. stale Project Orchestrator binding no puede resolver trabajo nuevo;
4. sólo existe un AttentionTicket activo por source/version/type;
5. AttentionTicket resolution valida Ticket y source versions;
6. todo Delivery ACK valida owner y binding revision actuales;
7. redelivery no duplica steering, respuesta ni decisión;
8. dashboard optimistic state nunca sustituye confirmación autoritativa;
9. múltiples vistas consumen el mismo event stream sin crear lifecycles paralelos;
10. una operación con outcome indeterminado se reconcilia por receipt/estado autoritativo antes de retry.

---

## 23. Invariantes v0.9

1. Mission Control no es un actor agentic autoritativo.
2. No existe meta-Orchestrator LLM global obligatorio.
3. Cada Project tiene un Project Orchestrator owner durable.
4. Project Orchestrator no equivale a proceso, pane ni sesión.
5. Cada Mission pertenece exactamente a un Project.
6. Cada Mission tiene un Project Orchestrator accountable.
7. Cada Mission posee exactamente una Execution Cell primaria.
8. Cada Execution Cell posee exactamente un primary Worktree.
9. Cada Mission tiene como máximo un lead Worker binding actual.
10. Subagentes no adquieren ownership global implícito.
11. Human Operator entra por Mission Control para decisiones de portfolio.
12. Worker escala primero a su Project Orchestrator.
13. Sólo necesidades humanas se convierten en AttentionTicket.
14. AttentionTicket referencia recursos fuente; no duplica su lifecycle.
15. Status global es una proyección determinista.
16. Toda observación runtime muestra timestamp, fuente y freshness.
17. Idle no equivale a done.
18. Process absent no equivale a failed.
19. Heartbeat no equivale a progreso semántico.
20. Delivery ACK no equivale a outcome.
21. WorkResult no equivale a Verification PASS.
22. Agent-declared completion no cierra Mission.
23. Un criterio no mecanizable requiere decisión humana explícita.
24. PTY no es protocolo autoritativo.
25. Steering que cambia contrato muta Mission de forma versionada.
26. Rebind incrementa binding revision y fencea writers anteriores.
27. Un LLM opcional de portfolio permanece read-only/propose-only durante toda v0.9.
28. No existen dos autoridades del task lifecycle.
29. El ACR seleccionado conforme a ADR 0009 posee cada recurso durable HARD.
30. Capacidades de runtimes externos se reutilizan conforme a ADR 0009.
31. Cross-project mutation nunca ocurre por inferencia o conversación libre.
32. Mission COMPLETED significa outcome integrado o policy explícita `no_integration_required`, nunca sólo proposal verification.

---

## 24. Riesgos humanos y mitigaciones

### 24.1. Alert fatigue

Mitigaciones:

- sólo excepciones accionables;
- dedupe por resource/correlation;
- severity, impact y deadline;
- grouping sin borrar source evidence;
- métricas de false/ignored alerts.

### 24.2. Human bottleneck

Se mide:

```text
decision arrival rate
operator resolution rate
queue age
operator touch time
```

Si arrival ≥ resolution sostenidamente, se limita admission/concurrency o se introduce policy específica. No se añaden más alertas.

### 24.3. Out-of-the-loop

Cada Ticket debe ser decision-complete:

- objetivo y constraints relevantes;
- estado deseado vs observado;
- decisión exacta;
- trigger e impacto;
- intentos previos;
- evidencia compacta y timeline;
- opciones y reversibilidad.

### 24.4. Poor decomposition

Antes de dispatch, Mission requiere:

- objetivo;
- boundary;
- deliverable;
- acceptance criteria;
- dependencies conocidas;
- ownership y scope.

Workers pueden sugerir follow-ups, no crear compromisos top-level silenciosos.

---

## 25. Phase gate and scope v0.9

### 25.1. ADR 0009 gate

Esta spec es el contrato objetivo; no autoriza construir un segundo control plane.

Hasta registrar el resultado del bakeoff exigido por ADR 0009, el único trabajo permitido es:

- contrato y perfiles de conformidad;
- adapters hacia runtimes existentes;
- Mission Control como proyección no autoritativa;
- Verification y checks que no dupliquen lifecycle;
- instrumentación del experimento E9-A.

Después del bakeoff, un ADR de selección MUST nombrar el ACR y mapear cada recurso HARD a su store autoritativo. Sólo si incident replay demuestra que ningún runtime satisface una invariante esencial puede autorizarse un núcleo A4S mínimo para ese gap. La fase E9-B permanece bloqueada hasta entonces.

ADR 0009 menciona una v0.8 que nunca se materializó como spec; v0.9 hereda íntegramente ese gate.

### 25.2. HARD contract

- North Star de ADR 0001;
- gate runtime-first y single-authority de ADR 0009;
- Mission Control no agentic;
- Human Operator identity;
- Project y Project Orchestrator por repositorio;
- Mission/WorkUnit y Execution Cell;
- one primary Worktree y one current lead Worker binding;
- HarnessSession con native ref exacta en el perfil Pi/Herdr;
- Mailbox/Delivery con ACK fenceado por binding;
- Escalation local y AttentionTicket único por source version;
- operator response/steering correlacionado;
- WorkResult inmutable;
- Verification y IntegrationResult independientes;
- manual disposition para criterios no mecanizables;
- timestamped runtime observations con freshness policy;
- Event Journal y Mission Control read models;
- ningún PTY autoritativo;
- restart sin pérdida ni duplicate domain effect en el ACR seleccionado.

### 25.3. STRONG

- múltiples Projects y Missions visibles;
- AttentionTicket dedupe/aggregation;
- notification policy;
- Project Orchestrator on-demand;
- peer informational Queries;
- explicit hold/cancel/rebind;
- reusable external runtime adapter.

### 25.4. FUTURE / SÓLO CON EVIDENCIA

- autonomous cross-project prioritization sin mutation authority;
- cualquier autoridad futura para Portfolio Copilot mediante ADR que sustituya ADR 0010;
- multi-operator assignment y RBAC completo;
- agentic negotiation entre Project Orchestrators;
- scheduler global de capacidad/fairness;
- automatic semantic retry o mid-turn recovery;
- distributed placement, multi-node o HA;
- second harness abstraction;
- semantic verifier LLM autoritativo;
- multi-tenant service.

### 25.5. HARD conformance matrix

| Contract | Observable assertion |
| --- | --- |
| single authority | profile maps every HARD resource to exactly one authoritative store |
| exact binding | stale binding cannot mutate, ACK or resolve current resources |
| durable Delivery | restart at each attempt/ACK boundary preserves one logical input |
| AttentionTicket | duplicate source/version/type yields the same active Ticket |
| source resolution | repeated resolve applies one source decision and one response Delivery |
| Verification | WorkResult/idle/ACK cannot close Mission |
| Integration | code Mission closes only after IntegrationResult PASSED |
| freshness | expired observation becomes UNKNOWN at declared TTL |
| projection safety | rebuilding dashboard from ACR reproduces authoritative state |
| no PTY authority | no test depends on terminal text for command or outcome |

---

## 26. No objetivos

v0.9 no pretende:

- convertir Mission Control en otro chat global;
- reemplazar Project Orchestrators;
- mantener un contexto LLM con todos los repositorios;
- reconstruir capacidades ya satisfechas por un runtime seleccionado;
- ser un issue tracker general o un observability product solamente;
- automatizar decisiones humanas irreversibles;
- inferir estado desde terminal title o screen text;
- resolver portfolio scheduling antes de medir operator capacity.

---

## 27. Experimentos v0.9

### 27.1. E9-A — attention centralization bakeoff

Se ejecuta antes de construir recursos autoritativos nuevos.

- mínimo cuatro Projects reales o representativos;
- mínimo treinta eventos accionables durante una ventana pre-registrada;
- baseline comparable del flujo actual;
- proyección/ticket UI sobre lifecycle existente;
- ningún cambio de autoridad del runtime;
- tickets de pregunta, verification, stale work y result review;
- replies/steering correlacionados mediante adapters existentes cuando sea posible.

Pass requires:

- cero tickets accionables perdidos;
- cero steering entregado al Project/Mission incorrecto;
- duplicate-alert rate menor o igual a 10%;
- queue age estable: arrival rate permanece por debajo de resolution rate en la ventana;
- reducción pre-registrada de al menos 25% en recordatorios/manual cross-project checks o en operator minutes por evento accionable;
- ningún empeoramiento de incorrect closure o duplicate effect respecto al baseline.

Si no alcanza el threshold de outcome humano, v0.9 se conserva como aprendizaje y no justifica construir Mission Control autoritativo.

### 27.2. E9-B — technical vertical slice

Sólo se ejecuta después de que un ADR seleccione ACR o autorice un gap mínimo.

Debe involucrar al menos dos Projects:

```text
1. Mission Control abre proyecciones reconstruibles del ACR.
2. Project A y B tienen Orchestrators durables.
3. Cada Project crea una Mission mediante expected Project version.
4. Cada Mission obtiene Execution Cell, Worktree y Worker binding.
5. Ambas reciben kickoff estructurado sin PTY.
6. Mission A progresa sin atención humana.
7. Mission B eleva Escalation y un único AttentionTicket.
8. Human resolve crea receipt y source mutation idempotente.
9. Respuesta redeliverada produce un solo native input aceptado.
10. Worker B entrega WorkResult; Verification ejecuta checks.
11. Criterio no mecánico resuelve Verification, no Mission directamente.
12. Project Orchestrator integra; IntegrationResult PASSED cierra Mission.
13. Rebind fencea write y ACK del binding anterior.
14. Dashboard se borra y reconstruye desde el ACR sin drift.
```

Fault matrix, mínimo veinte trials por boundary en macOS y cualquier plataforma adicional que se declare PASS:

- crash antes/después de command receipt;
- crash antes/después de source mutation;
- disconnect antes/después de native acceptance;
- crash antes/después de ACK persistence;
- duplicate Delivery y duplicate ticket resolution;
- daemon y adapter restart simultáneos;
- stale Worker/Orchestrator ACK y write;
- crash antes/después de IntegrationResult.

---

## 28. Criterios de éxito E9-B

- cero recursos durables perdidos en la matriz declarada;
- cero decisiones humanas no correlacionadas;
- cero duplicate logical effects por retry/redelivery;
- stale writes y ACKs rechazados;
- ninguna Mission cerrada por idle, ACK, WorkResult o Verification sin integración requerida;
- ninguna respuesta entregada al Project/Mission incorrecto;
- observaciones stale degradadas a `UNKNOWN` al TTL declarado;
- restart recovery reproducible;
- todos los HARD assertions de §25.5 pasan.

Operator metrics continúan midiéndose: intervenciones por Mission, touch time, queue age, alertas falsas/duplicadas, transcript opens, re-decomposition y user reminders.

---

## 29. Estado de implementación al adoptar v0.9

E0 obtuvo **PASS-macOS** para framing, attach básico, owner validation experimental, reconnection y redelivery/dedupe dentro de la vida del daemon/cliente. Linux y Windows permanecen NOT RUN. Su ACK es transport-only, `binding_revision` está fijado a 1 y Delivery sólo soporta `kind: probe`.

No implementado todavía:

- resultado E9-A ni ACR seleccionado;
- Mission Control autoritativo;
- Project Orchestrator/Mission/Execution Cell resources;
- almacenamiento durable de dominio;
- AttentionTicket y command receipts;
- input Pi con semantic acceptance;
- binding revision > 1 y ACK fenceado;
- restart durability;
- WorkResult/Verification/IntegrationResult end-to-end;
- E9-B multi-project.

La spec no convierte estas ausencias en comportamiento existente.

---

## 30. Referentes verificados

Patrones de producto:

- GitHub Agents: central session management, steering y review;
- Linear Agent Sessions: estados visibles, activities y awaiting input;
- Temporal: durable workflows y approval signals;
- LangGraph: checkpointed interrupts;
- Prefect: typed human input desde UI;
- Restate: durable signals/awakeables;
- UiPath Maestro: process supervision, human tasks e incident handling.

Investigación relevante:

- Wang et al., ACL 2025: governance central puede mejorar eficiencia en tareas específicas;
- MultiAgentBench, ACL 2025: graph-mesh gana en un escenario, no universalmente;
- AgentDropout, ACL 2025: eliminar agentes/edges redundantes mejora coste y performance;
- Li et al., EMNLP 2024: comunicación sparse puede igualar/superar all-to-all;
- Shen et al., EMNLP 2025: sparsity moderada equilibra información útil y error propagation;
- Bainbridge 1983: ironías de automation y riesgo out-of-the-loop;
- Parasuraman, Sheridan y Wickens 2000: automatización por función y nivel;
- Amershi et al. 2019: status, context, correction, scope y global controls.

Estos referentes justifican experimentar; no prueban anticipadamente el resultado de A4S.

---

## 31. Resumen

A4S v0.9 organiza agentic work así:

```text
Human Operator
  ↓
Mission Control
  ↓ typed attention and commands
Project Orchestrators
  ↓ durable Missions
Execution Cells
  ↓ structured WorkResults
Verifier
  ↓ authoritative outcomes
Mission Control projections
```

No hay un meta-Orchestrator LLM obligatorio.

Los Project Orchestrators conservan ownership semántico. Mission Control conserva la atención humana. El ACR conserva la verdad durable. Los Workers ejecutan. Verification valida propuestas y IntegrationResult prueba el outcome integrado antes del cierre.
