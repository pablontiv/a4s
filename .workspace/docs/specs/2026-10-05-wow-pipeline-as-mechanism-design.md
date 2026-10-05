---
tipo: spec
estado: draft
fecha: '2026-10-05'
title: WoW — pipeline como mecanismo, config como invariantes (Opción C)
authority_source: .workspace/config.yaml
baseline_sha: db209c97879eb564a6558d9005bc6c4101308dc1
---

# WoW — pipeline como mecanismo, config como invariantes (Opción C)

> Borrador de diseño. No es autoridad. No modifica `.workspace/config.yaml` ni
> ningún registro vigente. Cambiar config es `reserved_authority`: requiere
> autorización explícita del operador y un ADR aprobado. Este documento propone
> el diseño para esa decisión.

## 1. Problema

`.workspace/config.yaml` solapa dos artefactos distintos:

1. Un **flujo ordenado** (pipeline) que el ejecutor debería seguir: *qué hacer a
   continuación*. Sus claves de primer nivel (`choose_work` → `define_work` →
   `prepare_work` → `do_work` → `accept_work` → `deliver_work` → `track_work` →
   `improve_work`) están organizadas por fase y **parecen** un pipeline.
2. Un conjunto de **reglas/invariantes transversales**: autoridad, seguridad,
   credenciales, autoridad reservada, revisión. Valen en cualquier fase.

Síntomas del solapamiento:

- Los **pasos del pipeline nunca se enumeraron**. Su orden solo existe implícito,
  por el orden de las claves y por referencias cruzadas
  (`accept_work.end_to_end`, `deliver_work.merge`). La evidencia de campo (ReAct,
  Plan-and-Execute; convergencia de LangGraph/Swarm/CrewAI) indica que el orden
  implícito **se desvía** en procedimientos de más de ~5 pasos o con ramas.
- Invariantes transversales viven dentro de cubetas de fase (p. ej. `safety`
  bajo `do_work`, `reserved_authority` bajo `deliver_work`), aunque aplican
  siempre.
- Las fases no cierran como pipeline lineal: `authority`, `roles`, `product` son
  transversales; `track_work` es **concurrente**; `improve_work` es un **lazo de
  realimentación**, no un paso terminal.

### Origen histórico

Dos encuadres aterrizaron en el mismo archivo con dos días de diferencia y nunca
se reconciliaron:

