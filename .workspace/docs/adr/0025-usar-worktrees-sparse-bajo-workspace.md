---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'Los worktrees administrados deben vivir bajo .workspace/worktrees conforme al perfil, pero al ser .workspace contenido versionado Git replica configuración y conocimiento en cada checkout derivado, creando múltiples copias visibles de la autoridad.'
decision: 'Usar worktrees Git bajo .workspace/worktrees con sparse checkout por worktree hijo que excluya /.workspace por defecto; el checkout principal conserva la única instancia completa y los cambios de política requieren hidratación explícita y temporal.'
alternativas: 'Mantener /.worktrees fuera de la autoridad: contradice el perfil; aceptar una .workspace completa por worktree: mantiene la duplicación; separar .workspace en otro repositorio o usar symlinks: rompe la coherencia versionada o añade referencias frágiles.'
consecuencias: 'La creación de worktrees deberá configurar sparsity antes del checkout, validar que los hijos no materializan /.workspace y fallar cerrado si la configuración por worktree no se puede verificar; las herramientas resolverán la autoridad desde el checkout principal y la migración preservará los worktrees existentes hasta una limpieza autorizada.'
---
# 0025. Usar worktrees sparse bajo workspace

## Contexto
Los worktrees administrados deben vivir bajo .workspace/worktrees conforme al perfil, pero al ser .workspace contenido versionado Git replica configuración y conocimiento en cada checkout derivado, creando múltiples copias visibles de la autoridad.

## Decisión
Usar worktrees Git bajo .workspace/worktrees con sparse checkout por worktree hijo que excluya /.workspace por defecto; el checkout principal conserva la única instancia completa y los cambios de política requieren hidratación explícita y temporal.

## Alternativas descartadas
Mantener /.worktrees fuera de la autoridad: contradice el perfil; aceptar una .workspace completa por worktree: mantiene la duplicación; separar .workspace en otro repositorio o usar symlinks: rompe la coherencia versionada o añade referencias frágiles.

## Consecuencias
La creación de worktrees deberá configurar sparsity antes del checkout, validar que los hijos no materializan /.workspace y fallar cerrado si la configuración por worktree no se puede verificar; las herramientas resolverán la autoridad desde el checkout principal y la migración preservará los worktrees existentes hasta una limpieza autorizada.
