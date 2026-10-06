# SDD: cámara DVP para ESP32-S3

**Estado:** diseño inicial; pendiente de revisión antes del TDD.  
**Propuesta:** sensor OV2640 conectado directamente a la interfaz DVP del ESP32-S3, con `esp32-camera` en hardware físico.  
**Base de emulación:** reutilizar la webcam del navegador y el servicio de capturas existente, a través de un adaptador virtual explícito.  
**Fuera de alcance:** video continuo, envío de imágenes desde el firmware a una pantalla, y validación en una placa física.

Este diseño inicia la siguiente familia de cámaras después de ArduCAM. No es una variante SPI: la captura física usa un bus paralelo DVP y un periférico de cámara del ESP32. En el emulador, la imagen seguirá viniendo de la webcam del navegador, porque `esp-emu` actualmente no simula el periférico DVP ni sus transferencias DMA.

## 1. Objetivo y primera entrega

Agregar un módulo de cámara DVP para el ESP32-S3 que permita probar el flujo de captura de una aplicación de cámara usando la webcam del navegador como fuente virtual. El firmware solicitará una fotografía; la aplicación pedirá un fotograma nuevo al navegador, lo validará y se lo devolverá al adaptador de cámara del emulador.

La primera entrega debe demostrar en localhost que:

1. El firmware inicializa la cámara y solicita una captura.
2. La solicitud llega a la webcam activa de esa instancia.
3. Una imagen nueva llega al firmware con dimensiones y formato declarados.
4. El programa puede examinar la imagen recibida y reportar tamaño y SHA-256.
5. Los bytes y metadatos del panel coinciden con la captura entregada al adaptador.

El firmware de hardware físico usará la API pública `esp_camera.h` y el componente oficial `esp32-camera`. El adaptador de emulación reproducirá las operaciones de alto nivel necesarias para el caso soportado; no afirmará emular el controlador DVP, los ciclos de reloj, DMA, interrupciones ni el tiempo real de captura.

## 2. Hardware objetivo y cableado

### Sensor de referencia

OV2640 con salida DVP de 8 bits y control SCCB. Es la referencia inicial porque el driver oficial de Espressif lo soporta y puede entregar JPEG comprimido desde el sensor. La primera configuración de emulación usará JPEG QVGA (320 × 240), una captura pendiente y un buffer.

El módulo físico debe exponer las señales de alimentación, SCCB, reloj y bus paralelo. Según el modelo, también puede exponer PWDN y RESET. Se documentará la variante concreta del módulo antes de fijar un pinout final.

### Señales del componente

El símbolo tendrá conectores explícitos, con sus nombres funcionales; cada señal irá cableada a un GPIO o pin de alimentación de la placa:

| Grupo | Señales |
|---|---|
| Alimentación | VCC, GND |
| Control del sensor (SCCB) | SIOD/SDA, SIOC/SCL |
| Reloj hacia el sensor | XCLK |
| Sincronización DVP | PCLK, VSYNC, HREF |
| Datos DVP | D0–D7 |
| Opcionales del módulo | PWDN, RESET |

Son 14 conexiones de señal base, o 16 si el módulo también expone PWDN y RESET, más VCC y GND. En el programa se indicarán los números GPIO asociados a cada función, por ejemplo mediante los campos `pin_d0`…`pin_d7`, `pin_vsync`, `pin_href` y `pin_pclk` de `camera_config_t`. **GPIO no significa que todos los números sirvan en cualquier placa:** el perfil debe respetar los GPIO realmente expuestos, sus funciones alternativas, pines de arranque, memoria y periféricos reservados. El dibujo no impondrá una asignación universal.

La ESP32-S3 DevKitC-1 es el primer objetivo de circuito porque ya existe en el catálogo, pero su `module.json` actual no define un perfil de cámara ni una variante con PSRAM. El SDD no copiará el pinout de una placa ESP32-S3-EYE, WROVER o ESP32-CAM como si correspondiera a DevKitC-1. Antes del TDD se debe validar una asignación completa contra el esquema y la variante exacta de la placa elegida. Si la placa física seleccionada tiene cámara integrada, se documentará como un perfil de placa aparte y no como este módulo cableado.

