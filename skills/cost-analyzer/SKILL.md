---
name: cost-analyzer
metadata:
  author: pablontiv
  updated: "2026-10-06"
description: Analiza un ledger canónico de sesiones Pi, Claude Code y Codex de TODAS LAS SESIONES (sin filtro de proyecto). Clasifica sesiones Pi en 4 formas de topología. Costo/cuota predicho por tokens (input/output/cacheRead/cacheWrite), no por forma. Use when the user asks about costo/tokens/outcomes por harness, topología de sesión, o eficiencia de delegación. Requiere `git`, opcionalmente `gh` y `bd`.
---

## What this skill answers

El skill analiza sesiones de TODOS LOS PROYECTOS (Pi, Claude Code, Codex) y clasifica las sesiones Pi en 4 formas de topología independientes del costo. El costo/cuota se predice por tokens consumidos, no por forma.

### 4-Form Topology Model (Pi only)

| Forma | Definición | Señales | Confianza |
|-------|-----------|---------|-----------|
| **Form 1: Solo** | Un agente, sin subagentes, sin coordinación cross-sesión | `subagent-notify == 0`, sin `intercom` | direct (ausencia de señales) |
| **Form 2: Orch-Hybrid** | Subagentes presentes + trabajo directo del agente (grado mixto) | Delegación presente, `delegation_degree < 0.8` | direct (si señales de delegación) |
| **Form 3: Delegator-Pure** | Delegación dominante (>= 80% de turnos) | Delegación presente, `delegation_degree >= 0.8` | direct (si señales de delegación) |
| **Form 4: Cross-Session** | Coordina sesiones separadas (PARCIAL/heurística, requiere `parent_session_id` para prueba) | `intercom` presente + heurística de sesiones distintas | inferred (heurística sin parent_session_id) |

**intercom Flag (Orthogonal)**: Presente en cualquier forma. No determina forma. Campo `has_intercom` aparte.

**Delegation Degree (0.0–1.0)**: `spawn_tool_calls / assistant_turns`. Proxy medible para distinguir Form 2 vs 3.

### Legacy S1-S4 Compatibility

El skill mantiene compatible la nomenclatura S1-S4 para reportes legacy:
- S1 ↔ Form 1 (Solo)
- S2 ↔ Form 2 (Orch-Hybrid con bajo grado)
- S3 ↔ Form 2 (Orch-Hybrid con alto grado) o Form 3 (Delegator-Pure)
- S4 ↔ Form 4 (Cross-Session)

**Cambios en v2 (2026-10-06)**:
- Quitó heurístico de directorio (a4s, bead-hs, review, worktrees) — DEFECT 1
- Añadió detección de `intercom` como `toolCall` — DEFECT 2
- Añadió vista de tokens con desglose de cacheRead — DEFECT 3
- Implementó 4-form model con degree-based distinction — DEFECT 4
- Expandió alcance a TODAS LAS SESIONES (quitó filtro de a4s)

El método base del 18-sept está preservado en `assets/quad.py`. Classifier añade superficie legacy de agosto — **NO improvisar otras señales sin prueba de regresión**.

## Method (4-Form + Token-Based Cost)

### Session Discovery (Scope = ALL SESSIONS)

