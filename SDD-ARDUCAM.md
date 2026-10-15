# SDD: ArduCAM Mini 2MP Plus con ESP32-S3 y MicroPython

Estado: implementado y validado automáticamente; aceptación con webcam física pendiente. La webcam virtual en localhost fue probada y confirmada por el usuario («Funciona»). Esta entrega reutiliza su servicio, sin requerir otra cámara en el circuito.

## Alcance

Una fotografía JPEG nueva, solicitada por firmware mediante machine.I2C, machine.SPI y machine.Pin. JPEG 320 × 240, SPI modo 0 a 1 MHz, I2C 0x30. TFT, video continuo, audio y validación física del driver quedan fuera de esta entrega.

## Referencias fijadas

[Mini 2MP Plus](https://docs.arducam.com/Arduino-SPI-camera/Legacy-SPI-camera/2MP-Plus/), consultada el 3 de octubre de 2026. Registros y tablas del fabricante: [ArduCAM/Arduino, revisión 066a7ea1ccae4813e9a9b9d04e55f96bb8b4039e](https://github.com/ArduCAM/Arduino/tree/066a7ea1ccae4813e9a9b9d04e55f96bb8b4039e/ArduCAM). Las tablas adaptadas conservan atribución y licencia LGPL-2.1-or-later. El driver requiere validación posterior en hardware físico.

## Circuito

| ArduCAM | ESP32-S3 |
|---|---|
| VCC / GND | 3V3 / GND |
| SDA / SCL | GPIO8 / GPIO9 |
| SCLK / MOSI / MISO | GPIO12 / GPIO11 / GPIO13 |
| CS | GPIO10 |

Dos chips por instancia: OV2640 I2C y ArduChip SPI. El coordinador comunica la configuración del sensor al controlador. Sin alimentación no hay respuesta. Modelo resistivo aproximado: 70 mA a 3,3 V; no reproduce los transitorios ni el consumo por estado (la especificación comercial publica 70 mA a 5 V).

## Protocolo soportado

Sensor: banco 0/1 en 0xff; reset COM7 (banco 1, 0x12 bit 7); identificación PID/VER 0x0a/0x0b = 0x26/0x42, fabricante 0x1c/0x1d = 0x7f/0xa2. Conserva las escrituras de las tablas oficiales JPEG_INIT, YUV422, JPEG y 320x240_JPEG. Comprueba formato JPEG (DSP 0xda) y dimensiones (0x5a/0x5b/0x5c); otras configuraciones no producen fotografías y se informan en consola.

SPI: prueba 0x00; FIFO 0x04 (limpiar 0x01, iniciar 0x02, reiniciar puntero de lectura 0x10 y escritura 0x20); GPIO 0x06; estado 0x41 (terminada 0x08); tamaño 0x42–0x44; lectura individual 0x3d y ráfaga 0x3c. Escritura de registros: dirección con bit 7. CS conserva la transacción entre llamadas; subirlo finaliza el comando. Registros no modelados no emulan el hardware completo.

## Coordinación y aislamiento

El inicio por SPI emite una solicitud identificada. El backend publica camera.capture.request (proyecto, instancia, requestId), sin identificador privado de sesión. El navegador propietario captura un fotograma nuevo y lo sube con requestId. El backend decodifica, valida y normaliza a 320 × 240 con bandas; conserva exactamente los bytes entregados a la FIFO y publica metadatos con SHA-256. La captura manual virtual mantiene su contrato.

Una solicitud por instancia, vencimiento de 10 segundos; el driver espera hasta 15 segundos. Un error, cierre de sesión, limpieza, apagado, parada o reinicio cancela la solicitud. Identificadores únicos y comprobación posterior a la decodificación impiden que respuestas tardías completen otra ejecución. La FIFO mantiene una copia estable hasta limpiar o completar otra captura. Las entradas externas al sandbox son datos JSON validados y limitados, nunca objetos del servidor.

Rutas existentes de webcam más requestId opcional en POST /session/:sesion/captures y POST /session/:sesion/requests/:requestId/error. Sesión exclusiva, heartbeat 15 s / vencimiento 45 s, JPEG hasta 1 MiB y presupuesto de fotos del servidor 16 MiB. La FIFO tiene una copia adicional limitada a 1 MiB por cámara activa.

## Entrega y aceptación

Tests primero: identificación/configuración, FIFO, ráfagas divididas, punteros, cancelación y respuestas tardías. Plantilla TypeScript genera driver y programa MicroPython; lee bloques de 512 bytes, valida SOI/EOI, imprime longitud y SHA-256. Integración con ESP32-S3 real emulado y JPEG determinista debe comparar ambas medidas con el backend. Prueba manual localhost: activar webcam, ejecutar firmware sin pulsar Capturar, comparar huella y repetir con otro objeto. Regresión: webcam virtual, buses existentes, Vitest, typechecks y build web.

## Resultados de validación

MicroPython v1.29.0 ejecutado en ESP32-S3 mediante esp-emu v0.44.0: dos fotogramas deterministas diferentes solicitados por I2C/SPI, con longitud y SHA-256 idénticos a los JPEG recuperados del backend. Una respuesta retenida y enviada tras cortar VCC fue rechazada, conservando la fotografía confirmada anterior. No se pulsó Capturar.

Regresión automatizada: webcam virtual (captura, permisos, exclusividad y eliminación), BME280 I2C y TFT ST7735 SPI con MicroPython. Vitest, typechecks shared/servidor/frontend y build web. El build general mantiene la limitación previa: shared no declara el script build.

Aceptación pendiente: repetir el ejemplo con la webcam física en localhost y cambiar el objeto frente a la cámara. La confirmación previa del usuario corresponde a la webcam virtual, no a este recorrido nuevo. La TFT no recibe imágenes de ArduCAM en esta entrega.
