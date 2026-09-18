---
tipo: adr
estado: accepted
fecha: '2026-09-18'
contexto: 'El owner corrigió el ADR 0017: A4S autoriza únicamente los kinds claude y pi en Herdr; Kimi, MiniMax, xAI, Devin y otros nombres de proveedor o modelo no son kinds autorizados y el texto anterior confundía la superficie del host con el routing interno del agente.'
decision: 'Cada dispatch declarará su altitud sin ampliar los kinds de Herdr: trabajo mecánico o acotado usará kind pi con un preset o routing interno económico hacia proveedores como Kimi o MiniMax, o kind claude con tier Sonnet; razonamiento y orquestación usarán Claude Opus o una ruta fuerte dentro de Pi sólo con justificación explícita.'
alternativas: 'Añadir un kind de Herdr por proveedor o modelo: descartado porque viola la política de kinds autorizados y confunde host con routing; usar premium por defecto: descartado por coste sin evidencia marginal; confiar sólo en el auto-router actual: descartado porque no materializó las rutas económicas planificadas.'
consecuencias: 'skills/herdr/SKILL.md conservará únicamente ejemplos --kind claude y --kind pi; los tiers Claude se pasarán como argumentos nativos y los proveedores o modelos Pi se resolverán mediante su preset o router interno; cada ejecución registrará kind, ruta efectiva, altitud y justificación.'
pendientes: ""
---
# 0018. Enrutar altitud dentro de claude y pi

Reemplaza a 0017-enrutar-modelos-por-altitud-de-tarea.

## Contexto
El owner corrigió el ADR 0017: A4S autoriza únicamente los kinds claude y pi en Herdr; Kimi, MiniMax, xAI, Devin y otros nombres de proveedor o modelo no son kinds autorizados y el texto anterior confundía la superficie del host con el routing interno del agente.

## Decisión
Cada dispatch declarará su altitud sin ampliar los kinds de Herdr: trabajo mecánico o acotado usará kind pi con un preset o routing interno económico hacia proveedores como Kimi o MiniMax, o kind claude con tier Sonnet; razonamiento y orquestación usarán Claude Opus o una ruta fuerte dentro de Pi sólo con justificación explícita.

## Alternativas descartadas
Añadir un kind de Herdr por proveedor o modelo: descartado porque viola la política de kinds autorizados y confunde host con routing; usar premium por defecto: descartado por coste sin evidencia marginal; confiar sólo en el auto-router actual: descartado porque no materializó las rutas económicas planificadas.

## Consecuencias
skills/herdr/SKILL.md conservará únicamente ejemplos --kind claude y --kind pi; los tiers Claude se pasarán como argumentos nativos y los proveedores o modelos Pi se resolverán mediante su preset o router interno; cada ejecución registrará kind, ruta efectiva, altitud y justificación.

## Pendientes
Definir umbrales cuantitativos de promoción después de acumular resultados comparables por clase de tarea.
