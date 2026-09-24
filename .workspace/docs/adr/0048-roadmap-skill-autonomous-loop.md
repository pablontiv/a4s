---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'ADR 0044 esperaba migración de lógica determinista y pruebas de beads-loop a roadmap; pero la spec .workspace/docs/specs/2026-09-24-roadmap-on-beads-design.md (commit ab69df8) definió roadmap como skill solo Markdown y el commit 5590abb retiró código/tests de beads-loop. El operador decidió que el loop de roadmap sea autónomo por defecto (encadena tasks hasta condición de paro) y que el pacing (wake/reintento/ScheduleWakeup) sea responsabilidad del reconciler (épica a4s-knt).'
decision: 'Roadmap es un skill solo Markdown: no migra lógica determinista ni pruebas de beads-loop; la verificación es por escenarios de presión con agentes frescos (skills/roadmap/README.md ''Verification''). El loop es autónomo por defecto hasta una condición de paro explícita. El pacing y re-despacho corresponden al reconciler (a4s-knt), el skill no usa ScheduleWakeup.'
alternativas: 'Mantener 0044 como referencia parcial evita reescribir decisiones aceptadas; versionar spec de roadmap en commit histórico preserva el contrato; solo Markdown reduce superficie de runtime y simplifica verificación; autonomía por defecto alinea con ADR 0047 modo autónomo supervisado.'
consecuencias: 'Roadmap es responsable de encadenamiento de tasks hasta paro explícito; el reconciler (a4s-knt) gestiona pacing y re-despacho fuera del skill; no se migran tests ni lógica determinista de beads-loop; verificación es por presión con agentes frescos en escenarios acotados.'
---
# 0048. Roadmap skill autonomous loop

Sustituye parcialmente a 0044-unificar-planificacion-y-ejecucion-en-roadmap.md (decisión a, b, c; 0044 permanece accepted). Cita ADR 0047-modo-entrega-autonomo-supervisado.md.

## Contexto
ADR 0044 esperaba migración de lógica determinista y pruebas de beads-loop a roadmap; pero la spec .workspace/docs/specs/2026-09-24-roadmap-on-beads-design.md (commit ab69df8) definió roadmap como skill solo Markdown y el commit 5590abb retiró código/tests de beads-loop. El operador decidió que el loop de roadmap sea autónomo por defecto (encadena tasks hasta condición de paro) y que el pacing (wake/reintento/ScheduleWakeup) sea responsabilidad del reconciler (épica a4s-knt).

## Decisión
Roadmap es un skill solo Markdown: no migra lógica determinista ni pruebas de beads-loop; la verificación es por escenarios de presión con agentes frescos (skills/roadmap/README.md 'Verification'). El loop es autónomo por defecto hasta una condición de paro explícita. El pacing y re-despacho corresponden al reconciler (a4s-knt), el skill no usa ScheduleWakeup.

## Alternativas descartadas
Mantener 0044 como referencia parcial evita reescribir decisiones aceptadas; versionar spec de roadmap en commit histórico preserva el contrato; solo Markdown reduce superficie de runtime y simplifica verificación; autonomía por defecto alinea con ADR 0047 modo autónomo supervisado.

## Consecuencias
Roadmap es responsable de encadenamiento de tasks hasta paro explícito; el reconciler (a4s-knt) gestiona pacing y re-despacho fuera del skill; no se migran tests ni lógica determinista de beads-loop; verificación es por presión con agentes frescos en escenarios acotados.
