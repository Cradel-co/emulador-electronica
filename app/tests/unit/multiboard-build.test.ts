import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { defaultProject, type Project } from '@emu/shared';
import { BuildService, type BuildResult } from '../../server/src/buildService.js';
import { PATHS } from '../../server/src/paths.js';
import { reservePorts, releasePorts } from '../../server/src/ports.js';

vi.mock('../../server/src/boardRegistry.js', () => ({ buscarPlaca: async (id: string) => ({ id, nombre: id, desc: {} }) }));

describe('compilación y puertos de varias placas', () => {
  it('compila las placas en paralelo y aísla código y artefactos aunque compartan el mismo lenguaje', async () => {
    const project: Project = { ...defaultProject('build-multiple', 'micropython'), boards: [
      { id: 'board', board: 'esp32-s3-devkitc-1', language: 'micropython' },
      { id: 'board2', board: 'esp32-s3-devkitc-1', language: 'micropython' },
    ] };
    const builder = new BuildService();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const calls: { source: string; artifacts: string }[] = [];
    vi.spyOn(builder, 'compilarEn').mockImplementation(async (_project, _board, source, artifacts) => {
      calls.push({ source, artifacts });
      await barrier;
      return { ok: true, durationMs: 1, errors: [], lineMap: null, warnings: [], artifacts: {
        firmware: path.join(artifacts, 'firmware.bin'), elf: null, usesWebServer: false, usesApi: false, needsRepl: true,
      } } satisfies BuildResult;
    });
    const pending = builder.buildBoards(project, () => ({ onLine: () => {} }));
    try {
      // Si se vuelve serial, la primera espera la barrera y la segunda nunca llega.
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 1000 });
      expect(builder.isBuilding(project.name)).toBe(true);
      expect(calls).toEqual(expect.arrayContaining([
        { source: path.join(PATHS.projects, project.name), artifacts: path.join(PATHS.builds, project.name) },
        { source: path.join(PATHS.projects, project.name, 'boards', 'board2'), artifacts: path.join(PATHS.builds, project.name, 'boards', 'board2') },
      ]));
    } finally { release(); }
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(Object.keys(result.boardResults!)).toEqual(['board', 'board2']);
    expect(result.boardResults!.board!.artifacts!.firmware).not.toBe(result.boardResults!.board2!.artifacts!.firmware);
    expect(builder.isBuilding(project.name)).toBe(false);
  });

  it('reserva puertos distintos entre lanzamientos concurrentes y permite liberarlos', async () => {
    const reservations = await Promise.all([reservePorts(4, 45100), reservePorts(4, 45100)]);
    const ports = reservations.flat();
    try { expect(new Set(ports).size).toBe(8); }
    finally { releasePorts(ports); }
    const next = await reservePorts(1, Math.min(...ports));
    try { expect(next).toEqual([Math.min(...ports)]); }
    finally { releasePorts(next); }
  });
});