- **2026-09-26 (memoria #13352):** el operador pidió que config fuera una
  definición de **Way of Working** en prosa — enfoque, ciclo de vida/cadencia,
  gobernanza, roles/artefactos — que *describa cómo se convierten requisitos en
  valor y por qué ese proceso*.
- **2026-09-28 (ADR 0061):** config pasó a ser la **autoridad de reglas** —
  fuente normativa única; todo lo demás se audita contra ella.

## 2. Decisión adoptada: Opción C

El operador eligió **C**: `config.yaml` queda como **autoridad de invariantes**
(reglas puras); el **pipeline** (el flujo ordenado con pasos explícitos) vive
como **mecanismo** — un skill/método que *lee su política del config* y no añade
regla propia, en los términos de `authority.mechanism` de ADR 0061:
*"Skills and methods provide technique and read their policy from this file;
they add no rule of their own."*

### Consecuencia que el operador debe aceptar

C **contradice el encuadre de #13352**: la *descripción del proceso* deja de
vivir en config y se traslada al mecanismo. Config ya no "describe cómo se
entrega valor"; declara *qué es siempre verdad* y *qué requiere autorización*.
Si esto no es aceptable, la opción B (config en dos secciones: flujo normativo +
invariantes) preserva la descripción del proceso dentro de config.

## 3. Descomposición en cuatro planos

Toda clave actual de `config.yaml` cae en exactamente uno de estos planos. Esto
es lo que hoy está solapado.

| Plano | Naturaleza | Dónde vive en C | Claves actuales |
| --- | --- | --- | --- |
| **1. Pipeline** | Flujo ordenado por unidad de trabajo (técnica/secuencia) | **Mecanismo** (skill/método) | `choose_work`, `define_work`, `prepare_work`, el *cómo* de `do_work`, `accept_work`, `deliver_work.mechanism/cadence/merge/external_prs/close` |
| **2. Invariantes transversales** | Reglas siempre-activas (autoridad) | **config.yaml** | `authority`, `roles`, `do_work.safety`, `do_work.credentials`, `do_work.communication`, `do_work.history`, `do_work.decision_records`, `deliver_work.reserved_authority`, `product` |
| **3. Lazo de realimentación** | Revisión del propio WoW (no es paso terminal) | **config.yaml** (gobernanza) | `improve_work.review/early_review/change` |
| **4. Concurrente/continuo** | Estado y reporte en paralelo al flujo | **config.yaml** (invariante de reporte) + lo invoca el mecanismo | `track_work.progress/blockers/controller_identity` |

`do_work.modes` (assignment / autonomous / common_rule) es el **selector de
entrada** al pipeline: gobierna *cómo* una unidad entra al flujo. Es invariante
(config), y el mecanismo lo consulta como condición de arranque.

## 4. Las etapas del pipeline (modelo stage-gate)

**Un solo skill** `work-lifecycle` contiene las 7 etapas (no un skill por etapa:
eso multiplicaba la ceremonia de la casa). Cada etapa declara un **Gate de
inicio** (precondiciones para entrar) y un **Gate de fin** (postcondiciones para
salir/avanzar), estructurados con tags XML (§4.1). Cada gate resuelve contra
invariantes del config (la etapa no inventa regla). El orden emerge (C2): el Gate
de inicio de una etapa exige la evidencia que produjo el Gate de fin de la
anterior; no hay secuencia declarada en ninguna parte.

**Gate de admisión (inicio del pipeline):** hay una necesidad del operador
presentada **y** el selector de modo (`do_work.modes`) autoriza la entrada.
Config: `choose_work.intake`, `do_work.modes`, `roles`.

| # | Skill (estándar) | Gate de inicio | Actividad | Gate de fin | Config (compuerta) |
| --- | --- | --- | --- | --- | --- |
| 1 | `intake` | Gate de admisión superado | Investigar repo/registros/historia; proponer resultados y criterios | El operador elige el resultado, con criterios y scope | `choose_work`, `roles` |
| 2 | `refinement` | Resultado elegido | Clasificar kind; delimitar una unidad con un resultado | Task/epic con un kind | `define_work` |
| 3 | `planning` | Unidad definida | Acordar resultado, criterios, scope, invariantes aplicables, evidencia | Readiness acordada | `prepare_work` |
| 4 | `implementation` | **Readiness acordada ∧ main limpio/sincronizado ∧ worktree dedicado** (gate; el orden emerge, C2) | Implementar; efecto externo solo tras autorización del payload | Candidato con evidencia; checks locales pasan | `do_work.*`, `reserved_authority` |
| 5 | `verification` | Candidato existe | Mapear cada criterio a evidencia; E2E si cambia comportamiento; revisión independiente según riesgo | Aceptado o devuelto | `accept_work` |
| 6 | `delivery` | **Aceptado ∧ sin HIGH abiertos** (gate; el orden emerge, C2) | PR con trailer `Bead:`, checks, merge bajo controles | Integrado en main | `deliver_work.mechanism/merge/external_prs` |
| 7 | `closure` | **Integrado y verificado** (ÚNICA barrera dura: integración→cleanup) | Cleanup exacto preautorizado (worktree, rama, outputs reproducibles) | Unidad cerrada | `deliver_work.close`, `improve_work.cleanup` |

**Gate de cierre (fin del pipeline):** unidad integrada, evidencia durable en el
registro y cleanup exacto verificado. Config: `deliver_work.close`,
`improve_work.cleanup`.

La **única barrera dura** que config aserta es el gate de cierre de la etapa 7
(`integración → cleanup`): nunca limpiar antes de verificar la integración. El
orden de las demás etapas emerge de sus gates (C2); no se declara en config.

**Transversal durante 1–7:** `track_work` (reporte) corre en concurrencia;
`improve_work.review` puede escalar un hallazgo del WoW en cualquier punto.

### 4.1 Forma de los Gates: XML tags (patrón oficial de Claude)

Cada skill estructura su etapa con **tags XML**, el patrón que Anthropic
recomienda para que el modelo parsee instrucciones sin ambigüedad: *"XML tags
help Claude parse complex prompts unambiguously… Wrapping each type of content in
its own tag reduces misinterpretation"* (docs de Claude, *Structure prompts with
XML tags*). Tags consistentes y descriptivos, anidados cuando hay jerarquía:

```
<gate_entry>
  <condition ref="prepare_work">readiness_acordada</condition>
  <condition ref="do_work.starting_point">main_limpio_sincronizado</condition>
  <condition ref="do_work.starting_point">worktree_dedicado</condition>
</gate_entry>
<activity> … técnica del paso … </activity>
<gate_exit>
  <condition ref="accept_work.evidence">candidato_con_evidencia</condition>
  <condition ref="deliver_work.merge">checks_locales_pasan</condition>
</gate_exit>
```

