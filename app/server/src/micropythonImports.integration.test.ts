import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leerFuentesMicroPython } from './micropythonSources.js';
import { EmulatorManager } from './emulator.js';
import { firmwarePath } from './toolchains/micropython.js';

/** Optativo: una sola instancia esp-emu y firmware YA instalado; nunca descarga ni usa Docker. */
describe.skipIf(process.env.EMU_TEST_MICROPYTHON_IMPORTS !== '1')('imports locales sobre MicroPython real', () => {
  it('ejecuta helper.py y paquete anidado del manifiesto', async () => {
    const firmware = firmwarePath();
    await fs.access(firmware);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-mp-real-imports-'));
    const logs: string[] = [];
    const emulator = new EmulatorManager({ onLog: line => logs.push(line), onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} });
    try {
      await fs.mkdir(path.join(root, 'pkg'));
      await fs.writeFile(path.join(root, 'main.py'), 'from helpers import value\nfrom pkg import read\nprint("LOCAL_IMPORTS_OK", value + read())\n');
      await fs.writeFile(path.join(root, 'helpers.py'), 'value = 20\n');
      await fs.writeFile(path.join(root, 'pkg', '__init__.py'), 'from .sensor import read\n');
      await fs.writeFile(path.join(root, 'pkg', 'sensor.py'), 'def read():\n    return 22\n');
      const manifest = await leerFuentesMicroPython(root);
      await emulator.start('real-local-imports', { firmware, elf: null, needsRepl: true, usesWebServer: false, usesApi: false }, { chip: 'esp32s3' });
      // Este boot mínimo evita arrancar el puente: la prueba sólo verifica filesystem e imports.
      const result = await emulator.uploadMicroPython([{ path: 'boot.py', content: '# prueba de imports locales\n' }, ...manifest.files]);
      expect(result.ok, result.output).toBe(true);
      await expect.poll(() => logs.some(line => line.includes('LOCAL_IMPORTS_OK 42')), { timeout: 15000 }).toBe(true);
    } finally {
      await emulator.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
