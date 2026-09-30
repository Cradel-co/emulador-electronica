# Motores de emulación (plugins)

Un **motor** corre el firmware de un chip. Cada placa elige el suyo en su `module.json`:

```json
"board": {
  "backend": { "engine": "avr8js", "options": { "mcu": "atmega328p", "clockHz": 16000000 } },
  "io": { "mode": "native" }
}
```

El server busca `"avr8js"` en `ENGINES` (`index.ts`). **Una placa nueva con un chip que ya
tiene motor es solo datos** (module.json + module.svg); un chip nuevo es un motor nuevo
acá, sin tocar el resto de la app.

| Motor | Estado | Chips | `io.mode` | Opciones |
|---|---|---|---|---|
| `esp-emu` (`espEmu.ts`) | implementado | ESP32-S3/C3/C5/C6/H2/P4 (binario de Espressif) | `bridge-uart` (UART1) | `chip` |
| `avr8js` (`avr8js.ts`) | implementado | ATmega328P (Uno, Nano...) | `native` | `mcu`, `clockHz` |
| `renode` (`renode.ts`) | **preparado, sin implementar** | Cortex-M, RISC-V... por `.repl` | `native` | `platform` |

## Interfaz (`tipos.ts`)

```ts
interface MotorEmulacion {
  nombre: string;                 // lo que va en board.backend.engine
  descripcion: string;
  disponible: boolean;            // false: la placa queda en "compila"/"solo-dibujo"
  modosIo: ('bridge-uart' | 'native')[];
  crear(eventos: EmulatorEvents): Emulador;                        // una instancia = una simulación
  opcionesArranque(desc: BoardDescriptor, artefactos: BuildArtifacts): OpcionesArranque;
  validarOpciones?(opciones, desc): string[];                      // chequeos de board.backend.options
}
```

La instancia (`Emulador`, en `../emulatorBackend.ts`) tiene `start / stop / reset /
getStatus / getRecentLog / writeConsole / getBridge / markBridgeReady / shutdown`, y avisa
todo por `EmulatorEvents` (`../emulator.ts`), igual para cualquier chip:

| Evento | Qué es | Llega a la UI como |
|---|---|---|
| `onLog(línea)` | consola del chip (UART0 / Serial) | `emu.log` |
| `onState(estado)` | `starting` → `booted` → `bridge` (listo para manejar pines); `crashed` / `hung` / `stopped` | `emu.state` |
| `onBridgeState(bool)` | canal de pines conectado/caído | `bridge.state` |
| `onBridgeMessage({type:'READY'})` | la simulación está lista ("En vivo") | `bridge.ready` |
| `onBridgeMessage({type:'OUT', pin, level})` | cambió una salida (número de pin lógico = `board.pins.<nombre>.gpio`) | `pin.out` |

Entradas: `getBridge().setInput(pin, nivel)` (de `pin.in`), `watch(pin)` (de `pin.watch`),
`sendRf(bits, protocolo)`.

- **`bridge-uart`** (esp-emu): esp-emu no deja tocar los pads desde afuera, así que un
  puente dentro del firmware (`firmware/components/sim_bridge`, `simbridge.py`) habla el
  protocolo `@WATCH/@OUT/@IN` por la UART de `board.io`.
- **`native`** (avr8js): el motor ve los registros del MCU; `setInput` va directo al pad
  (`AVRIOPort.setPin`) y `@READY` se manda apenas arranca la CPU. Cada pin de `board.pins`
  necesita `port` y `bit`.

## Agregar un motor

1. Un archivo `miMotor.ts` que exporte un `MotorEmulacion` (ver `avr8js.ts` como ejemplo
   corto) y su clase `Emulador`.
2. Registrarlo en `ENGINES` (`index.ts`).
3. Una placa que lo use en `board.backend.engine`, validarla (`POST /api/boards/validate`
   o la herramienta MCP `validar_placa`) y certificarla (`POST /api/boards/:id/certify` /
   `certificar_placa`).

`renode.ts` tiene el plan detallado para el motor genérico (Cortex-M/RISC-V por archivos
`.repl`), que junto con el toolchain `platformio` habilitaría "casi cualquier placa".
