---
tipo: adr
estado: proposed
fecha: '2026-10-05'
contexto: >-
  .workspace/config.yaml solapa dos artefactos: un pipeline (flujo ordenado que
  el ejecutor sigue) y un conjunto de invariantes transversales (autoridad,
  seguridad, credenciales, autoridad reservada, revisión). Las claves de primer
  nivel están organizadas por fase y parecen un pipeline, pero los pasos nunca
  se enumeraron y su orden solo existe implícito. Dos encuadres sin reconciliar
  colisionaron en el archivo: la memoria #13352 (2026-09-26) pidió config como
  WoW descriptivo del proceso, y ADR 0061 (2026-09-28) lo hizo autoridad única
  de reglas. La evidencia de campo (ReAct, Plan-and-Execute; OPA; Constitutional
  AI; convergencia LangGraph/Swarm/CrewAI) indica que el orden implícito se
  desvía en procedimientos de más de ~5 pasos y que separar proceso de política
  e itemizar pasos explícitos mejora la fiabilidad.
decision: >-
  Adoptar Opción C: config.yaml queda como autoridad de invariantes (reglas
  puras) y el pipeline (flujo de 7 etapas) vive como mecanismo en UN SOLO skill
  `work-lifecycle` que lee su política del config y no añade regla propia, en los
  términos de authority.mechanism (ADR 0061). Un solo skill en vez de uno por
  etapa, para no multiplicar la ceremonia de la casa (README, PROFILE routing,
  tests y sección de autoridad por skill). El orden sigue el modelo C2: no se
  declara una secuencia narrativa; emerge de compuertas (gates en tags XML) que
  cada etapa resuelve contra invariantes del config. Como respaldo, config
  declara un invariante MÍNIMO de precedencia con tres barreras duras:
  readiness→mutación, aceptación→entrega, integración→cleanup. En la misma pasada
  se limpia config de inconsistencias y ceremonia excesiva y se recorta el
  procedimiento de config hacia invariantes —el flujo paso-a-paso queda solo en
  el skill— todo bajo autorización del operador (reserved_authority; ver
  Consecuencias).
alternativas: >-
  A (status quo, flujo implícito) se descarta por la desviación de orden
  documentada. B (config en dos secciones: flujo normativo + invariantes)
  preserva la narrativa de #13352 pero mantiene el proceso dentro de la
  autoridad; el operador prefirió C. C1 (orden declarado como regla en config)
  se descarta frente a C2 por depender de que la secuencia se respete en vez de
  precondiciones verificables. C2 puro se descarta por no dejar ningún respaldo
  explícito de precedencia. Un DSL ejecutable (entry/exit/guards/RBAC) se
  descarta por chocar con KISS y con INT-007 (operación directa, no otro
  framework).
