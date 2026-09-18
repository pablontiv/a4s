---
tipo: adr
estado: accepted
fecha: '2026-09-18'
contexto: 'En S4 el 79 por ciento del gasto fue cacheRead: un orquestador de vida larga releyó contextos de 600K a 1.2M tokens y reinyectó 206 KB de outputs de hijos; además, esperar con herdr agent wait acopla y bloquea al coordinador.'
decision: 'El Orchestrator despachará y rastreará estado mediante veredictos y punteros: cada tab peer escribirá un reporte acotado y, como último paso, enviará un callback con herdr agent prompt al pane o nombre del Orchestrator sin --wait; el Orchestrator permanecerá idle, leerá el artifact-path al recibirlo y no incorporará transcripts completos.'
alternativas: 'Reinyectar respuestas o transcripts completos: descartado por crecimiento de contexto; sondear con wait o timeouts como flujo normal: descartado por bloquear turnos y acoplar lifecycles; añadir ahora una cola propia: descartado por ADR 0009.'
consecuencias: 'Los prompts de dispatch deberán incluir target de callback y ruta de reporte; herdr agent wait queda limitado a recuperación excepcional de agentes colgados o externos no rastreables; fallos de entrega se registrarán como bloqueo y no autorizan reenvíos ciegos.'
pendientes: ""
---
# 0015. Mantener orquestador delgado con handoffs por puntero

## Contexto
En S4 el 79 por ciento del gasto fue cacheRead: un orquestador de vida larga releyó contextos de 600K a 1.2M tokens y reinyectó 206 KB de outputs de hijos; además, esperar con herdr agent wait acopla y bloquea al coordinador.

## Decisión
El Orchestrator despachará y rastreará estado mediante veredictos y punteros: cada tab peer escribirá un reporte acotado y, como último paso, enviará un callback con herdr agent prompt al pane o nombre del Orchestrator sin --wait; el Orchestrator permanecerá idle, leerá el artifact-path al recibirlo y no incorporará transcripts completos.

## Alternativas descartadas
Reinyectar respuestas o transcripts completos: descartado por crecimiento de contexto; sondear con wait o timeouts como flujo normal: descartado por bloquear turnos y acoplar lifecycles; añadir ahora una cola propia: descartado por ADR 0009.

## Consecuencias
Los prompts de dispatch deberán incluir target de callback y ruta de reporte; herdr agent wait queda limitado a recuperación excepcional de agentes colgados o externos no rastreables; fallos de entrega se registrarán como bloqueo y no autorizan reenvíos ciegos.

## Pendientes
Evaluar con el runtime seleccionado si el callback requiere inbox durable, ACK o deduplicación más allá del prompt confirmado por Herdr.
