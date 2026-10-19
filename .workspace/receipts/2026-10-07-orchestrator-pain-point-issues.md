# Receipt de issues sobre puntos de dolor del orquestador

Fecha: 2026-10-07

## Solicitud

El Orquestador solicitó registrar los diez issues sobre puntos de dolor del orquestador. El Orquestador solicitó publicar este receipt mediante un pull request contra `main`.

## Decisión de ubicación

El Implementer no encontró una ubicación autoritativa para receipts en el árbol versionado. El Implementer usó `.workspace/receipts/2026-10-07-orchestrator-pain-point-issues.md` según la instrucción recibida.

## Alcance

Este receipt registra los issues #70 a #79. Este receipt registra sus títulos y sus URL. Este receipt registra la base y la referencia del POC. Este receipt registra la revisión, la relectura, los riesgos y el estado de integración.

## Exclusiones

Este cambio no modifica código. Este cambio no modifica política. Este cambio no modifica el harness. Este cambio no modifica los issues. Este receipt no copia los cuerpos completos de los issues. Este trabajo no fusiona el pull request.

## Referencias

- SHA base: `1c448b5954d78b57c9b968781e38550748ba9e37`
- POC: `ee4d4e546cc6decc3d8cf7354b84f04179d8d06a`

## Demostrado por el POC

- Node observó ocho Workers reales únicos.
- Los ocho completaron y sus inicios abarcaron 3 ms.
- El probe detectó `OPERATOR_AGREEMENT_OBSERVED`.
- AgentEvals 0.0.9 llamó a un juez Pion real y produjo `VETO`.

## No demostrado por el POC

- La vía atómica no fue validada en vivo.
- La condición terminal no fue validada en vivo.
- El último canary no completó el flujo integrado de receipts por timeout externo.
- El POC no está promovido ni fusionado.

## Issues

1. [#70 feat(orchestrator): añadir una vía atómica para tareas de una unidad](https://github.com/pablontiv/a4s/issues/70)
2. [#71 fix(orchestrator): detener nuevas fases al aceptar el resultado solicitado](https://github.com/pablontiv/a4s/issues/71)
3. [#72 fix(orchestrator): despachar todas las unidades listas hasta la capacidad disponible](https://github.com/pablontiv/a4s/issues/72)
4. [#73 docs(orchestrator): definir y congelar el contrato de cada unidad antes de ejecutarla](https://github.com/pablontiv/a4s/issues/73)
5. [#74 feat(orchestrator): reutilizar evidencia válida para candidatos sin cambios](https://github.com/pablontiv/a4s/issues/74)
6. [#75 fix(agents): permitir una corrección mecánica registrada dentro del mismo intento](https://github.com/pablontiv/a4s/issues/75)
7. [#76 fix(workers): validar ruta, rama y SHA antes de la primera acción y de cada efecto sensible](https://github.com/pablontiv/a4s/issues/76)
8. [#77 feat(review): revisar el candidato completo después de cada cambio material sujeto a review](https://github.com/pablontiv/a4s/issues/77)
9. [#78 fix(orchestrator): exigir un resultado independiente por cada dispatch de Worker](https://github.com/pablontiv/a4s/issues/78)
10. [#79 refactor(orchestrator): limitar cada dispatch al contexto operativo necesario](https://github.com/pablontiv/a4s/issues/79)

## Evidencia de revisión aprobada

El Orquestador entregó el conjunto aprobado al Implementer para su registro durable. La solicitud delegada identifica los diez issues por número. La solicitud delegada fija el SHA base y la referencia del POC. El Implementer conservó esos datos sin cambios.

## Evidencia de relectura

El Implementer releyó los diez issues publicados en GitHub el 2026-10-07. El Implementer comparó cada número, título y URL con este receipt. GitHub informó que los diez issues estaban abiertos durante la relectura. El Implementer no modificó los issues.

## Riesgos

Los issues definen trabajo pendiente. El POC no está promovido ni fusionado. El estado de cada issue puede cambiar después de esta relectura. Este receipt no valida la implementación futura de los issues.

## Estado

Estado: pendiente de merge.
