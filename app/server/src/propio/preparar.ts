import type { BuildResult } from '../buildService.js';
import type { Language } from '@emu/shared';
import { leerFuentesMicroPython } from '../micropythonSources.js';
import { compilarProgramaPropio, ErrorProgramaPropio } from './programa.js';

export async function prepararProgramaPropio(lenguaje: Language, chip: string, directorio: string): Promise<BuildResult> {
  const started = Date.now();
  try {
    if (lenguaje !== 'micropython' || !chip.startsWith('esp32')) throw new Error('El motor propio admite por ahora GPIO y temporización de MicroPython en placas ESP32. No ejecuta ESPHome ni binarios C/C++.');
    const fuentes = await leerFuentesMicroPython(directorio), main = fuentes.files.find(f => f.path === 'main.py');
    if (!main) throw new Error('Falta main.py.');
    compilarProgramaPropio(main.content);
    return { ok: true, durationMs: Date.now() - started, errors: [], lineMap: null,
      warnings: ['Motor propio funcional: no ejecuta firmware ni instrucciones ESP32; GPIO y temporización limitados.'],
      artifacts: { firmware: 'programa-propio', elf: null, usesApi: false, usesWebServer: false, needsRepl: false, codigoPropio: { main: main.content } },
    };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - started, errors: [{ line: e instanceof ErrorProgramaPropio ? e.linea : null, file: 'main.py', message: e instanceof Error ? e.message : String(e) }], lineMap: null, artifacts: null, warnings: [] };
  }
}
