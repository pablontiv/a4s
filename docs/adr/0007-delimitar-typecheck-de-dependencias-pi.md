---
tipo: adr
estado: accepted
fecha: "2026-09-02"
contexto: "La integración del cliente E0 de la extensión Pi requiere importar el tipo público ExtensionAPI desde @earendil-works/pi-coding-agent. Esa importación activa la verificación de declaraciones transitivas del paquete, que actualmente incluyen incompatibilidades ajenas al código del repositorio bajo module NodeNext."
decision: "Mantener la importación del tipo público ExtensionAPI y configurar TypeScript con skipLibCheck para delimitar el typecheck al código del proyecto y a sus fronteras de uso, sin validar internals de declaraciones de terceros."
alternativas: "Importar subrutas privadas del paquete Pi; declarar un shim local de ExtensionAPI; eliminar el tipado público de la extensión; corregir node_modules localmente."
consecuencias: "El typecheck vuelve a validar el código del proyecto sin fallar por defectos de empaquetado de dependencias. A cambio, TypeScript no revisa exhaustivamente los archivos .d.ts de terceros, por lo que los errores internos de esas declaraciones quedan fuera de esta garantía."
---

## Contexto

Task 5 agrega el adaptador de ciclo de vida de la extensión Pi para E0. El requisito de integración indica que el adaptador debe usar la API pública de extensiones, por lo que el archivo importa `ExtensionAPI` desde `@earendil-works/pi-coding-agent`.

Al ejecutar `npm run typecheck`, esa importación arrastra la gráfica de declaraciones del paquete Pi y de sus dependencias. La validación falla dentro de `node_modules` por declaraciones incompatibles con la configuración `NodeNext` del repositorio, incluidas importaciones JSON sin atributo de tipo, referencias faltantes a declaraciones transitivas y una referencia a `path.PlatformPath` no expuesta por la versión efectiva de tipos de Node.

Estos errores no se originan en el cliente E0 ni en el adaptador, pero bloquean la validación solicitada para el proyecto.

## Decisión

Se conserva la importación pública:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

Se agrega `skipLibCheck: true` a `tsconfig.json`. Con esto, TypeScript sigue verificando los archivos del repositorio, las llamadas al tipo importado y la compatibilidad de las fronteras usadas por el proyecto, pero omite la revisión interna completa de los archivos `.d.ts` de terceros.

## Alternativas descartadas

- **Importar subrutas privadas del paquete Pi**: descartado porque cumpliría peor el requisito de usar la API pública y acoplaría el adaptador a layout interno del paquete.
- **Crear un shim local de `ExtensionAPI`**: descartado porque podría divergir silenciosamente de la API pública real.
- **Eliminar el tipo público y usar un objeto estructural local**: descartado porque reduciría la garantía de integración con Pi.
- **Modificar `node_modules` o las declaraciones de dependencias**: descartado porque no sería reproducible ni apropiado para una corrección del repositorio.

## Consecuencias

- `npm run typecheck` queda enfocado en el código del proyecto y pasa con la importación pública requerida.
- La integración mantiene compatibilidad de superficie con la API pública de Pi.
- Los defectos internos de declaraciones de terceros ya no bloquean esta base de código, pero tampoco quedan cubiertos por el typecheck del proyecto.
- Si las dependencias corrigen sus declaraciones en el futuro, se puede reevaluar retirar `skipLibCheck`.
