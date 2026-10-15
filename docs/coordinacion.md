# Coordinación de corridas, observaciones y guardado

Etapa 5 de [SDD-CONSOLIDACION.md](../SDD-CONSOLIDACION.md). La extracción conserva
el comportamiento de `main` (`ca9171a`); no cambia las ecuaciones ni las rutas HTTP.

## Servidor

| Responsabilidad | Implementación | Adaptador / límite |
|---|---|---|
| Serializar arranques y recuperar la cola tras un fallo | `app/server/src/colaCorridas.ts` | `index.ts` mantiene la generación, cancela BuildService y detiene motores |
| Capturar y resolver la observación compartida por REST, MCP y eventos | `app/server/src/observacionElectrica.ts` | `DependenciasObservacion` recibe catálogo, proyecto, GPIO/PWM, controles y contexto |
| Agrupar solicitudes mientras trabaja el solver | `app/server/src/actualizadorElectrico.ts` | Extraído en etapa 3; recibe la tarea y conserva un grupo pendiente |
| Invalidar resultados de otro contexto | `app/server/src/vigenciaElectrica.ts` | La generación y la revisión del proyecto se comprueban al terminar |
| Validar y publicar eventos del backend | `app/server/src/transporteEventos.ts` | Puerto `ClienteEventos`; WebSocket, registro de clientes y seguridad siguen en `index.ts` |

La cola propaga el error al solicitante y permite ejecutar el siguiente trabajo. `esperar()`
espera la cola capturada al invocarlo; no es un bloqueo para nuevas solicitudes. Incrementar
la generación antes de encolar y volver a detener motores después de esperar sigue siendo
responsabilidad del servidor. La cola no proporciona aislamiento por usuario.

La observación copia niveles GPIO, PWM y controles antes de sus esperas asíncronas. Al terminar
comprueba vigencia y huella del proyecto. Una respuesta obsoleta retira medidas y no publica
memoria del modelo. El puerto del solver usa el mismo contrato de `sim/analisis.ts` y su
implementación de producción sigue siendo `analizarCircuito`.

El transporte valida `ServerEventSchema`, serializa el resultado y envía sólo a clientes con
`readyState === 1`. Un evento inválido genera el mismo log de diagnóstico. No incorpora
reintentos ni cambia qué ocurre si `send` lanza una excepción.

## Web

`app/web/guardado-diagrama.ts` coordina el debounce de 300 ms, la cola local de envíos,
la revisión de ediciones y la espera que necesita la cámara. Recibe `PuertosGuardadoDiagrama`:
lectura de proyecto/contenido, envío normal y al salir, notificación y efectos de éxito/error.
No importa React, DOM ni HTTP. `app.ts` conecta esos puertos y conserva los efectos visuales,
el guardado del editor, la navegación y la recepción de WebSocket.

Un cambio captura proyecto y contenido al programarse. Sólo refresca avisos si ese proyecto
sigue seleccionado. La cámara espera también ediciones que llegan durante el envío y rechaza
la operación si cambia el proyecto. Navegar espera los envíos pendientes y comprueba revisión;
un fallo conserva la navegación pendiente. La política actual de cambios externos y revisiones se describe en [conflictos-guardado.md](conflictos-guardado.md).

La etapa 5 caracterizó el debounce y la cola originales antes de extraerlos. La segunda entrega
de etapa 4 agrega revisiones y resolución de conflictos mediante puertos. El keepalive conserva
su carácter de entrega tentativa; ahora incluye revisión y no se solapa con la cola HTTP activa.
El [contrato de persistencia](persistencia.md) distingue publicación atómica de durabilidad.

## Tipos y evidencia

El servidor conserva `strict` y `noUncheckedIndexedAccess`. El módulo web nuevo se compila con
`tsconfig.coordinacion.json`, que hereda esas opciones de `tsconfig.navigation.json`; el comando
`npm --workspace web run typecheck` compila sus declaraciones antes de comprobar la web heredada.
Esto no convierte todo `app.ts` a TypeScript estricto.

Las pruebas `coordinacion-caracterizacion.test.ts`, `observacion-caracterizacion.test.ts` y
`transporte-caracterizacion.test.ts`, en `app/tests/unit`, ejecutan tanto el código congelado
anterior como las extracciones. La fixture conserva la fuente anterior como oráculo, se transpila
sólo en tests y no participa del build. Se verificó antes de conectar los nuevos módulos.

La comparación eléctrica usa doce circuitos deterministas con resistencia, alimentación y GPIO
variados y el solver real. Las pausas controladas verifican captura previa, rechazo de corridas
viejas, recuperación de colas y ediciones durante el guardado. Los E2E comprueban la integración
con el DOM y el servidor; estas pruebas no certifican hardware físico ni firmware Docker opcional.
