# A4S — Agent Workload Control Plane
## Especificación Arquitectónica v0.7

**Estado:** Borrador de diseño  
**Fecha:** 2026-08-31  
**Nombre del sistema:** **A4S** (`agents`)  
**CLI:** `a4sctl`  
**Daemon/control plane local:** `a4sd`  
**Alcance:** Arquitectura local-first para coordinar trabajo de desarrollo operado por agentes CLI mediante sesiones terminales e integración estructurada.

**Documento actual:** v0.7.

---

# Historial de revisiones

Este es el único historial de cambios del documento. El cuerpo de la especificación describe únicamente el modelo vigente.

| Versión | Fecha | Área | Cambio |
|---|---|---|---|
| 0.1 | 2026-08-30 | Modelo de ejecución | Se estableció el modelo inicial inspirado en sistemas distribuidos: `WorkUnit`, scheduler determinista, controllers, leases, generations, runtime Herdr y Pi como primer harness. |
| 0.1 | 2026-08-30 | Interacciones externas | Se introdujo `ToolCall` y Human-as-Tool como operación durable. |
| 0.1 | 2026-08-30 | Terminal | Se estableció que el terminal debe ser execution driver y no fuente de verdad ni store durable del workload. |
| 0.2 | 2026-08-30 | Ownership | Se introdujo `Orchestrator` como identidad durable separada de su ejecución física y `scope` como límite de autoridad. |
| 0.2 | 2026-08-30 | Interacción humana | Se estableció un único ingress humano: el usuario interactúa con Orchestrators, nunca directamente con Workers o subagentes. |
| 0.2 | 2026-08-30 | Escalación | Se introdujo `Escalation`: las necesidades de decisión de un Worker escalan primero a su Orchestrator owner; Human-as-Tool queda detrás del Orchestrator. |
| 0.2 | 2026-08-30 | Comunicación cross-scope | Se introdujo `Proposal` para solicitar a otro ownership domain que considere un cambio sin conceder autoridad al originador. |
| 0.2 | 2026-08-30 | Subagentes | Se reemplazó la suposición inicial de subagentes read-only por autoridad delegada: pueden escribir, ejecutar tests, usar Git, commitear e implementar; el Worker conserva accountability. |
| 0.2 | 2026-08-30 | Controllers | Se adoptó la regla: los controllers corresponden a recursos/lifecycles durables; no se crea un controller por cada tipo de contenido. |
| 0.3 | 2026-08-30 | Transporte | `Message` dejó de ser recurso first-class; `Delivery` pasó a ser la primitiva genérica de transporte hacia `Mailbox`. |
| 0.3 | 2026-08-30 | Comunicación cross-scope | Se introdujo `Query` para solicitudes de información entre Orchestrators peers. |
| 0.3 | 2026-08-30 | Proposal | `Proposal` dejó de representar negociación y adoptó el lifecycle `PENDING → ACCEPTED | REJECTED`, con `FULFILLED` tras verified completion del trabajo resultante. |
| 0.3 | 2026-08-30 | Proposal | `ACCEPTED` dejó de duplicar el lifecycle de una WorkUnit; una Proposal aceptada puede referenciar la WorkUnit creada por el owner destino. |
| 0.3 | 2026-08-30 | Proposal | El outcome de `FULFILLED` puede informar cambios de contrato/API correlacionados al Orchestrator originador. |
| 0.3 | 2026-08-30 | Observabilidad | Se separó `Event Journal` de `Delivery` y de telemetría/observabilidad. |
| 0.3 | 2026-08-30 | Diseño abierto | Se abrió el problema de notificar cambios de contrato no correlacionados a una Proposal previa. |
| 0.4 | 2026-08-30 | Ejecución agentic | Se reemplazó la ambigüedad de `Session` por `AgentExecution` como recurso lógico. `Continuation` y `Activation` son subentidades de `AgentExecution`. |
| 0.4 | 2026-08-30 | Continuidad | A4S posee la referencia durable y exacta de continuación; el formato y los identificadores nativos siguen siendo opacos y pertenecen al Harness Adapter. No se permite reanudar mediante heurísticas como “última sesión”. |
| 0.4 | 2026-08-30 | Suspensión | Se adoptó suspensión real en esperas durables: tras un punto seguro se destruye la Activation física y posteriormente se crea otra Activation que reanuda la misma Continuation. |
| 0.4 | 2026-08-30 | Lifecycle | `AgentExecution` usa un estado principal pequeño acompañado de `Conditions` ortogonales derivadas de evidencia del harness/runtime. |
| 0.4 | 2026-08-30 | Fencing | Reemplazar, suspender o reactivar una Activation no crea una nueva WorkUnit generation. Sólo un retry lógico crea una nueva generation. |
| 0.4 | 2026-08-30 | Worktree | `Worktree` se convirtió en recurso first-class del control plane. A4S posee su lifecycle y un `WorktreeProvider` materializa/observa Git o Treehouse. |
| 0.4 | 2026-08-30 | Worktree | Cada WorkUnit generation posee exactamente un primary Worktree. El mismo worktree sobrevive a todas las Activations de esa generation; un retry crea otro primary Worktree. |
| 0.4 | 2026-08-30 | Subagentes | Los worktrees auxiliares creados por Workers/subagentes siguen encapsulados y no son recursos globales de A4S en v0.x. |
| 0.4 | 2026-08-30 | Documentación | Se reemplazaron las secciones “Cambios desde vX” por este único `Historial de revisiones` acumulativo. |
| 0.5 | 2026-08-31 | Calibración arquitectónica | Se auditó el modelo contra el funcionamiento real de sesiones terminales de Pi; se retiraron supuestos no validados de Kubernetes/durable execution. |
| 0.5 | 2026-08-31 | Modelo de sesión | `AgentExecution`, `Continuation` y `Activation` se reemplazaron por `HarnessSession`, que vincula un owner A4S con una sesión nativa exacta del harness. |
| 0.5 | 2026-08-31 | Lifecycle | Se eliminó `SUSPENDED` y la suspensión/reanudación como lifecycle durable. Busy, idle, proceso presente y proceso ausente son observaciones. |
| 0.5 | 2026-08-31 | WorkUnit | Se eliminó `generation`; el estado durable se redujo a `OPEN | COMPLETED | FAILED | CANCELLED`, con readiness/waits/verification/runtime como vistas derivadas. |
| 0.5 | 2026-08-31 | Ownership de Worker | `Assignment` y `Lease` se sustituyeron por un Worker binding único con `binding_revision` e idempotencia para rechazar writers stale. |
| 0.5 | 2026-08-31 | Scheduling y capacity | Scheduler completo, placement, fairness y capacity por sesiones residentes se retiraron del MVP hasta medir un bottleneck real. |
| 0.5 | 2026-08-31 | Integración Pi | Se adoptó `PiBridge`: extensión Pi + endpoint local de `a4sd` + protocolo bidireccional estructurado; Herdr conserva únicamente el hosting terminal. |
| 0.5 | 2026-08-31 | Worktree | Cada WorkUnit, no cada generation, posee exactamente un primary Worktree. |
| 0.5 | 2026-08-31 | MVP y preguntas abiertas | El primer experimento pasa a ser eliminar el PTY como protocolo. Las incógnitas inmediatas se convierten en PoCs de integración; suspensión, recovery, capacity y portabilidad se difieren. |
| 0.6 | 2026-08-31 | Frontera de integración | Se explicita que runtimes y harnesses son implementaciones consumidas por A4S mediante adapters: sus detalles pueden documentarse en perfiles concretos sin convertirse automáticamente en semántica del core. |
| 0.6 | 2026-08-31 | Perfil Pi | El comportamiento de Pi se separa de las decisiones normativas de A4S; `session_id/session_file`, eventos Pi y detalles de Herdr se etiquetan como parte del perfil de implementación Pi/Herdr. |
| 0.6 | 2026-08-31 | HarnessSession | Se elimina la política prematura sobre `/new`, `/resume`, `/fork` y `/clone`; A4S conserva una referencia nativa exacta sin gobernar capacidades internas del harness que no respondan a un requisito propio. |
| 0.6 | 2026-08-31 | Disciplina experimental | Las hipótesis materiales deben validarse mediante PoC antes de productizarse. Un PoC puede y, cuando sea razonable, debe ser ejecutable y usable; usable no implica production-ready ni descartable. |
| 0.7 | 2026-08-31 | Auditoría | Auditoría de v0.6: consistencia interna + verificación de los perfiles contra código primario (Pi 0.84.4, Herdr checkout 2026-08-28). El perfil Pi §4 quedó confirmado (10/11 claims con evidencia archivo:línea); cuatro huecos de borde se cierran en esta versión. |
| 0.7 | 2026-08-31 | Orchestrator | Se definieron las operaciones agent-facing del Orchestrator: la misma extensión sirve ambos roles y a4sd dicta el toolset según el owner adjuntado (`work.create`, `work.get/list`, `work.cancel`, `escalation.list/resolve`, `result.inspect`). |
| 0.7 | 2026-08-31 | Ownership | El Worker binding se generalizó a regla de owner-session binding: todo owner de Mailbox (WorkUnit u Orchestrator) tiene como máximo una HarnessSession vinculada actual con `binding_revision` monotónica. Cubre autorización de Deliveries y sucesión de Orchestrator. |
| 0.7 | 2026-08-31 | Verification | `acceptance_criteria` pasó de prosa a entradas estructuradas con `check` mecánico opcional definido por el Orchestrator al crear la WorkUnit. PASS mecánico requiere que todos los criterios tengan check; un criterio sin check exige decisión explícita del owner, reconciliando §28 con §39.1. |
| 0.7 | 2026-08-31 | Perfil Herdr | Se documentó la superficie de control de Herdr (socket + CLI: `pane split`, `agent start` con readiness, `pane process-info`, `events.subscribe`/`pane.exited`) y se formalizó `SessionLauncher` como componente del perfil Pi/Herdr. |
| 0.7 | 2026-08-31 | Perfil Pi | Ajustes de exactitud verificados contra 0.84.4: colas `steer`/`followUp` (nombres reales de API), eventos observables `auto_retry_start/end` y `compaction_start/end`, distinción `CustomEntry` (no llega al LLM) vs `CustomMessageEntry`, y caveat `assertActive` de `sendUserMessage` tras session switch/reload. |

