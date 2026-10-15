# ArduCAM con ESP32-S3 y MicroPython

Activá la webcam desde el panel de la cámara antes de ejecutar. Cada cinco segundos el programa solicita un JPEG nuevo por I2C/SPI e imprime longitud y SHA-256. Compará la huella con el visor del backend.

Driver generado desde app/server/src/templates/arducam.ts. SPI modo 0, 1 MHz; I2C 0x30. Solo JPEG 320 × 240; sin TFT ni video. Su uso en hardware físico requiere validación posterior.
