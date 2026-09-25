---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: Pi Subagents 1.6.1 contiene metadata con forma de fallback inactivo (`fallback_failed`, `unknown_fallback`, intentos primario/fallback y `fallback_used`), pero el runner ejecuta sólo `attempt(preferred)` y el historial observado mantiene `fallback_used=false`; las categorías estructuradas permiten distinguir fallos transitorios, mientras la topología exige una definición canónica por rol, ausencia de retry tras efectos e independencia del reviewer.
decision: 'Adoptar role_routes como grupo conceptual ligado al scope de la definición: preservar la ruta primaria profile/definition/default/orchestrator, añadir hasta dos fallbacks secuenciales, permitirlos sólo para provider_api_error, provider_rate_limit o provider_network_error sin output ni tools, conservar identidad y contexto, validar independencia de proveedor y familia para reviewers y emitir un recibo acotado por intento; las asignaciones requieren aprobación posterior de model-optimizer.'
alternativas: Confiar en la metadata de fallback implícita se descarta porque permanece inactiva y el runner no selecciona otra ruta; reintentar cualquier fallo se descarta porque repetiría auth, timeout, overflow, cancelación o efectos; duplicar la definición del rol por modelo se descarta por drift; hedging paralelo y fallback cross-harness se descartan por romper secuencialidad, ownership y alcance.
consecuencias: 'El contrato fija hard cap de tres intentos, cooldown acotado, tabla terminal exhaustiva, continuidad de prompt tools cwd y task identity, y recibos requested/effective; runtime, perfiles y modelos concretos permanecen sin cambios hasta implementación y aprobación separadas.'
---
# 0054. Definir rutas logicas secuenciales por rol

## Contexto
Pi Subagents 1.6.1 contiene metadata con forma de fallback inactivo (`fallback_failed`, `unknown_fallback`, intentos primario/fallback y `fallback_used`), pero el runner ejecuta sólo `attempt(preferred)` y el historial observado mantiene `fallback_used=false`; las categorías estructuradas permiten distinguir fallos transitorios, mientras la topología exige una definición canónica por rol, ausencia de retry tras efectos e independencia del reviewer.

## Decisión
Adoptar role_routes como grupo conceptual ligado al scope de la definición: preservar la ruta primaria profile/definition/default/orchestrator, añadir hasta dos fallbacks secuenciales, permitirlos sólo para provider_api_error, provider_rate_limit o provider_network_error sin output ni tools, conservar identidad y contexto, validar independencia de proveedor y familia para reviewers y emitir un recibo acotado por intento; las asignaciones requieren aprobación posterior de model-optimizer.

## Alternativas descartadas
Confiar en la metadata de fallback implícita se descarta porque permanece inactiva y el runner no selecciona otra ruta; reintentar cualquier fallo se descarta porque repetiría auth, timeout, overflow, cancelación o efectos; duplicar la definición del rol por modelo se descarta por drift; hedging paralelo y fallback cross-harness se descartan por romper secuencialidad, ownership y alcance.

## Consecuencias
El contrato fija hard cap de tres intentos, cooldown acotado, tabla terminal exhaustiva, continuidad de prompt tools cwd y task identity, y recibos requested/effective; runtime, perfiles y modelos concretos permanecen sin cambios hasta implementación y aprobación separadas.
