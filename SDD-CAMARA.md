# SDD: módulo Cámara virtual del computador

**Fecha:** 2026-10-03. **Estado:** implementación inicial; ver validación al final.
**Validación inicial:** localhost. Flujo de trabajo: SDD → TDD → implementación → PR.

## 1. Objetivo y alcance

Agregar una Cámara virtual al catálogo. Obtiene imágenes de la webcam del computador donde
se abre el navegador y las pone a disposición del backend. Si el servidor está en otra
máquina, la fuente continúa siendo el dispositivo del navegador.

La primera versión incluye selección de cámara, vista previa, captura manual y un visor de
la última fotografía recuperada del servidor. El visor es el primer consumidor y demuestra
el recorrido completo. La cámara funciona sin iniciar firmware ni energizar el circuito:
es un recurso virtual sin pines ni consumo eléctrico simulado.

Quedan fuera de esta entrega: lectura desde firmware, emulación de sensores físicos y sus
buses, video continuo hacia el servidor, procesamiento de imágenes, grabación, audio,
almacenamiento permanente y configuración/pruebas en LAN. Las OLED SSD1306 y TFT ST7735
existentes reciben dibujos del firmware por sus buses; no se conectan automáticamente.

## 2. Arquitectura y responsabilidades

| Subsistema | Responsabilidad |
|---|---|
| Catálogo | Definir módulo, representación y límites. |
| Frontend | Permisos, webcam, video local y fotografías. |
| Backend | Sesiones, validación JPEG y última captura en memoria. |
| Tipos compartidos | Descriptor, sesiones, estados, metadatos y errores. |
| Visor | Solicitar la fotografía del backend y mostrarla. |

El panel usa React y un controlador TypeScript separado administra MediaStream, captura y
limpieza. Las acciones se registran en el puente; los componentes no importan app.ts.
Un servicio y rutas separados administran el backend; index.ts conecta sus dependencias.

El catálogo incorpora camara-computador, programmable=false, sin chips ni pines. Un descriptor
opcional camera, validado con Zod, establece maxWidth, maxHeight, maxBytes y quality.
El panel explica que es un recurso virtual. Los módulos existentes siguen funcionando sin
ese descriptor. El proyecto guarda únicamente la instancia; dispositivo, permisos, sesiones,
streams y fotografías son temporales y nunca se agregan a project.json.

El repositorio no tiene un build propio del workspace shared: publica las fuentes TypeScript.
El frontend admite esas fuentes en su rootDir para compartir contratos sin duplicarlos.
Todo código fuente nuevo o modificado se escribe en TypeScript; JSON/SVG son datos.

## 3. Experiencia y flujo de datos

El panel muestra selector de dispositivo, Activar/Capturar/Detener, estado y errores en
español, vista previa y Última captura recibida con número, dimensiones y hora de recepción.
La elección de dispositivo se realiza con la cámara detenida. Las etiquetas disponibles se
actualizan después de obtener permiso.

1. La primera activación solicita getUserMedia con video y audio=false. El permiso lo administra
   y recuerda el navegador, no se serializa en el proyecto. Al volver a montar el panel, si el
   navegador informa que el permiso ya está concedido, el frontend puede reanudar la cámara;
   después de pulsar Detener no se reanuda automáticamente.
2. Obtenido el stream, el frontend crea una sesión para proyecto e instancia.
3. Ante rechazo del backend, se detienen inmediatamente las pistas.
4. El video local muestra el stream y habilita Capturar cuando hay un fotograma disponible.
5. Capturar reduce el fotograma conservando su proporción y lo codifica como JPEG.
6. HTTP envía los bytes y el backend valida, almacena y asigna metadatos.
7. El visor solicita la captura por su identificador y muestra exclusivamente esos bytes.

Las peticiones iniciales de estado/sesión esperan el guardado pendiente del diagrama para
evitar activar una instancia que aún no existe en el backend. Los guardados se serializan.

La imagen local no representa una captura confirmada. Un error conserva la última imagen
confirmada y muestra el problema. Solo hay una captura pendiente por sesión. Seleccionar otro
módulo mantiene la sesión y el stream activo; la última foto continúa disponible hasta su
eliminación o expulsión. Detener, cambiar de proyecto, salir de la página o perder la conexión
libera las pistas y la sesión.

## 4. Contratos e interfaces

Base: /api/projects/:nombre/cameras/:instancia.

| Método y ruta relativa | Resultado |
|---|---|
| POST /session | CameraSession: id privado y expiresAt. |
| POST /session/:sesion/heartbeat | Renovar; devolver sesión y vencimiento. |
| DELETE /session/:sesion | Cierre idempotente; una sesión ajena no cierra la propietaria. |
| POST /session/:sesion/captures | image/jpeg binario → CameraCapture. |
| GET /capture | Última imagen, Content-Type image/jpeg y X-Capture-Id. |
| GET /status | CameraStatus: active, expiresAt y capture, sin id privado. |

GET /capture?id=<captura> devuelve conflicto si esa foto fue reemplazada. La imagen usa
Cache-Control: no-store. El visor verifica también X-Capture-Id para evitar atribuir una
foto distinta a la captura confirmada.

