---
tipo: adr
estado: superseded
fecha: '2026-08-31'
contexto: 'La especificación v0.7 incluye recursos y fases que exceden lo necesario para validar la North Star y volvieron la revisión innecesariamente compleja.'
decision: 'A4S v0.8 se limitará a un corte vertical con un Orchestrator, una WorkUnit, un Worker, WorkResult, Verification y outcome, usando PiBridge sin PTY como protocolo.'
alternativas: 'Implementar solo PiBridge: descartado porque no demuestra el resultado verificable; cerrar la arquitectura completa: descartado porque introduce WorkGraph, multi-scope, scheduling y recovery antes de obtener evidencia.'
consecuencias: 'Los gaps se evalúan únicamente por su impacto en el corte vertical; capacidades posteriores permanecen fuera de v0.8 hasta que evidencia operacional las justifique.'
superseded_by: 0010-adoptar-mission-control-y-orquestadores-por-proyecto-en-v0-9
---
# 0002. Limitar v0 8 al corte vertical minimo

## Contexto

La especificación v0.7 incluye recursos y fases que exceden lo necesario para validar la North Star y volvieron la revisión innecesariamente compleja.

## Decisión

A4S v0.8 se limitará a un corte vertical con un Orchestrator, una WorkUnit, un Worker, WorkResult, Verification y outcome, usando PiBridge sin PTY como protocolo.

## Alternativas descartadas

Implementar solo PiBridge: descartado porque no demuestra el resultado verificable; cerrar la arquitectura completa: descartado porque introduce WorkGraph, multi-scope, scheduling y recovery antes de obtener evidencia.

## Consecuencias

Los gaps se evalúan únicamente por su impacto en el corte vertical; capacidades posteriores permanecen fuera de v0.8 hasta que evidencia operacional las justifique.
