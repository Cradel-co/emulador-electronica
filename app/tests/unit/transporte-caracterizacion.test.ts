import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ServerEventSchema, type ServerEvent } from '@emu/shared';
import { describe, expect, it, vi } from 'vitest';
import { crearTransporteEventos } from '../../server/src/transporteEventos.js';
import { transporteOriginal } from './fixtures/coordinacion-original.js';

describe.each(['original', 'extraído'] as const)('transporte de eventos: %s', version => {
  it('valida, conserva el log de error y sólo envía a sockets abiertos del conjunto actual', () => {
    const abierto = { readyState: 1, send: vi.fn() }, cerrado = { readyState: 3, send: vi.fn() };
    const clients = new Set([abierto, cerrado]), registrar = vi.fn();
    const transporte: ReturnType<typeof crearTransporteEventos> = version === 'original'
      ? runInNewContext(ts.transpileModule(`${transporteOriginal}\n({publicar:broadcast, log:broadcastLog})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, { clients, console: { log: registrar }, ServerEventSchema })
      : crearTransporteEventos(clients, registrar);
    transporte.publicar({ type: 'bridge.state', connected: true });
    expect(JSON.parse(abierto.send.mock.calls[0]?.[0] ?? 'null')).toEqual({ type: 'bridge.state', connected: true });
    expect(cerrado.send).not.toHaveBeenCalled();
    transporte.publicar({ type: 'bridge.state', connected: 'inválido' } as unknown as ServerEvent);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar.mock.calls[0]?.[0]).toContain('evento inválido:');
    expect(JSON.parse(abierto.send.mock.calls[1]?.[0] ?? 'null').type).toBe('emu.log');
    clients.delete(abierto); cerrado.readyState = 1; transporte.log('reconectado');
    expect(abierto.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(cerrado.send.mock.calls[0]?.[0] ?? 'null')).toEqual({ type: 'emu.log', line: 'reconectado' });
  });
});
