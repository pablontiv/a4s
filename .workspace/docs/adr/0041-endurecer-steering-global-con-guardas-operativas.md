---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'El diagnóstico de comportamiento verificó que reglas generales no impidieron reemplazar un symlink, convertir una corrección puntual en preferencia durable ni ampliar una edición acotada con validación desproporcionada.'
decision: 'El steering global canónico distinguirá contenido de topología de paths, exigirá una regla futura explícita antes de persistir correcciones como preferencias y limitará la verificación al cambio y al contrato activo.'
alternativas: 'Conservar sólo las reglas generales: descartado porque el incidente atravesó esas reglas; añadir una extensión interceptora: descartado por complejidad y control plane no justificados; guardar correcciones como preferencias por defecto: descartado porque convierte incidentes en autoridad.'
consecuencias: 'A4S incorpora cláusulas operativas y regresiones de contrato; la proyección global las recibe por el symlink canónico y las verificaciones amplias siguen siendo obligatorias cuando el impacto o el contrato las exigen.'
---
# 0041. Endurecer steering global con guardas operativas

## Contexto
El diagnóstico de comportamiento verificó que reglas generales no impidieron reemplazar un symlink, convertir una corrección puntual en preferencia durable ni ampliar una edición acotada con validación desproporcionada.

## Decisión
El steering global canónico distinguirá contenido de topología de paths, exigirá una regla futura explícita antes de persistir correcciones como preferencias y limitará la verificación al cambio y al contrato activo.

## Alternativas descartadas
Conservar sólo las reglas generales: descartado porque el incidente atravesó esas reglas; añadir una extensión interceptora: descartado por complejidad y control plane no justificados; guardar correcciones como preferencias por defecto: descartado porque convierte incidentes en autoridad.

## Consecuencias
A4S incorpora cláusulas operativas y regresiones de contrato; la proyección global las recibe por el symlink canónico y las verificaciones amplias siguen siendo obligatorias cuando el impacto o el contrato las exigen.
