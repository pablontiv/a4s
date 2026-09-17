---
tipo: adr
estado: accepted
fecha: "2026-09-02"
contexto: "El driver experimental E0 crea un servidor real por ensayo. En Unix, los endpoints son sockets de dominio Unix y el límite efectivo de longitud de ruta puede ser menor que las rutas de artefactos generadas bajo directorios temporales largos del sistema."
decision: "Separar los artefactos persistidos de los recursos de transporte runtime: conservar reportes y evidencia bajo artifactRoot, pero crear endpoints Unix concretos bajo una raíz corta /tmp/a4s-e0, registrando cada endpoint concreto en eventos estructurados del driver y manteniendo endpoint_pattern en environment.json."
alternativas: "Crear sockets bajo artifactRoot; acortar run_id y nombres de ensayo; cambiar la implementación del servidor para escuchar directamente sobre rutas canónicas más cortas; usar TCP local para las pruebas."
consecuencias: "El driver evita fallas de listen por longitud de ruta en macOS y mantiene evidencia trazable de cada endpoint. A cambio, los recursos runtime Unix ya no quedan físicamente dentro del árbol de artefactos y requieren limpieza explícita al finalizar cada ensayo."
---

## Contexto

Task 7 introduce un driver determinístico que ejecuta S1-S5 con servidor y cliente reales por ensayo. Cada ensayo necesita endpoint, sesión y Delivery frescos. En Unix, el servidor usa un socket canónico y un socket privado anunciado mediante symlink. Esa estrategia preserva identidad de limpieza, pero también agrega segmentos a la ruta efectiva usada por `listen()`.

Durante la validación con artefactos temporales creados bajo el directorio temporal del sistema en macOS, los ensayos fallaron antes de iniciar el launcher Pi. La evidencia registrada mostró errores `listen EINVAL` sobre rutas largas bajo `/var/folders/.../a4s-driver-.../<run_id>/endpoints/.../.a4-*`. Esto impidió alcanzar el ciclo de vida fake y producía `launcher.starts === 0`.

## Decisión

El driver mantiene `artifactRoot` exclusivamente para evidencia persistida (`environment.json`, `events.jsonl`, `summary.json` y sesiones), pero aloja endpoints Unix concretos bajo `/tmp/a4s-e0`.

Cada ensayo sigue generando un endpoint fresco mediante `createRunEndpoint()` y registra el endpoint concreto con un evento estructurado del componente `driver`. El registro de ambiente conserva `endpoint_pattern` para describir la forma de los endpoints usados en la corrida.

## Alternativas descartadas

- **Crear sockets bajo `artifactRoot`**: descartado porque reproduce fallas por límite de longitud cuando `artifactRoot` está debajo de rutas temporales largas.
- **Acortar solo `run_id` y nombres de ensayo**: descartado porque reduce trazabilidad y no elimina la contribución dominante de rutas base largas como `/var/folders/...`.
- **Cambiar el servidor para omitir el socket privado/symlink**: descartado porque afectaría una decisión previa de seguridad/limpieza de endpoints Unix.
- **Usar TCP local para pruebas**: descartado porque ampliaría el alcance y dejaría de validar el transporte nativo requerido por E0.

## Consecuencias

- Las corridas del driver evitan errores de `listen` por rutas Unix demasiado largas.
- La evidencia conserva trazabilidad mediante `endpoint_pattern` y eventos `endpoint_resolved` con el endpoint concreto.
- La limpieza del driver debe remover explícitamente el endpoint canónico y su directorio de ensayo bajo `/tmp/a4s-e0`.
- En Windows no cambia la semántica: los endpoints siguen siendo named pipes generados por `createRunEndpoint()`.
