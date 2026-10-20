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
5. Update the primary checkout under the existing closure authorization:
   - Identify its exact absolute path from the repository's primary identity and
     `git worktree list --porcelain`. Verify that this is the stable `main`
     checkout. Use `git -C "$PRIMARY"` for every command below.
   - Run `git fetch`. Record its observed result; failure or an unknown result
     blocks the update.
   - Inspect `git status --porcelain=v1 --untracked-files=all` and record the
     existing stash object identities with `git stash list --format=%H`.
     A clean checkout records `no-stash-needed` and proceeds directly to pull.
   - For tracked or untracked local changes, run
     `git stash push --include-untracked -m "a4s-closure:<identity>"`, using the
     session/task identity in the name. Immediately resolve
     `git rev-parse 'stash@{0}'` and record the exact new object SHA in the durable
     receipt, outside the primary working tree, **before** attempting pull.
     Verify that stash creation succeeded, the SHA identifies a new stash, prior
     stash objects remain listed, and `git stash show --include-untracked <SHA>`
     exposes the preserved work. Verify that the checkout is now clean; residual
     changes (including submodule work not captured by stash) block the pull.
     On preservation failure, retain the files and every available stash, record
     the observed state, and report the gate blocked.
   - Run `git pull --ff-only` only after preservation is established. Record its
     exact exit status, stdout and stderr in the receipt. On success, run a
     second `git fetch` and record its result before the checks in step 6.
   - Keep preserved changes stored in the recorded stash through closure, with
     prior stashes retained. Report `stored`, explicitly meaning that the work
     has not been reapplied. Recovery can later use the recorded SHA; this
     closing procedure leaves the stash available for that recovery.
6. Verifica que `main` está limpio y sincronizado con `origin/main`. Verifica que
   el resultado candidato está integrado.
7. Ejecuta sólo el cleanup exacto autorizado. Verifica cada identidad antes de
   retirar el worktree, la rama local, la rama remota o una salida desechable.
8. Write and reread a durable receipt. Notify the user with the same observed
   primary-update outcome. Both the receipt and notification must contain:
   - The exact primary path and branch.
   - The new stash SHA and name, or explicit `no-stash-needed`; the preserved-work
     state (`stored` or `not-needed`) and confirmation of prior-stash retention.
   - The observed fetch results and pull exit status, stdout and stderr (or
     `not-attempted` with the reason).
   - The actual final worktree status, local and remote `main` SHAs, candidate
     integration result, and gate state (`pass` or `blocked` with its condition).
   A clean working tree with work `stored` describes only the primary checkout;
   it does not mean the user's preserved changes were restored.
9. Verifica el gate final. Cierra la tarea.

No ejecutes cleanup antes de verificar la integración y la sincronización
final. No cierres antes de releer el receipt. Detén el trabajo cuando falte una
condición. Nombra la condición. Emite un bloqueo explícito con la salida
estructurada del gate. Copia sin cambios en `condition` el identificador
canónico en mayúsculas que devuelve la evidencia. No traduzcas, resumas ni
renombres ese identificador. No intentes el siguiente efecto prohibido.

Any failed or unknown preservation, pull, fetch, integration or synchronization
result blocks closure and cleanup. On divergence or another pull failure, retain
the recorded stash and all prior stashes, observe the actual worktree and refs,
and write/reread the receipt and notify the user before emitting the structured
final-gate block. Record unavailable evidence as `unknown` and an unexecuted pull
as `not-attempted`. Report the observed failure without claiming a successful
update or synchronized primary; a clean post-stash worktree alone is insufficient.
The same receipt and notification requirements apply when blocking before step 8.

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
