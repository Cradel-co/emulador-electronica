import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATHS } from './paths.js';

/**
 * API de placas y proyectos contra un server de verdad (tsx server/src/index.ts), en
 * otro puerto y con carpetas temporales de proyectos y módulos: no toca projects/ ni
 * el server de desarrollo (5180).
 */
const PORT = 5300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
const proyectos = mkdtempSync(path.join(os.tmpdir(), 'emu-api-p-'));
const modulos = mkdtempSync(path.join(os.tmpdir(), 'emu-api-m-'));

const pedir = async (ruta: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(BASE + ruta, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  cpSync(path.join(PATHS.root, 'modules'), modulos, { recursive: true });
  server = spawn('npx', ['tsx', 'server/src/index.ts'], {
    cwd: PATHS.app,
    env: { ...process.env, PORT: String(PORT), EMU_PROJECTS_DIR: proyectos, EMU_MODULES_DIR: modulos },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Si el puerto ya estaba ocupado (quedó un server de una corrida anterior), /api/health
  // contesta igual —lo contesta el otro— y los tests terminan hablándole a un server con su
  // propia carpeta de proyectos: aparecen 409 ("ya existe") imposibles de entender. Así que al
  // conectar se confirma que el que atiende es el nuestro, creando un proyecto centinela y
  // viendo que aparezca en NUESTRA carpeta temporal.
  const stderr: string[] = [];
  server.stderr?.on('data', (d: Buffer) => { stderr.push(d.toString()); });
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) {
        const centinela = `centinela-${Math.random().toString(36).slice(2, 10)}`;
        await fetch(`${BASE}/api/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: centinela, language: 'esphome' }),
        });
        if (existsSync(path.join(proyectos, centinela))) return;
        throw new Error(
          `el server que contesta en el ${PORT} no es el de esta corrida: el proyecto centinela no `
          + `apareció en ${proyectos}. Seguro quedó otro server escuchando ahí `
          + `(ps aux | grep "tsx server/src/index").${stderr.length ? ` El nuestro dijo: ${stderr.join('').trim().split('\n').slice(-2).join(' · ')}` : ''}`,
        );
      }
    } catch (err) {
      if ((err as Error).message.includes('no es el de esta corrida')) throw err;
      /* todavía no */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('el server de prueba no arrancó');
}, 30_000);

afterAll(() => {
  server?.kill('SIGTERM');
  rmSync(proyectos, { recursive: true, force: true });
  rmSync(modulos, { recursive: true, force: true });
});

describe('GET /api/boards', () => {
  it('lista las placas del catálogo con su descriptor, lenguajes y nivel de soporte', async () => {
    const { status, body } = await pedir('/api/boards');
    expect(status).toBe(200);
    expect(body.porDefecto).toBe('esp32-s3-devkitc-1');
    const uno = body.boards.find((b: any) => b.id === 'arduino-uno');
    expect(uno).toMatchObject({ nombre: 'Arduino Uno R3', lenguajes: ['arduino'], soporte: { declarado: 'emula' } });
    expect(uno.board.pins.D13.gpio).toBe(13);
    expect(uno.board.logicVoltage).toBe(5);
    const s3 = body.boards.find((b: any) => b.id === 'esp32-s3-devkitc-1');
    expect(Object.keys(s3.board.reservedPins)).toEqual(expect.arrayContaining(['17', '18', '43', '44']));
    expect(body.motores.map((m: any) => m.nombre)).toEqual(expect.arrayContaining(['esp-emu', 'avr8js']));
    expect(body.toolchains.map((t: any) => t.nombre)).toEqual(expect.arrayContaining(['esphome', 'esp-idf', 'arduino-cli', 'micropython']));
  });

  it('GET /api/boards/schema devuelve el JSON Schema', async () => {
    const { status, body } = await pedir('/api/boards/schema');
    expect(status).toBe(200);
    expect(body.board.definitions.BoardDescriptor.required).toEqual(expect.arrayContaining(['chip', 'backend', 'pins', 'io', 'languages']));
  });
});

describe('POST /api/boards/validate', () => {
  it('acepta una placa válida y rechaza una rota con los motivos', async () => {
    const ok = await pedir('/api/boards/validate', {
      method: 'POST',
      body: { module: { type: 'placa-x', name: 'X', category: 'Placas', svg: 'module.svg', programmable: true, pins: [{ name: 'P1', x: 0, y: 0 }, { name: 'GND', x: 0, y: 10, kind: 'ground' }],
        board: { chip: 'atmega328p', backend: { engine: 'avr8js' }, logicVoltage: 5, maxPinCurrentMa: 40, io: { mode: 'native' },
          pins: { P1: { gpio: 0, port: 'D', bit: 0 } }, languages: { arduino: { toolchain: 'arduino-cli', options: { fqbn: 'arduino:avr:uno' } } } } } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, nivel: 'emula' });

    const mal = await pedir('/api/boards/validate', { method: 'POST', body: { module: { type: 'placa-y', name: 'Y', category: 'Placas', svg: 's', programmable: true, board: { chip: 'x' } } } });
    expect(mal.status).toBe(400);
    expect(mal.body.ok).toBe(false);
    expect(mal.body.errores.length).toBeGreaterThan(0);
  });

  it('POST /api/boards/:id/certify: 404 si la placa no existe', async () => {
    expect((await pedir('/api/boards/no-existe/certify', { method: 'POST', body: {} })).status).toBe(404);
  });
});

describe('POST /api/projects con placa', () => {
  it('Arduino Uno + arduino: 201, sketch.cpp de AVR y circuito D2 → D13 con resistencia', async () => {
    const { status, body } = await pedir('/api/projects', { method: 'POST', body: { name: 'uno-api', language: 'arduino', board: 'arduino-uno' } });
    expect(status).toBe(201);
    expect(body.project.board).toBe('arduino-uno');
    expect(body.project.wires).toContainEqual({ from: 'btn1.OUT', to: 'board.D2' });
    expect(readdirSync(path.join(proyectos, 'uno-api')).sort()).toEqual(['project.json', 'sketch.cpp']);
    const det = await pedir('/api/projects/uno-api');
    expect(det.body.placa.id).toBe('arduino-uno');
    expect(det.body.files.map((f: any) => f.path)).toContain('sketch.cpp');
  });

  it('lenguaje que la placa no soporta: 400 con los que sí', async () => {
    const r = await pedir('/api/projects', { method: 'POST', body: { name: 'uno-yaml', language: 'esphome', board: 'arduino-uno' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('arduino');
    expect(existsSync(path.join(proyectos, 'uno-yaml'))).toBe(false);
  });

  it('placa desconocida: 400', async () => {
    const r = await pedir('/api/projects', { method: 'POST', body: { name: 'x1', language: 'arduino', board: 'arduino-mega' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Placa desconocida');
  });

  it('sin indicar placa: ESP32-S3 como siempre; en C3, ESPHome con su board', async () => {
    const s3 = await pedir('/api/projects', { method: 'POST', body: { name: 's3-api', language: 'esphome' } });
    expect(s3.status).toBe(201);
    expect(s3.body.project.board).toBe('esp32-s3-devkitc-1');
    const c3 = await pedir('/api/projects', { method: 'POST', body: { name: 'c3-api', language: 'esphome', board: 'esp32-c3-devkitm-1' } });
    expect(c3.status).toBe(201);
    const yaml = await pedir('/api/projects/c3-api/files/main.yaml');
    expect(yaml.body.content).toContain('board: esp32-c3-devkitm-1');
  });

  it('PUT no deja cambiar la placa de un proyecto', async () => {
    const r = await pedir('/api/projects/s3-api', { method: 'PUT', body: { board: 'arduino-uno' } });
    expect(r.status).toBe(400);
  });
});

describe('proyectos sin placa (board: null)', () => {
  it('se crea sin código; ▶ energiza; la placa se agrega con su lenguaje y se quita sin borrar el código', async () => {
    const creado = await pedir('/api/projects', { method: 'POST', body: { name: 'proto-api', board: null } });
    expect(creado.status).toBe(201);
    expect(creado.body.project).toMatchObject({ board: null, language: null });
    expect(readdirSync(path.join(proyectos, 'proto-api'))).toEqual(['project.json']);
    const det = await pedir('/api/projects/proto-api');
    expect(det.body.placa).toBeNull();
    expect(det.body.files).toEqual([]);
    // Sin código: los archivos dan un 400 claro, no un 500.
    expect((await pedir('/api/projects/proto-api/files/main.py')).status).toBe(400);

    // Apagado: la fuente no entrega. Energizado: sí.
    let pins = await pedir('/api/projects/proto-api/pins');
    expect(pins.status).toBe(200);
    expect(pins.body.electrico).toMatchObject({ placa: null, energizado: false });
    expect(pins.body.electrico.fuentes[0].modo).toBe('apagada');
    expect((await pedir('/api/projects/proto-api/energia', { method: 'POST', body: { encendido: true } })).status).toBe(200);
    pins = await pedir('/api/projects/proto-api/pins');
    expect(pins.body.electrico.energizado).toBe(true);
    expect(pins.body.electrico.fuentes[0].modo).toBe('CV');

    // Agregar la placa: pide lenguaje, escribe el código y deja de estar "energizado aparte".
    expect((await pedir('/api/projects/proto-api/board', { method: 'POST', body: { board: 'esp32-s3-devkitc-1' } })).status).toBe(400);
    const conPlaca = await pedir('/api/projects/proto-api/board', { method: 'POST', body: { board: 'esp32-s3-devkitc-1', language: 'micropython' } });
    expect(conPlaca.status).toBe(200);
    expect(conPlaca.body.project).toMatchObject({ board: 'esp32-s3-devkitc-1', language: 'micropython' });
    expect(conPlaca.body.project.modules.some((m: any) => m.id === 'board')).toBe(true);
    expect(readdirSync(path.join(proyectos, 'proto-api'))).toContain('main.py');
    await pedir('/api/projects/proto-api/files/main.py', { method: 'PUT', body: { content: 'print("mio")\n' } });

    // Quitarla: vuelve a sin placa, pero el código queda; al volver a ponerla no se pisa.
    const sin = await pedir('/api/projects/proto-api/board', { method: 'DELETE' });
    expect(sin.body.project).toMatchObject({ board: null, language: null });
    expect(readdirSync(path.join(proyectos, 'proto-api'))).toContain('main.py');
    await pedir('/api/projects/proto-api/board', { method: 'POST', body: { board: 'esp32-s3-devkitc-1', language: 'micropython' } });
    expect((await pedir('/api/projects/proto-api/files/main.py')).body.content).toBe('print("mio")\n');
  });
});

/**
 * Recarga del código sin reiniciar el emulador. Acá se prueba la parte que no necesita
 * un chip: cuándo se hace y cuándo no, y que `sim.autoReload` quede activo al incorporar
 * la placa. La subida por el REPL en sí la cubre el emulador (emulator.test.ts).
 */
describe('POST /api/projects/:name/reload', () => {
  it('falla si el proyecto no existe', async () => {
    // Como el resto de las rutas de proyecto: store.read tira ENOENT y fail() lo manda como 500.
    const { status, body } = await pedir('/api/projects/no-existe/reload', { method: 'POST' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.ok).not.toBe(true);
  });

  it('sin placa no hay código que recargar', async () => {
    await pedir('/api/projects', { method: 'POST', body: { name: 'recarga-proto', board: null, language: null } });
    const { status, body } = await pedir('/api/projects/recarga-proto/reload', { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false });
    expect(body.motivo).toContain('no tiene placa');
  });

  it('con el emulador parado no arranca nada por su cuenta', async () => {
    await pedir('/api/projects', { method: 'POST', body: { name: 'recarga-mp', language: 'micropython' } });
    const { status, body } = await pedir('/api/projects/recarga-mp/reload', { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false });
    expect(body.motivo).toContain('no está corriendo');
  });

  it('el proyecto nuevo con placa viene con sim.autoReload, y se puede desactivar', async () => {
    const creado = await pedir('/api/projects', { method: 'POST', body: { name: 'recarga-flag', language: 'micropython' } });
    expect(creado.body.project.sim.autoReload).toBe(true);
    const apagado = await pedir('/api/projects/recarga-flag', { method: 'PUT', body: { sim: { wifiSsid: 'sim-wifi', wifiPassword: 'sim-password', autoReload: false } } });
    expect(apagado.body.project.sim.autoReload).toBe(false);
    // Persistido: se relee del disco, no de memoria.
    expect((await pedir('/api/projects/recarga-flag')).body.project.sim.autoReload).toBe(false);
  });

  it('incorporar la placa a un circuito sin placa deja la recarga activa', async () => {
    await pedir('/api/projects', { method: 'POST', body: { name: 'recarga-alta', board: null, language: null } });
    expect((await pedir('/api/projects/recarga-alta')).body.project.sim.autoReload).toBe(false);
    const conPlaca = await pedir('/api/projects/recarga-alta/board', { method: 'POST', body: { board: 'esp32-s3-devkitc-1', language: 'micropython' } });
    expect(conPlaca.body.project.sim.autoReload).toBe(true);
  });
});

/**
 * El estado que un cliente nuevo no puede deducir de los eventos: `pin.out` y los controles
 * solo viajan cuando algo cambia. Sin esto, una UI que reconecta queda con los niveles de la
 * corrida anterior y pinta un LED encendido con el pin en 0 (issue #8).
 */
describe('GET /api/emulator expone el estado en vivo', () => {
  it('trae niveles y cerrados, aunque no haya nada corriendo', async () => {
    const { status, body } = await pedir('/api/emulator');
    expect(status).toBe(200);
    // La forma, no el contenido: el emulador es global y otro test pudo dejar algo andando.
    expect(body.niveles).toBeTypeOf('object');
    expect(body.niveles).not.toBeNull();
    expect(Array.isArray(body.cerrados)).toBe(true);
  });
});

describe('contexto de archivos multiplaca', () => {
  it('aísla las rutas y conserva la instancia sobreviviente al quitar la primaria', async () => {
    const name = 'archivos-multiplaca';
    await pedir('/api/projects', { method: 'POST', body: { name, language: 'micropython' } });
    const added = await pedir(`/api/projects/${name}/board`, { method: 'POST', body: { board: 'esp32-c3-devkitm-1', language: 'micropython' } });
    const secondId = added.body.project.boards[1].id;
    await pedir(`/api/projects/${name}/files/main.py`, { method: 'PUT', body: { content: 'primary\n' } });
    await pedir(`/api/projects/${name}/files/main.py?boardId=${secondId}`, { method: 'PUT', body: { content: 'secondary\n' } });
    expect((await pedir(`/api/projects/${name}?boardId=${secondId}`)).body.files.map((f: any) => f.path)).toEqual(['main.py']);
    expect((await pedir(`/api/projects/${name}/files/main.py?boardId=missing`)).status).toBe(404);
    expect((await pedir(`/api/projects/${name}/files/boards/${secondId}/main.py`)).status).toBe(403);
    for (const modules of [null, 'wrong', [null]]) expect((await pedir(`/api/projects/${name}/diagram`, { method: 'PUT', body: { modules } })).status).toBe(400);
    expect((await pedir(`/api/projects/${name}`, { method: 'PUT', body: { boards: [], board: added.body.project.board } })).status).toBe(400);
    await pedir(`/api/projects/${name}/board?boardId=board`, { method: 'DELETE' });
    const surviving = await pedir(`/api/projects/${name}`);
    expect(surviving.body.project.boards.map((b: any) => b.id)).toEqual([secondId]);
    expect(surviving.body.project.modules.some((m: any) => m.id === 'board')).toBe(false);
    expect((await pedir(`/api/projects/${name}/files/main.py`)).body.content).toBe('secondary\n');
  });
});
