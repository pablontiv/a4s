---
tipo: adr
estado: accepted
fecha: '2026-09-18'
contexto: 'La medición de sesiones del 15 al 18 de septiembre muestra que S3, con un tab peer por unidad de trabajo y sin subagentes, costó cerca de seis dólares por sesión y conservó revisión independiente útil, mientras S4, con subagentes anidados bajo un orquestador vivo, costó cerca de ciento veinticuatro dólares por sesión y concentró el 73 por ciento del gasto.'
decision: 'A4S usará S3 por defecto: cada unidad de trabajo se ejecuta en un tab peer de Herdr con un solo agente, el fan-out crea N tabs paralelos y ningún agente abre subagentes in-session; S4 queda prohibido y Herdr permanece como provider externo conforme al gate runtime-first del ADR 0009.'
alternativas: 'Ejecutar todo inline en S1: descartado porque elimina aislamiento y paralelismo; usar S4 con subagentes anidados: descartado por coste, reinyección de contexto y ownership difuso; construir un scheduler o control plane propio: descartado por contradecir ADR 0009.'
consecuencias: 'Cada dispatch deberá declarar unidad, tab, scope y criterio de término; la revisión exact-SHA se hará en otro tab peer cuando aplique; aumenta el número visible de tabs, pero no aparece una jerarquía agentic ni una segunda autoridad de lifecycle.'
---
# 0014. Adoptar topologia de dispatch por tabs peer

Los números 0012 y 0013 se reservan para los ADRs del worktree `pi-rule-compiler`; esta secuencia empieza en 0014 para coordinar numeración sin duplicar esos registros antes de su integración.

## Contexto
La medición de sesiones del 15 al 18 de septiembre muestra que S3, con un tab peer por unidad de trabajo y sin subagentes, costó cerca de seis dólares por sesión y conservó revisión independiente útil, mientras S4, con subagentes anidados bajo un orquestador vivo, costó cerca de ciento veinticuatro dólares por sesión y concentró el 73 por ciento del gasto.

## Decisión
A4S usará S3 por defecto: cada unidad de trabajo se ejecuta en un tab peer de Herdr con un solo agente, el fan-out crea N tabs paralelos y ningún agente abre subagentes in-session; S4 queda prohibido y Herdr permanece como provider externo conforme al gate runtime-first del ADR 0009.

## Alternativas descartadas
Ejecutar todo inline en S1: descartado porque elimina aislamiento y paralelismo; usar S4 con subagentes anidados: descartado por coste, reinyección de contexto y ownership difuso; construir un scheduler o control plane propio: descartado por contradecir ADR 0009.

## Consecuencias
Cada dispatch deberá declarar unidad, tab, scope y criterio de término; la revisión exact-SHA se hará en otro tab peer cuando aplique; aumenta el número visible de tabs, pero no aparece una jerarquía agentic ni una segunda autoridad de lifecycle.