Busca recursivamente JSONL en todas las raíces (sin filtro de proyecto):
- Pi: `~/.pi/agent/sessions/**/*.jsonl`
- Claude: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/**/*.jsonl`

Filtro por mtime del archivo: `os.path.getmtime(path)`, NO timestamp interno.

**Cambio**: Antes filtraba a4s. Ahora analiza TODAS LAS SESIONES.

### Form Classification Signals (Pi only)

**Delegación** (subagent spawning):
- `customType == 'subagent-notify'` (formato actual)
- `message.content[]` con `type='toolCall'` y `name in {'subagent', 'subagent_run'}` (legacy, agosto)

**Coordinación** (intercom/fm):
- `customType` comienza con `intercom` (actual)
- `message.content[]` con `type='toolCall'` y `name == 'intercom'` (legacy)
- `customType` comienza con `fm-` o contiene `firstmate`

**Grado de Delegación** (`delegation_degree`):
- Ratio: `spawn_tool_calls / assistant_turns` (0.0–1.0)
- Umbral Form 2 vs 3: 0.8 (>= 80% delegación = Form 3, < 80% = Form 2)

**Nota**: Quitó heurístico de directorio (a4s, bead-hs, review, worktrees). No marca sesiones como orquestadas por ruta.

### Cost Model = TOKENS (No by Form)

**Métrica principal**: Tokens consumidos por sesión (no costo por forma ni $/sesión por topología):

```
Quota consumed = ∑(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)
```

Desglose por harness y modelo (ver `render_tokens_breakdown()` view).

**cacheRead**: Cuenta contra cuota aunque costo en USD sea menor. Campo ortogonal en resultado.

**Costo nativo** (Pi only): `usage.cost.total` para referencia histórica, pero NO es proxy de cuota. Usar tokens para predicción.

**Crítico**: Pi tiene dos serializaciones: `custom`/`custom_message` con `customType` y tool calls en `message.content[]`. Buscar `obj.type == 'tool'` retorna **cero** hits. Ignorar legacy `subagent`/`subagent_run` clasifica falsamente.

## Outcomes reales (opcional pero recomendado)

Para cada sesión clasificada:

1. **Commits**: `git log --since/--until` en el `cwd` de la sesión durante su ventana temporal. El reporte deduplica SHAs dentro de cada escenario: reporta commits únicos, no apariciones duplicadas por sesiones solapadas.
2. **PRs merged**: `gh pr list --search <sha>` por cada commit, deduplicado por PR number.
3. **Beads cerradas**: `bd list --status=closed --json` filtrado por `metadata.worktree` matching el cwd.
4. **Subagentes**: conteo de `customType='subagent-notify'` + fan-out máximo (cuántos en ventana de 60s).
5. **Atribución S3/S4 → S1 spawneadas** (`attribution.py`): grafo de qué S1 fueron lanzadas por cada S3/S4. Heurística: la S1 se inicia durante la ventana del orquestador (+buffer 60min) Y comparte worktree/repo parent. Devuelve ratio `$orch / $S1_spawned` — si >>1, el orquestador quema contexto sin entregar.

## Usage

### Reporte completo Pi (cost + outcomes)

```bash
python3 assets/report.py --since 2026-09-18 [--until 2026-09-21] [--out report.md]
```

Salida: cuadro S1–S4, tabla por día, tabla de outcomes, tabla de costo por outcome.

### Indicador de harness: Pi / Claude / Codex

```bash
python3 assets/report.py --since 2026-08-01 --until 2026-09-30 --view harness
python3 assets/report.py --since 2026-08-01 --until 2026-09-30 --view topology
python3 assets/report.py --since 2026-08-01 --until 2026-09-30 --view harness --with-commits
```

Las vistas muestran tokens, SHAs únicos, `tokens/SHA` y cobertura Git. `--view topology` cruza Pi, Claude y Codex con S1–S4/unknown. `--with-commits` consulta `git log` por sesión y añade SHAs únicos; es lento. Menor `tokens/SHA` es más eficiente en unidad de trabajo, no prueba valor final. Claude/Codex no se declaran ganadores en dólares porque sus logs no exponen costo nativo.

### Eficiencia de entrega (opt-in)

```bash
python3 assets/report.py --since 2026-09-01 --until 2026-09-16 \
  --view delivery-efficiency --evaluation-date 2026-09-24
