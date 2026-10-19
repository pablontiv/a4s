---
tipo: adr
estado: proposed
fecha: '2026-09-19'
contexto: 'El rule-compiler ya extrae RuleSignals, sintetiza proposals y ahora expone una superficie de revisión store-only (/rules-review, /rules-show, /rules-accept); ADR 0012 fijó el MVP como propose-only y dejó pendiente "definir publicación Rootline sólo tras validar el MVP". Aceptar una regla hoy sólo persiste un recibo; falta decidir cómo y con qué gate una regla aceptada se escribe de forma durable, y AGENTS.md exige autorización explícita y acotada antes de efectos externos y un ADR aceptado antes de implementar el cambio.'
decision: 'Cuando se habilite el write, una regla aceptada se materializará como un registro Rootline gobernado bajo `.workspace/docs/` (schema-validado), no en AGENTS.md, que permanece de autoría humana; el write será manual, por regla, con confirmación explícita, disparado sólo desde un recibo de aceptación existente, y fallará cerrado ante ownership ambiguo, path drift o schema inválido. La escritura automática queda prohibida.'
alternativas: 'Escribir directo en AGENTS.md: descartado porque mezcla reglas propuestas por máquina con la política curada a mano y amplía el blast radius; escribir en ambos destinos: descartado por el mismo motivo y por doble fuente de verdad; auto-aplicar al aceptar: descartado porque cruza un efecto externo durable sin gate humano; mantener propose-only indefinidamente: descartado porque deja el camino review->apply incompleto que el bead a4s-6ak.10 pide cerrar.'
consecuencias: 'Rootline sigue siendo la autoridad de reglas aceptadas (coherente con ADR 0012); la aceptación store-only actual se vuelve el paso previo verificable al write; el write requerirá su propio contrato, tests y un comando explícito antes de tocar el filesystem; ADR 0009 permanece intacto porque el rule-compiler no adquiere task lifecycle.'
pendientes: 'Definir el schema Rootline destino y su .stem; decidir el comando/flag de confirmación del write; calibrar si una regla aceptada revocable necesita un recibo de revocación; validar la superficie store-only con corpora reales antes de aceptar este ADR.'
---
# 0020. Definir apply revisado de reglas a Rootline

## Contexto
El rule-compiler ya extrae RuleSignals, sintetiza proposals y ahora expone una superficie de revisión store-only (`/rules-review`, `/rules-show`, `/rules-accept`). ADR 0012 fijó el MVP como propose-only y dejó pendiente "definir publicación Rootline sólo tras validar el MVP". Aceptar una regla hoy sólo persiste un recibo de aceptación; falta decidir cómo y con qué gate una regla aceptada se escribe de forma durable. AGENTS.md exige autorización explícita y acotada antes de efectos externos destructivos y un ADR aceptado antes de implementar el cambio.

## Decisión
Cuando se habilite el write, una regla aceptada se materializará como un registro Rootline gobernado bajo `.workspace/docs/` (schema-validado), no en AGENTS.md, que permanece de autoría humana. El write será manual, por regla, con confirmación explícita, disparado sólo desde un recibo de aceptación existente, y fallará cerrado ante ownership ambiguo, path drift o schema inválido. La escritura automática queda prohibida.

## Alternativas descartadas
Escribir directo en AGENTS.md: descartado porque mezcla reglas propuestas por máquina con la política curada a mano y amplía el blast radius; escribir en ambos destinos: descartado por el mismo motivo y por doble fuente de verdad; auto-aplicar al aceptar: descartado porque cruza un efecto externo durable sin gate humano; mantener propose-only indefinidamente: descartado porque deja el camino review->apply incompleto que el bead a4s-6ak.10 pide cerrar.

## Consecuencias
Rootline sigue siendo la autoridad de reglas aceptadas (coherente con ADR 0012); la aceptación store-only actual se vuelve el paso previo verificable al write; el write requerirá su propio contrato, tests y un comando explícito antes de tocar el filesystem; ADR 0009 permanece intacto porque el rule-compiler no adquiere task lifecycle.

## Pendientes
Definir el schema Rootline destino y su `.stem`; decidir el comando/flag de confirmación del write; calibrar si una regla aceptada revocable necesita un recibo de revocación; validar la superficie store-only con corpora reales antes de aceptar este ADR.
