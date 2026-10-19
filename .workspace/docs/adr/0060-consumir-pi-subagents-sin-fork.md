---
tipo: adr
estado: accepted
fecha: '2026-09-26'
contexto: 'El backlog de resiliencia asumía crear un fork controlado para modificar pi-subagents-j0k3r, pero el Operador corrigió que A4S sólo necesita consumir la extensión instalada y no mantener una variante propia.'
decision: 'Consumir pi-subagents-j0k3r exclusivamente como extensión externa instalada, sin fork, vendoring ni modificaciones de su fuente; toda integración usará configuración e interfaces públicas soportadas y fallará cerrado cuando una capacidad no exista.'
alternativas: 'Crear un fork se descarta por introducir mantenimiento y ownership innecesarios; editar node_modules se descarta por no ser reproducible; vendorizar la fuente se descarta porque convertiría un provider externo en código mantenido por A4S.'
consecuencias: 'Se cancela el checkout controlado de a4s-ong y no se implementará fallback modificando Pi Subagents; la instalación 1.6.1 permanece intacta y cualquier capacidad ausente deberá resolverse aguas arriba o mediante otra integración aprobada.'
pendientes: ""
---
# 0060. Consumir pi subagents sin fork

## Contexto
El backlog de resiliencia asumía crear un fork controlado para modificar pi-subagents-j0k3r, pero el Operador corrigió que A4S sólo necesita consumir la extensión instalada y no mantener una variante propia.

## Decisión
Consumir pi-subagents-j0k3r exclusivamente como extensión externa instalada, sin fork, vendoring ni modificaciones de su fuente; toda integración usará configuración e interfaces públicas soportadas y fallará cerrado cuando una capacidad no exista.

## Alternativas descartadas
Crear un fork se descarta por introducir mantenimiento y ownership innecesarios; editar node_modules se descarta por no ser reproducible; vendorizar la fuente se descarta porque convertiría un provider externo en código mantenido por A4S.

## Consecuencias
Se cancela el checkout controlado de a4s-ong y no se implementará fallback modificando Pi Subagents; la instalación 1.6.1 permanece intacta y cualquier capacidad ausente deberá resolverse aguas arriba o mediante otra integración aprobada.

## Pendientes
Replanificar los hijos de a4s-e50 que asumían cambios de fuente y verificar qué parte del contrato puede cumplirse sólo con la extensión instalada.
