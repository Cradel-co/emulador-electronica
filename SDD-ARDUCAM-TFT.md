# SDD: mostrar una captura ArduCAM en la TFT ST7735

**Estado:** diseño propuesto para el siguiente hito.  
**Base:** ArduCAM Mini 2MP Plus, ESP32-S3, MicroPython y webcam en localhost.  
**Resultado buscado:** una foto solicitada por el firmware, decodificada y dibujada en una TFT conectada al circuito.

## 1. Objetivo y alcance

Ampliar la plantilla ArduCAM existente para que, después de recibir una fotografía JPEG
completa por I²C/SPI, el firmware la decodifique y la muestre en el módulo TFT ST7735
128 × 160, también mediante el bus SPI del circuito.

La primera entrega mostrará una imagen fija por captura. El programa podrá pedir capturas
sucesivas manualmente, pero no habrá temporizador ni streaming continuo. El panel de cámara
seguirá mostrando la captura confirmada por el backend y permitirá comparar su SHA-256 con
el JPEG leído por el firmware.

Quedan fuera: video en vivo, rotación y controles de imagen configurables, más resoluciones,
otros controladores de pantalla, aceleración JPEG específica del emulador y validación en
una placa física.

## 2. Estado existente y brecha

- La ArduCAM emulada entrega al firmware una captura JPEG 320 × 240 bajo demanda; el ejemplo
  lee la FIFO en bloques y comprueba longitud y SHA-256.
- El backend conserva y muestra el JPEG confirmado por la webcam.
- La ST7735 ya interpreta comandos y píxeles RGB565 por SPI, y su imagen aparece en el
  circuito.
- Falta un decodificador JPEG que pueda ejecutar el firmware MicroPython instalado por el
  proyecto, además del ejemplo que conecte cámara y pantalla.

El JPEG no se enviará en crudo a la ST7735: la pantalla no entiende ese formato. La conversión
ocurrirá en el firmware y el resultado se escribirá a la pantalla a través del controlador
ST7735 y sus señales reales del circuito.

## 3. Decisión de decodificación

La solución será una biblioteca pequeña, escrita para este proyecto y compatible con
MicroPython estándar, incluida como fuente generada desde una plantilla TypeScript. No
requerirá un firmware MicroPython modificado, una extensión C externa ni un módulo privado
del emulador; así el mismo programa podrá probarse en esp-emu y llevarse a una placa física.

La primera versión aceptará JPEG baseline secuencial de 8 bits generado por el servicio de
cámara. Soportará las tablas Huffman y el submuestreo YCbCr que produce la normalización del
backend. Rechazará de forma explícita JPEG progresivo, componentes o marcadores no soportados,
dimensiones inesperadas y entradas truncadas. Las restricciones se comprobarán antes de
reservar memoria o comenzar la escritura en la pantalla.

El decodificador entregará píxeles en bloques pequeños, no creará un framebuffer RGB completo.
La conversión a RGB565 y el escalado por vecino más próximo se harán por bloque. Así se limita
la memoria de trabajo, que contiene además el JPEG de entrada y la FIFO de ArduCAM. El diseño
debe medir memoria y tiempo en el firmware ESP32-S3 emulado antes de fijar los tamaños de
bloque y los límites de aceptación.

## 4. Encuadre y formato de pantalla

La imagen de cámara es 320 × 240 y la TFT es 128 × 160. Se conservará la proporción y se
mostrará completa, centrada, con bandas negras arriba y abajo. No se estirará ni se recortará
la imagen. El área activa tendrá 128 × 96 píxeles.

Los píxeles se convertirán a RGB565 big-endian, que es el orden que espera la ST7735 del
proyecto. El programa fijará una ventana de escritura con CASET/RASET, enviará RAMWR y
transmitirá filas o bloques sin liberar CS a mitad de la ráfaga. Las señales SCLK y MOSI se
compartirán entre cámara y TFT; cada módulo tendrá su propio CS. D/C y RESET de la TFT usarán
GPIO independientes.

## 5. Circuito de ejemplo

Se conservarán las conexiones actuales de la cámara y se agregará la TFT al mismo bus SPI:

| Señal | ESP32-S3 | Módulo |
|---|---:|---|
| ArduCAM VCC / GND | 3V3 / GND | alimentación compartida |
| ArduCAM SDA / SCL | GPIO8 / GPIO9 | I²C |
| ArduCAM SCLK / MOSI / MISO | GPIO12 / GPIO11 / GPIO13 | SPI |
| ArduCAM CS | GPIO10 | selección ArduCAM |
| TFT VCC / GND / LED | 3V3 / GND / 3V3 | alimentación |
| TFT SCK / SDA | GPIO12 / GPIO11 | SPI compartido |
| TFT CS / A0 / RESET | GPIO14 / GPIO15 / GPIO16 | control TFT |

