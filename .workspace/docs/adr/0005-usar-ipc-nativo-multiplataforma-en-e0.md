---
tipo: adr
estado: accepted
fecha: '2026-09-01'
contexto: 'A4S requiere un canal local entre a4sd y la extensión Pi que preserve el ownership externo del control plane y funcione en los sistemas soportados por Node.'
decision: 'E0 usará node:net con Unix domain socket en macOS y Linux, named pipe en Windows y frames JSON con prefijo big-endian de cuatro bytes.'
alternativas: 'TCP localhost: descartado por descubrimiento de puerto, secreto local y superficie adicional; stdin y stdout: descartado porque haría a4sd propietario del proceso Pi; comparar múltiples transportes: descartado por falta de una incógnita útil.'
consecuencias: 'El adapter mantendrá una sola semántica de protocolo y variará únicamente la dirección por plataforma; reconexión, ACK, deduplicación y límites de frame serán verificables en E0.'
---
# 0005. Usar ipc nativo multiplataforma en e0

## Contexto

A4S requiere un canal local entre a4sd y la extensión Pi que preserve el ownership externo del control plane y funcione en los sistemas soportados por Node.

## Decisión

E0 usará node:net con Unix domain socket en macOS y Linux, named pipe en Windows y frames JSON con prefijo big-endian de cuatro bytes.

## Alternativas descartadas

TCP localhost: descartado por descubrimiento de puerto, secreto local y superficie adicional; stdin y stdout: descartado porque haría a4sd propietario del proceso Pi; comparar múltiples transportes: descartado por falta de una incógnita útil.

## Consecuencias

El adapter mantendrá una sola semántica de protocolo y variará únicamente la dirección por plataforma; reconexión, ACK, deduplicación y límites de frame serán verificables en E0.
