---
tipo: adr
estado: accepted
fecha: '2026-09-23'
contexto: 'El contrato de 0034 mantuvo claim y finalización condicionada, lo que introduce leases de cinco minutos y no reduce la interpretación de backlog del LLM.'
decision: 'Un script determinista proyectará Beads a JSON compacto y realizará detail/finalize sin claim; todo administrará la sesión y el LLM ejecutará sólo el Bead activo.'
alternativas: 'Mantener claims y renovar leases: descartado por complejidad operativa; hacer que el LLM interprete el grafo crudo: descartado por coste de tokens y no determinismo.'
consecuencias: 'La spec define los comandos exactos, la migración de estados in_progress heredados y los E2E desechables.'
---
# 0035. Beads todo loop deterministic projection

Reemplaza a 0034-beads-loop-autonomous-skill-routing.

## Contexto
El contrato de 0034 mantuvo claim y finalización condicionada, lo que introduce leases de cinco minutos y no reduce la interpretación de backlog del LLM.

## Decisión
Un script determinista proyectará Beads a JSON compacto y realizará detail/finalize sin claim; todo administrará la sesión y el LLM ejecutará sólo el Bead activo.

## Alternativas descartadas
Mantener claims y renovar leases: descartado por complejidad operativa; hacer que el LLM interprete el grafo crudo: descartado por coste de tokens y no determinismo.

## Consecuencias
La spec define los comandos exactos, la migración de estados in_progress heredados y los E2E desechables.
