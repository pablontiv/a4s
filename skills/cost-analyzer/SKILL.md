---
name: cost-analyzer
metadata:
  author: pablontiv
description: Analiza un ledger canónico de sesiones Pi, Claude Code y Codex; Pi se clasifica además en S1-S4 y j0k3r/pi-subagents. Use when the user asks about costo/tokens/outcomes por harness, extensión Pi, topología de agentes o subagentes. Requiere `git`, opcionalmente `gh` y `bd`.
---

## What this skill answers

Dada la pregunta del usuario sobre el gasto de Pi por topología de dispatch, este skill entrega el cuadro clásico S1–S4 **más outcomes reales**:

| Escenario | Definición | Qué hace |
|---|---|---|
| **S1** | Solo (1 agente, todo) | Ejecuta trabajo. Commitea código. |
| **S2** | Solo + subagentes | Un agente que abre sub-agentes. Caro. |
| **S3** | Orquestador + minions (peer, sin subagentes) | Un tab por unidad de trabajo. Barato. |
| **S4** | Orquestador + minions CON subagentes (anidado) | Orquestador que delega. El más caro. |

El método base del 18-sept (sesión 2026-09-18 18:24 UTC) está preservado en `assets/quad.py`. El clasificador del skill añade la superficie legacy de Pi descubierta al ampliar a mayo–agosto — **NO improvisar otras señales sin prueba de regresión**.

## Method (original + compatibilidad legacy)

Proxies de **orquestado**:
- `customType` empieza con `intercom`
- `customType` empieza con `fm-` o contiene `firstmate`
- directorio contiene `a4s`, `bead-hs`, `review`, o `worktrees`

Proxies de **delegó** (ambas superficies son equivalentes):
- `customType == 'subagent-notify'` — formato actual
- bloque `message.content[]` con `type='toolCall'` y `name in {'subagent', 'subagent_run'}` — formato legacy, dominante en agosto

Costos: `usage.cost.total` por cada `message`/`compaction` en el JSONL.
Tokens: `usage.totalTokens` por cada `message`/`compaction`.
Filtro: `os.path.getmtime(p)` del archivo, NO timestamp interno.

**Crítico**: Pi tiene dos serializaciones: `custom`/`custom_message` con `customType` y tool calls embebidos en `message.content[]`. Buscar `obj.type == 'tool'` retorna **cero** hits. Ignorar el tool call legacy `subagent`/`subagent_run` clasifica falsamente sesiones S2 como S1 y sesiones S4 como S3; agosto quedaba falsamente como S2=0.

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

- **Nunca improvisar clasificador**. El método base del 18-sept y su compatibilidad legacy están en `quad.py`. Si necesitas modificarlo, añade primero una prueba de regresión (`assets/test_quad.py`) y compáralo contra un rango conocido.
- **Filtrar por mtime**, no por timestamp interno. Sesiones antiguas reabriertas/migradas después del cutoff SÍ cuentan.
- **El filtro mtime es la ÚNICA fuente de rango válida**. No usar el timestamp del primer mensaje.
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
