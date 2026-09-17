---
tipo: adr
estado: accepted
fecha: '2026-08-31'
contexto: 'La revisión de A4S se estaba expandiendo hacia seguridad, scheduling y contratos que no contribuyen a validar el experimento central.'
decision: 'A4S convierte la coordinación frágil de agentes mediante terminales en trabajo durable, estructurado y verificable. Pi sigue ejecutando el trabajo y Herdr sigue mostrando las sesiones; A4S conserva los compromisos, las entregas y los resultados a través del tiempo y de los procesos.'
alternativas: 'Definir A4S como scheduler general: descartado porque no responde al problema inicial; convertirlo en sandbox o security manager: descartado porque invade responsabilidades del harness y del agente; mantener una arquitectura guiada por recursos sin una transformación de producto explícita: descartado porque favorece complejidad sin valor experimental.'
consecuencias: 'Todo requisito del MVP deberá demostrar kickoff sin PTY, trabajo estructurado, escalación correlacionada, resultado verificable o durabilidad ante desconexión y reinicio; capacidades que no contribuyan a esa prueba se difieren.'
---
# 0001. A4S North Star

## Contexto

La revisión de A4S se estaba expandiendo hacia seguridad, scheduling y contratos que no contribuyen a validar el experimento central.

## Decisión

A4S convierte la coordinación frágil de agentes mediante terminales en trabajo durable, estructurado y verificable. Pi sigue ejecutando el trabajo y Herdr sigue mostrando las sesiones; A4S conserva los compromisos, las entregas y los resultados a través del tiempo y de los procesos.

## Alternativas descartadas

Definir A4S como scheduler general: descartado porque no responde al problema inicial; convertirlo en sandbox o security manager: descartado porque invade responsabilidades del harness y del agente; mantener una arquitectura guiada por recursos sin una transformación de producto explícita: descartado porque favorece complejidad sin valor experimental.

## Consecuencias

Todo requisito del MVP deberá demostrar kickoff sin PTY, trabajo estructurado, escalación correlacionada, resultado verificable o durabilidad ante desconexión y reinicio; capacidades que no contribuyan a esa prueba se difieren.
