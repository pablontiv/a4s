# Política local de A4S

Este archivo define la política local y autoritativa del repositorio A4S. El
contrato runtime global sigue siendo una autoridad separada. Ambas autoridades
se aplican. Ninguna sustituye, amplía ni reduce a la otra.

La documentación histórica y `.workspace/docs/workflow-reference.md` son
informativas. No definen la operación actual. `.workspace/config.yaml` tampoco
es autoridad para esta política.

## Clases de trabajo

- `read_only`: lee, busca, compara o explica. No cambia archivos, refs, registros
  de trabajo ni servicios externos.
- `mutating`: puede cambiar cualquiera de esos estados. Toda mutación de tarea
  pertenece a esta clase.

El trabajo `read_only` no necesita un worktree. El trabajo `mutating` exige un
worktree dedicado antes de la primera mutación de tarea. Una rama aislada, una
copia del repositorio u otro directorio no son equivalentes.

## Gate inicial para trabajo `mutating`

Resuelve este gate antes de la primera mutación de tarea.

1. Presenta el resultado, los criterios de aceptación, el alcance, las
   exclusiones, los invariantes y la evidencia requerida.
2. Observa el acuerdo explícito del operador. Reconoce la readiness. Verifica
   de forma explícita la readiness compartida.
3. Identifica el checkout estable de `main`. Verifica que está limpio.
4. Ejecuta `git fetch`. Un resultado `failed` o `unknown` bloquea.
5. Ejecuta `git pull --ff-only` en el `main` estable. Un resultado `failed` o
   `unknown` bloquea.
6. Verifica la igualdad entre `main` y `origin/main`.
7. Crea el worktree dedicado. Verifica su rama, ruta y base.
8. Verifica el gate. Realiza la primera mutación de tarea dentro de ese
   worktree.

Detén el trabajo cuando falte una condición. Nombra la condición. Emite un
bloqueo explícito con la salida estructurada del gate. Copia sin cambios en
`condition` el identificador canónico en mayúsculas que devuelve la evidencia.
No traduzcas, resumas ni renombres ese identificador. No intentes la mutación
prohibida.

## Gate final para trabajo `mutating`

Resuelve este gate antes de cerrar la tarea.

1. Produce un candidato y verifica la evidencia aplicable.
2. Determina el requisito de review según el riesgo. Exige review independiente
   cuando el riesgo lo requiera. Cuando no aplique, realiza self-review. Un
   review `failed` o `unknown` bloquea.
3. Verifica que el PR está abierto. Verifica su head y su base. La base debe ser
   `main`. Verifica que los checks requeridos existen y pasan. Un estado
   `failed` o `unknown` bloquea. Una lista vacía de checks no prueba éxito.
4. Fusiona el PR a `main`. Verifica la identidad del merge y del head integrado.
5. Ejecuta `git fetch`. Ejecuta `git pull --ff-only` en el `main` estable.
   Ejecuta un segundo `git fetch`.
6. Verifica que `main` está limpio y sincronizado con `origin/main`. Verifica que
   el resultado candidato está integrado.
7. Ejecuta sólo el cleanup exacto autorizado. Verifica cada identidad antes de
   retirar el worktree, la rama local, la rama remota o una salida desechable.
8. Escribe un receipt durable. Relee el receipt y verifica su contenido.
9. Verifica el gate final. Cierra la tarea.

No ejecutes cleanup antes de verificar la integración y la sincronización
final. No cierres antes de releer el receipt. Detén el trabajo cuando falte una
condición. Nombra la condición. Emite un bloqueo explícito con la salida
estructurada del gate. Copia sin cambios en `condition` el identificador
canónico en mayúsculas que devuelve la evidencia. No traduzcas, resumas ni
renombres ese identificador. No intentes el siguiente efecto prohibido.

## Salida del gate

Usa esta forma exacta para un bloqueo:

```text
<gate_check gate="initial|final" result="block">
  <evidence condition="CANONICAL_CONDITION">hecho observado</evidence>
</gate_check>
```

Sustituye `CANONICAL_CONDITION` por el identificador canónico exacto que
devuelve la evidencia. No cierres con prosa libre cuando el gate está
bloqueado.
