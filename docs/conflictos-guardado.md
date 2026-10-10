# Revisiones y conflictos de guardado

Segunda entrega de la etapa 4 de [consolidación](../SDD-CONSOLIDACION.md), sobre la
persistencia atómica y cola por proyecto de PR #75. No es una fusión automática de documentos.

## Contrato REST y compatibilidad

`revisionGuardado.ts` genera revisiones fuertes y opacas con SHA-256 del contenido y su dominio.
No representan autenticación, orden cronológico ni una secuencia monotónica: volver al mismo
contenido recupera la misma revisión. Persisten entre reinicios porque se calculan del recurso.

| Recurso | Lectura | Escritura condicional |
|---|---|---|
| Proyecto | GET `/api/projects/:name`: `revision` y ETag | PUT de proyecto con esa revisión |
| Circuito | El mismo GET: `revisionDiagrama` | PUT `/diagram` con revisión del circuito |
| Archivo | GET `/files/:ruta?boardId=...`: `content`, `revision` y ETag | PUT sobre la misma ruta y placa |

La revisión de circuito incluye instancias, propiedades, posiciones, cables y placas; no depende
solamente de la firma física. Una posición también es una edición. La revisión de archivo depende
de proyecto, placa, ruta y contenido. Proyecto y circuito tienen dominios diferentes.

Enviar `If-Match: "<digest>"`. Sólo se admite una revisión fuerte: no listas, revisiones débiles
ni `*`. El chequeo ocurre dentro de `store.transaccion`, desde la lectura inicial hasta el guardado.
Dos pedidos con la misma revisión no pueden publicar dos contenidos distintos. Las respuestas
exitosas incluyen la revisión del contenido aceptado; la UI la usa para el siguiente envío.

- 412: `code: REVISION_CONFLICT`, `error` y `revisionActual`; no se escribe el cuerpo rechazado.
- 428: falta If-Match en un PUT identificado con `x-cliente`; se debe cargar el recurso antes de editar.
- 400: la cabecera no cumple el contrato.

**Migración:** la UI siempre envía `x-cliente` y requiere revisión en los tres PUT anteriores.
Los clientes REST históricos sin ese header mantienen escrituras incondicionales si omiten
If-Match. Pueden adoptar revisión sin agregar x-cliente. No se promete proteger una escritura
ciega de un cliente histórico: sí cambia la revisión y bloquea el siguiente guardado viejo de la UI.
Creación, borrado, controles y comandos de placas mantienen sus contratos de operación.

MCP conserva sus herramientas: las transformaciones de circuito leen dentro de la cola; una
mutación invalida la revisión de la UI. `escribir_archivo` sigue siendo un reemplazo explícito
incondicional. No se incorpora una falsa garantía de comparación para un agente que no envía
revisión. Una futura obligatoriedad universal necesita versionar/migrar estos clientes.

## Comportamiento de la UI

`VersionesGuardado` conserva una base por recurso. Sólo la actualiza al **aplicar una carga**
o aceptar un guardado propio. Un aviso WebSocket y la carga de una vista previa no cambian la
base de una edición pendiente. Cada recurso tiene una cola; el siguiente envío usa la revisión
del anterior aceptado. Un conflicto bloquea los reintentos automáticos sin escribir sobre él.

`GuardadoDiagrama` distingue revisión editada de revisión guardada. Un envío anterior no limpia
ediciones posteriores ni un contexto recién cargado. Cargar una versión aceptada libera una
barrera que había fallado. Los archivos limpios no se vuelven a escribir al navegar.

Cuando hay cambios locales, un evento externo no descarta el circuito ni el texto. La isla React
`ConflictosGuardado` muestra ambas versiones y ofrece:

- Descargar el contenido local actual (código o JSON del circuito).
- Cargar la versión guardada y descartar la local por elección explícita. Si se edita durante
  la espera, esa respuesta no se aplica; el usuario puede volver a decidir.
- Reemplazar la versión guardada con el contenido local actual, usando la revisión de la vista
  previa. Si vuelve a cambiar, se rechaza otra vez y se conserva la edición.

Las acciones quedan deshabilitadas mientras se resuelve. Un conflicto mantiene pendiente la
navegación. Al cerrar o recargar, `beforeunload` advierte si hay cambios o conflicto; no se garantiza
persistencia local después de que el usuario acepte salir. La descarga es el respaldo explícito.

El keepalive de circuito lleva If-Match y no se envía si ese recurso está bloqueado o tiene una
cola de HTTP activa. No puede sobrescribir una versión externa más nueva, pero sigue siendo un
intento de entrega: no certifica recepción ni durabilidad y no guarda código al cerrar.

## Verificación y alcance pendiente

Dos regresiones API fallaron antes del cambio (revisión ausente y guardados simultáneos sin
rechazo). La integración comprueba dos guardados con la misma base, código desactualizado,
revisión requerida y un cambio por MCP. Las pruebas de coordinadores cubren serialización,
recuperación, bloqueo, contextos y ediciones durante el envío. La caracterización anterior de
la cola y debounce sigue pasando; las políticas nuevas de conflicto se prueban por separado.

E2E reales usan dos pestañas, descarga de código, un editor externo sobre disco, respuesta tardía,
resolución del dibujo y navegación posterior. El ensayo de pagehide comprueba la cabecera y el
rechazo del servidor; no se presenta como un ensayo de cierre real ni persistencia tras un crash.

Siguen pendientes integridad de caché de firmware y límites durante las descargas. La cola sólo
coordina un proceso y no hace compare-and-swap frente a un editor externo que escriba entre el
chequeo y rename. Tampoco hay fusión semántica de cambios ni aislamiento multiusuario. La recuperación conjunta
de código pendiente y una placa borrada externamente necesita un flujo específico: esta entrega
conserva el estado y bloquea la recarga, pero no resuelve automáticamente esa combinación.
