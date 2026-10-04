# ArduCAM y TFT con ESP32-S3 / MicroPython

Seleccioná el módulo ArduCAM, activá la webcam desde su panel y ejecutá el programa.
La primera captura se solicita automáticamente. La huella SHA-256 del JPEG debe coincidir
con la mostrada en el panel de la cámara.

La imagen se decodifica en MicroPython y se envía por SPI a la pantalla ST7735. Pulsá Enter
en la consola serial para solicitar otra fotografía. Se conserva el encuadre 4:3 en un área
de 128 × 96 píxeles, centrada verticalmente en la pantalla de 128 × 160.

Para que el ESP32 emulado pueda procesar una captura en tiempo razonable, esta primera versión
usa el promedio de cada bloque 8 × 8 del JPEG al reducirlo a la TFT. El tamaño de salida es
128 × 96, con detalle efectivo aproximado de 40 × 30; la fotografía JPEG completa permanece
en la FIFO y el backend. La IDCT completa y una salida más nítida quedan para una mejora posterior.

El circuito comparte SCLK y MOSI; la cámara y la pantalla usan CS separados. Los GPIO del
diagrama son asignaciones de ejemplo y deben cambiarse junto con el programa si el cableado
se modifica.

El decodificador acepta JPEG baseline secuencial de 8 bits con Huffman y submuestreo YCbCr
1×1, 2×1, 1×2 o 2×2; el servicio produce 320 × 240. No admite JPEG progresivo ni intervalos
de reinicio. Cada captura es una foto fija; no es video continuo. La prueba en hardware real
queda pendiente.
