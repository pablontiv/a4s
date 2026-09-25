---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'ADR 0051 decidió usar el origen relocatable como identidad, pero su consecuencia podía interpretarse como que cualquier HEAD posterior distinto de verified_revision bloqueaba mutación, contradiciendo el carácter observacional aprobado para esa revisión.'
decision: 'Conservar repo.path como locator del repositorio de origen; descubrir el checkout local en runtime; verificar git remote get-url origin; y tratar verified_revision como evidencia de la revisión del origen sobre la que se verificó el binding, no como igualdad obligatoria con HEADs posteriores.'
alternativas: 'Mantener la consecuencia ambigua de ADR 0051 se descarta porque recrea un lock autorreferencial; retirar verified_revision se descarta porque pierde procedencia; persistir el checkout local se mantiene descartado por no ser portable.'
consecuencias: 'Una discrepancia de origin, o la imposibilidad de observar el origen y su revisión, queda unknown y bloquea mutación; un HEAD posterior distinto de verified_revision no invalida por sí solo el binding ni bloquea.'
---
# 0053. Aclarar revision observada en identidad relocalizable

Reemplaza a 0051-usar-origen-relocalizable-como-identidad-de-repositorio.

## Contexto
ADR 0051 decidió usar el origen relocatable como identidad, pero su consecuencia podía interpretarse como que cualquier HEAD posterior distinto de verified_revision bloqueaba mutación, contradiciendo el carácter observacional aprobado para esa revisión.

## Decisión
Conservar repo.path como locator del repositorio de origen; descubrir el checkout local en runtime; verificar git remote get-url origin; y tratar verified_revision como evidencia de la revisión del origen sobre la que se verificó el binding, no como igualdad obligatoria con HEADs posteriores.

## Alternativas descartadas
Mantener la consecuencia ambigua de ADR 0051 se descarta porque recrea un lock autorreferencial; retirar verified_revision se descarta porque pierde procedencia; persistir el checkout local se mantiene descartado por no ser portable.

## Consecuencias
Una discrepancia de origin, o la imposibilidad de observar el origen y su revisión, queda unknown y bloquea mutación; un HEAD posterior distinto de verified_revision no invalida por sí solo el binding ni bloquea.
