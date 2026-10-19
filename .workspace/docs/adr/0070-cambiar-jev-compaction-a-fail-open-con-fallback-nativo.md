---
tipo: adr
estado: accepted
fecha: '2026-10-06'
contexto: 'ADR 0013 estableció que fallos de Jev bloquearían la compactación sin fallback nativo (fail-closed). El operador ha decidido que cuando Jev no esté disponible o falle, la compactación debe caer a la estrategia nativa del host en lugar de bloquear (fail-open).'
decision: 'La extensión session_before_compact ejecutará compactación con Jev en el camino preferido; si Jev no responde, no está disponible o falla, el código caerá a la compactación nativa del host sin bloquear la sesión. Se registrará el fallback y se reportará como telemetría.'
alternativas: 'Mantener fail-closed como en ADR 0013: descartado porque impacta disponibilidad de sesión cuando Jev falla; usar fallback generativo: descartado porque contradice la preferencia por compactación determinista nativa.'
consecuencias: 'Las compactaciones sin autoridad Jev ocurren con más frecuencia de la deseada pero mantienen la disponibilidad de sesión; la pérdida semántica potencial es aceptada como trade-off por resiliencia; telemetría debe registrar tasas de fallback para evaluar la disponibilidad Jev a escala; el objetivo original de ADR 0013 (Jev como autoridad) se relaja hacia Jev como preferido-pero-no-bloqueante.'
pendientes: 'Instrumentar telemetría para tasa de fallback a compactación nativa; evaluar disponibilidad Jev en producción; si fallback nativo se activa más del 5% de intentos de compactación, revisar disponibilidad de Jev.'
superseded_by: ''
---
# 0070. Cambiar jev compaction a fail-open con fallback nativo

Reemplaza a 0013-usar-jev-como-autoridad-de-compaction-semantica.

## Contexto
ADR 0013 estableció que fallos de Jev bloquearían la compactación sin fallback nativo (fail-closed). El operador ha decidido que cuando Jev no esté disponible o falle, la compactación debe caer a la estrategia nativa del host en lugar de bloquear (fail-open).

## Decisión
La extensión session_before_compact ejecutará compactación con Jev en el camino preferido; si Jev no responde, no está disponible o falla, el código caerá a la compactación nativa del host sin bloquear la sesión. Se registrará el fallback y se reportará como telemetría.

## Alternativas descartadas
Mantener fail-closed como en ADR 0013: descartado porque impacta disponibilidad de sesión cuando Jev falla; usar fallback generativo: descartado porque contradice la preferencia por compactación determinista nativa.

## Consecuencias
Las compactaciones sin autoridad Jev ocurren con más frecuencia de la deseada pero mantienen la disponibilidad de sesión; la pérdida semántica potencial es aceptada como trade-off por resiliencia; telemetría debe registrar tasas de fallback para evaluar la disponibilidad Jev a escala; el objetivo original de ADR 0013 (Jev como autoridad) se relaja hacia Jev como preferido-pero-no-bloqueante.

## Pendientes
Instrumentar telemetría para tasa de fallback a compactación nativa; evaluar disponibilidad Jev en producción; si fallback nativo se activa más del 5% de intentos de compactación, revisar disponibilidad de Jev.
