# Diseño de pi-context-expert

**Fecha:** 2026-09-22
**Estado:** aprobado para revisión de spec
**Decisiones rectoras:** [ADR 0045](../adr/0045-adoptar-pi-context-expert.md) y [ADR 0056](../adr/0056-tratar-auto-persistido-como-consentimiento-durable.md)
**Sustituye:** la identidad y configuración de `pi-rule-compiler` de ADR 0031

## 1. Propósito

`pi-context-expert` es una extensión Pi que gestiona el contexto de una sesión para producir varias capacidades: compaction determinista con Jev, retrieval/evidence opt-in, recapitulación explícita y configuración interactiva. Las reglas son una de sus salidas, no la identidad del producto.

El éxito es que una persona operando Pi pueda:

- controlar las capacidades de contexto desde una UI nativa del TUI;
- cambiar una opción y observar su efecto en la misma sesión;
- solicitar un resumen fiable de objetivo, progreso y pendientes;
- usar comandos agrupados y descubribles, sin colisiones con otras extensiones;
- no recibir una sugerencia de `/compact` que Pi no puede ejecutar.

Pi conserva la autoridad sobre sesión, UI base y lifecycle. Jev conserva la autoridad semántica sobre selección de hechos de contexto. El código de la extensión valida, redacta, persiste y renderiza de forma determinista.

## 2. Límites

Incluye:

- renombre rupturista de paquete, rutas, documentación, config y custom entry types a `pi-context-expert`;
- configuración global persistida y mutable durante la sesión;
- `/ce-settings` construido con el `SettingsList` de Pi;
- `/ce-recap` respaldado por una evaluación Jev explícita;
- consolidación de los comandos del producto bajo el prefijo `ce-`;
- el gate que evita hints de compaction sin contenido compactable;
- pruebas offline por cada comportamiento.

No incluye:

- aliases, migración o lectura del paquete, config, comandos o custom entries antiguos;
- modificar, parchear o extender el `/settings` nativo de Pi;
- generación libre con el modelo activo para `/ce-recap`;
- activar reglas, escribir Rootline o cambiar gentle-engram;
- llamadas Jev automáticas sólo para mantener un recap actualizado;
- compatibilidad retroactiva con sesiones de `pi-rule-compiler`.

## 3. Identidad y superficie pública

El paquete pasa de `@a4s/pi-rule-compiler` a `@a4s/pi-context-expert`, y el directorio pasa de `packages/pi-rule-compiler/` a `packages/pi-context-expert/`. Todos los nombres públicos, documentación, scripts de workspace y artefactos propios usan la identidad nueva.

La configuración global pasa a:

```text
~/.pi/agent/pi-context-expert.json
```

La ruta anterior no se consulta. También cambian los `customType` y schemas `a4s.pi-rule-compiler.*` a `a4s.pi-context-expert.*`; una sesión previa no se interpreta parcialmente bajo la identidad nueva.

Los únicos comandos públicos del paquete son:

```text
/ce-recap
/ce-settings
/ce-rules [list|show <id>|accept <id>|retry]
```

`/retro-rules`, `/rules-review`, `/rules-show`, `/rules-accept` y `/compaction-trigger-acknowledge` se retiran. Seleccionar `trigger.mode=auto` en `/ce-settings` y persistirlo correctamente constituye el consentimiento durable; las sesiones posteriores no exigen confirmación, comando ni entrada de acknowledgement adicionales.

Se usa el prefijo `ce-`, no `ce:`, porque Pi utiliza el sufijo con dos puntos para desambiguar comandos duplicados entre extensiones.

## 4. Arquitectura

### 4.1 Configuración y runtime

Un módulo de configuración mantiene el schema flat actual:

```ts
{
  "compaction.strategy": "basic" | "ladder",
  "trigger.mode": "off" | "hint" | "auto",
  "evidence.strategy": "off" | "ladder"
}
```