Los GPIO son asignaciones de esta plantilla, no requisitos de los módulos. Cambiar un GPIO
requiere cambiar el cable del diagrama y el argumento correspondiente del firmware. El
ejemplo verificará alimentación y que ambos CS permanezcan altos cuando el otro periférico
usa SPI.

## 6. Flujo de captura y visualización

1. El usuario activa la webcam desde el módulo ArduCAM.
2. MicroPython configura OV2640 y ArduCAM como en el ejemplo existente.
3. El firmware solicita una captura; el navegador obtiene un fotograma nuevo.
4. El backend valida y normaliza el JPEG 320 × 240; la FIFO conserva esos bytes.
5. MicroPython lee el JPEG completo, valida SOI/EOI y calcula longitud y SHA-256.
6. El decodificador valida cabecera, tablas, dimensiones y formato antes de dibujar.
7. Inicializa la ST7735, limpia la pantalla a negro y escribe la imagen centrada por SPI.
8. El panel de cámara y la consola muestran que la captura fue solicitada por firmware; el
   panel indica la huella y la TFT muestra la misma imagen, reducida.

Una nueva captura solo reemplaza la imagen de pantalla después de recibirse y validarse
completamente. Si la captura o la decodificación falla, el firmware informa la causa y no
presenta datos parciales como una imagen válida. La captura anterior puede permanecer visible.

## 7. Arquitectura y archivos previstos

- La plantilla del proyecto será TypeScript y generará el ejemplo `arducam.py`, el
  decodificador MicroPython y `main.py`; no se añadirán fuentes ejecutables JavaScript.
- Se mantendrá el driver de ArduCAM independiente de la TFT.
- El driver ST7735 será pequeño y usará `machine.SPI` y `machine.Pin`, con la misma forma que
  una aplicación MicroPython física.
- Los buses, el sandbox y los chips existentes no recibirán una API de alto nivel para
  transferir imágenes entre cámara y pantalla.
- Una plantilla nueva de circuito contendrá ArduCAM, TFT, ESP32-S3 y todos los cables. La
  plantilla actual de ArduCAM conservará su comportamiento y ejemplo de verificación.
- La documentación de uso explicará que se trata de fotos fijas solicitadas por firmware y
  listará los límites del decodificador.

## 8. TDD y verificación

Primero se agregarán pruebas que fallen por la ausencia de las capacidades requeridas:

- **Conversión JPEG:** fixture JPEG baseline determinista, SOF0, submuestreo soportado,
  dimensiones y tablas; comparar píxeles seleccionados RGB565 contra una decodificación
  independiente.
- **Fallos del decodificador:** JPEG truncado, marcador desconocido, progresivo, dimensiones
  fuera del límite y tablas inválidas; debe fallar antes de escribir la TFT.
- **Controlador TFT:** inicialización, limpieza, CASET/RASET/RAMWR, conversión RGB565,
  encuadre centrado y CS sostenido durante los bloques.
- **SPI compartido:** capturar por ArduCAM y luego dibujar por TFT en el mismo `machine.SPI`;
  confirmar que cada chip responde solo cuando su CS está activo.
- **Ejemplo MicroPython:** longitud/hash del JPEG coinciden con backend y bytes de FIFO; al
  completar la decodificación, los píxeles publicados por ST7735 coinciden con los valores
  esperados para el fixture.
- **E2E localhost:** conectar webcam, ejecutar firmware sin botón Capturar, verificar la foto
  del panel y la TFT del circuito; cambiar el objeto y repetir. Detener la simulación debe
  cancelar cualquier captura pendiente.
- **Regresión:** webcam virtual, ArduCAM, ST7735 existente, Vitest, typechecks de shared,
  servidor y frontend, build web y e2e pertinentes.

La prueba manual final aceptará permiso de webcam en localhost, observará el recorrido
completo y comprobará dos imágenes diferentes. La prueba física del driver queda separada y
se realizará cuando haya un conjunto real ESP32-S3 + ArduCAM + ST7735 disponible.

## 9. Criterios de aceptación

El hito se considerará terminado cuando:

1. MicroPython solicite una fotografía nueva a la webcam mediante la ArduCAM emulada.
2. El firmware reciba el JPEG completo y su SHA-256 coincida con el backend.
3. El firmware decodifique el JPEG con el módulo MicroPython estándar y envíe píxeles RGB565
   por SPI al ST7735 conectado al circuito.
4. La TFT muestre una versión reducida sin deformación, con bandas negras y colores
   comprobados mediante fixture y prueba localhost.
5. Una segunda captura cambie la imagen; detener o reiniciar no deje webcam o solicitud
   pendiente activa.

## 10. Referencias

- [SDD de webcam virtual](SDD-CAMARA.md).
- [SDD de ArduCAM Mini 2MP Plus](SDD-ARDUCAM.md).
- [Estado y arquitectura de pantallas](docs/pantallas.md).
- [Módulo TFT ST7735](modules/tft-st7735-128x160/module.json).
- [Controlador de chip ST7735](chips/sitronix-st7735/comportamiento.js).
