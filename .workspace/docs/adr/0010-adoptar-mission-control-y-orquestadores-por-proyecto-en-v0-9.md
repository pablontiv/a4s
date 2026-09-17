---
tipo: adr
estado: accepted
fecha: '2026-09-17'
contexto: 'La operación simultánea de más de ocho proyectos y la reducción de fatiga observada con Firstmate muestran que el problema global es atención fragmentada, mientras la coordinación semántica permanece local a cada repositorio y a cada cambio.'
decision: 'A4S v0.9 separará un Mission Control global no agentic, Project Orchestrators por repositorio y Missions ejecutadas por una Execution Cell; Mission Control gestionará Attention Tickets, respuestas y steering sin autoridad semántica ni lifecycle LLM propio.'
alternativas: 'Conservar orch-main como LLM global: descartado por duplicar contexto y autoridad y recrear el bottleneck de atención; eliminar todos los Orchestrators: descartado porque cada proyecto requiere ownership semántico; dashboard pasivo: descartado porque observabilidad sin comandos durables no resuelve la intervención.'
consecuencias: 'ADR 0001 y el gate runtime-first de ADR 0009 permanecen vigentes; ADR 0002 queda sustituido; la spec v0.9 mantiene Project Orchestrator, Mission/WorkUnit, Worker, WorkResult y Verification, añade Mission Control y AttentionTicket, y retira orch-main global obligatorio.'
pendientes: ""
---
# 0010. Adoptar mission control y orquestadores por proyecto en v0 9

Reemplaza a 0002-limitar-v0-8-al-corte-vertical-minimo.

## Contexto

La operación simultánea de más de ocho proyectos y la reducción de fatiga observada con Firstmate muestran que el problema global es atención fragmentada, mientras la coordinación semántica permanece local a cada repositorio y a cada cambio.

## Decisión

A4S v0.9 separará un Mission Control global no agentic, Project Orchestrators por repositorio y Missions ejecutadas por una Execution Cell; Mission Control gestionará Attention Tickets, respuestas y steering sin autoridad semántica ni lifecycle LLM propio.

## Alternativas descartadas

Conservar orch-main como LLM global: descartado por duplicar contexto y autoridad y recrear el bottleneck de atención; eliminar todos los Orchestrators: descartado porque cada proyecto requiere ownership semántico; dashboard pasivo: descartado porque observabilidad sin comandos durables no resuelve la intervención.

## Consecuencias

ADR 0001 y el gate runtime-first de ADR 0009 permanecen vigentes; ADR 0002 queda sustituido; la spec v0.9 mantiene Project Orchestrator, Mission/WorkUnit, Worker, WorkResult y Verification, añade Mission Control y AttentionTicket, y retira orch-main global obligatorio.

## Pendientes

Validar empíricamente volumen y latencia de Attention Tickets, carga del operador, residencia de Project Orchestrators y valor de un copilot global opcional y sin autoridad.