La alimentación y el consumo deben ajustarse a la hoja de datos del módulo OV2640 elegido. El motor eléctrico comprobará conexiones y alimentación dentro de sus límites, pero no modelará inicialmente los tiempos de señal ni la potencia del sensor a nivel de componente.

## 3. Software físico y compatibilidad de firmware

El controlador oficial `esp32-camera` expone `esp_camera_init`, `esp_camera_fb_get` y `esp_camera_fb_return` mediante `esp_camera.h`. El sensor entrega un framebuffer que declara bytes, longitud, ancho, alto y formato.

Para hardware físico, la primera ruta será **ESP-IDF** con el componente oficial. Arduino sobre ESP32 también puede usar la biblioteca que integra Arduino-ESP32; queda como ruta secundaria después del ejemplo IDF.

El ejemplo físico no será MicroPython estándar. La API `machine` documenta `Pin`, `I2C`, `SPI` e `I2S`, pero no ofrece la API del driver DVP `esp_camera`. Añadir soporte real en MicroPython requeriría compilar un módulo C nativo que integre el controlador y exponga los buffers al intérprete; eso queda fuera de la primera entrega. El proyecto actual puede conservar MicroPython para ArduCAM, pero la documentación de esta cámara debe decir con claridad que sus ejemplos físicos usan ESP-IDF o Arduino.

## 4. Alcance del driver y configuración

La implementación física usará la API pública de Espressif, no reimplementará registros internos del OV2640. El ejemplo configurará:

- formato JPEG;
- resolución QVGA 320 × 240;
- un framebuffer y modo de captura bajo demanda;
- un conjunto de pines tomado del perfil de placa validado;
- inicialización, captura, lectura de metadatos, hash y devolución del framebuffer.

No se declarará que el sensor se comporta como FIFO SPI de ArduCAM. El framebuffer de `esp_camera` es una imagen capturada por el driver y se libera explícitamente para su reutilización. La calidad y los límites concretos se fijarán según el OV2640 y la versión del driver seleccionados.

PSRAM se tratará como una propiedad del perfil de placa y de la configuración: el driver oficial la requiere salvo para JPEG a resolución CIF o inferior. QVGA JPEG está dentro de esa excepción, pero la capacidad, el número de buffers y las resoluciones mayores no se asumirán. Si se habilitan resoluciones superiores, el perfil deberá declarar PSRAM disponible y activa.

## 5. Responsabilidades y arquitectura

| Subsistema | Responsabilidad |
|---|---|
| Catálogo | Tipo de módulo DVP, grupos de pines, alimentación y descriptor de cámara. |
| Perfil de placa | Mapa de GPIO validado y disponibilidad de PSRAM para un modelo/variante concreto. |
| Frontend | Panel de la cámara: seleccionar dispositivo, obtener permiso por gesto, mostrar estado y detener el stream. |
| Controlador de webcam existente | Mantener la sesión; extraer fotogramas nuevos cuando el backend solicite capturas. |
| Backend de cámara | Reutilizar validación, sesión, límites de JPEG, almacenamiento temporal y transporte HTTP existentes. |
| Adaptador de emulación | Recibir una solicitud del firmware virtual, correlacionar respuesta y entregar bytes/metadatos de forma acotada. |
| Firmware físico | Usar `esp_camera.h` y devolver el framebuffer según el ciclo de vida del driver. |
| Firmware de emulación | Usar un adaptador de compatibilidad que implemente solo la superficie declarada, sin fingir DVP eléctrico. |
| Pantallas | Fuera de esta entrega; un consumidor posterior podrá convertir JPEG a RGB565 y escribir en TFT/OLED. |

Los componentes frontend no importarán `app.ts`; comunicación por el puente existente. La sesión de webcam seguirá temporal y no se guardará en `project.json`.

## 6. Flujo de captura virtual

1. El usuario agrega y cablea el módulo DVP al ESP32-S3, y activa la webcam desde el panel de ese módulo.
2. El navegador pide permiso mediante `getUserMedia()` tras la acción explícita del usuario.
3. El firmware virtual llama la operación de captura soportada por el adaptador.
4. El adaptador emite una solicitud identificada con proyecto, instancia de cámara y ejecución actual.
5. El backend la entrega al navegador propietario de la sesión mediante un evento WebSocket, sin exponer identificadores privados de sesión.
6. El navegador obtiene un fotograma nuevo, lo codifica como JPEG y lo envía por la ruta autenticada por sesión ya existente.
7. El backend valida la imagen, verifica la solicitud y la normaliza a 320 × 240 conservando proporción con bandas cuando sea necesario.
8. El adaptador entrega esos mismos bytes al firmware virtual y habilita metadatos de la captura.
9. El ejemplo calcula longitud y SHA-256; el panel muestra la captura confirmada por el backend.

