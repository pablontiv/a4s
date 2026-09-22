---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'Pi tiene USD nativo, Claude y Codex solo tokens; S1-S4 debe cubrir los tres harnesses.'
decision: 'Usar tokens por SHA único como ranking universal, mantener USD solo para Pi y clasificar topología por evidencia con estado unknown.'
alternativas: 'Estimar USD por modelo: introduce supuestos; exigir PR o bead: excluye trabajo válido; usar SHAs como valor: confunde actividad con valor.'
consecuencias: 'Los reportes comparan consumo y trabajo observable sin tratar costos ausentes como cero; la migración de CLIs legacy debe consumir SessionRecord.'
pendientes: ""
---
# 0001. Cross harness token efficiency

## Contexto
Pi tiene USD nativo, Claude y Codex solo tokens; S1-S4 debe cubrir los tres harnesses.

## Decisión
Usar tokens por SHA único como ranking universal, mantener USD solo para Pi y clasificar topología por evidencia con estado unknown.

## Alternativas descartadas
Estimar USD por modelo: introduce supuestos; exigir PR o bead: excluye trabajo válido; usar SHAs como valor: confunde actividad con valor.

## Consecuencias
Los reportes comparan consumo y trabajo observable sin tratar costos ausentes como cero; la migración de CLIs legacy debe consumir SessionRecord.

## Pendientes
La cobertura Git y coordinación externa puede ser incompleta.
