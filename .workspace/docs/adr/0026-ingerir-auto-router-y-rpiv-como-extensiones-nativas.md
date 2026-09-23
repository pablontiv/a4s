---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'A4S es un monorepo de extensiones con rule-compiler y typesafe ya nativos; el owner decide no depender de los forks vendor en runtime para pi-auto-router y rpiv-ask-user-question; ADR 0020 y 0021 hoy los tratan como providers integrados no propios, y ADR 0023 ya decidio reemplazar rpiv con un decider nativo.'
decision: 'Ingerir pi-auto-router y rpiv-ask-user-question como extensiones nativas del monorepo a4s bajo packages, eliminando la dependencia de runtime hacia los forks vendor para esas dos; la ingesta de cualquier extension nueva es opt-in explicito por extension y nunca automatica; esto acota y supersede el boundary vendor igual a provider integrado no codigo propio de ADR 0020 y 0021 solo para esas dos extensiones, que por lo demas sigue vigente.'
alternativas: 'Mantenerlas como providers integrados vendor status quo 0020 y 0021: descartado porque a4s es monorepo de extensiones y el owner no quiere dependencia vendor en runtime para estas dos; principio general de auto-nativo para toda extension: descartado por taxonomia anticipada contra Simplicity, cada nueva debe ser opt-in; reconstruir la UI de rpiv desde cero como preveia el iter2 original de 0023: descartado a favor de ingerir el codigo existente y refactorizar su path Jev a @a4s/typesafe.'
consecuencias: 'La ingesta de rpiv reformula el iter2 de ADR 0023 de reconstruir UI a ingerir el codigo existente y refactorizar su path Jev a @a4s/typesafe sin rebuild; la ingesta del auto-router habilita gap 2 eje sensibilidad como codigo nativo unificado con costo y altitud; hay que preservar licencia y atribucion del upstream de terceros al importar; estas dos dejan de recibir PRs contra el fork pablontiv y pasan a ser codigo a4s con sus tests y CI; la migracion a @a4s/typesafe del orden de 0020 se pliega en la ingesta.'
pendientes: ""
---
# 0026. Ingerir auto router y rpiv como extensiones nativas

## Contexto
A4S es un monorepo de extensiones con rule-compiler y typesafe ya nativos; el owner decide no depender de los forks vendor en runtime para pi-auto-router y rpiv-ask-user-question; ADR 0020 y 0021 hoy los tratan como providers integrados no propios, y ADR 0023 ya decidio reemplazar rpiv con un decider nativo.

## Decisión
Ingerir pi-auto-router y rpiv-ask-user-question como extensiones nativas del monorepo a4s bajo packages, eliminando la dependencia de runtime hacia los forks vendor para esas dos; la ingesta de cualquier extension nueva es opt-in explicito por extension y nunca automatica; esto acota y supersede el boundary vendor igual a provider integrado no codigo propio de ADR 0020 y 0021 solo para esas dos extensiones, que por lo demas sigue vigente.

## Alternativas descartadas
Mantenerlas como providers integrados vendor status quo 0020 y 0021: descartado porque a4s es monorepo de extensiones y el owner no quiere dependencia vendor en runtime para estas dos; principio general de auto-nativo para toda extension: descartado por taxonomia anticipada contra Simplicity, cada nueva debe ser opt-in; reconstruir la UI de rpiv desde cero como preveia el iter2 original de 0023: descartado a favor de ingerir el codigo existente y refactorizar su path Jev a @a4s/typesafe.

## Consecuencias
La ingesta de rpiv reformula el iter2 de ADR 0023 de reconstruir UI a ingerir el codigo existente y refactorizar su path Jev a @a4s/typesafe sin rebuild; la ingesta del auto-router habilita gap 2 eje sensibilidad como codigo nativo unificado con costo y altitud; hay que preservar licencia y atribucion del upstream de terceros al importar; estas dos dejan de recibir PRs contra el fork pablontiv y pasan a ser codigo a4s con sus tests y CI; la migracion a @a4s/typesafe del orden de 0020 se pliega en la ingesta.

## Pendientes
Mecanica de licencia y atribucion de la ingesta; nombres y rutas de paquete; relacion de los ADR propios del auto-router con los ADR de a4s; si se mantiene sync con upstream o se posee el fork; reconciliacion del pin de Pi entre auto-router y a4s.
