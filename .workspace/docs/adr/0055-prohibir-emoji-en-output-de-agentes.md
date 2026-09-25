---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'Los agentes y subagentes redactan texto que se renderiza en terminal, donde los emoji no aportan valor operativo y los glifos de ancho doble pueden provocar fallos de presentación.'
decision: 'Prohibir emoji y Unicode pictográfico en todo output redactado por agentes; usar texto plano o etiquetas ASCII y nombrar por código Unicode cualquier símbolo que deba identificarse.'
alternativas: 'Limitar la regla a subagentes se descarta porque el criterio aplica a toda salida generada; confiar sólo en corregir el renderer se descarta porque evita el fallo técnico pero no establece la convención de escritura.'
consecuencias: 'El estilo Mentor Telemetría y su artefacto append-system deben contener la regla y una prueba debe impedir su pérdida; esta decisión no reactiva ni proyecta APPEND_SYSTEM global, por lo que ADR 0042 permanece vigente.'
---
# 0055. Prohibir emoji en output de agentes

## Contexto
Los agentes y subagentes redactan texto que se renderiza en terminal, donde los emoji no aportan valor operativo y los glifos de ancho doble pueden provocar fallos de presentación.

## Decisión
Prohibir emoji y Unicode pictográfico en todo output redactado por agentes; usar texto plano o etiquetas ASCII y nombrar por código Unicode cualquier símbolo que deba identificarse.

## Alternativas descartadas
Limitar la regla a subagentes se descarta porque el criterio aplica a toda salida generada; confiar sólo en corregir el renderer se descarta porque evita el fallo técnico pero no establece la convención de escritura.

## Consecuencias
El estilo Mentor Telemetría y su artefacto append-system deben contener la regla y una prueba debe impedir su pérdida; esta decisión no reactiva ni proyecta APPEND_SYSTEM global, por lo que ADR 0042 permanece vigente.