El flujo reutilizará el protocolo introducido por ArduCAM donde sea compatible (requestId, `camera.capture.request`, error correlacionado y política de timeout), pero usará un adaptador de captura distinto. No se enviarán buffers JPEG completos por WebSocket: HTTP seguirá transportando imágenes.

Habrá una sola solicitud pendiente por instancia. Inicio de nueva ejecución, parada/reinicio, pérdida de alimentación, desconexión de cámara o sesión cerrada cancelarán la solicitud. Una respuesta tardía no podrá completar una ejecución distinta. Si la webcam no está activa o no responde antes del timeout, la captura fallará y no se fabricará un framebuffer exitoso.

## 7. Frontera de fidelidad de emulación

La plataforma actualmente usa `esp-emu` para ejecutar el ESP32-S3, pero su integración de chips conectados sustituye llamadas MicroPython I2C/SPI por un puente UART. Ese mecanismo no representa la interfaz DVP. Tampoco existe hoy un periférico `LCD_CAM`, DMA de cámara ni un sensor que emita PCLK/VSYNC/HREF hacia el emulador.

Por eso la primera entrega separará dos afirmaciones:

- **Sí se valida:** la lógica de aplicación que inicia una captura, maneja éxito/error, procesa el JPEG recibido y libera el buffer en la API adaptada.
- **No se valida:** la inicialización real del driver sobre el periférico emulado, la temporización eléctrica DVP, el DMA, la calidad/latencia del sensor físico ni la compatibilidad de pines con hardware.

El adaptador de emulación debe estar claramente nombrado y activado por configuración/toolchain. No debe reemplazar silenciosamente la biblioteca de hardware ni hacer que un build físico dependa de APIs privadas del emulador. El ejemplo se dividirá en una capa de aplicación común y un adaptador elegido en compilación:

```text
aplicación de captura
  ├─ hardware: esp_camera.h → driver DVP oficial → OV2640 físico
  └─ emulación: adaptador virtual → webcam del navegador → JPEG normalizado
```

La API común tendrá únicamente inicializar, solicitar un framebuffer, consultar sus metadatos/bytes, liberar el framebuffer y reportar error. La forma concreta de enlazar el adaptador en el toolchain ESP-IDF/Arduino deberá verificarse con el sistema de build antes de implementar; no se presupone que `esp-emu` cargue drivers intercambiables automáticamente.

## 8. Límites y errores iniciales

- Imagen de emulación: JPEG QVGA, máximo 1 MiB conforme al contrato de webcam existente.
- Una captura pendiente por instancia; sin flujo continuo ni cola de imágenes.
- Una sesión de webcam propietaria por instancia, siguiendo exclusividad y heartbeat actuales.
- Timeout de captura: reutilizar el de ArduCAM salvo que una medición justifique cambiarlo; un timeout del backend y otro del adaptador deben quedar coordinados.
- Sesiones, framebuffer y captura retenida no se guardan en `project.json` ni sobreviven al reinicio del servidor.
- Rechazar sensor desconectado, configuración no soportada, módulo no alimentado, pinout incompleto, webcam no activa, captura vencida, JPEG inválido o respuesta tardía.
- Mantener las comprobaciones actuales de Host y Origin; no loguear bytes de imagen ni secretos de sesión.

Los códigos estables del servicio actual se reutilizarán donde correspondan. Los nuevos errores de emulación (adaptador ausente, perfil de cámara incompatible, ejecución cancelada) tendrán código y texto en español.

## 9. TDD y plan de trabajo

### Etapa A — cerrar decisiones físicas

- Elegir el módulo concreto (OV2640 breakout frente a placa con cámara integrada).
- Validar el esquema y la tabla de pines de la variante exacta de ESP32-S3 DevKitC-1 o seleccionar una placa de cámara con perfil fijo.
- Confirmar si la variante cuenta con PSRAM; limitarla a JPEG QVGA si no la requiere.
- Fijar versión/revisión del componente oficial y toolchain físico ESP-IDF.
- Definir si Arduino entra en la primera entrega o en una posterior.

