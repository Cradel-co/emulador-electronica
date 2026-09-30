import type { BuildResult } from '../buildService.js';
import { fallo, texto, type ContextoBuild, type Toolchain } from './tipos.js';

/**
 * TODO (preparado, sin implementar): toolchain genérico con PlatformIO.
 *
 * Es el que habilitaría "casi cualquier placa" del lado de la compilación: PlatformIO
 * trae plataformas para AVR, RP2040, STM32, nRF52, SAMD, ESP32... con el mismo comando.
 * Idea de implementación (misma forma que arduinoCli.ts):
 *   1. Imagen Docker propia (docker/platformio/Dockerfile) con `pip install platformio`
 *      y una carpeta de caché montada en .cache/platformio (las plataformas pesan).
 *   2. Generar un platformio.ini en .build/<proyecto>/ con
 *        [env:sim]  platform = <options.platform>  board = <options.board>  framework = <options.framework>
 *      y copiar el código del usuario a src/.
 *   3. `pio run -d /build` → .pio/build/sim/firmware.{hex,bin,elf}; el artefacto que se
 *      entrega depende del motor de la placa (avr8js: .hex; renode: .elf).
 *   4. Errores: el formato es el de gcc (archivo:línea:col: error:), reutilizar
 *      extractArduinoErrors con el prefijo de ruta de src/.
 * Opciones esperadas: { platform, board, framework }.
 */
export const platformio: Toolchain = {
  nombre: 'platformio',
  descripcion: 'PlatformIO (genérico: AVR, RP2040, STM32, nRF52...). Interfaz lista, sin implementar todavía.',
  disponible: false,
  lenguajes: ['arduino', 'idf-c', 'idf-cpp'],

  validarOpciones(_l, opciones) {
    return ['platform', 'board', 'framework']
      .filter((k) => !texto(opciones, k))
      .map((k) => `options.${k}: falta (platformio necesita platform, board y framework)`);
  },

  plantilla() {
    return {};
  },

  async build(ctx: ContextoBuild): Promise<BuildResult> {
    return fallo(ctx.started, 'El toolchain "platformio" todavía no está implementado (ver server/src/toolchains/platformio.ts).');
  },
};
