---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'Handbook aún conservaba cuatro destinos globales activos aunque sus artefactos vigentes ya existían en A4S; ADR 0011 fue reemplazado por ADR 0021, por lo que la retirada final de la autoridad operativa de Handbook necesitaba una decisión vigente que no revirtiera el modelo incremental.'
decision: 'A4S supersede a Handbook como única fuente operativa de la configuración, output styles y skills ya consolidados; todo symlink global correspondiente debe resolver al checkout estable de A4S y Handbook queda únicamente como archivo histórico no autoritativo, sin alterar el modelo incremental de ADR 0021.'
alternativas: 'Mantener symlinks globales hacia Handbook: descartado porque conserva dos fuentes de autoridad; apuntarlos a un worktree temporal de A4S: descartado porque rompería al limpiar el worktree; borrar o archivar físicamente Handbook en esta operación: descartado porque requiere una verificación y autorización separadas.'
consecuencias: 'Los cuatro consumidores globales residuales pasan a depender de rutas estables de A4S; los cambios futuros a esos artefactos se realizan y validan aquí; Handbook puede archivarse o eliminarse posteriormente tras comprobar que no conserva consumidores operativos fuera del barrido global.'
---
# 0039. Decomisar handbook como fuente operativa

## Contexto
Handbook aún conservaba cuatro destinos globales activos aunque sus artefactos vigentes ya existían en A4S; ADR 0011 fue reemplazado por ADR 0021, por lo que la retirada final de la autoridad operativa de Handbook necesitaba una decisión vigente que no revirtiera el modelo incremental.

## Decisión
A4S supersede a Handbook como única fuente operativa de la configuración, output styles y skills ya consolidados; todo symlink global correspondiente debe resolver al checkout estable de A4S y Handbook queda únicamente como archivo histórico no autoritativo, sin alterar el modelo incremental de ADR 0021.

## Alternativas descartadas
Mantener symlinks globales hacia Handbook: descartado porque conserva dos fuentes de autoridad; apuntarlos a un worktree temporal de A4S: descartado porque rompería al limpiar el worktree; borrar o archivar físicamente Handbook en esta operación: descartado porque requiere una verificación y autorización separadas.

## Consecuencias
Los cuatro consumidores globales residuales pasan a depender de rutas estables de A4S; los cambios futuros a esos artefactos se realizan y validan aquí; Handbook puede archivarse o eliminarse posteriormente tras comprobar que no conserva consumidores operativos fuera del barrido global.
