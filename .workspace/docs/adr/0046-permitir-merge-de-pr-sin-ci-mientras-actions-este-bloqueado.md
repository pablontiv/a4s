---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'GitHub Actions no inicia jobs en pablontiv/a4s desde 2026-09-19 por pagos fallidos o límite de gasto; todo PR y push queda en rojo con 0 steps y el trabajo debe avanzar sin reemplazar la entrega por pull-request.'
decision: 'Mantener delivery_mode pull-request y declarar en .workspace/config.yaml la excepción temporal delivery_overrides.ci-billing: se permite mergear un PR con CI rojo sólo si los jobs muestran la anotación de billing con 0 steps, exigiendo checks locales en verde registrados, revisión previa, autorización del operador ligada al SHA y la marca Delivery-Override: ci-billing; el push directo a main queda como segundo nivel sólo cuando un PR sea imposible, con autorización explícita por caso y marca Delivery-Override: direct-push; la excepción caduca cuando un job vuelva a iniciar y se sigue en el Bead a4s-1cy.'
alternativas: 'Cambiar delivery_mode a push directo: descartado porque la política correcta sigue siendo pull-request; esperar a restaurar el CI sin entregar: descartado porque bloquea el avance; mergear sin controles ni marca: descartado porque deja entregas sin evidencia ni trazabilidad.'
consecuencias: 'Cada merge bajo la excepción queda identificable con git log --grep ''Delivery-Override''; al volver el CI se ejecuta el workflow sobre la cabeza de main y cualquier fallo abre un Bead de regresión; las entregas por push directo previas a esta decisión (8b395a2, d8dd61d, 1e5da97, f91a17a) quedan registradas en a4s-1cy sin reescribir historia.'
pendientes: ""
---
# 0046. Permitir merge de pr sin ci mientras actions este bloqueado

## Contexto
GitHub Actions no inicia jobs en pablontiv/a4s desde 2026-09-19 por pagos fallidos o límite de gasto; todo PR y push queda en rojo con 0 steps y el trabajo debe avanzar sin reemplazar la entrega por pull-request.

## Decisión
Mantener delivery_mode pull-request y declarar en .workspace/config.yaml la excepción temporal delivery_overrides.ci-billing: se permite mergear un PR con CI rojo sólo si los jobs muestran la anotación de billing con 0 steps, exigiendo checks locales en verde registrados, revisión previa, autorización del operador ligada al SHA y la marca Delivery-Override: ci-billing; el push directo a main queda como segundo nivel sólo cuando un PR sea imposible, con autorización explícita por caso y marca Delivery-Override: direct-push; la excepción caduca cuando un job vuelva a iniciar y se sigue en el Bead a4s-1cy.

## Alternativas descartadas
Cambiar delivery_mode a push directo: descartado porque la política correcta sigue siendo pull-request; esperar a restaurar el CI sin entregar: descartado porque bloquea el avance; mergear sin controles ni marca: descartado porque deja entregas sin evidencia ni trazabilidad.

## Consecuencias
Cada merge bajo la excepción queda identificable con git log --grep 'Delivery-Override'; al volver el CI se ejecuta el workflow sobre la cabeza de main y cualquier fallo abre un Bead de regresión; las entregas por push directo previas a esta decisión (8b395a2, d8dd61d, 1e5da97, f91a17a) quedan registradas en a4s-1cy sin reescribir historia.

## Pendientes
Confirmar si el workflow puede ejecutarse de nuevo sobre commits ya integrados cuando se restaure el billing.
