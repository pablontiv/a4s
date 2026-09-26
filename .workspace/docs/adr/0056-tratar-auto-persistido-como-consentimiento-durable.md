---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'La configuración global trigger.mode=auto ya es una elección explícita del operador, pero el runtime exigía además una entrada de acknowledgement por sesión y dejaba el modo automático inesperadamente inerte.'
decision: 'Persistir trigger.mode=auto será consentimiento durable suficiente: el runtime no exigirá comando ni entrada por sesión; la futura UI nativa hará visible la consecuencia al seleccionar auto antes de persistir, y los gates de readiness, editor, cola, cooldown y credencial permanecen obligatorios.'
alternativas: 'Se descartan conservar el doble opt-in porque contradice el significado de auto, pedir confirmación en cada sesión porque no es persistente y mantener el comando temporal porque la superficie pi-context-expert ya decidió retirarlo.'
consecuencias: 'Las entradas históricas de acknowledgement quedan inertes y no se borran; auto aplica a sesiones posteriores tras cargar la configuración, mientras /ce-settings deberá tratar la selección y persistencia exitosa como el único consentimiento explícito.'
---
# 0056. Tratar auto persistido como consentimiento durable

## Contexto
La configuración global trigger.mode=auto ya es una elección explícita del operador, pero el runtime exigía además una entrada de acknowledgement por sesión y dejaba el modo automático inesperadamente inerte.

## Decisión
Persistir trigger.mode=auto será consentimiento durable suficiente: el runtime no exigirá comando ni entrada por sesión; la futura UI nativa hará visible la consecuencia al seleccionar auto antes de persistir, y los gates de readiness, editor, cola, cooldown y credencial permanecen obligatorios.

## Alternativas descartadas
Se descartan conservar el doble opt-in porque contradice el significado de auto, pedir confirmación en cada sesión porque no es persistente y mantener el comando temporal porque la superficie pi-context-expert ya decidió retirarlo.

## Consecuencias
Las entradas históricas de acknowledgement quedan inertes y no se borran; auto aplica a sesiones posteriores tras cargar la configuración, mientras /ce-settings deberá tratar la selección y persistencia exitosa como el único consentimiento explícito.
