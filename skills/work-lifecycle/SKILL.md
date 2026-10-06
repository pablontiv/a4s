---
name: work-lifecycle
description: "Trigger: driving a unit of work through the A4S lifecycle — intake, choose/define/prepare/do/accept/deliver/close work, elegir trabajo, qué hacemos, admitir trabajo, avanzar una tarea, entregar, cerrar. Applies the repository-local lifecycle policy without adding gates."
metadata:
  author: pablontiv
  updated: "2026-10-06"
---

# Work lifecycle

Esta skill aplica la técnica del ciclo de trabajo A4S. Lee `AGENTS.md` en la
raíz del repositorio. Ese archivo es la autoridad local para readiness,
mutación, review, entrega y cierre.

El contrato runtime global conserva su autoridad separada. Esta skill no lo
sustituye. `.workspace/config.yaml`, los ADR, los planes y la documentación
histórica no tienen autoridad operativa sobre este procedimiento.

## Clasifica el trabajo

Clasifica la unidad como `read_only` o `mutating` según `AGENTS.md`.

El trabajo `read_only` puede inspeccionar y explicar. Debe permanecer sin
efectos. El trabajo `mutating` debe usar un worktree dedicado. No aceptes una
rama aislada, una copia u otro directorio como equivalente.

## Resuelve el gate inicial

Antes de una mutación de tarea:

1. Presenta criterios, resultado, alcance, exclusiones, invariantes y evidencia.
2. Obtén el acuerdo explícito del operador. Reconoce y verifica la readiness.
3. Identifica el checkout estable de `main`. Verifica que está limpio.
4. Ejecuta `git fetch`.
5. Ejecuta `git pull --ff-only` en el `main` estable.
6. Verifica que `main` y `origin/main` son iguales.
7. Crea el worktree dedicado. Verifica su ruta, rama y base.
8. Verifica el gate. Haz la primera mutación dentro del worktree.

Trata `failed` y `unknown` como bloqueos. Nombra la condición que bloquea. No
intentes el efecto siguiente.

## Produce y revisa el candidato

Implementa sólo el resultado acordado. Produce la evidencia aplicable.
Determina el requisito de review según el riesgo. Pide review independiente
cuando el riesgo lo requiera. Haz self-review cuando no aplique review
independiente. Un review `failed` o `unknown` bloquea.

## Resuelve el gate final

Antes del cierre:

1. Verifica el candidato y su review.
2. Verifica el PR, su head y su base `main`. Verifica que los checks requeridos
   existen y pasan. Un PR abierto con una lista vacía de checks no pasa.
3. Fusiona el PR a `main`. Verifica el merge y el head integrado.
4. Ejecuta `git fetch`.
5. Ejecuta `git pull --ff-only` en el `main` estable.
6. Ejecuta un segundo `git fetch`.
7. Verifica que `main` está limpio y sincronizado. Verifica el resultado
   integrado.
8. Ejecuta y verifica sólo el cleanup exacto autorizado.
9. Escribe el receipt durable. Reléelo y verifica su contenido.
10. Verifica el gate final. Cierra la tarea.

Trata `failed` y `unknown` como bloqueos. No hagas cleanup antes de la
integración verificada. No cierres antes de releer el receipt. Nombra la
condición que bloquea. No añadas gates ni ceremonia.

## Salida del gate

Usa una salida breve:

```text
<gate_check gate="initial|final" result="pass|block">
  <evidence condition="<condition>">hecho observado</evidence>
</gate_check>
```

Usa `result="block"` cuando falte una condición. Detén el avance de ese gate.
