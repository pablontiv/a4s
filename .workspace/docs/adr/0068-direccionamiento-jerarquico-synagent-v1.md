---
tipo: adr
estado: superseded
fecha: '2026-10-04'
contexto: 'El bus synagent usa un solo tópico plano por harness (a4s/inbox/<addr>): difunde a todas las instancias del mismo tipo, impide dirigir a un agente concreto y no permite versionar el esquema de direcciones.'
decision: 'Adoptar direccionamiento jerárquico versionado con regla topic == ''synagent/''+version+''/''+to: synagent/v1/<proyecto>/<instancia> (directo), synagent/v1/<proyecto>/all (proyecto) y synagent/v1/all (global, opt-in); protocol.ts es el contrato compartido (gramática, toTopic, subscriptions, routing, resolución de proyecto/instancia) importado por ambos adaptadores, con la copia del plugin Claude generada y verificada por test de paridad.'
alternativas: 'Jerarquía pura sin /all (rechazada: el nivel proyecto haría doble función namespace y buzón); sin versión de esquema (rechazada: un cambio futuro sería breaking y obligaría a coordinar a todos); ids hasheados (rechazada: no direccionables por intención); cutover atómico flag-day (rechazada: corta la comunicación de los agentes vivos hasta que cada uno recargue).'
consecuencias: 'Cutover dual-read/single-write (suscribir y aceptar legacy a4s/inbox mas v1, publicar solo v1 tras actualizar ambos adaptadores, dedupe compartido por id de mensaje); dos clientes por adaptador (directo mas legacy durable clean=false; proyecto/all y global online-only clean=true); steer solo directo, rechazado en envío y en recepción; from canónico = <proyecto>/<instancia> y reply_to conserva su semántica de id de mensaje; la retirada de legacy será posterior con unsubscribe durable explícito y un gate observable, sin borrar estado del broker implícitamente.'
pendientes: 'Fuente determinista y collision-safe de <proyecto> (SYNAGENT_PROJECT mayor que config mayor que owner-repo del remoto, evitando basename de cwd y saneado lossy) y unicidad de <instancia> entre launchers no coordinados sin registro ni presencia; la integración con herdr (SYNAGENT_INSTANCE y naming de tabs) queda fuera de alcance de este ADR.'
superseded_by: 0069-identidad-por-sesion-nativa-y-contrato-de-adaptador-synagent
---
# 0068. Direccionamiento jerarquico synagent v1

## Contexto
El bus synagent usa un solo tópico plano por harness (a4s/inbox/<addr>): difunde a todas las instancias del mismo tipo, impide dirigir a un agente concreto y no permite versionar el esquema de direcciones.

## Decisión
Adoptar direccionamiento jerárquico versionado con regla topic == 'synagent/'+version+'/'+to: synagent/v1/<proyecto>/<instancia> (directo), synagent/v1/<proyecto>/all (proyecto) y synagent/v1/all (global, opt-in); protocol.ts es el contrato compartido (gramática, toTopic, subscriptions, routing, resolución de proyecto/instancia) importado por ambos adaptadores, con la copia del plugin Claude generada y verificada por test de paridad.

## Alternativas descartadas
Jerarquía pura sin /all (rechazada: el nivel proyecto haría doble función namespace y buzón); sin versión de esquema (rechazada: un cambio futuro sería breaking y obligaría a coordinar a todos); ids hasheados (rechazada: no direccionables por intención); cutover atómico flag-day (rechazada: corta la comunicación de los agentes vivos hasta que cada uno recargue).

## Consecuencias
Cutover dual-read/single-write (suscribir y aceptar legacy a4s/inbox mas v1, publicar solo v1 tras actualizar ambos adaptadores, dedupe compartido por id de mensaje); dos clientes por adaptador (directo mas legacy durable clean=false; proyecto/all y global online-only clean=true); steer solo directo, rechazado en envío y en recepción; from canónico = <proyecto>/<instancia> y reply_to conserva su semántica de id de mensaje; la retirada de legacy será posterior con unsubscribe durable explícito y un gate observable, sin borrar estado del broker implícitamente.

## Pendientes
Fuente determinista y collision-safe de <proyecto> (SYNAGENT_PROJECT mayor que config mayor que owner-repo del remoto, evitando basename de cwd y saneado lossy) y unicidad de <instancia> entre launchers no coordinados sin registro ni presencia; la integración con herdr (SYNAGENT_INSTANCE y naming de tabs) queda fuera de alcance de este ADR.