---

# 1. Visión

A4S trata el desarrollo agentic como un problema de **coordinación durable de trabajo** y no como un problema de agentes enviándose texto mediante terminales.

Una unidad de trabajo —ticket, story, bugfix, refactor o investigación con deliverable— se representa como un `WorkUnit` durable.

El control plane mantiene:

- intención;
- ownership;
- dependencias;
- interacciones pendientes;
- resultados;
- verificación;
- auditabilidad.

Pi mantiene:

- la sesión conversacional nativa;
- los turns;
- ejecución de tools;
- retries internos;
- compaction;
- colas internas;
- subagentes y microdelegación.

Herdr mantiene la materialización terminal visible.

La extensión A4S para Pi reemplaza el PTY como canal de control y observación.

```text
                           HUMAN
                             │
                             ▼
                      ┌──────────────┐
                      │ ORCHESTRATOR │
                      │ durable actor│
                      └──────┬───────┘
                             │
                    semantic decisions
                             │
                             ▼
                  ┌────────────────────┐
                  │        a4sd        │
                  │                    │
                  │ work + ownership   │
                  │ mailbox/delivery   │
                  │ outcomes/evidence  │
                  └─────────┬──────────┘
                            │ structured protocol
                            ▼
                  ┌────────────────────┐
                  │  A4S Pi Extension  │
                  └─────────┬──────────┘
                            │ native Pi API/events
                            ▼
                         Pi session
                            │
                     Herdr terminal
```

---

# 2. Problema que A4S resuelve

El problema inmediato de Orca no es que mantenga sesiones ociosas ni que carezca de un scheduler equivalente a Kubernetes.

El problema inmediato es:

```text
control mediante PTY
+ entrega de instrucciones por texto
+ inferencia de estado desde terminal
+ correlación débil
+ outcomes no estructurados
```

A4S debe sustituirlo por:

```text
recursos durables
+ operaciones tipadas
+ deliveries correlacionadas
+ eventos nativos del harness
+ WorkResult estructurado
```

Mantener un pane o proceso Pi abierto e idle no se considera por sí mismo una falla ni un consumo de capacidad que deba reclamarse.

La suspensión de sesiones, reinicio automático, placement distribuido, leases temporales y capacity scheduling no forman parte del problema inicial hasta que exista evidencia operacional que los justifique.

---

# 3. Disciplina de diseño y evidencia

A4S distingue explícitamente cuatro categorías:

```text
DECISIÓN DE DISEÑO
  Regla normativa elegida para la arquitectura.

COMPORTAMIENTO DOCUMENTADO
  Propiedad respaldada por documentación o código primario del harness.

HIPÓTESIS
  Propiedad razonada pero todavía no observada en una integración A4S.

EVIDENCIA EXPERIMENTAL
  Resultado reproducible de un experimento/PoC ejecutado.
```

Reglas:

1. Una sección de diseño no constituye evidencia.
2. Un criterio de aceptación no constituye evidencia.
3. Una propiedad dependiente de un runtime/harness se valida mediante documentación primaria y, cuando afecta correctness, mediante PoC.
4. Una hipótesis material se valida mediante PoC antes de productizar la capacidad que depende de ella.
5. Un PoC puede ser ejecutable y usable; `usable` no implica `production-ready` ni obliga a descartar el código después del experimento.
6. Siempre que sea razonable, los PoCs del MVP deben ejercitar la capacidad real de extremo a extremo y producir un artefacto que pueda utilizarse para evaluarla.
7. Una optimización no se promueve a requisito `HARD` sin un bottleneck observado.
8. Una abstracción portable no se introduce antes de conocer al menos dos implementaciones reales o una necesidad inmediata del core.
9. La spec puede definir el experimento que falta, pero no declarar su resultado por anticipado.
10. Las capacidades de un runtime/harness no generan requisitos de A4S por sí mismas; primero debe existir una necesidad del producto y después se verifica cómo la satisface el adapter.

---

# 4. Perfil documentado de implementación: Pi

Esta sección registra comportamiento documentado de Pi relevante para implementar el adapter inicial. No define por sí misma semántica del core de A4S ni convierte capacidades de Pi en requisitos del producto.

Pi es un harness terminal interactivo cuya sesión y cuyo proceso son cosas diferentes.

## 4.1. Sesión nativa

Pi persiste las conversaciones como archivos JSONL con identidad propia y estructura de árbol.

Una sesión puede:

- continuar a través de múltiples turns;
- permanecer abierta sin actividad;
- cerrarse y volver a abrirse;
- ramificarse;
- compactarse;
- cambiar de modelo;
- conservar entradas de extensiones.

Pi permite abrir una sesión específica mediante:

```bash
pi --session <path|id>
```


## 4.2. Proceso terminal

Un proceso Pi interactivo alterna normalmente entre:

```text
idle
  ↓ prompt/input
busy
  ↓ agent_settled
idle
```

`busy` e `idle` son actividad actual, no estados durables del trabajo.

Un pane, PID o proceso puede estar presente o ausente sin que la sesión JSONL deje de existir.

## 4.3. Lifecycle interno

Pi posee:

- `agent_start`;
- turns;
- tool calls;
- auto-retry (eventos observables `auto_retry_start` / `auto_retry_end`);
- auto-compaction (eventos observables `compaction_start` / `compaction_end`);
- colas `steer` y `followUp` (nombres reales de la API; en memoria, no durables);
- `agent_settled`.

`agent_settled` significa que Pi no continuará automáticamente en ese momento. No significa:

- WorkUnit completada;
- resultado aceptado;
- sesión suspendida;
- proceso terminado;
- estado durable nuevo de A4S.

## 4.4. Extensión como integración

Las extensiones de Pi pueden:

- observar eventos nativos;
- conocer `session_id` y `session_file`;
- registrar tools (`registerTool`) y flags de CLI propios (`registerFlag`/`getFlag`);
- enviar mensajes de usuario que disparan turns (`sendUserMessage` en `ExtensionAPI`, con `deliverAs: steer | followUp`; requiere runtime activo — un contexto stale tras session switch/reload no puede enviar);
- persistir entradas propias (`CustomEntry` para estado puro — no llega al LLM; `CustomMessageEntry` para contenido que participa en el contexto);
- reaccionar a cambios de sesión (start/shutdown/switch/fork);
- conectarse con servicios externos.

Comportamiento verificado contra Pi 0.84.4 (2026-08-31): sesiones JSONL con id UUIDv7 en `~/.pi/agent/sessions/`, escritura per-entry con `appendFileSync` (tras un crash mid-turn solo se pierde la entry incompleta), `pi --session <path|id>` y `--extension <path>` por invocación.


Referencias primarias:

