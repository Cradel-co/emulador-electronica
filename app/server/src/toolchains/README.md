# Toolchains (plugins de compilación)

Un **toolchain** convierte el código del proyecto en un firmware para el motor de la placa.
Cada placa elige uno por lenguaje en su `module.json`:

```json
"board": {
  "languages": {
    "arduino": { "toolchain": "arduino-cli", "options": { "fqbn": "arduino:avr:uno" } }
  }
}
```

El server busca `"arduino-cli"` en `TOOLCHAINS` (`index.ts`) y le pasa esas `options`.

| Toolchain | Estado | Lenguajes | Salida | Opciones |
|---|---|---|---|---|
| `esphome` (`esphome.ts`) | implementado | esphome | `firmware.factory.bin` (+ puente sim_bridge inyectado) | `board`, `variant`, `unsupportedInputPins` |
| `esp-idf` (`espIdf.ts`) | implementado (sin verificar en esta PC: la imagen de 3 GB no está bajada) | idf-c, idf-cpp, arduino (arduino-esp32 como componente) | `merged_flash.bin` | `target`, `arduino` |
| `arduino-cli` (`arduinoCli.ts`) | implementado | arduino | `.hex` | `fqbn` (hoy solo `arduino:avr:*`) |
| `micropython` (`micropython.ts`) | implementado | micropython | firmware oficial + archivos por REPL | `firmware`, `url`, `gpioOutRegs` |
| `platformio` (`platformio.ts`) | **preparado, sin implementar** | arduino, idf-c, idf-cpp | según el motor | `platform`, `board`, `framework` |

## Interfaz (`tipos.ts`)

```ts
interface Toolchain {
  nombre: string;                 // lo que va en board.languages.<l>.toolchain
  descripcion: string;
  disponible: boolean;
  lenguajes: Language[];
  build(ctx: ContextoBuild): Promise<BuildResult>;
  plantilla(lenguaje, placa, opciones): Record<string, string>;   // archivos del proyecto nuevo
  validarOpciones?(lenguaje, opciones, placa): string[];
}
```

`ContextoBuild` trae el proyecto, `projectDir` (el código del usuario), `buildDir` (carpeta de
trabajo), la placa (id, nombre, descriptor), las `options`, callbacks de log, timeout y
`registrarProceso` (para cancelar). `build` devuelve `BuildResult` (`../buildService.ts`):

- `errors`: `{ file, line, message }[]` con la ruta **relativa al proyecto** (`sketch.cpp`,
  `main.yaml`), así el editor marca la línea. Errores del core/SDK van sin `file`.
- `artifacts`: `firmware` (lo que carga el motor), `elf`, y extras para el motor:
  `rmtLoopback` (esp-emu, RF), `repl` (archivos a subir por el REPL al arrancar, MicroPython).

Plantillas: si la placa trae `board.templates.<lenguaje>.files`, se usan esas; si no, las
genera el toolchain con el circuito de prueba de la placa (`board.demo`: botón → LED).

## Agregar un toolchain

1. Un archivo que exporte un `Toolchain` (ver `arduinoCli.ts`: Docker, copia del código,
   parseo de errores de gcc).
2. Registrarlo en `TOOLCHAINS` (`index.ts`).
3. Usarlo desde el `board.languages` de una placa, validar y certificar.

Versiones fijadas (sección 16 de la guía): cada toolchain fija la suya (imagen Docker, core,
firmware); `arduino-cli` usa la imagen `emu-arduino-avr:1.5.1-1.8.6`, que la app construye
sola desde `docker/arduino-avr/Dockerfile` la primera vez.