consecuencias: >-
  Config deja de narrar el proceso; esa descripción se traslada al skill
  `work-lifecycle`, consecuencia aceptada por el operador (contradice #13352).
  Las 7 etapas quedan definidas por primera vez, en el skill. Limpieza de config
  aplicada en esta pasada bajo autorización del operador: (a) se elimina la
  contradicción del PoC obligatorio — `do_work.investigation` ya no afirma "a
  separate PoC task required for a new capability", dejando `prepare_work.new_
  capability` (directo primero, experimento solo ante unknown material); (b)
  `accept_work.review` se relaja — una revisión independiente solo según riesgo,
  self-review en los demás casos, sin preferencia de familia/proveedor; (c) se
  extrae el procedimiento: las claves de ciclo de vida se recortan a su
  invariante y el flujo paso-a-paso (comandos git, intake, readiness detallada,
  backscroll, pasos de cleanup) vive solo en el skill. Los tests dogfood
  derivados que congelaban ese texto se actualizaron a los invariantes (config
  prevalece, `authority.derived`). Este
  ADR no entra en vigor hasta aprobación del operador e integración en main;
  refina la organización del WoW de ADR 0061 sin anular su autoridad única.
pendientes: >-
  Validar el skill `work-lifecycle` en el harness consumidor (E2E). Seguir
  barriendo inconsistencias/ceremonia si el operador lo pide. Crear Bead y PR.
---
# 0069. Separar el pipeline como mecanismo de los invariantes en config

## Contexto
`.workspace/config.yaml` solapa dos artefactos distintos: un **pipeline** —el
flujo ordenado que el ejecutor debería seguir— y un conjunto de **invariantes
transversales** (autoridad, seguridad, credenciales, autoridad reservada,
revisión). Las claves de primer nivel (`choose_work` → `define_work` →
`prepare_work` → `do_work` → `accept_work` → `deliver_work` → `track_work` →
`improve_work`) están organizadas por fase y **parecen** un pipeline, pero:

- los **pasos nunca se enumeraron**; su orden solo existe implícito, por el orden
  de las claves y referencias cruzadas;
- invariantes transversales viven dentro de cubetas de fase (`safety` bajo
  `do_work`, `reserved_authority` bajo `deliver_work`) aunque aplican siempre;
- las fases no cierran como pipeline lineal: `authority`, `roles`, `product` son
  transversales, `track_work` es concurrente e `improve_work` es un lazo.

Dos encuadres aterrizaron en el archivo sin reconciliarse: la memoria **#13352**
(2026-09-26) pidió config como WoW descriptivo del proceso; **ADR 0061**
(2026-09-28) lo hizo autoridad única de reglas. La evidencia de campo (ReAct,
Plan-and-Execute; filosofía OPA de desacoplar política de servicio;
Constitutional AI como capa siempre-activa; convergencia de LangGraph/Swarm/
CrewAI hacia pasos explícitos) indica que el orden implícito se desvía y que la
separación proceso/política con pasos explícitos mejora la fiabilidad.

## Decisión
Se adopta la **Opción C**:

- **config.yaml = autoridad de invariantes.** Reglas puras siempre-activas;
  sigue siendo la fuente normativa única (ADR 0061).
- **pipeline = mecanismo, UN solo skill.** El flujo de **7 etapas** (admitir →
  definir → preparar → ejecutar → aceptar → entregar → cerrar) vive en un único
  skill `work-lifecycle`, que *lee su política del config y no añade regla propia*
  (`authority.mechanism`). Un solo skill, no uno por etapa, para no multiplicar la
  ceremonia de la casa (README, routing en PROFILE, tests y sección de autoridad
  por cada skill). Se activa por su `description` (frases `Trigger:`).
- **Orden en modelo C2.** No se declara una secuencia narrativa en ninguna parte;
  el orden **emerge de los gates** (precondiciones) que cada etapa resuelve contra
  invariantes del config.
- **Gates en tags XML.** Cada etapa se estructura con tags XML (`<gate_entry>`,
  `<activity>`, `<gate_exit>`) y emite su veredicto en
  `<gate_check stage="..." result="pass|block">`, con cada condición citando la
  clave de config que la gobierna. Es el patrón de prompting recomendado por
  Claude para instrucciones sin ambigüedad; no es un DSL ejecutable (KISS,
  INT-007): el gate verifica, no define.
- **Respaldo de precedencia (de C1, mínimo).** Config declara un invariante con
  tres barreras duras: `readiness → mutación`, `aceptación → entrega`,
  `integración → cleanup`.
- **Limpieza de config en esta pasada** (autorizada por el operador): eliminar la
  contradicción del PoC obligatorio, relajar la ceremonia del revisor y **recortar
  el procedimiento de config hacia invariantes** —el flujo paso-a-paso queda solo
  en el skill—; detalle en Consecuencias.

## Alternativas descartadas
- **A — status quo:** flujo implícito; descartada por la desviación de orden.
- **B — config en dos secciones (flujo normativo + invariantes):** preserva la
  narrativa de #13352 pero mantiene el proceso dentro de la autoridad; el
  operador prefirió C.
- **C1 — orden declarado como regla en config:** depende de respetar la secuencia
  en vez de precondiciones verificables.
- **C2 puro:** sin respaldo explícito de precedencia.
- **DSL ejecutable (entry/exit/guards/RBAC):** choca con KISS e INT-007.

## Consecuencias
Config deja de narrar el proceso; esa descripción se traslada al skill
`work-lifecycle` —consecuencia **aceptada por el operador** (contradice #13352).
Las 7 etapas quedan definidas por primera vez, en el skill.

Limpieza de config aplicada en esta pasada, bajo autorización del operador:

- **Contradicción del PoC (resuelta).** `do_work.investigation` ya no afirma *"a
  probe does not replace the separate PoC task required for a new capability"*,
  que chocaba con `prepare_work.new_capability` (implementación directa primero;
  experimento separado solo ante un unknown material). Elimina una ceremonia de
  PoC obligatorio inexistente en la otra regla.
- **Ceremonia del revisor (relajada).** `accept_work.review` pide una revisión
  independiente **según riesgo**, con self-review en los demás casos y sin
  preferencia de familia/proveedor. Se eliminó *"fresh"* y *"different model
  family or provider"*.
- **Procedimiento extraído.** Las claves de ciclo de vida se recortaron a su
  invariante; el flujo paso-a-paso (comandos git de `starting_point`/`close`,
  intake, readiness detallada, probe, backscroll, pasos de cleanup) vive solo en
  el skill. Config queda en invariantes.
- **Derivados corregidos.** Los tests dogfood de perfil que congelaban ese texto
  procedimental se actualizaron a los invariantes (config prevalece,
  `authority.derived`).

**Este ADR no entra en vigor hasta aprobación del operador e integración en
main**; refina la organización del WoW de ADR 0061 sin anular su autoridad única.

## Pendientes
- Validar el skill `work-lifecycle` en el harness consumidor (E2E).
- Seguir barriendo inconsistencias/ceremonia si el operador lo pide.
- Crear Bead y abrir PR para integrar.
