---
tipo: adr
estado: accepted
fecha: '2026-09-23'
contexto: 'El costo por sesion y los tokens agregados confunden topologia, cache, modelo y sesiones sin costo; ADR 0014 uso ese proxy para justificar S3 frente a S4.'
decision: 'A4S evaluara eficiencia de entrega por costo por cambio durable de produccion con guardrails de reversión, tiempo y cobertura; no declarara ganadores por costo por sesion o tokens por sesion.'
alternativas: 'Mantener costo por sesion como eficiencia: descartado por cohortes y precios heterogeneos; usar commits crudos: descartado por actividad especulativa y duplicacion entre topologias; crear un score compuesto: descartado por opaco y optimizable.'
consecuencias: 'La vista delivery-efficiency sera opt-in, comparara por repositorio o value stream, separara SHAs mixtos y conservara los reportes de presupuesto existentes sin cambio.'
---
# 0036. Medir eficiencia por cambio durable

## Contexto
El costo por sesion y los tokens agregados confunden topologia, cache, modelo y sesiones sin costo; ADR 0014 uso ese proxy para justificar S3 frente a S4.

## Decisión
A4S evaluara eficiencia de entrega por costo por cambio durable de produccion con guardrails de reversión, tiempo y cobertura; no declarara ganadores por costo por sesion o tokens por sesion.

## Alternativas descartadas
Mantener costo por sesion como eficiencia: descartado por cohortes y precios heterogeneos; usar commits crudos: descartado por actividad especulativa y duplicacion entre topologias; crear un score compuesto: descartado por opaco y optimizable.

## Consecuencias
La vista delivery-efficiency sera opt-in, comparara por repositorio o value stream, separara SHAs mixtos y conservara los reportes de presupuesto existentes sin cambio.
