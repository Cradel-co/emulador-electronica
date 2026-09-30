# Imagen para compilar sketches de Arduino para placas AVR (Arduino Uno, etc.).
#
# arduino-cli + el core arduino:avr ya instalado adentro de la imagen: así cada
# compilación arranca sin bajar nada (el core pesa ~150 MB con avr-gcc). La app
# la construye sola la primera vez que se compila un proyecto de Arduino Uno
# (buildService.ts → ensureArduinoImage). Versiones fijadas a propósito (sección
# 16 de la guía): cambiarlas acá y en ARDUINO_AVR_IMAGE de buildService.ts.
#
# Uso manual:
#   docker build -t emu-arduino-avr:1.5.1-1.8.6 docker/arduino-avr
#   docker run --rm -v "$PWD/sketch:/sketch" emu-arduino-avr:1.5.1-1.8.6 \
#     arduino-cli compile --fqbn arduino:avr:uno /sketch
FROM node:20-bookworm-slim

ARG ARDUINO_CLI_VERSION=1.5.1
ARG ARDUINO_AVR_VERSION=1.8.6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh -s "v${ARDUINO_CLI_VERSION}"

# Todo lo de arduino-cli en /opt/arduino (no en $HOME): la app corre el contenedor
# con el uid del usuario (-u), que no tiene home propio adentro.
ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/staging \
    ARDUINO_DIRECTORIES_USER=/opt/arduino/user \
    ARDUINO_UPDATER_ENABLE_NOTIFICATION=false \
    ARDUINO_METRICS_ENABLED=false

RUN arduino-cli core update-index \
 && arduino-cli core install "arduino:avr@${ARDUINO_AVR_VERSION}" \
 && rm -rf /opt/arduino/staging \
 && mkdir -p /opt/arduino/user \
 && chmod -R a+rwX /opt/arduino

WORKDIR /sketch
