---
tipo: adr
estado: accepted
fecha: '2026-09-22'
contexto: 'A4S necesita un loop autónomo portable que reduzca la interpretación LLM al operar el backlog Beads desde el repositorio actual.'
decision: 'Adoptar una skill autocontenida y un adapter determinista que delegan doctor, prime, selección y claim en bd; el loop se invoca como /beads-loop, opera sólo en el repositorio actual y no mantiene cola, memoria ni scheduler propios.'
alternativas: 'Skill shell-only: descartada por duplicar policy en prompts y no permitir pruebas de carreras; acoplarlo a Herdr: descartado porque impediría uso agnóstico; usar Rootline: descartado porque Beads es la única autoridad del backlog.'
consecuencias: 'El adapter debe fallar cerrado fuera de Git con .beads, usar bd prime --no-memories y descartar su texto, soportar el doctor compatible con embedded, y registrar evidencia en Beads al cerrar o bloquear.'
---
# 0032. Beads loop adapter

## Contexto
A4S necesita un loop autónomo portable que reduzca la interpretación LLM al operar el backlog Beads desde el repositorio actual.

## Decisión
Adoptar una skill autocontenida y un adapter determinista que delegan doctor, prime, selección y claim en bd; el loop se invoca como /beads-loop, opera sólo en el repositorio actual y no mantiene cola, memoria ni scheduler propios.

## Alternativas descartadas
Skill shell-only: descartada por duplicar policy en prompts y no permitir pruebas de carreras; acoplarlo a Herdr: descartado porque impediría uso agnóstico; usar Rootline: descartado porque Beads es la única autoridad del backlog.

## Consecuencias
El adapter debe fallar cerrado fuera de Git con .beads, usar bd prime --no-memories y descartar su texto, soportar el doctor compatible con embedded, y registrar evidencia en Beads al cerrar o bloquear.