```

Esta vista calcula **Cost per Durable Production Change (CDPC)**: coste nativo atribuible dividido por commits de código de producción que tienen al menos una ventana **seven-day** de madurez, siguen alcanzables desde la rama principal y no presentan un revert explícito. Mantiene la selección de sesiones exclusivamente por `mtime`; la fecha de evaluación solo clasifica los outcomes Git de esas sesiones ya seleccionadas.

No mezcla SHAs observados por varias topologías: los informa como cohorte `mixed` y los excluye de los denominadores S1–S4. Solo filas del mismo repositorio/value stream con cobertura atribuible ≥80% y estado `ranked` son comparables. La vista muestra reverts, tiempo mediano hasta el commit durable, candidatos inmaduros/desconocidos y cobertura. Es lectura local de Git; no modifica refs, ramas ni remotos.

### Solo clasificador (rápido)

```bash
python3 assets/quad.py --since 2026-09-18 [--json] [--files]
```

### Solo outcomes (asume clasificación ya hecha)

```bash
python3 assets/outcomes.py --since 2026-09-18 [--until 2026-09-21] [--no-prs] [--no-beads]
```

`--no-prs` y `--no-beads` saltan los lookups costosos.

### Solo attribution S3/S4 → S1

```bash
python3 assets/attribution.py --since 2026-09-18 [--until 2026-09-21] [--buffer-min 60]
```

Devuelve para cada orquestador: cuántas S1 spawneó, costo del orquestador, costo de las S1 spawneadas, ratio. Útil para detectar orquestadores que queman contexto sin entregar trabajo.

### Comparar extensiones: j0k3r vs pi-subagents

```bash
python3 assets/extensions.py --since 2026-05-01 --until 2026-09-30
```

Divide por el cutover verificado `2026-09-04T04:43:09Z`: sesiones antes = `pi-subagents-j0k3r`, posteriores = `pi-subagents`; sesiones que cruzan la frontera o no tienen timestamps = `mixed/unknown` y se excluyen del ganador. Informa costo, SHAs únicos, $/commit y el cruce extensión × S1–S4 con `tokens/SHA`; es la vista reproducible para comparar `j0k3r + S2` contra `pi-subagents + S2`.

## Hard Rules

- **Nunca improvisar clasificador**. El método de 4 formas está en `dataset.py` (functions: `classify_pi_form`, `calculate_delegation_degree`). Si necesitas modificarlo, añade primero una prueba de regresión (`assets/test_quad.py`) contra un rango conocido.
- **Alcance = TODAS LAS SESIONES**. No filtrar por proyecto ni por directorio. Busca recursivamente en todas las raíces (Pi, Claude, Codex).
- **Filtrar por mtime**, no por timestamp interno. Sesiones antiguas reabriertas/migradas después del cutoff SÍ cuentan.
- **El filtro mtime es la ÚNICA fuente de rango válida**. No usar el timestamp del primer mensaje.
- **Costo/Cuota = TOKENS, no Form**. Métrica: ∑(input + output + cacheRead + cacheWrite) por sesión. Usar `render_tokens_breakdown()` view, no $/form.
- **intercom es ORTHOGONAL**. Presente en cualquier forma. Campo `has_intercom` independiente de `form`.
- **delegation_degree para distinguir Form 2 vs 3**. Umbral: 0.8 (>= 80% = Form 3 Delegator-Pure, < 80% = Form 2 Orch-Hybrid).
- **Reportar SIEMPRE el rango de fechas en el cuadro** (incluido en el header).

## Interpretation guide

| Patrón en los datos | Lo que significa |
|---|---|
| S4 = >50% del gasto | Presión presupuestaria alta; no prueba por sí sola una topología ineficiente. |
| S2 reaparece después de prohibirse | Algún flujo todavía genera S2 (posiblemente migración o skill no aplicado). |
| S4 con 0 commits pero >$100/sess | Señal de investigación; comprobar `delivery-efficiency` antes de concluir falta de entrega. |
| S3 con cacheRead >95% | Describe volumen de caché, no eficiencia ni precio relativo. |
| S1 con commits/sess <0.5 | Actividad baja; no concluye ineficiencia sin CDPC, cobertura y calidad. |
| **Ratio $orch / $S1_spawned > 5** | Señal de coste de orquestación; contrastar con cambios durables antes de tomar una decisión. |
| `j0k3r` vs `pi-subagents` | Comparación observacional por cohortes temporales; no atribuir causalidad sin controlar tareas/repos. |

### ADVERTENCIA: commits ≠ valor

Los commits como métrica de éxito son **engañosos**. Sesiones que iteran sobre trabajo especulativo (documentos no pedidos, pruebas especulativas, refactors no aprobados) pueden tener **muchos commits** y **cero valor entregado**.

El usuario explícitamente rechazó esta métrica el 2026-09-21: muchas sesiones S3 de los últimos días se centraron en "retomar la idea que se repitió varias veces porque los pr/commits eran humo".

**Métricas más confiables para "valor real":**
1. **PRs merged que sobreviven 7 días** (no revertidos). Proxy: `git log` después de la fecha del PR.
2. **Beads cerradas con outcome durable** (no "doc", "wip", "draft").
3. **Líneas de código en producción** (excluyendo `*.md`, `*.test.*`, `__tests__/`).
4. **Ratio commits_revertidos / commits_total** en los 7 días post-merge.
5. **Tiempo a "accepted"** desde el primer commit hasta el merge del PR.

Si solo tienes commits como proxy, **categorízalos** (code vs doc vs test) antes de comparar $/commit entre escenarios.

## Hard-won lessons (del 18-sept)

1. **`obj.type == 'tool'` retorna 0 hits en Pi**. Las herramientas son `custom`/`custom_message` con `customType` o tool calls embebidos en `message.content[]`. Cualquier clasificador que use `type=tool` clasificará todo como S1 y reportará S4 = 0 (falso).
2. **El ADR 0015 del 18-sept NO detuvo S4**. El 18-sept fue el día MÁXIMO de S4 ($3,728). El 19-sept fue el único día limpio ($0 S4). El 21-sept S4 volvió con $430. El skill pega a las sesiones NUEVAS, no a las que ya estaban abiertas.
3. **S4 post-ADR ($198/sess) es MÁS caro que S4 histórico ($79/sess)**. Las S4 que se abrieron después del cambio son las más caras, no las más baratas.
4. **Septiembre 2026 costó 4× agosto 2026** ($13,408 vs $3,010). El pico es S4.
5. **El usuario espera números con el método del 18-sept**, no aproximaciones. Si el clasificador requiere cambios, partir de `assets/quad.py` y añadir una regresión antes de cambiar sus señales.

## Files

```
cost-analyzer/
├── SKILL.md                      # este archivo
├── assets/
│   ├── quad.py                   # clasificador S1–S4 (actual + legacy)
│   ├── test_quad.py              # regresión de serialización legacy
│   ├── outcomes.py               # commits + PRs + beads
│   ├── attribution.py            # grafo S3/S4 -> S1 spawneadas
│   ├── extensions.py             # j0k3r vs pi-subagents por cutover
│   ├── test_extensions.py        # regresión de la frontera de cutover
│   ├── test_outcomes.py          # contrato de outcomes incompletos
│   └── report.py                 # orquestador (incluye attribution)
└── examples/
    └── report-september-2026.md  # ejemplo de salida
```

## Memory

Después de usar el skill, guardar con `mem_save`:
- Solo si el usuario decide algo nuevo (ej. "S4 ahora también incluye X")
- Solo si descubres un nuevo patrón en los datos que cambia la interpretación
- NO guardar el cuadro de resultados — es data, no aprendizaje
- topic_key sugerido: `pi-auto-router/cost-analyzer-method`