CameraCapture incluye id, project, instance, number, width, height, size y receivedAt.
Los tiempos son milisegundos desde epoch; el backend determina receivedAt. El evento
WebSocket camera.state incluye project, instance y CameraStatus; nunca bytes ni id de sesión.
Se emite al abrir/cerrar/vencer sesión, recibir captura, expulsar foto o eliminar recurso.
La renovación no emite eventos repetitivos. Las fotografías viajan por HTTP.

Los errores de estas rutas usan code estable y message en español:

| HTTP | Casos |
|---|---|
| 404 | Proyecto, cámara o captura inexistentes. |
| 409 | Cámara ocupada, sesión vencida/ajena, captura pendiente o reemplazada. |
| 413 | Bytes excesivos o foto que excede presupuesto. |
| 415 | Tipo o formato no JPEG. |
| 400 | Contenido corrupto o dimensiones inválidas. |

Se mantienen los controles globales de Host/Origin. El servidor no registra imágenes ni
identificadores privados. El frontend limita cada petición a 10 segundos y no reabre
sesiones automáticamente.

## 5. Límites, vida útil y fallos

- JPEG hasta 640 × 480, calidad 0,8, máximo 1 MiB; sin deformación ni ampliación.
- Una sesión propietaria por instancia y una cámara activa por pestaña.
- Heartbeat cada 15 segundos; sesión vence tras 45 segundos sin renovación.
- El servidor barre vencimientos cada segundo y detiene ese timer al cerrar.
- Máximo global de 16 MiB en imágenes; una foto por instancia, expulsando las menos recientes.

El descriptor permite límites menores, nunca mayores a los máximos anteriores. sharp limita
píxeles, comprueba formato/dimensiones y decodifica completamente antes de aceptar. El backend
no confía en Content-Type ni en dimensiones del cliente. Tras decodificar comprueba nuevamente
la propiedad de sesión y la existencia del recurso para descartar trabajo tardío.

El frontend libera pistas al detener, cambiar proyecto/módulo, desmontar, abandonar página,
desconectar dispositivo o perder conexión con el backend. Un permiso resuelto después de
cancelar libera el stream inmediatamente. Una sesión creada tarde se cierra. Respuestas de
captura/recuperación tardías no actualizan una instancia distinta.

El servidor conserva la foto tras detener. Quitar módulo o proyecto elimina sesión y foto;
los cambios del ProjectStore, incluidos los realizados por MCP, reconcilian recursos. Reiniciar
el servidor elimina todo estado. Un cierre de página es de mejor esfuerzo: el vencimiento
libera la sesión aun si nunca llega DELETE. La pantalla no usa selección de módulo para
encender ni modificar el motor eléctrico.

## 6. TDD y criterios de aceptación

### Tests automatizados

- Servicio con reloj controlado: exclusividad, renovación, vencimiento, cierre, recuperación
  exacta, reemplazo, presupuesto y eliminación.
- API: sesión, ausencia de secretos en status, JPEG real, bytes recuperados, caché desactivada,
  corrupción, formato incorrecto y módulo inexistente.
- Controlador: permiso denegado, cancelación antes/después de permiso y rechazo del backend;
  pistas detenidas y sesión creada tarde cerrada.
- E2E: video sintético, controlador real, captura, recepción, visor, contenido de imagen,
  segunda captura, cierre, recarga sin activación y competencia entre pestañas.
- Regresión: Vitest completo, typechecks shared/server/web, build web y e2e pertinentes.

Se escriben primero los tests del servicio, rutas y controlador y se verifica que fallen
por la ausencia de implementación. Después se implementa el comportamiento y se ejecutan
e2e y regresiones. La prueba sintética no acredita una webcam física.

### Prueba manual completa en localhost

1. Abrir aplicación y agregar Cámara virtual sin ejecutar firmware ni energizar.
2. Activar y aceptar permiso; mover la mano y comprobar movimiento en vista previa.
3. Mostrar un objeto reconocible y capturar.
4. Ver la fotografía recuperada del backend con número y dimensiones correctas.
5. Cambiar el objeto y capturar de nuevo: foto y número deben cambiar.
6. Detener: indicador del navegador apagado y sesión inactiva.
7. Recargar: cámara desactivada.
8. Repetir con permiso denegado, webcam ausente/desconectada, cambio de proyecto y dos pestañas.

La entrega funcional se considera verificada cuando una foto real atraviesa frontend →
backend → visor, y detener/abandonar libera los recursos. En un entorno sin acceso a webcam
se entregará el código probado con fuente sintética, indicando que la prueba física sigue
pendiente y sin afirmar que se completó.

## 7. Entrega y validación

Rama y PR según CLAUDE.md; commits temáticos en español. Revisar PRs superpuestos antes de
editar. No mergear el PR. Incorporar este documento, implementar tras los tests iniciales,
actualizar README y reportar los comandos ejecutados y sus resultados en el PR.

El workspace shared carece del script build que invoca el build general existente. Verificar
shared con tsc --noEmit y usar build:web; no atribuir ese problema previo a la cámara.

**Prueba física:** el usuario confirmó que la webcam funciona en localhost («Funciona»). Esto valida la cámara virtual; el recorrido de ArduCAM con webcam real se verificará por separado.
Los resultados automatizados definitivos se documentan en la descripción del PR.