### Etapa B — pruebas de contrato antes del código

- Adaptador: inicialización, una solicitud, respuesta JPEG, timeout, error y cancelación.
- Correlación: respuestas tardías y reinicios no contaminan capturas posteriores.
- Límites: módulo desconectado/no alimentado, tipo incorrecto, longitud excedida y datos inválidos.
- Compatibilidad: la webcam virtual y el recorrido ArduCAM existente mantienen su conducta.
- Plantilla física: configuración usa el pinout validado; adquisición y devolución de framebuffer se emparejan incluso ante errores.

### Etapa C — componentes de catálogo y firmware de emulación

- Agregar el módulo DVP con pines funcionales y datos/descriptor de cámara.
- Añadir el adaptador virtual sin alterar la interpretación de I2C/SPI existentes.
- Construir una plantilla de ESP-IDF con aplicación común y backend virtual inyectado solo en emulación.
- Mantener fuente nueva y modificada en TypeScript; el firmware de ejemplo se genera desde plantillas TypeScript según la convención del proyecto.

### Etapa D — ejemplo físico

- Añadir proyecto ESP-IDF mínimo con el componente `espressif/esp32-camera`.
- Seleccionar OV2640, JPEG QVGA, un buffer y perfil de pines documentado.
- Imprimir longitud, dimensiones, formato y SHA-256, y devolver framebuffer tras el procesamiento.
- Compilar en CI/toolchain y registrar que esto solo valida compilación hasta probar la placa.

### Etapa E — integración y aceptación

- Recorrido determinista automatizado: solicitud del firmware → webcam sintética → backend → adaptador → firmware.
- Comparar longitud, bytes y SHA-256 entre captura del backend y datos entregados a la app.
- Probar cancelación por parada, reinicio, desconexión y pérdida de sesión.
- En localhost, activar la webcam, ejecutar el firmware y comprobar una imagen nueva sin pulsar Capturar.
- Prueba física posterior: conectar el sensor a la placa seleccionada, tomar varias capturas, validar el pinout, PSRAM y liberación de buffers.
- Regresión: MicroPython I2C/SPI, ArduCAM, TFT, webcam, Vitest, typechecks y build web.

## 10. Criterios de aceptación

La etapa de emulación se acepta cuando la llamada de captura del firmware virtual genera una petición de webcam, recibe una imagen nueva desde el backend, y el firmware reporta exactamente las dimensiones, longitud y SHA-256 de los bytes confirmados. Parar o reiniciar debe cancelar la espera y liberar los recursos de webcam y buffer.

La etapa física se acepta por separado cuando el ejemplo ESP-IDF inicializa una variante de OV2640 y obtiene JPEG real en una placa cuyo perfil de pines y memoria están documentados. La aceptación del emulador nunca se presentará como prueba de hardware físico.

## 11. Referencias oficiales

Referencias consultadas el 4 de octubre de 2026:

- [Driver oficial Espressif `esp32-camera`](https://github.com/espressif/esp32-camera): SoC/sensores soportados, JPEG, PSRAM, `esp_camera.h`, buffers e integración con ESP-IDF/Arduino.
- [API pública `esp_camera.h`](https://github.com/espressif/esp32-camera/blob/master/driver/include/esp_camera.h): configuración de pines, formato, framebuffer y funciones de inicialización/adquisición/devolución.
- [Mapas de pines del ejemplo oficial](https://github.com/espressif/esp32-camera/blob/master/examples/camera_example/main/camera_pinout.h): ejemplos por placa; confirman que la asignación es específica de cada diseño, no universal.
- [Documentación de `machine` en MicroPython](https://docs.micropython.org/en/latest/library/machine.html): clases periféricas estándar; no documenta una API `esp_camera` para la interfaz DVP.
- [SDD de cámara virtual](SDD-CAMARA.md): sesiones, capturas, permisos y límites de webcam existentes.
- [SDD ArduCAM](SDD-ARDUCAM.md) y [SDD ArduCAM + TFT](SDD-ARDUCAM-TFT.md): precedente de solicitud de captura por firmware y recorrido JPEG, con buses SPI/I2C distintos.
