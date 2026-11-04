# Super-agent sobre T3 Code, a4s y Dagu: arquitectura y roadmap

Fecha: 2026-11-03. Estado: investigación y plan. No adopta nada ni cambia código o
configuración de a4s. Parte de [a4s sobre T3 Code con coordinador OMP](t3-omp-roadmap.md)
(F0–F7) y no la reemplaza: este documento añade el **plano de entrada** (eventos,
admisión, tickets, atención) sobre el **plano de ejecución** que define F0–F7.

Fuentes y nivel de evidencia (código = leído en código; doc = solo documentación del
proyecto; sin verificar = afirmación sin respaldo en código ni ejecución):

- `deepseek-ai/dsh-superagent-prototype`, rama `main`, commit `8c32a9d` (2026-10-31), MIT.
  El README lo declara prototipo de investigación, distinto de la versión interna y del
  artículo *Exploring Super-agent Design*; parte del diseño del artículo no está implementado.
  Se leyeron `docs/000`–`004`, `docs/007` y partes de `src/`. No se ejecutó.
- La guía de adopción adjuntada por el operador (resumen de un trend de X). Sus cifras
  ("5× más caro", "70× más tokens") y la idea "router con modelo ligero" quedan **sin verificar**:
  en el prototipo, Eval y Executor tienen cada uno su `model` configurable
  (`src/app/settings.ts:160`) y por defecto usan el modelo del perfil (`docs/006-deployment.md:26`).
