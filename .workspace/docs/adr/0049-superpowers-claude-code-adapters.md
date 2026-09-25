---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'A4S Superpowers roles se definen canonicamente en agents/superpowers/*.md con herramientas Pi (read, grep, find, edit, write, bash, mem_save). Claude Code requiere adapters con herramientas equivalentes (Read, Grep, Glob, Edit, Write, Bash, mcp__plugin_engram_engram__mem_save). ADR 0043 adopta Superpowers como topología general; los adapters permiten usar roles en ambos orquestadores.'
decision: 'Crear adapters de Superpowers en agents/superpowers/claude-code/ con frontmatter idéntico al canonical (name, description) y herramientas mapeadas a Claude Code; instalar con symlinks desde ~/.claude/agents/ al checkout de main; fail-closed si existe target.'
alternativas: 'Registrar archivos canonical directamente en Pi fallará en Claude Code (falta tool names); copiar archivos causaría drift; ejecutar loop sólo en Pi fue descartado por el Operador.'
consecuencias: 'Ambos orquestadores pueden usar la misma base de roles; el test garantiza byte-identical body; la instalación es reversible (symlink removal); provenance.json se preserva; sin cambios en roles o Pi.'
---
# 0049. Superpowers claude code adapters

## Contexto
A4S Superpowers roles se definen canonicamente en agents/superpowers/*.md con herramientas Pi (read, grep, find, edit, write, bash, mem_save). Claude Code requiere adapters con herramientas equivalentes (Read, Grep, Glob, Edit, Write, Bash, mcp__plugin_engram_engram__mem_save). ADR 0043 adopta Superpowers como topología general; los adapters permiten usar roles en ambos orquestadores.

## Decisión
Crear adapters de Superpowers en agents/superpowers/claude-code/ con frontmatter idéntico al canonical (name, description) y herramientas mapeadas a Claude Code; instalar con symlinks desde ~/.claude/agents/ al checkout de main; fail-closed si existe target.

## Alternativas descartadas
Registrar archivos canonical directamente en Pi fallará en Claude Code (falta tool names); copiar archivos causaría drift; ejecutar loop sólo en Pi fue descartado por el Operador.

## Consecuencias
Ambos orquestadores pueden usar la misma base de roles; el test garantiza byte-identical body; la instalación es reversible (symlink removal); provenance.json se preserva; sin cambios en roles o Pi.
