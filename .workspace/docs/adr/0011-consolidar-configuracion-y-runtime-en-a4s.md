---
tipo: adr
estado: superseded
fecha: '2026-09-17'
contexto: 'Handbook y A4S evolucionaban como repositorios separados aunque configuración, métodos, decisiones de orquestación y runtime pertenecen al mismo producto, generando duplicación de autoridad y fricción de mantenimiento.'
decision: 'A4S absorberá los artefactos vigentes de Handbook como directorios funcionales de primer nivel, conservará su historia como referencia no autoritativa y alojará la configuración efectiva y el conocimiento gobernado bajo .workspace.'
alternativas: 'Mantener Handbook separado mediante contratos: descartado porque preserva dos puntos de trabajo y dos superficies de decisión; crear un monorepo de proyectos relacionados: descartado por ampliar el alcance sin necesidad; conservar un subdirectorio handbook: descartado porque perpetúa una frontera de producto inexistente.'
consecuencias: 'A4S se convierte en el único repositorio activo para configuración y runtime; pablontiv/handbook se archiva; los demás proyectos sólo se documentan como referencias y no se migran.'
superseded_by: 0021-adoptar-monorepo-incremental-para-outer-harnesses
---
# 0011. Consolidar configuracion y runtime en a4s

## Contexto
Handbook y A4S evolucionaban como repositorios separados aunque configuración, métodos, decisiones de orquestación y runtime pertenecen al mismo producto, generando duplicación de autoridad y fricción de mantenimiento.

## Decisión
A4S absorberá los artefactos vigentes de Handbook como directorios funcionales de primer nivel, conservará su historia como referencia no autoritativa y alojará la configuración efectiva y el conocimiento gobernado bajo .workspace.

## Alternativas descartadas
Mantener Handbook separado mediante contratos: descartado porque preserva dos puntos de trabajo y dos superficies de decisión; crear un monorepo de proyectos relacionados: descartado por ampliar el alcance sin necesidad; conservar un subdirectorio handbook: descartado porque perpetúa una frontera de producto inexistente.

## Consecuencias
A4S se convierte en el único repositorio activo para configuración y runtime; pablontiv/handbook se archiva; los demás proyectos sólo se documentan como referencias y no se migran.
