# esp-emu (Espressif) — simulación 100% local

Herramienta principal de este workspace para simular el ESP32 **sin ningún servidor externo**: CPU, WiFi, BLE, RMT y más, corriendo como un proceso nativo en tu PC. Hecha por Espressif, en beta: [espressif/esp-emulator](https://github.com/espressif/esp-emulator).

**No es open source**: el repo solo distribuye binarios, docs y scripts auxiliares (el código fuente no está publicado — ver [issue #10](https://github.com/espressif/esp-emulator/issues/10)). Es gratis y corre 100% local, pero si tiene un bug no lo podemos arreglar nosotros: solo buscar un workaround o reportarlo.

Instalado en `~/.local/bin/esp-emu`. Para reinstalar o actualizar: `esp-emu update`, o en otra máquina `curl -fsSL https://raw.githubusercontent.com/espressif/esp-emulator/main/install.sh | sh`.

## ⚠️ Obligatorio en ESP32-S3: consola por UART0

ESPHome manda la consola del S3 por **USB-Serial-JTAG** por defecto, y con eso `esp-emu` se cuelga para siempre en el bootloader (último renglón del log: `entry 0x403c89xx`, y nada más). Solución, en el YAML:

```yaml
logger:
  hardware_uart: UART0
```

Con eso bootea completo en segundos. En la placa real no cambia nada importante: en la DevKitC-1 los logs salen por el puerto USB marcado "UART" en vez del marcado "USB".

(Diagnosticado el 2026-09-28: se colgaba igual con un YAML mínimo sin WiFi ni RMT, y en v0.43.0 y v0.44.0. `--skip-rom` no sirve de workaround. Probablemente es lo mismo que el [issue #11](https://github.com/espressif/esp-emulator/issues/11), reportado para C6.)

## Por qué ESP32-**S3** y no el ESP32 clásico

`esp-emu` no soporta el ESP32 original (Xtensa LX6) — solo C3/C5/C6/H2/P4 (RISC-V) y **S3** (Xtensa LX7, soportado desde v0.43.0 del 2026-09-18). Por eso el proyecto de la alarma usa **ESP32-S3** como chip objetivo (real y simulado). Detalle en [`../../IDEA.md`](../../IDEA.md).

## Generar el firmware simulable

`esp-emu` corre un **binario de flash mergeado** (bootloader + tabla de particiones + app). ESPHome ya lo genera al compilar: es `firmware.factory.bin`. No hace falta mergear a mano.

```sh
# ESPHome (con Docker, sin instalar nada):
docker run --rm -v "$PWD":/config ghcr.io/esphome/esphome compile mi-proyecto.yaml
# Salida:
#   .esphome/build/<nombre>/build/firmware.factory.bin   ← para --firmware
#   .esphome/build/<nombre>/build/firmware.elf           ← para --elf (backtraces con líneas de código)

# ESP-IDF puro:
idf.py set-target esp32s3 && idf.py build && idf.py merge-bin -o build/merged_flash.bin
```

Nota: Docker genera `.esphome/` como root. Se lee sin problema; para borrarlo: `docker run --rm -v "$PWD":/config alpine rm -rf /config/.esphome`.

## Correrlo, con red hacia Home Assistant

```sh
esp-emu --chip esp32s3 \
  --firmware .esphome/build/<nombre>/build/firmware.factory.bin \
  --elf .esphome/build/<nombre>/build/firmware.elf \
  --wifi-ssid "TU_WIFI" --wifi-password "TU_PASSWORD" \
  --net "user,mdns-nat=yes,hostfwd=tcp::6053-:6053"
```

- `--wifi-ssid` / `--wifi-password`: el emulador levanta su propio access point; tienen que coincidir con lo que el firmware tiene en `secrets.yaml`.
- `hostfwd=tcp::6053-:6053`: expone la API nativa de ESPHome en `localhost:6053` de tu PC. **Probado**: la conexión cifrada desde el host funciona (`esphome logs <yaml> --device 127.0.0.1` hace el handshake y trae los logs). En HA: agregar la integración ESPHome a mano con host `127.0.0.1` (o la IP de la PC si HA corre en otro lado), puerto 6053.
- `mdns-nat=yes`: reescribe los anuncios mDNS para que apunten a `127.0.0.1`. Debería permitir que HA descubra el dispositivo solo; **todavía no probado** con HA real.
- Modo **TAP** (IP real en la LAN, como hardware físico): `sudo ./tools/setup-tap.sh` + `--net "tap,ifname=tap0"`. Requiere root; ver el README del repo.

## Simular el receptor/transmisor 433 MHz sin hardware

`esp-emu` emula el **RMT** (el periférico que usan `remote_receiver`/`remote_transmitter` de ESPHome) y tiene un loopback:

```
--rmt-loopback TX_CH:RX_CH
```

Conecta la salida de un canal TX a la entrada de un canal RX dentro del emulador, como un cable entre dos pines. Sirve para validar que el firmware decodifica sus propios códigos EV1527 antes de tener el RXB6/STX882. Todavía no probado con el proyecto de la alarma: hay que averiguar qué número de canal RMT le asigna ESPHome a cada pin (en S3 los canales RX empiezan en 4).

## Referencias

- [README completo](https://github.com/espressif/esp-emulator/blob/main/README.md)
- [Releases y notas de versión](https://github.com/espressif/esp-emulator/releases)
- [Issues](https://github.com/espressif/esp-emulator/issues)
