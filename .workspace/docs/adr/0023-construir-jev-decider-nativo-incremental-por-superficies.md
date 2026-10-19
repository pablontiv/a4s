---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'Reusar la capacidad de ask-user como decisor Jev (auto-resolver en vez de bloquear en humano) requiere inyectar una decision; el spike sobre Pi 0.84.4 y 0.87.0 confirma que no existe hook que devuelva respuesta a una pregunta pendiente (ui_prompt observe-only, tool_call solo bloquea), por lo que solo una tool via execute puede responder; el vendor rpiv-ask-user-question ya implementa ese patron pero es codigo integrado no propio (ADR 0020/0021).'
decision: 'A4S construira un decider Jev nativo como extension propia, con un core reusable, decision tipada mas threshold, que consume @a4s/typesafe, desplegado de forma incremental una superficie a la vez: iter 1 ownear la tool ask-user con el decider en execute y fallback humano, retirando el path Jev de rpiv; iter 2 paridad de UI para eliminar rpiv; iter 3 gate de permisos via tool_call; iteraciones posteriores otras superficies como cache_warming_decision; el core se generaliza al llegar la segunda superficie, no antes.'
alternativas: 'Pre-hook que responde la pregunta: descartado porque Pi no lo permite en 0.84.4 ni 0.87.0; extender el auto-answer del vendor rpiv: descartado por acoplar codigo no propio contra ADR 0020/0021; tool_call mas tool_result para sustituir la respuesta: descartado por indirecto y por no evitar el bloqueo humano; interceptor universal generico desde el inicio: descartado por taxonomia anticipada contra Simplicity; reimplementar el cliente SDK en la extension: descartado por DRY, debe consumir @a4s/typesafe.'
consecuencias: 'El decider posee la tool ask-user y A4S asume su mantenimiento; eliminar rpiv exige reconstruir su UI humana, 504 tests, 9 locales y fallback RPC ACP, por eso se escalona iter 1 a iter 2; iter 1 corre en el pin 0.84.4 sin bump; superficies solo-0.87 como cache_warming_decision exigen bump del pin, decision separada ligada al pendiente de ADR 0020; cada iteracion es shippable y reversible y entrega valor por si misma.'
pendientes: ""
---
# 0023. Construir jev decider nativo incremental por superficies

## Contexto
Reusar la capacidad de ask-user como decisor Jev (auto-resolver en vez de bloquear en humano) requiere inyectar una decision; el spike sobre Pi 0.84.4 y 0.87.0 confirma que no existe hook que devuelva respuesta a una pregunta pendiente (ui_prompt observe-only, tool_call solo bloquea), por lo que solo una tool via execute puede responder; el vendor rpiv-ask-user-question ya implementa ese patron pero es codigo integrado no propio (ADR 0020/0021).

## Decisión
A4S construira un decider Jev nativo como extension propia, con un core reusable, decision tipada mas threshold, que consume @a4s/typesafe, desplegado de forma incremental una superficie a la vez: iter 1 ownear la tool ask-user con el decider en execute y fallback humano, retirando el path Jev de rpiv; iter 2 paridad de UI para eliminar rpiv; iter 3 gate de permisos via tool_call; iteraciones posteriores otras superficies como cache_warming_decision; el core se generaliza al llegar la segunda superficie, no antes.

## Alternativas descartadas
Pre-hook que responde la pregunta: descartado porque Pi no lo permite en 0.84.4 ni 0.87.0; extender el auto-answer del vendor rpiv: descartado por acoplar codigo no propio contra ADR 0020/0021; tool_call mas tool_result para sustituir la respuesta: descartado por indirecto y por no evitar el bloqueo humano; interceptor universal generico desde el inicio: descartado por taxonomia anticipada contra Simplicity; reimplementar el cliente SDK en la extension: descartado por DRY, debe consumir @a4s/typesafe.

## Consecuencias
El decider posee la tool ask-user y A4S asume su mantenimiento; eliminar rpiv exige reconstruir su UI humana, 504 tests, 9 locales y fallback RPC ACP, por eso se escalona iter 1 a iter 2; iter 1 corre en el pin 0.84.4 sin bump; superficies solo-0.87 como cache_warming_decision exigen bump del pin, decision separada ligada al pendiente de ADR 0020; cada iteracion es shippable y reversible y entrega valor por si misma.

## Pendientes
Nombre definitivo del paquete y de la tool durante la transicion para evitar colision con rpiv instalado; cuanta paridad de UI exige iter 1 frente a iter 2; momento del bump de pin a 0.87 para habilitar superficies nuevas.
