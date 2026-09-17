---
tipo: adr
estado: accepted
fecha: '2026-09-17'
contexto: 'El pain point observado no es sólo persistencia ante crash, sino que tareas autorizadas desaparecen del working set; Agentpack, Beads y Gobby ya implementan parte sustancial del ledger y la orquestación, mientras A4S sólo demuestra E0.'
decision: 'A4S no construirá ni mantendrá un segundo control plane mientras un runtime existente no haya sido evaluado mediante incident replay; habrá una sola autoridad del task lifecycle, y A4S permanecerá como contrato, adapters y políticas de verificación hasta decidir con evidencia si adopta un runtime externo o necesita un núcleo propio.'
alternativas: 'Construir a4sd completo ahora: descartado por duplicación prematura; mantener A4S y un runtime externo como autoridades pares: descartado por drift y reconciliación circular; adoptar o forkear Gobby sin bakeoff: descartado por falta de evidencia, ausencia de Pi y restricciones de licencia.'
consecuencias: 'Se pausa la expansión del control plane después de E0; la siguiente entrega es un bakeoff reproducible; la spec v0.8 queda condicionada por su resultado; si un runtime pasa, A4S se reduce a contrato, profile, adapters y verificación; si todos fallan una invariante esencial, esa evidencia justifica implementar sólo el mínimo faltante.'
pendientes: ""
---
# 0009. Evaluar runtime externo antes de construir control plane

## Contexto
El pain point observado no es sólo persistencia ante crash, sino que tareas autorizadas desaparecen del working set; Agentpack, Beads y Gobby ya implementan parte sustancial del ledger y la orquestación, mientras A4S sólo demuestra E0.

## Decisión
A4S no construirá ni mantendrá un segundo control plane mientras un runtime existente no haya sido evaluado mediante incident replay; habrá una sola autoridad del task lifecycle, y A4S permanecerá como contrato, adapters y políticas de verificación hasta decidir con evidencia si adopta un runtime externo o necesita un núcleo propio.

## Alternativas descartadas
Construir a4sd completo ahora: descartado por duplicación prematura; mantener A4S y un runtime externo como autoridades pares: descartado por drift y reconciliación circular; adoptar o forkear Gobby sin bakeoff: descartado por falta de evidencia, ausencia de Pi y restricciones de licencia.

## Consecuencias
Se pausa la expansión del control plane después de E0; la siguiente entrega es un bakeoff reproducible; la spec v0.8 queda condicionada por su resultado; si un runtime pasa, A4S se reduce a contrato, profile, adapters y verificación; si todos fallan una invariante esencial, esa evidencia justifica implementar sólo el mínimo faltante.

## Pendientes
Resultados del bakeoff Gobby 0.4.9; viabilidad del adapter Pi; semantic ACK e idempotencia; fencing de stale owners; efectos ambiguos; Verification independiente; coste operativo, reversibilidad y licencia.
