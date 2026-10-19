---
name: roadmap
description: Muestra un backlog Beads como un arbol de solo lectura agrupado por la prioridad registrada. Usar cuando el operador pide ver el roadmap, backlog o arbol por prioridades sin planificar, recomendar ni modificar nada.
compatibility: Requiere Python 3.10 o posterior y el CLI bd disponible en PATH.
metadata:
  author: pablontiv
  updated: "2026-10-01"
---

# Roadmap

Esta skill solamente muestra el arbol pendiente segun la prioridad ya registrada en Beads.

## Contrato

- Una pregunta solicita informacion; no autoriza una accion.
- Lee Beads y devuelve el arbol. Nada mas.
- No crea, actualiza, reclama, difiere, cierra ni elimina Beads.
- No cambia prioridades ni las infiere desde titulos, descripciones o labels.
- No elige candidato, no recomienda trabajo y no ejecuta tareas.
- No inspecciona Git, historial, readiness, criterios, autoridad ni documentacion.
- No modifica ni invoca la skill `roadmap-legacy`.

## Uso

Conserva el directorio de trabajo actual para que `bd` resuelva el backlog del proyecto. No ejecutes `cd`. Resuelve la ruta absoluta de esta skill y ejecuta:

```bash
python3 <skill-dir>/scripts/tree.py
```

Devuelve stdout sin agregar analisis, recomendaciones, siguientes pasos ni ceremonia. Si el comando falla, informa solamente el error que impide leer el backlog.

## Presentacion

- Agrupa por el valor literal `priority`: `P0`, `P1`, `P2`, `P3`, `P4` y despues cualquier otro valor.
- Dentro de cada prioridad conserva la jerarquia `parent-child` cuando padre e hijo comparten prioridad.
- Si el padre tiene otra prioridad, muestra el hijo en su propia prioridad y anota el ID del padre.
- Muestra ID, tipo, estado y titulo.
- Anota bloqueadores `blocks` pendientes cuando Beads los proporciona.
- Cada Bead pendiente aparece exactamente una vez.
