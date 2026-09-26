---
tipo: adr
estado: superseded
fecha: '2026-09-24'
contexto: 'La skill beads-loop sólo ejecuta una proyección del backlog y ha producido falsos finales sin trabajo cuando status parking, ownership stale o contratos incompletos ocultan la frontera; el Roadmap histórico ya unificaba propuesta, árbol pendiente y ejecución, mientras Beads y .workspace aportan estado durable y DoD configurable.'
decision: 'Reemplazar beads-loop por una única skill global roadmap: roadmap plan propone epic/task y pide autorización antes de materializar en Beads; roadmap sin argumentos muestra y explica el árbol pendiente; roadmap doctor alinea backlogs existentes; roadmap loop valida contratos, reconcilia bd ready con la frontera topológica blocks, reclama una task por vez con heartbeat, ejecuta mediante subagentes Superpowers y sólo cierra con ACs del Bead más el DoD efectivo de .workspace.'
alternativas: 'Conservar beads-loop como interfaz separada se descarta por duplicar proceso; volver a archivos Roadmap Rootline se descarta porque Beads es el backlog durable; ejecutar sin claims se descarta porque permite trabajo duplicado entre sesiones; usar olas paralelas se descarta por los conflictos y bloqueos operativos observados.'
consecuencias: 'A4S debe retirar la interfaz beads-loop, migrar su lógica determinista y pruebas a roadmap, definir validación y doctor sin inventar requisitos, implementar heartbeat y cierre condicionado, resolver la configuración .workspace por repositorio y conservar Rootline únicamente para conocimiento gobernado.'
superseded_by: 0057-reemplazar-leases-roadmap-por-fencing-de-sesion
---
# 0044. Unificar planificacion y ejecucion en roadmap

Reemplaza a 0035-beads-todo-loop-deterministic-projection.

## Contexto
La skill beads-loop sólo ejecuta una proyección del backlog y ha producido falsos finales sin trabajo cuando status parking, ownership stale o contratos incompletos ocultan la frontera; el Roadmap histórico ya unificaba propuesta, árbol pendiente y ejecución, mientras Beads y .workspace aportan estado durable y DoD configurable.

## Decisión
Reemplazar beads-loop por una única skill global roadmap: roadmap plan propone epic/task y pide autorización antes de materializar en Beads; roadmap sin argumentos muestra y explica el árbol pendiente; roadmap doctor alinea backlogs existentes; roadmap loop valida contratos, reconcilia bd ready con la frontera topológica blocks, reclama una task por vez con heartbeat, ejecuta mediante subagentes Superpowers y sólo cierra con ACs del Bead más el DoD efectivo de .workspace.

## Alternativas descartadas
Conservar beads-loop como interfaz separada se descarta por duplicar proceso; volver a archivos Roadmap Rootline se descarta porque Beads es el backlog durable; ejecutar sin claims se descarta porque permite trabajo duplicado entre sesiones; usar olas paralelas se descarta por los conflictos y bloqueos operativos observados.

## Consecuencias
A4S debe retirar la interfaz beads-loop, migrar su lógica determinista y pruebas a roadmap, definir validación y doctor sin inventar requisitos, implementar heartbeat y cierre condicionado, resolver la configuración .workspace por repositorio y conservar Rootline únicamente para conocimiento gobernado.
