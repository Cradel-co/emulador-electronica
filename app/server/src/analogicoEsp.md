# ADC ESP mediante MicroPython

Esta ruta implementa `machine.ADC` en el shim que se carga antes de `main.py`.
Cada `read()` consulta por UART al servidor y convierte la última solución DC válida
del circuito mediante un perfil explícito. `read_u16()` expande esa cuenta de 12 bits.
No inyecta señales en el periférico SAR de esp-emu: Arduino, ESPHome e IDF nativo
siguen sin una ruta analógica acreditada.

## Contrato

El proyecto guarda `sim.analogicoEsp[boardId]`, validado por
`shared/src/analogicoEsp.ts`. Cada perfil contiene:

- `tipo: 'micropython-lineal-explicito-12bits'`, `chip`, `id`, `fuente` y `condiciones`.
- `rangoVAlimentacion: { min, max }`, con límites finitos y `0 < min <= max`.
- `canales`: combinaciones únicas de `gpio` y `atenuacion`
  (`0db`, `2.5db`, `6db`, `11db`), con `rangoVEntrada`, `voltajeCeroV`
  y `voltajeFondoEscalaV` explícitos.

El perfil declara una transferencia de escenario:

```text
cuenta = clip(floor(4096 × (Vin − voltajeCeroV) /
                          (voltajeFondoEscalaV − voltajeCeroV)), 0, 4095)
```

Se rechaza la lectura antes de aplicar la fórmula si falta solución, alimentación,
entrada o perfil del canal; si el GPIO no pertenece al dominio modelado; o si
alimentación/entrada quedan fuera del rango declarado. También se rechaza Vin
fuera de GND..VCC. Saturar la transferencia dentro del dominio no autoriza
sobretensiones. Los parámetros/rangos son declaraciones del escenario, no
garantías del fabricante ni una calibración de laboratorio. No hay referencia ni
curva por defecto.

`estadoAnalogicoEspDesdeCircuito(boardId, descriptor, analisis)` produce
`{ resuelto, vcc, canales }`. VCC y canales son relativos a GND de esa placa;
los pines sin solución o flotantes conservan `null`. Usa el riel `3V3` de los
descriptores ESP soportados. No estima la impedancia de Thévenin ni aplica carga
de adquisición al solver.

`OpcionesArranque.perfilAnalogicoEsp` y `.analogicoEsp` inicializan la lectura antes
de ejecutar el programa. `actualizarAnalogicoEsp(estado)` copia un snapshot nuevo.
El perfil también se copia y queda fijo durante la corrida; cambiarlo requiere
relanzar. El reset conserva el perfil y el snapshot más reciente: este modelo
lineal no tiene memoria de adquisición. Otra corrida empieza sin snapshot/perfil
si no se proporcionan. Los callbacks de corridas anteriores no responden.

El backend rechaza un perfil ESP declarado en firmware nativo o en AVR, y un
perfil AVR declarado en el backend ESP. Un perfil de otro chip también falla antes
de reservar puertos o lanzar procesos.

## API y protocolo

Se modela únicamente ADC1: ESP32-S3 GPIO1..10, ESP32-C3 GPIO0..4 y ESP32-C6
GPIO0..6. Un pin además debe estar publicado por el descriptor y resuelto en el
snapshot. ADC2 requiere arbitraje/WiFi fuera del alcance actual.

- `ADC(Pin(gpio), atten=...)` y `ADC(gpio, atten=...)`, `init(atten=...)`, `atten(...)`.
- La atenuación por omisión es `ATTN_11DB`, como el código ESP de MicroPython
  v1.29.0 usado por el proyecto; la configuración es compartida por pad.
- `width(ADC.WIDTH_12BIT)`, `read()` y `read_u16()`; esta última usa
  `(raw << 4) | (raw >> 8)`, igual que el puerto ESP de esa versión.
- `sample_ns` no está admitido por el constructor/init. `read_uv()`, `ADCBlock`,
  `block()`, `deinit()` y otros anchos se rechazan explícitamente: no se delegan al
  ADC nativo ni se inventan calibración/eFuse o ciclo de vida de la unidad.

El shim manda `@ADC <id> <gpio> <atenuacion 0..3>`; el servidor responde
`@ADCR <id> <cuenta>` o `@ADCR <id> E:<codigo>`. Los errores de lectura se convierten
en `OSError(5, 'ADC MicroPython: <codigo>')`; ausencia de perfil es `SIN_MODELO`.
No se sustituye una respuesta ausente/incorrecta o una entrada desconocida por cero.

## Evidencia y límites

Los tests usan oráculos analíticos de transferencia, SPICE para un divisor real,
CPython ejecutando el shim completo con UART stdin/stdout contra el puente real,
y el gestor con procesos/sockets dobles para verificar arranque/reset/stop. Cubren
GPIO/atenuación, 12 bits/16 bits, unknown, flotantes, dominio, rechazo sin modelo,
aislamiento entre placas, snapshot/perfil inmutables y listeners obsoletos.
No compilan ni ejecutan firmware ESP y no certifican temporización del silicio.

No se modelan adquisición RC, memoria sample-and-hold, ruido, INL/DNL, temperatura,
impedancia de carga, arbitraje ADC2/WiFi, modos continuos, eFuse ni calibración
del ESP. La solución DC se refresca por el actualizador del runtime; no hay
cosimulación continua ni una muestra sincronizada a cada ciclo del MCU.

## Fuentes primarias

- [MicroPython v1.29.0, implementación ESP de machine.ADC](https://github.com/micropython/micropython/blob/v1.29.0/ports/esp32/machine_adc.c):
  mapeo GPIO/unidades, atenuación inicial, ancho y expansión de `read_u16()`.
- [MicroPython, referencia ADC para ESP32](https://docs.micropython.org/en/v1.29.0/esp32/quickref.html#adc-analog-to-digital-conversion):
  API, limitaciones por chip y distinción entre cuentas y `read_uv()`.
- [Espressif ESP32-S3, ADC oneshot](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/adc_oneshot.html):
  unidades/canales, ancho y atenuación como configuración del convertidor.
- [Espressif ESP32-S3, calibración ADC](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/adc_calibration.html):
  variación de referencia y calibración específica con eFuse. Esta implementación
  no convierte un valor nominal en una garantía de calibración.
- [esp-emulator](https://github.com/espressif/esp-emulator): su interfaz instalada
  v0.44.0 no ofrece inyección analógica de ADC; el hook implementado aquí pertenece
  exclusivamente al shim MicroPython controlado por la aplicación.