Añade lectura, validación, serialización y escritura atómica del archivo global. Falta de archivo, JSON inválido, claves desconocidas, valores inválidos o combinaciones inválidas resuelven al perfil seguro `basic / hint / off`.

Un `ContextRuntime` contiene la configuración válida activa. Cada hook consulta ese objeto en el momento de ejecución. El hook `context_with_system` se registra siempre, pero retorna el contexto original sin evaluación cuando la estrategia viva no es `ladder`. Esta forma permite activar o desactivar Ladder sin reiniciar ni registrar handlers dinámicamente.

`/ce-settings` usa la superficie pública que Pi recomienda para extensiones: `ctx.ui.custom()` con `Container`, `DynamicBorder`, `SettingsList` y `getSettingsListTheme()`, siguiendo el patrón del selector `/tools`. No copia ni instancia `SettingsSelectorComponent`, que pertenece al `/settings` completo de Pi.

La lista contiene tres filas con descripción y valores cíclicos: `Compaction strategy` (`basic|ladder`), `Trigger mode` (`off|hint|auto`) y `Evidence strategy` (`off|ladder`). Enter o Espacio cambia el valor, Esc cierra y todo input se delega a `SettingsList` antes de solicitar render. Seleccionar `auto` es por sí mismo el consentimiento explícito; no abre un segundo diálogo.

Cada cambio parte del snapshot completo vigente, construye una configuración candidata y valida también dependencias entre campos. Sólo una candidata válida se escribe atómicamente; después del éxito se reemplaza `ContextRuntime.config` y se actualiza el valor mostrado. Si validación o persistencia fallan, `SettingsList.updateValue()` restaura el valor anterior, disco y runtime permanecen intactos y se muestra un aviso acotado. Fuera de TUI, `/ce-settings` no muta estado y notifica que requiere modo TUI.

### 4.2 Recap

`/ce-recap` opera sólo bajo petición de la persona usuaria. Construye una vista de la rama activa con las mismas normalización, redacción y cotas de texto usadas por la extensión. Jev recibe un request tipado que clasifica y selecciona evidencia para tres campos:

- objetivo vigente;
- trabajo completado;
- trabajo pendiente o siguiente paso.

La respuesta debe pasar validación estricta y conservar referencias a la evidencia seleccionada. Un renderer determinista presenta las tres secciones, sin convertir la respuesta en una narración libre ni introducir contenido no soportado por el schema.

Si no hay credencial, Jev falla, excede el deadline o devuelve una forma inválida, `/ce-recap` sigue siendo útil: muestra un recap local parcial, marcado explícitamente como parcial. Ese fallback no ejecuta otra llamada de modelo y no afecta compaction, trigger, evidence ni la sesión.

### 4.3 Compaction, retrieval y evidence

La compaction custom, el corpus, Ladder y Evidence conservan sus contratos existentes. Cambian para leer la configuración viva y para emitir únicamente nombres de la nueva identidad.

El trigger mantiene sus gates locales antes de llamar a Jev. Añade una verificación determinista de que Pi dispone de contenido compactable antes de mostrar el hint. Por tanto, una sesión que sólo produce `Nothing to compact (session too small)` no genera `Compaction suggested: Jev recommends compaction`.

## 5. Flujos

### Cambio de configuración

```text
/ce-settings
  -> abrir ctx.ui.custom con SettingsList y tema de Pi
  -> seleccionar valor; elegir auto constituye consentimiento durable
  -> validar combinación completa
  -> escritura atómica de pi-context-expert.json
  -> reemplazar ContextRuntime.config
  -> actualizar la fila y notificar aplicación inmediata
  -> siguiente hook usa la configuración nueva
  -> ante fallo, restaurar la fila y conservar disco/runtime previos
```

La persistencia precede al cambio runtime para que una sesión no anuncie una configuración que se perderá al reiniciar.

### Recapitulación

```text
/ce-recap
  -> leer rama activa
  -> normalizar, redactar y acotar
  -> evaluación Jev explícita y validada
  -> renderer determinista de objetivo / completado / pendiente
```

