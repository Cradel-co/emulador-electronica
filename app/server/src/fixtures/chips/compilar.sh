#!/bin/sh
# Compila los sketches de prueba de los chips con arduino-cli y las librerías REALES que usa la
# gente (versiones fijadas acá), y deja cada .hex al lado de su .ino. Los .hex se versionan: los
# tests corren sin Docker. Volver a correr esto solo si cambia un sketch o una versión.
#
#   sh app/server/src/fixtures/chips/compilar.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGEN=emu-arduino-avr:1.5.1-1.8.6
LIBS='"Adafruit BME280 Library@2.3.0" "Adafruit Unified Sensor@1.1.15" "Adafruit BusIO@1.17.4" "RTClib@2.1.4" "Adafruit SSD1306@2.5.17" "Adafruit GFX Library@1.12.6" "Adafruit MPU6050@2.2.9" "Adafruit ST7735 and ST7789 Library@1.11.0"'
docker run --rm -e UID_HOST="$(id -u):$(id -g)" -v "$DIR:/fx" "$IMAGEN" sh -c "
  set -e
  arduino-cli lib update-index >/dev/null
  arduino-cli lib install $LIBS >/dev/null
  for ino in /fx/*/*.ino; do
    d=\$(dirname \"\$ino\"); n=\$(basename \"\$d\")
    echo \"== \$n\"
    arduino-cli compile --fqbn arduino:avr:uno --output-dir /tmp/out-\$n \"\$d\" 2>&1 | grep -E 'Sketch uses|Global variables|error' || true
    cp /tmp/out-\$n/\$n.ino.hex \"\$d/\$n.hex\" && chown \"\$UID_HOST\" \"\$d/\$n.hex\"
  done
"