El skill instruye al modelo a emitir su veredicto en un tag verificable:
`<gate_check stage="implementation" result="pass|block">` con la evidencia de
cada condición citando su invariante de config. No es un DSL ejecutable (respeta
KISS e INT-007): es prosa estructurada que el modelo produce y un revisor lee.
Cada `ref` apunta a la clave de config que es la única autoridad de esa regla
(`authority.mechanism`): el gate verifica, no define.

## 5. Cómo funciona el orden en C (decisión abierta)

El punto fino: ADR 0061 dice que el mecanismo "no añade regla propia". Pero el
**orden** (ejecutar antes de aceptar, aceptar antes de entregar) es normativo.
Dos formas de ubicarlo:

- **C1 — el orden es invariante (config), el mecanismo solo coreografía.** Config
  declara invariantes de precedencia ("sin entrega antes de aceptación", "sin
  mutación antes de readiness"). El skill secuencia técnica alrededor de ellos.
  Preserva más de #13352; config aún "sabe" el orden.
- **C2 — el orden emerge de las compuertas (estilo OPA).** El orden no se declara
  en ninguna parte como secuencia; emerge de las precondiciones por invariante
  (no puedes entregar hasta que pase la compuerta de aceptación). El mecanismo es
  conveniencia; los invariantes garantizan corrección. Más limpio y robusto, pero
  config deja de describir el proceso por completo.

**Recomendación:** C2 por robustez, con un invariante mínimo de precedencia en
config (de C1) que fije las barreras duras (readiness→mutación,
aceptación→entrega, integración→cleanup). Es la decisión abierta #1.

## 6. Qué sale y qué queda en config.yaml

- **Sale de config (pasa al mecanismo):** el *cómo* secuencial de `choose_work`,
  `define_work`, `prepare_work`, `do_work` (procedimiento), `accept_work`
  (procedimiento), `deliver_work.mechanism/cadence/close` (procedimiento).
- **Queda en config como invariante:** `purpose`, `authority`, `roles`,
  `do_work.safety/credentials/communication/history/decision_records`,
  `accept_work.review` (quién/cuándo exige revisión), `deliver_work.merge`
  (controles) y `reserved_authority`, `track_work`, `improve_work`, `product`, y
  los invariantes de precedencia de §5.

La frontera no es "mover texto": es separar *la regla que debe cumplirse*
(queda) de *el procedimiento para cumplirla* (va al mecanismo).

## 7. Decisiones abiertas para el operador

1. **C1 vs C2** para el orden (§5). **RESUELTO: C2 + precedencia mínima.**
2. **Dónde vive el mecanismo. RESUELTO: UN solo skill** `work-lifecycle` con las
   7 etapas (no uno por etapa: multiplicaba la ceremonia de la casa). Se activa
   por su `description` (frases `Trigger:`).
3. **Granularidad de las compuertas. RESUELTO: Gates en tags XML** (§4.1):
   `<gate_entry>`/`<activity>`/`<gate_exit>` + `<gate_check>`, con condiciones
   nombradas que citan claves de config. Sin DSL ejecutable (KISS, INT-007).
4. **Limpieza de config. HECHA** (autorizada por el operador): resuelta la
   contradicción del PoC obligatorio, relajada la ceremonia del revisor, y
   **recortado el procedimiento de config hacia invariantes** (el flujo
   paso-a-paso vive solo en el skill). Barrido adicional según lo pida el operador.

## 8. Incrementos

1. **[hecho]** Decisiones acordadas con el operador.
2. **[hecho]** ADR **propuesto** `0069` (estado `proposed`).
3. **[hecho]** Skill único `skills/work-lifecycle/SKILL.md` con las 7 etapas y
   Gates XML; ruta en PROFILE; sin test por skill (se evita ceremonia). Tests de
   repo y perfil en verde.
4. **[hecho]** Limpieza de config: PoC eliminado; revisor relajado; procedimiento
   extraído a invariantes; tests dogfood derivados corregidos.
5. Validar `work-lifecycle` en el harness (E2E); crear Bead y PR para integrar.

Todo va por PR con revisión independiente según riesgo (`accept_work.review`). El
PR no requiere aprobación previa (config: *"Pull requests… need no prior
approval"*); solo cambiar `config.yaml` es autoridad reservada.