- [Pi — Sessions](https://pi.dev/docs/latest/sessions)
- [Pi — Session File Format](https://pi.dev/docs/latest/session-format)
- [Pi — Extensions](https://pi.dev/docs/latest/extensions)
- [`AgentSession` source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
- [`ExtensionContext` source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [`SessionManager` source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)

## 4.5. Perfil documentado: Herdr

Comportamiento verificado contra el código de Herdr (checkout 2026-08-28). Igual que el perfil Pi, no define semántica del core.

Herdr es daemon + clientes: el servidor posee panes, layout y procesos, y escucha en un Unix socket (`~/.herdr/socket` o `$HERDR_SOCKET_PATH`). La TUI es opcional; los panes siguen ejecutándose sin cliente adjunto.

Superficie de control relevante para A4S (CLI y socket API equivalentes):

```text
pane split <root> --cwd <path> --env K=V --no-focus
  → pane_id estable (w1:pN, nunca reusado)

agent start <name> --kind pi --pane <id> -- [args de pi]
  → lanza el agente y espera readiness (detección integrada)

pane process-info <id>
  → shell_pid + foreground_processes (poll)

events.subscribe {pane.exited}
  → push con exit al terminar el proceso
```

Límites conocidos:

- no existe kill API (solo `send-keys ctrl+c` u OS signal);
- `--env` solo aplica al crear el pane;
- los procesos mueren si el servidor Herdr reinicia;
- el exit code solo se obtiene vía evento.

Ninguno contradice el diseño: A4S no mata procesos por principio, el env es de lanzamiento, y la ausencia de proceso es observación, no failure (§39.2).

Herdr distribuye además una integración oficial Pi (`herdr integration install pi` → extensión `herdr-agent-state.ts`): el patrón "extensión Pi reporta a un daemon externo" que el PiBridge adopta ya existe en producción.

---

# 5. Hipótesis central

> Una plataforma local de desarrollo agentic mejora sustancialmente cuando separa el trabajo durable de la actividad efímera del harness, reemplaza la comunicación por PTY con un protocolo estructurado y deja al harness poseer su sesión nativa, sus turns y sus mecanismos internos.

Separaciones fundamentales:

```text
A4S control plane  → posee trabajo, ownership, interacciones y outcomes.
Orchestrators      → poseen decisiones y coordinación semántica.
WorkUnit           → posee el objetivo y accountability del trabajo.
HarnessSession     → vincula un owner de A4S con una ejecución/sesión nativa direccionable.
Pi                 → posee conversación, turns, tools, retries y compaction.
Herdr              → posee hosting terminal visible.
Subagents          → ejecutan trabajo delegado dentro del Worker.
```

---

# 6. Regla arquitectónica principal

> **A4S persiste compromisos; los adapters reportan hechos; los agentes toman decisiones.**

Regla de dependencia:

> **A4S define la semántica del workflow y consume runtimes/harnesses mediante contratos de integración. Un detalle interno de Pi, Claude, Herdr u otro backend sólo entra al core si existe un requisito independiente de A4S que lo necesite.**

Los perfiles de implementación pueden documentar detalles concretos necesarios para construir y operar el MVP; documentarlos no los convierte en abstracciones universales.

Ejemplo correcto:

```text
EscalationService:
  - persiste la solicitud;
  - la entrega al owner;
  - correlaciona la resolución;
  - entrega la respuesta al Worker.
```

Ejemplo incorrecto:

```text
EscalationService:
  - decide si REST o gRPC es mejor.
```

Ese juicio pertenece al Orchestrator.

Otro ejemplo correcto del perfil Pi/Herdr:

```text
PiBridge:
  - reporta agent_start;
  - reporta agent_settled;
  - adjunta session_id/session_file;
  - entrega una respuesta correlacionada.
```

Ejemplo incorrecto:

```text
PiBridge:
  - deduce que el ticket está terminado porque Pi quedó idle.
```

---

# 7. Planos de la arquitectura

## 7.1. Coordination Plane

Determinista y autoritativo únicamente para estado de A4S.

Incluye:

```text
API / durable store
Project / WorkGraph / WorkUnit
ownership y bindings
Mailbox / Delivery
Escalation / Proposal / Query / ToolCall
WorkResult / Verification
Event Journal
```

No contiene un LLM.

No intenta reflejar todo el lifecycle interno de Pi.

## 7.2. Agentic Plane

Contiene sesiones de agentes que aportan cognición:

```text
Orchestrator HarnessSessions
Worker HarnessSessions
native subagents
```

## 7.3. Terminal Runtime Plane

Implementa la presencia física visible:

```text
Herdr
terminal / PTY
Pi process
pane/workspace
OS processes
```

El terminal runtime no es canal autoritativo de comunicación.

## 7.4. Integration Boundary

La frontera de integración separa la semántica de A4S de los mecanismos concretos de ejecución. El core requiere sólo las capacidades necesarias para coordinar el workflow; cada adapter las traduce al runtime/harness correspondiente.

Contrato conceptual mínimo del corte actual:

```text
address/bind execution
send structured input
receive structured operations/results
report minimal observations
carry an opaque native reference when needed
```

Perfil inicial Pi/Herdr:

```text
PiBridge
  = A4S Pi Extension
  + endpoint local de a4sd
  + envelopes tipados
  + delivery acknowledgement
  + eventos nativos Pi
  + Herdr como host terminal
```

---

# 8. Modelo de recursos

Recursos first-class de v0.7:

```text
Project
Orchestrator
WorkGraph
WorkUnit
HarnessSession
Worktree
Mailbox
Delivery
Escalation
Proposal
Query
ToolCall
WorkResult
Verification
Event
```

Subentidades estructuradas:

```text
WorkUnit.worker_binding
WorkUnit.acceptance_criteria
HarnessSession.native_ref
HarnessSession.launch_spec
HarnessSession.last_observation
Verification.checks
```

No son recursos first-class en v0.7:

```text
AgentExecution
Continuation
Activation
Assignment
Lease
WorkUnit generation
Pi turn
Pi tool execution
Pi retry
Pi compaction
pane
PTY
PID
busy/idle state
native subagent
auxiliary worktree
```

Futuros sólo si aparece necesidad real:

```text
DispatchPolicy
ResourceBudget
Node
PlacementPolicy
Quota
Capability
SecretReference
```

---

# 9. Project

`Project` representa un dominio de ownership para trabajo de software.

```yaml
id: project-a
repo: github.com/example/project-a
default_branch: main
```

Sirve para:

- scope;
- ownership;
- WorkGraphs;
- WorkUnit provenance;
- Worktree provenance;
- comunicación cross-project.

---

# 10. Orchestrator

Un `Orchestrator` es un actor agentic durable encargado de decisiones y coordinación semántica dentro de un scope.

No forma parte del control plane.

## 10.1. Identidad

```yaml
id: orch-main

scope:
  type: global

mailbox_id: mb-orch-main
harness_session_id: HS-orch-main
enabled: true
```

La identidad del Orchestrator no es el pane ni el proceso Pi.

```text
Orchestrator orch-main
        │
        ├── Mailbox mb-orch-main
        │
        └── HarnessSession HS-orch-main
                   │
                   ├── native Pi session S-main
                   └── current process/pane observation
```

Si el proceso no está presente, el Orchestrator sigue existiendo como owner y destinatario durable.

## 10.2. Responsabilidades

El Orchestrator puede:

- conversar con el usuario;
- crear o modificar WorkGraphs/WorkUnits dentro de su autoridad;
- utilizar Superpowers, SDD, OpenSpec u otros planners;
- hacer replanning;
- interpretar resultados;
- resolver Escalations;
- decidir cuándo necesita input humano;
- crear ToolCalls permitidas;
- recibir y enviar Proposals;
- crear y responder Queries;
- coordinar otros Orchestrators;
- sintetizar estado;
- comunicar outcomes al usuario.

El Orchestrator no:

- interpreta actividad Pi como completion;
- muta recursos fuera de su autoridad;
- reemplaza la verificación autoritativa;
- mantiene leases;
- decide liveness por screen parsing;
- convierte un retry interno de Pi en un retry de WorkUnit.

---

# 11. Scope y autoridad

`Orchestrator` es una sola entidad con diferentes `scope`.

Scopes iniciales:

```yaml
scope:
  type: global
```

```yaml
scope:
  type: project
  project_id: project-a
```

No existen clases separadas `GlobalOrchestrator` y `ProjectOrchestrator`.

> `scope` define el límite máximo de visibilidad y autoridad; ownership explícito puede restringirlo aún más.

Inicialmente puede existir:

```text
Human
  ↕
orch-main
scope=global
```

Más adelante:

```text
                      Human
                        │
                        ▼
                    orch-main
                   scope=global
                        │
             ┌──────────┼──────────┐
             ▼          ▼          ▼
          orch-A     orch-B     orch-C
         project=A  project=B  project=C
```

Un scope más amplio no concede automáticamente derecho a saltarse a un owner especializado.

La semántica formal de delegación se difiere hasta la fase multi-scope.

---

# 12. Fronteras de ownership

1. Un recurso tiene un owner lógico.
2. Un Orchestrator sólo muta directamente recursos dentro de su autoridad.
3. Una WorkUnit tiene como máximo un Worker binding actual.
4. Cada WorkUnit posee exactamente un primary Worktree.
5. El primary Worktree no pertenece a Herdr ni a Pi.
6. La comunicación cross-scope no transfiere ownership.
7. El owner del scope destino conserva la decisión final.
8. Una sesión Pi no adquiere autoridad por existir; su binding determina qué puede mutar.
9. Reemplazar el Worker binding invalida writes posteriores del binding anterior.
10. Un nuevo turn, retry de proveedor o auto-compaction no cambia ownership ni identidad de WorkUnit.

---

# 13. Human ingress

A4S expone una única interfaz agentic humana por defecto:

```text
Human ↔ Orchestrator
```

Nunca:

```text
Human ↔ Worker
Human ↔ Subagent
```

Aunque existan múltiples Orchestrators internos, la UX puede seguir siendo:

```text
Human ↔ orch-main
```

La existencia de panes visibles para Workers no los convierte en interfaces humanas soportadas.

---

# 14. WorkGraph y WorkUnit

`WorkGraph` representa relaciones entre unidades de trabajo.

```text
W1 ──► W3
W2 ──► W3
W3 ──► W4
```

`WorkUnit` es la unidad mínima de ownership y accountability durable.

No representa:

- cada turn de Pi;
- cada retry interno;
- cada tool call;
- cada subtarea cognitiva;
- cada subagente.

## 14.1. Esquema conceptual

```yaml
id: W42
project_id: project-a

title: Refresh token rotation

objective: >
  Implementar rotación de refresh tokens manteniendo
  compatibilidad con clientes existentes.

dependencies:
  - W17

acceptance_criteria:
  - text: existing auth tests pass
    check:
      command: go test ./internal/auth/...
      exit_code: 0
  - text: new rotation tests pass
    check:
      command: go test ./internal/auth/rotation/...
      exit_code: 0
  - text: no plaintext refresh token persistence
    check: null   # no mecanizable; requiere decisión explícita del owner

status: OPEN

worktree_id: WT42

worker_binding:
  harness_session_id: HS-W42
  revision: 1

constraints:
  harness:
    preferred:
      - pi
```

Cada criterio es una entrada estructurada: `text` (intención legible) y `check` opcional (comando + exit code esperado, ejecutado en el primary Worktree). La traducción de intención a check es juicio semántico y pertenece al Orchestrator en el momento de crear o modificar la WorkUnit (§6: los agentes deciden, el plane persiste y ejecuta). Un criterio con `check: null` no es verificable mecánicamente; ver §28.1.

## 14.2. Estado durable mínimo

Estados persistidos:

```text
OPEN
COMPLETED
FAILED
CANCELLED
```

Semántica:

- `OPEN`: todavía puede recibir trabajo, feedback o resultados.
- `COMPLETED`: existe Verification aceptada para un WorkResult.
- `FAILED`: un owner autorizado cerró el trabajo como failure explícita.
- `CANCELLED`: el owner canceló el objetivo.

No se persisten como estados de WorkUnit:

```text
PENDING
READY
ASSIGNED
STARTING
RUNNING
WAITING_ESCALATION
WAITING_TOOL
VERIFYING
RETRY_WAIT
UNKNOWN
```

Esas palabras pueden existir como vistas derivadas, no como una segunda verdad.

---

# 15. Vistas derivadas de WorkUnit

El core expone facetas independientes.

```yaml
view:
  readiness: READY          # BLOCKED | READY
  worker: BOUND             # UNBOUND | BOUND
  waits:
    escalation: 1
    tool_call: 0
  verification: NONE        # NONE | PENDING | PASSED | FAILED
  runtime:
    connection: CONNECTED   # CONNECTED | DISCONNECTED | UNKNOWN
    activity: IDLE          # BUSY | IDLE | UNKNOWN
```

Las facetas se calculan desde recursos y observaciones:

```text
readiness
  ← dependencies + WorkUnit.status

worker
  ← current worker_binding

waits
  ← Escalations/ToolCalls pendientes

verification
  ← WorkResults + Verifications

runtime/activity
  ← PiBridge + Herdr observations
```

Una UI puede sintetizar etiquetas como:

```text
BLOCKED
READY
WORKING
WAITING
VERIFYING
OFFLINE
```

pero esas etiquetas no son el lifecycle autoritativo del trabajo.

Ventajas:

- evita duplicar hechos;
- evita estados combinatorios;
- localiza `Unknown` en la observación incierta;
- permite que Pi cambie `busy ↔ idle` muchas veces sin mutar la WorkUnit.

---

# 16. Owner-session binding

Regla general:

> Todo owner de Mailbox —WorkUnit u Orchestrator— tiene como máximo una HarnessSession vinculada actual, con una `binding_revision` monotónica. Reemplazar la sesión vinculada incrementa la revisión; los writes y claims de revisiones anteriores son stale.

`WorkUnit.worker_binding` es la instancia Worker de esta regla. El Orchestrator tiene el binding equivalente sobre su propia HarnessSession (§10.1): reemplazarla —sesión corrupta, rebind deliberado, sucesión— incrementa su revisión con la misma semántica de fencing. No se introduce un mecanismo separado.

## 16.0. Worker binding

Una WorkUnit puede tener como máximo un Worker binding actual.

```yaml
worker_binding:
  harness_session_id: HS-W42
  revision: 3
  bound_at: ...
  bound_by: orch-main
```

## 16.1. Binding revision

Toda mutación agent-facing que pueda cerrar, escalar o alterar la WorkUnit incluye:

```text
work_unit_id
binding_revision
idempotency_key
```

Si el Worker es reemplazado, `binding_revision` aumenta.

Writes tardíos con una revisión anterior se registran para auditoría y se rechazan como stale.

Esto sustituye:

- WorkUnit generations;
- activation fencing;
- leases temporales.

## 16.2. Iteración normal

Permanecen dentro de la misma WorkUnit y binding:

- múltiples turns;
- correcciones después de feedback;
- provider retries;
- auto-compaction;
- reintentos de tools internos;
- uso de subagentes;
- varias submissions de WorkResult.

Si el owner decide abandonar por completo el intento y empezar un trabajo independiente, crea otra WorkUnit y puede relacionarla mediante:

```yaml
supersedes: W42
```

No se crea automáticamente una “generation”.

---

# 17. HarnessSession

`HarnessSession` es el recurso de A4S que vincula un owner durable con una ejecución/sesión nativa direccionable de un harness.

No es una abstracción de Pod, proceso o job y no intenta modelar el lifecycle interno del harness.

Puede pertenecer a:

- un Orchestrator;
- una WorkUnit como Worker.

Ejemplo del perfil Pi/Herdr:

```yaml
id: HS-W42

owner:
  kind: work_unit
  id: W42

role: worker
harness: pi

native_ref:
  session_id: 019...
  session_file: /home/.../.pi/agent/sessions/...jsonl

launch_spec:
  runtime: herdr
  cwd_from_worktree: WT42
  extension: a4s-pi-bridge

last_observation:
  connection: connected
  process: present
  activity: idle
  observed_at: ...
```

## 17.1. Qué posee A4S

A4S posee:

- el ID del `HarnessSession`;
- su owner;
- su role;
- el binding actual;
- la referencia nativa exacta reportada;
- el mailbox que puede consumir;
- launch metadata;
- última observación diagnóstica.

## 17.2. Qué posee Pi

Pi posee:

- formato JSONL;
- árbol de conversación;
- entradas;
- compaction;
- model state;
- turns;
- queues;
- tool lifecycle;
- retry behavior;
- comandos para abrir la sesión.

## 17.3. Qué no significa HarnessSession

No significa:

```text
proceso presente
turn activo
agent busy
sesión “suspendida”
workload accepted
WorkUnit completada
```

## 17.4. Referencia nativa

A4S conserva una referencia nativa exacta y direccionable cuando el adapter la necesita para identificar la ejecución vinculada. El core la trata como dato opaco del adapter: no interpreta su formato ni deriva de ella semántica del workflow.

No es aceptable identificar una ejecución mediante heurísticas ambiguas como “la última” o “la más reciente” cuando el adapter puede proporcionar una referencia exacta.

En el perfil Pi, la extensión puede reportar `session_id` y `session_file`; éstos son detalles del perfil Pi, no campos universales requeridos a todo harness.

`native_ref` puede estar vacío entre la creación del recurso y el primer attach. Una vez observado, se conserva como provenance del binding.

El binding actual del owner (§16) es la fuente autoritativa de `binding_revision` —`WorkUnit.worker_binding` en el caso Worker, el binding del Orchestrator en el suyo—; el valor se entrega al adapter al lanzar/adjuntar la ejecución y se valida en cada operación mutante.

---

# 18. Observaciones de runtime y actividad

`RuntimeObservation` no es un lifecycle durable. Es una lectura acotada de la realidad actual o última conocida.

Catálogo inicial:

```yaml
connection: CONNECTED | DISCONNECTED | UNKNOWN
process: PRESENT | ABSENT | UNKNOWN
activity: BUSY | IDLE | UNKNOWN
last_native_event: opaque
observed_at: ...
runtime_ref: opaque
```

El core consume estas observaciones sin conocer cómo las obtiene cada implementación.

Perfil Pi/Herdr:

```text
connection  ← Pi Extension attach/heartbeat
process     ← Herdr/process observation
activity    ← agent_start / agent_settled y eventos Pi
```

Reglas:

1. `IDLE` no significa suspensión.
2. `ABSENT` no significa WorkUnit failed.
3. `DISCONNECTED` no significa que el proceso haya muerto.
4. `UNKNOWN` sólo califica la observación correspondiente.
5. La última observación puede persistirse para diagnóstico, pero no se trata como verdad actual indefinida.
6. `agent_settled` no concede completion authority.

---

# 19. PiBridge — perfil inicial Pi/Herdr

`PiBridge` es la implementación concreta inicial de la Integration Boundary para Pi + Herdr. Sus mecanismos específicos pertenecen a este perfil y no definen por sí mismos el contrato universal de futuros adapters.

Está compuesto por:

```text
A4S Pi Extension
+ endpoint local de a4sd
+ protocolo de envelopes
+ coordinación de lanzamiento Herdr
```

## 19.1. Responsabilidades de la extensión

La extensión:

- se adjunta a `a4sd` con owner y binding revision;
- reporta `session_id` y `session_file`;
- reporta eventos nativos relevantes;
- mantiene los handlers de lifecycle acotados y evita bloquear el loop de Pi con I/O indefinido;
- registra tools A4S;
- obtiene WorkUnit payloads estructurados;
- crea Escalations/Queries/Proposals/ToolCalls permitidos;
- entrega WorkResults estructurados;
- recibe Deliveries pendientes;
- usa APIs de Pi para insertar input;
- confirma recepción/procesamiento según protocolo;
- nunca usa screen parsing para determinar outcomes.

## 19.2. Responsabilidades de a4sd

`a4sd`:

- valida el binding;
- persiste operaciones;
- aplica idempotencia;
- enruta Deliveries;
- registra Event Journal;
- rechaza writes stale;
- expone el workload completo;
- conserva correlación;
- nunca interpreta texto renderizado como completion.

## 19.3. Responsabilidades de Herdr

Herdr:

- crea y muestra el terminal;
- inicia Pi con cwd y extensión configurados;
- conserva el pane según su comportamiento normal;
- permite observación e intervención operacional.

Herdr no:

- entrega payloads autoritativos;
- confirma aceptación de WorkUnits;
- almacena outcomes;
- decide waits;
- decide completion.

## 19.4. Operaciones agent-facing mínimas

La misma extensión sirve ambos roles. El owner llega a la extensión en el lanzamiento (flags propios vía `registerFlag`, p.ej. `--a4s-owner`, o env del pane); el attach a `a4sd` confirma la identidad y a4sd dicta qué toolset se registra. La extensión no decide su propio rol.

Toolset `role=worker`:

```text
work.get
escalation.create
result.submit
```

Toolset `role=orchestrator`:

```text
work.create
work.get
work.list
work.cancel
escalation.list
escalation.resolve
result.inspect
```

Tools posteriores, según role y fase:

```text
query.create
proposal.create
tool.call
```

Operaciones internas de transporte —como attach, heartbeat, claim y `delivery.ack`— pertenecen a la extensión y no dependen de que el LLM decida invocarlas.

## 19.5. Deliveries hacia Pi

Tipos iniciales:

```text
work.kickoff
escalation.resolved
verification.feedback
operator.note
query.answered
proposal.outcome
```

La extensión transforma una Delivery válida en input nativo mediante `sendUserMessage` de la `ExtensionAPI` de Pi (dispara siempre un turn; `deliverAs: steer | followUp` cuando el agente está streaming), sin escribir al PTY. Requiere runtime activo: tras un session switch/reload el contexto anterior queda stale y la extensión debe operar desde el contexto vigente. Para inyectar contenido que participe en el contexto del modelo se usa `CustomMessageEntry`; `CustomEntry` es solo estado persistido.

El payload durable vive en A4S. El mensaje enviado al modelo puede contener una referencia breve e instrucciones para obtenerlo mediante tool.

## 19.6. Eventos de observación

Eventos iniciales candidatos:

```text
session.attached
session.detached
session.native_ref_observed
agent.started
agent.settled
turn.started
turn.ended
tool.started
tool.ended
```

Sólo los necesarios para la UX y diagnóstico se almacenan. No todo evento de tokens o streaming se convierte en evento durable de dominio.

## 19.7. Transporte

La semántica requerida es:

- comunicación local;
- bidireccional;
- envelopes tipados;
- correlation ID;
- idempotency key;
- acknowledgement;
- reconexión;
- entrega durable desde mailbox.

El transporte concreto —Unix socket, HTTP local, WebSocket u otro— se selecciona mediante PoC.

## 19.8. MCP

MCP no es requisito del PiBridge.

Puede utilizarse posteriormente como una superficie alternativa para tools agent-facing, pero:

- no sustituye los eventos nativos de la extensión;
- no sustituye el canal inbound hacia Pi;
- no es necesario para eliminar la dependencia del PTY.

---

# 20. Worker y subagentes

`Worker` es el rol de una `HarnessSession` vinculada a una WorkUnit.

```text
WorkUnit W42
      │
      ├── Worktree WT42
      └── HarnessSession HS-W42
             role=worker
             harness=pi
```

El Worker:

- obtiene la WorkUnit mediante operación estructurada;
- mantiene contexto en su sesión Pi;
- decide cómo ejecutar el objetivo;
- puede utilizar un framework SDD;
- puede despachar subagentes;
- integra o valida su trabajo;
- produce Escalations;
- produce uno o más WorkResults;
- es accountable por el resultado.

## 20.1. Subagentes

Los subagentes son implementación interna del Worker.

```text
Worker
   ├── implementer
   ├── tester
   ├── debugger
   ├── reviewer
   └── scout
```

Pueden, según política:

- leer;
- escribir;
- editar;
- ejecutar shell;
- ejecutar tests;
- usar Git;
- crear commits;
- implementar una unidad completa;
- crear worktrees auxiliares;
- revisar o corregir trabajo.

> **Ownership significa accountability, no authorship.**

El subagente no adquiere autoridad frente al control plane global.

---

# 21. Worktree

`Worktree` es un recurso first-class del control plane.

A4S posee:

- identidad;
- owner;
- base revision;
- branch;
- desired presence;
- lifecycle de filesystem;
- condiciones observadas del worktree.

Un `WorktreeProvider` realiza las operaciones concretas.

```yaml
id: WT42

owner:
  work_unit_id: W42

spec:
  base_revision: a81f...
  branch: a4s/W42

provider: git

status:
  path: /...
  head: ...
```

## 21.1. Regla principal

> Cada WorkUnit posee exactamente un primary Worktree.

Todos los turns y bindings sucesivos de la misma WorkUnit utilizan el mismo primary Worktree por defecto.

```text
W42
  ├── WT42
  ├── HS-W42 binding revision 1
  └── HS-W42b binding revision 2
```

Si se crea una WorkUnit independiente que supersede a W42, recibe su propio primary Worktree.

## 21.2. Worktrees auxiliares

Workers y subagentes pueden crear worktrees auxiliares.

A4S v0.x no los modela como recursos globales.

El Worker sigue siendo accountable por el estado final del primary Worktree.

---

# 22. WorktreeProvider

El control plane posee el desired state del filesystem; el provider posee mechanics.

Contrato conceptual:

```text
EnsureWorktree(spec)
ObserveWorktree(ref)
LockWorktree(ref)
RemoveWorktree(ref)
RepairWorktree(ref)
```

Implementaciones posibles:

```text
Git worktree
Treehouse
```

El Worktree no depende del pane ni del proceso Pi.

---

# 23. Mailbox y Delivery

Un `Mailbox` pertenece a una identidad durable:

- Orchestrator; o
- WorkUnit.

```yaml
id: mb-W42
owner:
  kind: work_unit
  id: W42
```

La `HarnessSession` actualmente vinculada consume Deliveries de su owner. El claim y el acknowledgement exigen la `binding_revision` vigente del owner (§16), sea WorkUnit u Orchestrator.

A4S no modela `Message` como entidad first-class genérica.

La primitiva de transporte durable es `Delivery`.

```yaml
id: D88

destination:
  mailbox_id: mb-W42

resource_ref:
  kind: escalation
  id: E42

event: escalation.resolved
sequence: 184
status: pending
```

Lifecycle mínimo:

```text
PENDING
  ↓ claimed by current binding
DELIVERED
  ↓ extension acknowledgement
ACKNOWLEDGED
```

Una Delivery acknowledged no implica que el recurso referenciado esté resuelto ni que Pi haya producido un turn exitoso.

```text
Delivery D88 = ACKNOWLEDGED
WorkUnit W42 = OPEN
```

Si no existe proceso o extensión conectada, la Delivery permanece pendiente.

Esto permite comunicación estructurada sin requerir que la sesión esté siempre presente.

---

# 24. Escalation

Un Worker nunca solicita directamente input humano.

```yaml
id: E42

source:
  harness_session_id: HS-W42
  work_unit_id: W42
  binding_revision: 3

owner:
  orchestrator: orch-A

reason: architecture_decision
status: PENDING
```

Flujo:

```text
Worker
  ↓ structured tool
Escalation
  ↓ Delivery
Orchestrator
   ├── resolve itself
   ├── consult tool/agent
   ├── send Proposal/Query
   └── request Human-as-Tool
```

Lifecycle:

```text
PENDING
  ├── RESOLVED
  ├── REJECTED
  └── CANCELLED
```

## 24.1. Espera natural

Después de crear la Escalation:

```text
Worker turn ends
  ↓
Pi emits agent_settled
  ↓
Pi remains open and idle
```

A4S no cambia la WorkUnit a un estado durable `WAITING_ESCALATION` ni destruye el proceso.

La vista `waits.escalation > 0` se deriva de la Escalation pendiente.

Cuando se resuelve:

```text
Escalation RESOLVED
  ↓
Delivery to mb-W42
  ↓
current Pi extension receives it
  ↓
Pi input API triggers next turn
```

---

# 25. Human-as-Tool y ToolCall

Human-as-Tool se encuentra detrás del Orchestrator.

Incorrecto:

```text
Worker → Human
```

Correcto:

```text
Worker
  ↓
Escalation
  ↓
Orchestrator
  ↓
ToolCall(provider=human)
  ↓
Human
```

`ToolCall` modela una operación durable externa.

Providers iniciales/conceptuales:

```text
human
service
MCP
external_agent
external_process
```

Los subagentes nativos del Worker no se convierten automáticamente en ToolCalls de A4S.

---

# 26. Proposal

`Proposal` representa una solicitud cross-scope para que otro Orchestrator considere realizar una acción dentro de su propio ownership domain.

```text
Orchestrator A
      │
      ▼
Proposal P42
      │
      ▼
Orchestrator B
```

A no puede crear directamente una WorkUnit en B.

Lifecycle:

```text
PENDING
  ├── REJECTED
  └── ACCEPTED
         │
         │ verified work outcome
         ▼
      FULFILLED
```

`ACCEPTED` no significa implementado.

Una Proposal aceptada puede referenciar:

```yaml
execution:
  work_unit_ref: B-17
```

El lifecycle de `B-17` no se duplica dentro de la Proposal.

## 26.1. Outcome

`FULFILLED` puede incluir consecuencias relevantes:

```yaml
outcome:
  summary: Fixed the reported parser defect.

  changes:
    - kind: api_contract
      component: parser
      compatibility:
        breaking: true
      evidence:
        - artifact://contracts/parser-v3
```

El Orchestrator originador decide si necesita crear trabajo dentro de su propio scope.

---

# 27. Query

`Query` representa una solicitud de información entre Orchestrators peers.

```yaml
id: Q12

source:
  orchestrator: orch-A

target:
  orchestrator: orch-B

question: >
  ¿La versión 2.x también presenta el problema?

status: PENDING
```

Lifecycle:

```text
PENDING
  ├── ANSWERED
  ├── REJECTED
  └── CANCELLED
```

La respuesta semántica pertenece al Orchestrator destino.

A4S limita intencionalmente la comunicación cross-scope a recursos tipados; no introduce conversación libre como primitive first-class.

---

# 28. WorkResult y Verification

El Worker propone un resultado mediante una operación estructurada.

```json
{
  "id": "WR-42-2",
  "work_unit_id": "W42",
  "binding_revision": 3,
  "revision": "abc123",
  "tests": [
    {
      "command": "go test ./...",
      "exit_code": 0
    }
  ],
  "artifacts": [],
  "followups": [],
  "summary": "Implemented refresh token rotation."
}
```

El WorkResult no incluye autoridad para cerrar la WorkUnit.

```text
WorkResult SUBMITTED
  ↓
Verification PENDING
  ├── PASS  → WorkUnit COMPLETED
  └── FAIL  → WorkUnit remains OPEN
```

Una WorkUnit puede recibir varios WorkResults.

Una failure de Verification puede producir:

- feedback al mismo Worker;
- una Escalation al Orchestrator;
- cierre explícito como FAILED;
- creación de otra WorkUnit que supersede a la actual.

No produce automáticamente:

- retry controller;
- new generation;
- new lease;
- new worktree.

## 28.1. Verification inicial

Para el primer corte:

```text
mechanical verification
```

El Verification Service ejecuta los `check` declarados en `acceptance_criteria` (§14.1) dentro del primary Worktree. No inventa comandos ni interpreta la intención: solo ejecuta lo que la WorkUnit declara.

Reglas:

1. PASS mecánico requiere que **todos** los criterios tengan `check` y todos pasen.
2. Un criterio con `check: null` impide el PASS mecánico: la Verification queda `PENDING` y la decisión escala al Orchestrator owner.
3. Esto instancia §39.1: el outcome terminal automático (PASS → COMPLETED) solo ocurre bajo la política "criterios 100 % mecanizados"; en cualquier otro caso el cierre es decisión explícita del owner.

Ejemplos de checks:

- revision existe;
- comandos declarados terminan con exit code esperado;
- archivos requeridos existen;
- tests definidos pasan;
- working tree cumple política conocida.

Posteriormente, si existe necesidad:

```text
policy verification
semantic verification
reviewer agent attestations
```

---

# 29. Dispatch y scheduling

A4S v0.7 no necesita un scheduler equivalente a Kubernetes para el primer corte.

El flujo inicial puede ser explícito:

```text
Orchestrator selects WorkUnit
  ↓
ensure primary Worktree
  ↓
create/bind HarnessSession
  ↓
launch Pi in Herdr
```

Cuando exista concurrencia suficiente para necesitar automatización, puede añadirse un `Dispatcher` determinista que use:

- dependencies satisfechas;
- priority;
- ausencia de Worker binding;
- política simple de concurrencia;
- harness disponible.

No se introducen inicialmente:

```text
Assignment resource
Lease resource
placement
fairness policy
retry admission
capacity by resident sessions
```

## 29.1. Capacity

No se asume que una sesión Pi idle consuma capacidad significativa.

Antes de modelar capacity se medirá cuál recurso es realmente escaso:

- provider concurrent requests;
- rate limits;
- tokens/costo;
- CPU de tools;
- memoria por proceso;
- subagentes concurrentes;
- file/worktree contention.

Sólo después se elige la unidad de presupuesto correcta.

---

# 30. Componentes y reconciliation

A4S no crea un controller por cada sustantivo.

Se utiliza un loop de reconciliation sólo cuando existe desired state que debe converger continuamente.

Componentes iniciales:

## 30.1. API / Durable Store

Posee recursos, transacciones, resource versions e idempotency.

## 30.2. PiBridge Service

Gestiona:

- attach/detach de extensiones;
- binding validation;
- envelopes;
- inbound deliveries;
- lifecycle observations;
- worker tools;
- session native refs.

## 30.3. WorkUnit Service

Gestiona:

- creación y actualización;
- dependencies;
- binding revision;
- terminal outcomes;
- derivación de vistas;
- correlation con WorkResult/Verification.

No interpreta código ni texto del terminal.

## 30.4. Worktree Reconciler

Es uno de los pocos reconcilers claros porque existe:

```text
desired Worktree present
vs
observed filesystem state
```

Utiliza `WorktreeProvider`.

## 30.5. Delivery Service

Gestiona:

- durable enqueue;
- ordering por mailbox;
- deduplication;
- claim por binding actual;
- acknowledgement;
- redelivery;
- correlation.

## 30.6. Interaction Services

Gestionan lifecycles de:

- Escalation;
- Proposal;
- Query;
- ToolCall.

No toman decisiones semánticas.

## 30.7. Verification Service

Ejecuta/agrega checks y emite un resultado autoritativo.

## 30.8. SessionLauncher (perfil Pi/Herdr)

Materializa el lanzamiento de una HarnessSession en el runtime terminal. En el perfil inicial:

```text
1. pane split <root> --cwd <primary worktree> --env <owner metadata> --no-focus
     → pane_id (runtime_ref opaco)
2. agent start <hs-id> --kind pi --pane <pane_id>
     -- --session <native_ref cuando reabre> --extension a4s-pi-bridge
     → readiness detectada por Herdr
3. events.subscribe pane.exited + pane process-info
     → RuntimeObservation.process (§18)
```

Es un componente del perfil, no un contrato portable: se abstraerá sólo cuando exista un segundo terminal runtime real (§3, regla 8).

## 30.9. Dispatcher opcional

Se introduce sólo en la fase multi-worker.

No existe `AgentExecutionController`, `OrchestratorController` de procesos, scheduler de placements ni LeaseController en v0.7.

---

# 31. Event Journal, telemetría y evidencia

Cambios significativos de dominio producen eventos durables:

```text
work.created
work.bound
work.result_submitted
work.completed
work.failed
work.cancelled
worktree.created
escalation.created
escalation.resolved
proposal.fulfilled
query.answered
delivery.acknowledged
```

Eventos de Pi pueden registrarse selectivamente como observaciones:

```text
session.attached
session.detached
agent.started
agent.settled
```

No todo evento de streaming pertenece al Event Journal de dominio.

## 31.1. Evidence hierarchy

Orden inicial de fuerza:

```text
1. Durable A4S protocol operation
2. Verified external/mechanical evidence
3. Pi extension native lifecycle event
4. Herdr/process observation
5. PTY observation
6. Rendered terminal text
```

Reglas:

- evidencia débil no se promociona silenciosamente;
- `agent_settled` prueba actividad idle, no completion;
- `PTY write succeeded` no prueba delivery ni aceptación;
- texto que dice “done” no prueba WorkResult;
- WorkResult submitted no prueba Verification passed.

Observabilidad puede derivar:

```text
logs
metrics
traces
audit views
dashboards
alerts
```

---

# 32. Terminal como UI y host, no como protocolo

El terminal sirve para:

- experiencia interactiva visible;
- operación manual excepcional;
- observación auxiliar;
- debugging;
- hosting del proceso Pi mediante Herdr.

El usuario sí puede conversar con el Orchestrator mediante la TUI nativa. La prohibición se aplica a la coordinación **machine-to-agent** de A4S.

No sirve como:

- store durable de instrucciones;
- mecanismo de entrega autoritativo;
- API de resultados;
- detector de completion;
- fuente primaria de lifecycle;
- cola de mensajes.

Preferencia:

```text
A4S store:
  WorkUnit W42 = full payload

Pi Extension:
  work.get(W42)
```

No:

```text
paste 10 KB into terminal
assume delivery
parse screen for answer
```

---

# 33. `a4sctl`

`a4sctl` es el cliente operacional del control plane.

Ejemplos:

```bash
a4sctl get workunits
a4sctl get worktrees
a4sctl get harnesssessions
a4sctl get orchestrators
a4sctl get proposals
a4sctl get queries
a4sctl get escalations

a4sctl describe workunit W42
a4sctl describe worktree WT42
a4sctl describe harnesssession HS-W42
a4sctl describe orchestrator orch-A
```

Operaciones administrativas provisionales:

```bash
a4sctl work create -f work.yaml
a4sctl work bind W42 --harness pi
a4sctl work cancel W42

a4sctl session launch HS-W42
a4sctl session observe HS-W42

a4sctl escalation resolve E42 -f answer.json
```

La interfaz agent-facing normal es el PiBridge, no shelling out a `a4sctl` ni paste al terminal.

El protocolo autoritativo puede implementarse mediante socket/API local; la CLI es un cliente.

---

# 34. Planner y SDD

A4S no impone un planner.

El Orchestrator puede utilizar:

- Superpowers;
- skills SDD;
- OpenSpec;
- skills de terceros;
- planning propio del harness;
- planning humano.

El resultado esperado puede expresarse como un IR común:

```yaml
work_units:
  - id: W1
    objective: ...
    dependencies: []

  - id: W2
    objective: ...
    dependencies:
      - W1
```

A4S no modela los pasos cognitivos internos del planner como WorkUnits salvo que tengan ownership y deliverable independientes.

---

# 35. Flujo completo: ejecución normal

```text
Human
  ↓
Orchestrator session
  ↓ structured operation
WorkUnit W1 created
  ↓
Worktree WT1 ensured
  ↓
HarnessSession HS-W1 bound
  ↓
Herdr launches Pi + A4S extension
  ↓
extension attaches and reports exact native session
  ↓
Delivery work.kickoff
  ↓
extension triggers Pi input without PTY
  ↓
Worker calls work.get(W1)
  ↓
Pi turns/tools/subagents
  ↓
Worker calls result.submit(WR1)
  ↓
Verification
  ↓ PASS
WorkUnit COMPLETED
  ↓ Delivery
Orchestrator
  ↓
Human
```

Durante el flujo Pi puede cambiar muchas veces entre `busy` e `idle` sin que eso cree nuevas entidades o estados durables de ejecución.

---

# 36. Flujo completo: Escalation y espera

```text
Worker Pi session BUSY
  ↓
escalation.create(E42)
  ↓
Escalation PENDING
  ↓ Delivery
Orchestrator receives E42
  ↓
Worker finishes current turn
  ↓
agent_settled
  ↓
Pi process remains open and IDLE

... decision occurs ...

Escalation RESOLVED
  ↓
Delivery D88 pending for mb-W42
  ↓
Pi extension claims D88
  ↓
extension injects correlated input
  ↓
Pi starts another turn
  ↓
Worker continues same WorkUnit and Worktree
```

No existe:

```text
SUSPENDED state
safe suspension protocol
Activation destruction
resume state machine
new WorkUnit generation
```

---

# 37. Flujo completo: proceso no presente

```text
HarnessSession HS-W42
  native Pi session S123 exists

Herdr/process observation:
  process = ABSENT
```

Esto produce una vista operacional, no un outcome.

Si llega una Delivery o el owner decide continuar:

```text
SessionLauncher
  ↓
Herdr launches:
  pi --session <exact S123> + A4S extension
  ↓
extension attaches
  ↓
pending Delivery is consumed
```

Este comportamiento se denomina **reapertura de sesión**, no un estado durable `RECOVERY`.

En v0.7:

- la referencia exacta se conserva;
- la reapertura limpia es una capability a validar;
- la reapertura automática no es requisito del primer corte;
- un crash durante un turn no dispara retry automático;
- el efecto real de un crash mid-turn se determina mediante PoC.

---

# 38. Flujo completo: bug cross-project

```text
Worker A
  ↓
Escalation/Finding
  ↓
Orchestrator A
  ↓
Proposal(kind=bug_report)
  ↓
Orchestrator B
   ├── reject
   └── accept
        ↓
      create WorkUnit B-17
        ↓
      verified completion
        ↓
      Proposal FULFILLED
        ↓
      outcome delivered to A
```

Project A nunca muta directamente el WorkGraph de B.

---

# 39. Failure semantics

A4S distingue tres dominios.

## 39.1. Work failure

Sólo ocurre mediante un hecho explícito:

- una Verification produce un outcome terminal únicamente si una política ya definida lo autoriza; o
- un owner autorizado cierra la WorkUnit como `FAILED`.

Por defecto, una Verification fallida mantiene la WorkUnit `OPEN` y produce feedback o escalación.

## 39.2. Runtime absence

Ejemplos:

```text
Pi extension disconnected
Herdr unreachable
pane absent
process absent
```

No significan:

```text
WorkUnit FAILED
Worker result invalid
new attempt required
```

## 39.3. Observation unknown

`Unknown` pertenece al campo incierto:

```yaml
runtime:
  process: UNKNOWN
```

No existe:

```text
WorkUnit.status = UNKNOWN
```

## 39.4. Mid-turn interruption

Si Pi desaparece durante un turn:

- A4S registra la última evidencia conocida;
- no asume si una tool externa fue aplicada;
- no relanza automáticamente el mismo input;
- el Orchestrator u operador decide después de inspección;
- el comportamiento se endurece sólo tras experimentos concretos.

---

# 40. Concurrencia e idempotencia

Aunque v0.7 es local y simple, el protocolo debe evitar duplicaciones básicas.

Toda operación durable incluye:

```text
request_id / idempotency_key
source owner
binding_revision
correlation_id cuando aplique
```

Reglas:

1. Repetir la misma request idempotente devuelve el mismo resultado lógico.
2. Un binding stale no puede cerrar ni escalar una WorkUnit.
3. Una Delivery sólo puede ser acknowledged por el binding actual autorizado.
4. La pérdida de conexión antes del ACK permite redelivery.
5. La redelivery no duplica la operación de dominio correlacionada.
6. No se requieren leases temporales para estas garantías en una máquina local.

---

# 41. Invariantes v0.7

1. A4S es fuente de verdad para trabajo, ownership, interacciones y outcomes.
2. Pi es fuente de verdad para su sesión nativa y lifecycle interno.
3. Herdr es host terminal, no protocolo.
4. El PTY nunca es el canal autoritativo de control.
5. El Orchestrator es un actor agentic, no parte del control plane.
6. El usuario interactúa únicamente con un Orchestrator.
7. Workers y subagentes nunca solicitan interacción humana directa.
8. Toda necesidad humana de un Worker escala primero al Orchestrator owner.
9. `scope` define el máximo límite de autoridad; ownership puede restringirlo.
10. Un Orchestrator no muta directamente un scope perteneciente a otro owner.
11. Cross-scope change se solicita mediante `Proposal`.
12. Cross-scope information se solicita mediante `Query`.
13. Una WorkUnit tiene como máximo un Worker binding actual.
14. Cada WorkUnit posee exactamente un primary Worktree.
15. `HarnessSession` vincula un owner con una ejecución/sesión nativa direccionable mediante el adapter.
16. `HarnessSession` no es proceso, pane, turn ni state machine de ejecución.
17. Busy/idle/process present/process absent son observaciones.
18. Pi puede alternar busy/idle sin mutar el estado durable de WorkUnit.
19. Una Escalation pendiente no requiere suspender Pi.
20. Un proceso ausente no convierte automáticamente una WorkUnit en failed.
21. Un retry interno de Pi no crea otra WorkUnit ni generation.
22. Una nueva WorkUnit sólo aparece por una decisión explícita del owner/planner.
23. Reemplazar el Worker binding incrementa `binding_revision`.
24. Writes de bindings anteriores son stale.
25. El Worker es accountable por cada WorkResult que entrega.
26. Los subagentes pueden escribir, usar Git, testear y commitear bajo autoridad delegada.
27. Agent-declared completion nunca equivale a verified completion.
28. `agent_settled` nunca equivale a WorkUnit completed.
29. Una Delivery acknowledged no implica que el recurso referenciado esté resuelto.
30. A4S conserva una referencia nativa exacta cuando el adapter la requiere y no usa heurísticas ambiguas para direccionar una ejecución.
31. `Unknown` califica observaciones concretas, no toda la WorkUnit.
32. La suspensión automática no es una invariante ni un requisito de v0.7.
33. Assignment, Lease, generation y Activation no existen en el modelo actual.
34. Todo owner de Mailbox tiene como máximo una HarnessSession vinculada actual con `binding_revision` monotónica; claims y writes de revisiones anteriores son stale.
35. Un PASS mecánico automático requiere que todos los acceptance_criteria tengan check declarado; cualquier criterio no mecanizable convierte el cierre en decisión explícita del owner.

---

# 42. Alcance v0.7

## HARD

- local-first;
- una máquina;
- `a4sd`;
- `a4sctl`;
- almacenamiento durable local;
- reinicio de `a4sd` sin perder recursos A4S;
- Herdr como host terminal inicial;
- Pi como primer harness;
- A4S Pi Extension;
- PiBridge estructurado y bidireccional;
- PTY fuera del protocolo autoritativo;
- Orchestrator durable;
- único human ingress;
- Project;
- WorkUnit;
- HarnessSession;
- referencia nativa exacta y direccionable cuando el adapter la requiera;
- un Worker binding actual por WorkUnit;
- binding revision e idempotency;
- un primary Worktree por WorkUnit;
- WorktreeProvider;
- Mailbox/Delivery;
- Escalation;
- Human-as-Tool vía Orchestrator;
- WorkResult estructurado;
- mechanical Verification;
- Event Journal de dominio.

## STRONG

- WorkGraph con dependencies;
- múltiples Workers;
- Dispatcher determinista simple;
- múltiples Orchestrators;
- scopes `global` y `project`;
- Proposal cross-scope;
- Query cross-scope;
- ToolCalls de servicios externos;
- redelivery después de desconexión de extensión.

## FUTURO / SÓLO CON EVIDENCIA

- reapertura limpia o automática de procesos/sesiones;
- crash recovery durante un turn;
- suspensión de sesiones idle;
- reclamación de memoria por suspensión;
- capacity model;
- rate-limit scheduler;
- fairness;
- placement;
- leases;
- WorkUnit attempts/generations;
- Claude harness;
- multi-node;
- distributed placement;
- quotas;
- multi-tenant;
- remote runtimes;
- RBAC completo;
- Kubernetes deployment;
- federation;
- HA control plane.

---

# 43. No objetivos

A4S v0.7 no pretende:

- crear otro IDE;
- reemplazar Herdr;
- reemplazar Pi;
- reemplazar Superpowers/SDD/planners;
- implementar su propio sistema de subagentes;
- modelar cada turn/tool/retry interno de Pi;
- mantener una réplica del session JSONL;
- inferir outcomes mediante parsing de pantalla;
- usar el PTY como message bus;
- suspender procesos idle por principio;
- relanzar automáticamente trabajo interrumpido;
- modelar capacity antes de medir un bottleneck;
- desplegar Kubernetes para el MVP;
- resolver distributed consensus;
- soportar cualquier harness sacrificando el diseño local;
- permitir una malla sin ownership donde cualquier agente muta cualquier proyecto.

---

# 44. MVP por fases

## Fase 0 — PiBridge PoC usable

Objetivo:

> Eliminar el PTY como canal de control entre A4S y un Worker Pi mediante un artefacto ejecutable que permita usar y evaluar el flujo real.

La Fase 0 sigue siendo un PoC: valida hipótesis y puede cambiar después de obtener evidencia. `Usable` no significa `production-ready`, y el código tampoco se considera descartable por definición.

Probar:

```text
a4sd local
  ↕ structured transport
A4S Pi Extension
  ↕ native Pi APIs/events
Pi interactive session in Herdr
```

Criterios:

1. La extensión adjunta owner + binding revision.
2. Reporta una `native_ref` exacta; en el perfil Pi, `session_id` y `session_file` cuando corresponda.
3. `a4sd` entrega un kickoff sin escribir al PTY.
4. Pi inicia un turn mediante API de extensión.
5. El Worker obtiene una WorkUnit mediante `work.get`.
6. El Worker crea una Escalation estructurada.
7. El Worker entrega un WorkResult estructurado.
8. `agent_start/agent_settled` se observan sin convertirlos en estados de trabajo.
9. La terminal sigue siendo visible y operable mediante Herdr.

## Fase 1 — Un Orchestrator y un Worker

```text
Human
  → Orchestrator Pi session
  → WorkUnit
  → Worktree
  → Worker Pi session
  → WorkResult
  → Verification
  → Orchestrator
  → Human
```

Incluye:

- Orchestrator identity;
- mailbox;
- HarnessSession por Orchestrator;
- HarnessSession Worker;
- one current binding;
- primary Worktree;
- mechanical verification;
- delivery de outcome;
- reinicio de `a4sd` sin perder WorkUnit, bindings, Escalations, WorkResults ni Deliveries.

Sin DAG complejo ni scheduler.

## Fase 2 — Interacciones durables

Añadir:

```text
Escalation
ToolCall(provider=human)
Delivery pending while Worker is idle/disconnected
redelivery after reconnect
verification feedback to same Worker
```

Pi permanece abierto e idle durante waits.

## Fase 3 — Multiple Workers y dispatch

Sólo después de medir el corte vertical:

- dependencies;
- readiness derivada;
- varias WorkUnits;
- varios Workers;
- Dispatcher simple;
- política de concurrencia basada en el recurso observado.

## Fase 4 — Multiple scopes

Añadir:

```text
orch-global
orch-project-A
orch-project-B
Proposal
Query
scope authority
```

## Fase 5 — Segundo harness

Evaluar Claude sólo después de documentar su semántica real de sesión e integración.

No se obliga a Claude a fingir la misma state machine de Pi.

## Fase 6 — Distributed execution

Sólo si existe necesidad probada.

---

# 45. Experimentos requeridos

Los experimentos generan evidencia; esta sección no declara sus resultados.

## E0. Attach y transporte

Pregunta:

> ¿Qué transporte local permite attach, bidireccionalidad, ACK y reconexión con la menor complejidad?

Candidatos:

```text
Unix socket
HTTP local + long polling/SSE
WebSocket local
```

Salida:

- decisión de transporte;
- envelope schema mínimo;
- comportamiento de reconexión;
- evidencia de idempotencia.

## E1. Inbound input sin PTY

Pregunta:

> ¿Puede una Delivery disparar de forma fiable un turn Pi mediante la extensión sin escribir al terminal?

Validar:

- idle input;
- input mientras Pi está busy;
- `steer` vs `followUp` cuando corresponda;
- ACK antes/después de insertar input;
- duplicación después de reconnect.

## E2. Binding y referencia nativa

Pregunta:

> ¿Puede el perfil Pi reportar una `native_ref` exacta y correlacionable para el Worker durante attach y operación normal?

Validar:

- startup;
- reload de extensión;
- cierre normal;
- attach repetido;
- que la referencia observada permita correlacionar inequívocamente el binding sin heurísticas de “última sesión”.

## E3. Reapertura limpia

Pregunta:

> Después de cerrar Pi en idle, ¿puede Herdr abrir la sesión exacta y consumir Deliveries pendientes sin ambigüedad?

No es requisito para aprobar E0.

## E4. Interrupción mid-turn

Pregunta:

> ¿Qué persiste Pi si el proceso termina durante streaming o durante una tool?

Debe observarse antes de diseñar retries automáticos o recovery policy.

## E5. Coste de sesiones idle

Pregunta:

> ¿En qué escala de sesiones residentes aparece un problema real de memoria, CPU o file descriptors?

Sólo se ejecuta cuando la escala esperada lo justifique.

Su resultado decide si suspensión/capacity vuelven al diseño.

---

# 46. Preguntas después de la auditoría

## 46.1. No hay otra ronda arquitectónica bloqueante antes del PoC

v0.7 define suficiente semántica para ejecutar E0–E2.

Las incógnitas inmediatas son elecciones experimentales de integración:

- transporte concreto;
- momento exacto del ACK inbound;
- estrategia de attach/reconnect;
- estabilidad/correlación de la `native_ref` reportada por el perfil Pi.

Deben resolverse mediante el PiBridge PoC, no mediante más abstracción previa.

## 46.2. Temas diferidos

Se conservan como temas futuros, no como preguntas del corte actual:

### A. Mutación de WorkGraph activo

Se diseña cuando exista DAG concurrente real.

### B. Delegación formal de scope

Se diseña en la fase multi-Orchestrator.

### C. Verification avanzada

Policy/semantic verification se diseña después de mechanical verification real.

### D. Cambios de contrato no correlacionados

Se diseña cuando existan consumidores y metadata de releases reales.

### E. Segundo harness

La portabilidad se deriva de Pi + una segunda implementación, no de Conditions hipotéticas.

### F. Capacity y scheduling

La unidad de capacidad se decide después de medir el bottleneck.

---

# 47. Corte vertical recomendado

```text
1. a4sd inicia con almacenamiento durable local.
2. existe orch-main scope=global.
3. orch-main tiene mailbox y HarnessSession Pi.
4. Herdr inicia Pi con A4S Pi Extension.
5. la extensión adjunta orch-main y reporta su native_ref exacto.
6. el usuario pide una unidad de trabajo a orch-main.
7. orch-main crea WorkUnit W1.
8. WorktreeProvider crea WT-W1.
9. A4S crea HarnessSession HS-W1 y binding revision 1.
10. Herdr inicia Pi Worker en WT-W1 con la extensión.
11. la extensión reporta la sesión Pi exacta.
12. A4S encola work.kickoff en mb-W1.
13. la extensión consume el kickoff y dispara input mediante API Pi.
14. el Worker llama work.get(W1).
15. el Worker puede usar subagentes con write/Git.
16. si necesita decisión, llama escalation.create.
17. Pi puede quedar idle sin transición durable de suspensión.
18. la resolución vuelve mediante Delivery.
19. el Worker llama result.submit.
20. Verification ejecuta checks mecánicos.
21. W1 pasa a COMPLETED sólo con PASS.
22. orch-main recibe el outcome.
23. el usuario ve el resultado únicamente en orch-main.
24. reiniciar a4sd no pierde recursos ni deliveries.
25. ninguna instrucción o conclusión autoritativa depende del PTY.
```

Éxito significa:

- comunicación bidireccional estructurada;
- workload completo fuera del terminal;
- session identity exacta;
- Escalation y WorkResult tipados;
- idle tratado como actividad normal;
- no suspension machinery;
- no generation/lease/activation machinery;
- ningún controller realiza juicio LLM;
- usuario nunca entra al Worker;
- Herdr sigue ofreciendo terminal visible.

---

# 48. Principio rector

> **Persistir el trabajo que importa, observar el harness sin apropiarse de él y eliminar el PTY del protocolo antes de optimizar problemas no observados.**

En A4S:

```text
Control plane owns coordination truth.
Orchestrators own decisions.
WorkUnits own objectives and accountability.
HarnessSessions bind native agent sessions.
Pi owns conversation and turns.
Worktrees preserve filesystem state.
Mailboxes preserve pending communication.
Deliveries cross temporal/process gaps.
Herdr hosts terminals.
Subagents perform delegated work.
```

---

# 49. Arquitectura resumida

```text
                              HUMAN
                                │
                                ▼
                     ┌─────────────────────┐
                     │    ORCHESTRATOR     │
                     │ identity + scope    │
                     │ mailbox + cognition │
                     └──────────┬──────────┘
                                │ structured operations
                                ▼
       ┌───────────────────────────────────────────────┐
       │                    a4sd                       │
       │                                               │
       │ Projects / WorkGraphs / WorkUnits             │
       │ HarnessSession bindings                       │
       │ Worktrees                                     │
       │ Mailboxes / Deliveries                        │
       │ Escalations / Proposals / Queries / ToolCalls │
       │ WorkResults / Verification / Event Journal    │
       └───────────────────────┬───────────────────────┘
                               │ local structured bridge
                               ▼
                    ┌───────────────────────┐
                    │   A4S Pi Extension    │
                    │ attach + tools + I/O  │
                    └───────────┬───────────┘
                                │ Pi native APIs/events
                                ▼
                          Pi HarnessSession
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
             primary Worktree         Herdr terminal
```

---

# 50. Estado del diseño

## Estable a nivel conceptual

- control plane autoritativo limitado al dominio A4S;
- Orchestrator fuera del control plane;
- identidad durable de Orchestrator;
- scope y ownership;
- único human ingress;
- WorkUnit como unidad de accountability;
- estado durable mínimo de WorkUnit;
- vistas derivadas en vez de state machine combinatoria;
- HarnessSession como binding a sesión nativa;
- Pi posee turns/retries/compaction;
- Herdr posee terminal hosting;
- Pi Extension como integración inicial;
- PTY excluido del protocolo;
- binding revision en vez de generations/leases;
- owner-session binding generalizado (Worker y Orchestrator);
- toolset agent-facing por rol dictado por a4sd;
- acceptance_criteria estructurados con checks mecánicos;
- SessionLauncher del perfil Pi/Herdr sobre la superficie real de Herdr;
- un primary Worktree por WorkUnit;
- Mailbox/Delivery durable;
- Escalation Worker → Orchestrator;
- Human-as-Tool vía Orchestrator;
- Proposal/Query cross-scope;
- Worker accountability;
- subagentes plenamente operativos;
- WorkResult separado de Verification;
- idle no implica suspensión;
- process absence no implica failure;
- `A4S`, `a4sctl`, `a4sd`.

## Pendiente de evidencia experimental inmediata

- transporte concreto del PiBridge;
- attach/reconnect;
- ACK e idempotencia inbound;
- input a Pi mediante extensión en idle/busy;
- estabilidad del session binding;
- estabilidad/correlación de la `native_ref` del perfil Pi.

## Diferido hasta existir necesidad

- reapertura automática;
- crash mid-turn policy;
- capacity/scheduling avanzado;
- suspensión;
- WorkUnit attempts/generations;
- mutación concurrente de WorkGraph;
- delegación formal de scope;
- semantic verification;
- contract change notification;
- Claude;
- multi-node.