- Repo a4s en `b3de7d4`; evidencia R/P/B de [t3-omp-roadmap §2](t3-omp-roadmap.md#2-validado-en-ejecución).

## 1. Qué es el super-agent y por qué encaja

Problema que ataca el prototipo: un operador solo puede seguir pocas sesiones a la vez.
Su principio (`docs/000-philosophy.md`) es **tomar la menor atención humana posible y dar
el mayor valor posible**: actuar solo si se lo pide alguien autorizado o una regla escrita,
hablar solo cuando una persona debe actuar o puede usar un resultado.

Es el mismo síntoma que mide [t3-omp-roadmap §1](t3-omp-roadmap.md#1-objetivo): el
operador no sabía en qué estado estaba una integración, ni si estaba bloqueada, ni dónde
había quedado un handover. Y es el problema de #918 (correcciones humanas recurrentes,
decisiones delegadas que vuelven al humano).

Lo que el prototipo aporta y a4s no tiene hoy es un **modelo de dominio de la entrada**:
qué evento puede crear trabajo, con qué autoridad, cómo llegan los mensajes posteriores
al trabajo vivo y cuándo se le pide algo a una persona. F0–F7 resuelven cómo se ejecuta
un paso; no resuelven de dónde sale el trabajo ni cómo vuelve el resultado.

### Modelo de dominio del prototipo (código: `src/core/model.ts`, doc: `docs/001-domain.md`)

```
Source ─Trigger─► Thread ─batch─► Eval (gate determinista + assessment LLM)
                    │                 │ accept + Mandate / stop / ignore / unavailable
                    │ Subscription    ▼
                    └─fan-out──────► Ticket ─Assignment─► Executor (sesión + directorio)
                                      │
                                      └─Channel (outbox) ─► Source
```

| Concepto | Regla clave |
|---|---|
| Source | Guarda su posición de lectura; un reinicio no repite eventos. Filtra los mensajes del propio bot. |
| Trigger | Evento inmutable. Aceptarlo dos veces crea un solo Ticket. |
| Thread | Como máximo un Eval a la vez; los Triggers que llegan mientras tanto entran en el siguiente lote. |
| Gate | Primera capa determinista: quién puede originar trabajo y con qué fuerza (`explicit` / `inferred`). |
| Assessment | Juicio del modelo. Sin estado. Expira → reintenta dos veces → `unavailable`. |
| Mandate | Inmutable: versión de Policy, alcance, fuerza, reglas, identidad del emisor. Más alcance = Ticket nuevo. |
| Ticket | Solo Eval lo crea. Su estado es propio, no el de la sesión del ejecutor. |
| Assignment | Ticket ↔ una instancia de ejecutor; un Ticket tiene varias en el tiempo. |
| Report | `progress · waiting · ready · blocked · failed · dropped`. "Esperando a una persona" sale de un campo estructurado, nunca del texto libre. |
| Subscription | Mensajes posteriores en el Thread llegan al Ticket vivo como contexto, sin Eval y sin dar autoridad. |
| Accept mode | `off` · `observe` (por defecto: registra "habría aceptado") · `auto`. |

Mecánicas de ejecución (`docs/003-execution.md`) relevantes para a4s:

- **Trabajo almacenado:** todo efecto posterior a una decisión (relay, lanzamiento, entrega,
  respuesta) se guarda primero y se ejecuta después, con reintento exponencial.
- **Etapa derivada:** la etapa del Ticket (`person / answer`, `person / review`, `blocked`,
  `queued`, `idle`, `working`) se calcula de Reports e Inputs guardados, así que sobrevive a un reinicio.
- **Slots de concurrencia con uno reservado** para el mensaje de una persona: el trabajo
  nuevo no impide continuar un Ticket existente.
- **Reinicio:** las Assignments en curso arrancan con una nota de recuperación que obliga a
  revisar directorio, historial git y GitHub antes de repetir una acción externa.
- **El router no espera:** un guard niega `sleep`, timeouts de shell > 30 s y esperas de job > 5 s
  (`docs/007-architecture.md`, "Presets and wait limits"). Notas del router ≤ 30 palabras.

## 2. Arquitectura objetivo

Tres planos. Cada uno lo controla quien puede garantizarlo; el LLM no sostiene ningún bucle.

```
             PLANO DE ENTRADA (a4s, determinista)          PLANO DURABLE (Dagu)
GitHub ──► Source (a4s tick) ─► Trigger store ─► Gate ─►┐
operador ─► thread coordinador T3 ──a4s enqueue──────────┤
                                                         ▼
                                         Eval dictado ─► Decision + Mandate
                                                         │ accept
                                                         ▼
                                    Ticket ─► run Dagu (feature/poc/…) = Assignment
                                                         │ a4s dictate (F1)
             PLANO SEMÁNTICO (T3 + OMP)                  ▼
   coordinador OMP (router, thread T3) ─delegate_task─► hijo OMP (worktree, rol, modelo fuerte)
                                                         │ a4s_submit_result (Report)
                                                         ▼
                              Outbox (paso Dagu) ─► comentario en el issue / aviso al operador
```

| Concepto super-agent | En a4s + Dagu + T3 | Estado |
|---|---|---|
| Source GitHub | Paso en el DAG programado `a4s tick` (`packages/issue-lifecycle/src/tick.ts`), con posición de lectura persistida | nuevo |
| Source operador | El thread coordinador en T3; `a4s enqueue` desde la extensión | F1/F2 |
| Trigger store | JSONL append-only con lock, como `escalation.json` y #863 | nuevo |
| Gate | `a4s admit` + lista de permitidos y bots en la config confirmada (`@a4s/launcher/config`) | ampliar |
| Assessment | Dictado corto con schema `Decision`; idealmente en un hijo efímero, no en la sesión del coordinador | nuevo, sobre F1 |
| Mandate | Se fija en el enqueue: issue, DAG, fuerza, versión de Policy y autoridad de push (decisión 3 de [t3-omp-roadmap §6](t3-omp-roadmap.md#6-decisiones-previas)) | nuevo |
| Ticket | Unidad que abarca varios runs del mismo issue; referencia receipts y runs | nuevo |
| Assignment | Run de Dagu + `taskId`/`childThreadId` de T3 (F2 `tool_result`) | F2/F4 |
| Executor | Hijo de `delegate_task` con `worktree`, modelo explícito (P9, P10) | F4/F6 |
| Report | `a4s_submit_result` con el enum de Report; F1 valida estado final y schema | F1/F2 |
| Subscription | Comentario nuevo en el issue → Input al Ticket vivo, dictado al thread hijo | nuevo, **sin verificar** el dictado a un hijo |
| Channel / Outbox | Paso de Dagu que publica en el issue con orden por Ticket y reintento; sin PR (trunk) | nuevo |
| Attention | `human.task` solo para decisiones del operador + dictado al coordinador (F7) | F7 |
| Etapa del Ticket | Función pura sobre Reports e Inputs; la ve el operador en T3 | nuevo, reemplaza el widget |
| Slots + slot humano | Cola de Dagu por repo (`queue: TEMPLATE_REPO` en `feature.yaml:4`) + reserva | parcial, **sin verificar** la reserva |
| Nota de recuperación | Reintento de Dagu + `session/load` (R10) + texto de recuperación en el dictado | F1 |
| Repetición como señal | `a4s correction` (#929) + contador `run:step:iteration` de F1 | #929 |

### Lo que no se adopta

| Del prototipo | Motivo |
|---|---|
| El host DeepSeek Harness y su bundle | a4s corre OMP dentro de T3; solo se reusa el modelo de dominio. El código es MIT, pero está acoplado a DSH/Cordis. |
| Panel web propio | T3 ya muestra threads y estado; la etapa del Ticket se dicta al coordinador. |
| Fin del Ticket por PR cerrado o mergeado | Trunk: un Ticket queda `ready` con merge local en `main`, push y la CI posterior en verde. |
| Feishu | Sin uso en a4s. |
| Overrides versionados de prompts desde el panel | Los prompts y skills ya están versionados en git. |
| Un router durable de larga vida | Es el problema medido en [t3-omp-roadmap §1](t3-omp-roadmap.md#por-qué-el-bucle-no-puede-vivir-en-una-sesión). El prototipo lo mitiga con un router que no espera y notas cortas; aquí el Assessment va a hijos cortos y el coordinador solo recibe lo que pide acción. |

## 3. Decisiones del operador (previas al roadmap)

1. **Invariantes de #918. Decidido por el operador el 2026-11-03:** el coordinador es un
   thread de T3 que corre OMP por ACP, y todo lo demás (roles, Assessment, follow-ups) se
   delega con `delegate_task` de T3, con los guards de F2: modelo explícito, `worktree` para
   los roles que editan, tool `task` nativa de OMP bloqueada y `taskId`/`childThreadId`
   registrados. Queda pendiente reescribir en #918 las invariantes "coordinador en TUI" y
   "subagente nativo" en términos independientes del host: cada rol es un hijo visible y
   dirigible del coordinador, sin modo headless.
2. **Fuentes de trabajo.** Propuesta: GitHub (issues y comentarios del repo) y el operador
   en T3. Nada más hasta S6.
3. **Modo de aceptación inicial.** Propuesta: explícito siempre; trabajo inferido en `observe`
   hasta revisar decisiones registradas.
4. **Modelo del router y de los hijos.** Propuesta: fijarlos por rol en a4s (`target.model`),
   router más barato que los ejecutores, y medirlo, no asumirlo (la guía no lo prueba).
5. **Dónde vive el store.** Propuesta: JSONL append-only con lock bajo `$DAGU_HOME`, como
   receipts y #863. Alternativa: SQLite transaccional, como el prototipo (`src/app/store.ts`),
   que da `afterCommit` para el outbox. Elegir antes de S1.

## 4. Roadmap

Orden: **S0** → F0 → (F1 ‖ F2+F3 ‖ **S1**) → **S2** → F4 → **S3** → F5 → **S4** → F6 → F7+**S5** → **S6**.
Las fases F son las de [t3-omp-roadmap §7](t3-omp-roadmap.md#7-roadmap) sin cambios de
alcance. Cada fase S se cierra igual: commit en el worktree, merge local en `main` y push,
`npm test` y `npm run typecheck`, y su `test:live` con los hosts reales cuando toca un host.

### S0 · Decisión y protocolo

- El operador resuelve las decisiones 2 a 5 de §3 (la 1 ya está decidida).
- Se decide si este plan es la variante C de #920 o un roadmap propio, y se reconcilia en #882.
- Métricas fijadas antes de construir, compatibles con #920: mensajes al operador por Ticket,
  preguntas innecesarias, correcciones repetidas por punto de decisión (#929), tiempo en
  `person/*`, coste y latencia por Ticket.
- Salida: decisión registrada en este documento.

### S1 · Modelo de dominio y store (en paralelo con F1, F2 y F3)

En `packages/issue-lifecycle`, sin host.

- Tipos `Trigger`, `Thread`, `Decision`, `Mandate`, `Ticket`, `Assignment`, `Report` e `Input`,
  con las invariantes de §1 como tests.
- Store append-only con lock; idempotencia por id de Trigger; `ticketStage` como función pura.
- La identidad del Mandate usa la identidad a4s de F3, no `OMP_SESSION_ID`.
- Salida: tests de invariantes (Trigger doble → un Ticket; Mandate inmutable; etapa derivada tras reinicio).

### S2 · Source GitHub y gate (tras S1 y F1)

- Paso de `a4s tick` que lee issues y comentarios nuevos con posición de lectura persistida
  y descarta los de la cuenta propia.
- Gate determinista: lista de permitidos, bots y tabla de admisión en la config confirmada;
  `explicit` / `inferred` / no admitido. El texto del mensaje nunca cambia permisos.
- Thread = issue. Un Eval por Thread a la vez; los Triggers que llegan se agrupan.
- Reemplaza el alcance de #501 (ingreso único de eventos con replay).
- Salida: `test:live` contra un repo de prueba: un comentario de un permitido produce un
  candidato, uno de un no permitido no, y un reinicio no repite eventos.

### S3 · Eval y Mandate (tras S2 y F4)

- El Assessment es un dictado (F1) con schema `Decision`; propuesta: en un hijo efímero para
  no crecer la sesión del coordinador (abierto en [t3-omp-roadmap §9.4](t3-omp-roadmap.md#9-pendiente-o-no-verificado)).
- Expira → reencola; tras dos reintentos → `unavailable` y aviso al operador.
- `accept` crea Ticket y Mandate y encola el run de Dagu; `a4s enqueue` del operador produce
  un Trigger `explicit` por el mismo camino.
- Un cambio de Policy descarta los Evals en curso y avisa a los Tickets afectados, sin cancelarlos.
- Salida: un issue de prueba pasa de comentario a run de `feature` con Mandate registrado.

### S4 · Subscriptions, Reports e Inputs (tras F5)

- Comentarios posteriores en el issue → Input al Ticket vivo, dictado al thread del hijo
  con `commandId` idempotente. **Primero hay que probar en ejecución** que `message.dispatch`
  a un thread hijo funciona como B2 sobre el coordinador.
- El hijo resuelve los follow-ups dentro del alcance y devuelve los demás (`handback`), que vuelven a Eval.
- `a4s_submit_result` adopta el enum de Report; `waiting` sobre una persona solo vía campo estructurado.
- Reanudar un Ticket terminado exige revalidar el Mandate contra la Policy vigente.
- Salida: `test:live` con un follow-up dentro del alcance y otro fuera.

### S5 · Outbox y atención (junto con F7)

- Outbox como paso de Dagu: una confirmación por Ticket, silencio mientras trabaja, un
  resultado o una pregunta concreta. Orden por Ticket y conversación, reintento con backoff,
  registro de lo descartado.
- La etapa `person/*` se dicta al coordinador; el operador responde ahí (`creationSource`, F7).
- Se retira el widget y el poll de `status` (F7).
- Salida: un Ticket completo produce como máximo tres mensajes al operador (confirmación,
  pregunta opcional, resultado).

### S6 · Trabajo proactivo y escalado

- Reglas escritas por el equipo (por ejemplo "dependabot: actualizar si la CI falla") en
  `observe`; pasan a `auto` por regla tras revisar las decisiones registradas.
- Slot reservado para mensajes del operador en la cola de Dagu, o la alternativa viable si
  Dagu no lo soporta.
- Nota de recuperación en todos los dictados tras reinicio; prueba de caída end-to-end
  Dagu–a4s–T3–OMP, que [t3-omp-roadmap §11](t3-omp-roadmap.md#recovery-and-delivery) deja abierta.
- Salida: medición S0 antes y después, con veredicto.

## 5. Relación con los issues

Estados consultados con `gh` el 2026-11-03.

| Issue | Relación |
|---|---|
| #918, #919, #920 | Host decidido (§3.1): falta reescribir en #918 las invariantes de TUI y subagente nativo. Esta arquitectura es la candidata C de #920. |
| #929 | Insumo directo de la métrica de repetición; independiente de la arquitectura. |
| #893 | Alternativa para exponer `a4s_submit_result`, el gate y la suscripción a eventos como tools MCP. Decidir antes de S3. |
| #501 | Lo reemplaza S2. |
| #499, #503, #884 | Lease y traspaso del coordinador: con Tickets durables y router reemplazable pierden peso; reformular tras S1. |
| #886 | Cancelar en un punto seguro equivale al stop de un Ticket; reusar en S3. |
| #786, #850 | Se cierran con el retiro del widget (S5/F7). |
| #882 | Tracker donde ubicar S0–S6 si se adoptan. |

## 6. Pendiente o no verificado

1. `message.dispatch` idempotente a un thread hijo (no al coordinador). Bloquea S4.
2. Reserva de un slot para el operador en la cola de Dagu.
3. Coste y calidad del router con un modelo más barato que los ejecutores.
4. Si el Assessment en un hijo efímero es más barato que en la sesión del coordinador.
5. Las cifras y afirmaciones de la guía de adopción y del artículo de DeepSeek que no están en el código del prototipo.
6. La fuerza de las garantías del prototipo: no se ejecutó; todo lo citado viene de su documentación y código leído.
