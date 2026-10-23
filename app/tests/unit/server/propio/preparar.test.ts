import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectSchema } from '@emu/shared';
import { prepararProgramaPropio } from '../../../../server/src/propio/preparar.js';
import { BuildService } from '../../../../server/src/buildService.js';
import { buscarPlaca } from '../../../../server/src/boardRegistry.js';
import { TOOLCHAINS } from '../../../../server/src/toolchains/index.js';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { force: true, recursive: true }); });
async function carpeta(main: string) { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'propio-code-')); dirs.push(d); await fs.writeFile(path.join(d, 'main.py'), main); return d; }
describe('preparación del programa del editor para el backend propio', () => {
  it('el BuildService existente elige código propio sin invocar el toolchain de firmware', async () => {
    const dir = await carpeta('print("programa propio")\n');
    const toolchain = TOOLCHAINS.micropython; if (!toolchain) throw new Error('Falta toolchain MicroPython');
    const firmware = vi.spyOn(toolchain, 'build').mockImplementation(() => { throw new Error('No debe preparar firmware'); });
    const p = ProjectSchema.parse({ name: 'propio', board: 'esp32-s3-devkitc-1', language: 'micropython', sim: { wifiSsid: 'sin-red', wifiPassword: '', motorEsp: 'propio' } });
    const placa = await buscarPlaca(p.board ?? ''); if (!placa) throw new Error('Falta placa de fábrica');
    const r = await new BuildService().compilarEn({ ...p, board: placa.id, language: 'micropython' }, placa, dir, path.join(dir, 'build'), { onLine() {} });
    expect(r.ok).toBe(true); expect(r.artifacts?.codigoPropio?.main).toContain('programa propio');
    expect(r.artifacts?.repl).toBeUndefined(); expect(firmware).not.toHaveBeenCalled();
  });
  it('devuelve un error de main.py con línea para imports no soportados', async () => {
    const r = await prepararProgramaPropio('micropython', 'esp32s3', await carpeta('print("inicio")\nimport network\n'));
    expect(r.ok).toBe(false); expect(r.artifacts).toBeNull(); expect(r.errors[0]).toMatchObject({ line: 2, file: 'main.py' });
  });
  it('no sustituye un binario Arduino/ESPHome por un programa de demostración', async () => {
    const r = await prepararProgramaPropio('esphome', 'esp32s3', await carpeta('print(1)'));
    expect(r.ok).toBe(false); expect(r.errors[0]?.message).toMatch(/No ejecuta ESPHome/);
  });
});
