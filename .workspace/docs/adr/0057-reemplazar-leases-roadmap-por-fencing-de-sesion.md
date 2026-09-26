---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'Roadmap unifica planificación y ejecución sobre Beads, pero sus claims usan leases de cinco minutos y heartbeats entre etapas; una etapa LLM puede exceder el TTL, las sesiones suelen compartir actor y el control temporal añade esperas sin impedir de forma fiable la doble ejecución ni facilitar la reanudación.'
decision: 'Conservar Roadmap como única interfaz de plan, árbol, Doctor y loop secuencial sobre Beads, y sustituir claim, heartbeat y reclaim del flujo normal por fencing no temporal: cada controlador usa PI_SESSION_ID, inicia mediante CAS, una nueva invocación toma automáticamente una tarea interrumpida por CAS y el Bead conserva checkpoints para reanudar desde la primera etapa incompleta.'
alternativas: 'Eliminar todo ownership se descarta porque no invalida a la sesión anterior; ampliar el TTL o añadir un heartbeat periódico se descarta porque conserva esperas y requiere runtime adicional para una skill Markdown-only; conservar el lease actual se descarta porque ya expiró durante trabajo LLM y no separa sesiones que comparten actor.'
consecuencias: 'Roadmap seguirá siendo Markdown-only y secuencial; loop, contracts, tree, Doctor y sus escenarios de presión deben usar controller_session y checkpoints, ignorar leases legacy como autoridad y mantener el cierre condicionado de ADR 0033 contra la sesión vigente; ADR 0048 y ADR 0050 conservan su alcance.'
---
# 0057. Reemplazar leases roadmap por fencing de sesion

Reemplaza a 0044-unificar-planificacion-y-ejecucion-en-roadmap.

## Contexto
Roadmap unifica planificación y ejecución sobre Beads, pero sus claims usan leases de cinco minutos y heartbeats entre etapas; una etapa LLM puede exceder el TTL, las sesiones suelen compartir actor y el control temporal añade esperas sin impedir de forma fiable la doble ejecución ni facilitar la reanudación.

## Decisión
Conservar Roadmap como única interfaz de plan, árbol, Doctor y loop secuencial sobre Beads, y sustituir claim, heartbeat y reclaim del flujo normal por fencing no temporal: cada controlador usa PI_SESSION_ID, inicia mediante CAS, una nueva invocación toma automáticamente una tarea interrumpida por CAS y el Bead conserva checkpoints para reanudar desde la primera etapa incompleta.

## Alternativas descartadas
Eliminar todo ownership se descarta porque no invalida a la sesión anterior; ampliar el TTL o añadir un heartbeat periódico se descarta porque conserva esperas y requiere runtime adicional para una skill Markdown-only; conservar el lease actual se descarta porque ya expiró durante trabajo LLM y no separa sesiones que comparten actor.

## Consecuencias
Roadmap seguirá siendo Markdown-only y secuencial; loop, contracts, tree, Doctor y sus escenarios de presión deben usar controller_session y checkpoints, ignorar leases legacy como autoridad y mantener el cierre condicionado de ADR 0033 contra la sesión vigente; ADR 0048 y ADR 0050 conservan su alcance.