Ante cualquier fallo después de la lectura, el flujo termina con el recap local parcial y un código o mensaje acotado; nunca cancela un turn, dispara compaction ni revela contenido sin redacción.

### Trigger de compaction

```text
agent_settled
  -> gates: UI, idle, editor vacío, sin cola, cooldown, credencial,
            umbral y contenido compactable
  -> Jev sólo recibe contadores text-free
  -> hint o ctx.compact según trigger.mode persistido
```

## 6. Privacidad y fallos

La frontera de privacidad permanece antes de cualquier digest, persistencia o request Jev. `/ce-recap` reutiliza esa frontera y no imprime texto de sesión en diagnósticos. Los diagnósticos se mantienen acotados y no incluyen credenciales, mensajes raw, paths de home ni respuestas de proveedor.

Los fallos de compaction siguen cancelando compaction sin fallback nativo, como fija ADR 0013. Los fallos de recap son degradables porque recap es observabilidad solicitada, no una sustitución de lifecycle: producen fallback local parcial y no cambian el estado de sesión.

## 7. Criterios de aceptación

1. El workspace expone únicamente `@a4s/pi-context-expert`; las rutas, scripts y README no conservan el nombre anterior.
2. La extensión lee y escribe sólo `~/.pi/agent/pi-context-expert.json`; la ruta antigua no participa en ninguna resolución.
3. Configuración inválida falla cerrada a `basic / hint / off` y una escritura fallida no cambia el runtime.
4. `/ce-settings` usa `SettingsList` con el tema y las teclas de Pi, revierte visualmente cualquier escritura fallida y aplica una selección válida a la siguiente evaluación sin reinicio; `auto` persistido no requiere acknowledgement por sesión.
5. Sólo `/ce-recap`, `/ce-settings` y `/ce-rules` son comandos públicos propios; los comandos anteriores dejan de registrarse.
6. `/ce-rules` mantiene las operaciones `list`, `show`, `accept` y `retry`, con mensajes de uso y completado de argumentos.
7. `/ce-recap` envía a Jev sólo una vista saneada y acotada, valida su respuesta y renderiza objetivo, completado y pendiente de forma determinista.
8. La indisponibilidad de Jev en `/ce-recap` entrega un resultado local marcado parcial, sin alterar lifecycle ni llamar al modelo activo.
9. Los cambios en `compaction.strategy`, `trigger.mode` y `evidence.strategy` se observan en caliente por cada hook correspondiente.
10. Una sesión sin contenido compactable no recibe un hint que recomiende `/compact`.
11. Cada criterio se cubre con tests offline; la prueba E2E del producto se ejecuta cuando las credenciales y los providers reales estén autorizados.

## 8. Descomposición de Beads

Cada Bead entrega comportamiento visible y verificable; ningún Bead es sólo una fase administrativa o una bolsa de tests.

1. **Renombrar el producto a pi-context-expert.** Entrega una extensión instalable con nueva identidad, config y artefactos propios; prueba imports, manifest y ausencia de lectura de la identidad anterior.
2. **Aplicar configuración viva con /ce-settings.** Entrega la UI persistente y el efecto inmediato de los tres modos; prueba escritura, validación, fallo de persistencia y gates runtime.
3. **Consolidar comandos bajo ce-.** Entrega una superficie de tres comandos, con `/ce-rules` como familia; prueba registro, dispatch, argumentos y retiro de nombres previos.
4. **Añadir recap semántico con Jev.** Entrega `/ce-recap` con salida estructurada y fallback local; prueba redacción, schema Jev, renderer, deadline y credencial ausente.
5. **Evitar hints no accionables de compaction.** Corresponde al bug `a4s-6ak.11`; entrega el gate de contenido compactable y una reproducción de regresión.

El renombre desbloquea los otros Beads. Settings, comandos y recap pueden desarrollarse en paralelo tras resolver los contratos compartidos del renombre. El bug de hint puede desarrollarse en paralelo porque modifica el trigger existente y tiene su propio criterio de aceptación.
