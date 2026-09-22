---
tipo: adr
estado: superseded
fecha: '2026-09-21'
contexto: 'La compaction Jev actual comprime cada chunk como keep/truncate/drop, un modelo binario que descarta informacion recuperable y limita la calidad de RuleSignals; el blueprint Jev archivado en references propone un visibility ladder de cuatro niveles decidido por query.'
decision: 'Extender la estrategia de compaction a un visibility ladder de cuatro niveles (hide/short/long/full) como opt-in sobre el trigger actual sin modificar el eje trigger; Jev emite el nivel por chunk como output tipado y los niveles short y long son resumenes query-aware, en evolucion de ADR 0013; se introduce config jev.compaction.strategy = basic|ladder con default basic.'
alternativas: 'Mantener solo keep/truncate/drop: descartado por seguir descartando informacion recuperable y degradar RuleSignals; acoplar el ladder a un nuevo trigger automatico: descartado porque mezcla dos ejes ortogonales, cuando frente a como, y amplia el alcance; aplicar el ladder per-turn como meta-attention: descartado por poner a Jev en el hot path de cada turno con costo y fail-closed por turno; resumen generativo libre: descartado por ADR 0013 al ser lossy y ciego a la query.'
consecuencias: 'La estrategia ladder es opt-in y el default preserva el comportamiento actual; conserva el contrato fail-closed de ADR 0013, Jev caido bloquea compaction, sin semantica de fallo nueva; RuleSignals siguen en la misma pasada y mejoran; el eje trigger, incluido auto-detectar el momento ideal, queda fuera de este ADR para decidirse por separado.'
pendientes: ""
superseded_by: 0025-reemplazar-ladder-por-retrieval-query
---
# 0022. Extender compaction a visibility ladder de cuatro niveles

## Contexto
La compaction Jev actual comprime cada chunk como keep/truncate/drop, un modelo binario que descarta informacion recuperable y limita la calidad de RuleSignals; el blueprint Jev archivado en references propone un visibility ladder de cuatro niveles decidido por query.

## Decisión
Extender la estrategia de compaction a un visibility ladder de cuatro niveles (hide/short/long/full) como opt-in sobre el trigger actual sin modificar el eje trigger; Jev emite el nivel por chunk como output tipado y los niveles short y long son resumenes query-aware, en evolucion de ADR 0013; se introduce config jev.compaction.strategy = basic|ladder con default basic.

## Alternativas descartadas
Mantener solo keep/truncate/drop: descartado por seguir descartando informacion recuperable y degradar RuleSignals; acoplar el ladder a un nuevo trigger automatico: descartado porque mezcla dos ejes ortogonales, cuando frente a como, y amplia el alcance; aplicar el ladder per-turn como meta-attention: descartado por poner a Jev en el hot path de cada turno con costo y fail-closed por turno; resumen generativo libre: descartado por ADR 0013 al ser lossy y ciego a la query.

## Consecuencias
La estrategia ladder es opt-in y el default preserva el comportamiento actual; conserva el contrato fail-closed de ADR 0013, Jev caido bloquea compaction, sin semantica de fallo nueva; RuleSignals siguen en la misma pasada y mejoran; el eje trigger, incluido auto-detectar el momento ideal, queda fuera de este ADR para decidirse por separado.

## Pendientes
Verificar que Jev emite hide/short/long/full como choice tipado y que los resumenes short y long caben en hookTimeoutMs; calibrar que chunks merecen long frente a short.
