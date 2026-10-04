import { it, expect } from 'vitest';
import { cargarChips } from './catalogoChips.js';
import { SandboxChip, type EventoChip } from './chipSandbox.js';

it('OV2640 identifica bancos, reset y configuración JPEG QVGA', () => {
  const def = cargarChips().find(c => c.id === 'ov2640'); expect(def).toBeDefined();
  const s = new SandboxChip('ov2640', def?.codigo ?? '');
  const run = (eventos: EventoChip[]) => s.correr(eventos, {}, {});
  run([{ tipo: 'encender', t: 0 }]);
  run([{ tipo: 'escribir', t: 1, bytes: [0xff, 1] }, { tipo: 'escribir', t: 2, bytes: [0x0a] }]);
  expect(run([{ tipo: 'leer', t: 3, n: 2 }]).lecturas[0]).toEqual([0x26, 0x42]);
  run([{ tipo: 'escribir', t: 4, bytes: [0xff, 0] }]);
  for (const [reg, val] of [[0xda,0x10],[0x5a,0x50],[0x5b,0x3c],[0x5c,0]]) run([{ tipo: 'escribir', t: 5, bytes: [reg ?? 0, val ?? 0] }]);
  expect(run([{ tipo: 'escribir', t: 6, bytes: [0xe0,0] }]).salida).toMatchObject({ cameraConfig: true });
  expect(run([{ tipo: 'escribir', t: 7, bytes: [0x5a,0x40] }]).salida).toMatchObject({ cameraConfig: false });
});
it('FIFO mantiene la foto, ráfagas entre llamadas, lectura individual y puntero', () => {
  const def = cargarChips().find(c => c.id === 'arduchip'); expect(def).toBeDefined();
  const s = new SandboxChip('arduchip', def?.codigo ?? '');
  const run = (eventos: EventoChip[]) => s.correr(eventos, {}, {});
  const spi = (mosi: number[]) => run([{ tipo: 'spi', t: 1, mosi, dc: mosi.map(() => 0) }]);
  const reg = (addr: number, value?: number) => { run([{ tipo: 'seleccionar', t: 1 }]); return spi([value === undefined ? addr : addr | 0x80, value ?? 0]); };
  run([{ tipo: 'encender', t: 0 }, { tipo: 'externo', t: 0, datos: { tipo: 'configuracion', soportada: true } }]);
  reg(0,0x55); expect(reg(0).lecturas[0]?.[1]).toBe(0x55);
  const token = reg(4,2).salida?.token as number; expect(token).toBeGreaterThan(0);
  expect(reg(0x41).lecturas[0]?.[1]).toBe(0);
  const bytes = [255,216,10,20,30,255,217];
  run([{ tipo: 'externo', t: 2, datos: { tipo: 'imagen', token, bytes } }]);
  expect(reg(0x41).lecturas[0]?.[1]).toBe(8);
  expect(reg(0x42).lecturas[0]?.[1]).toBe(7);
  run([{ tipo: 'seleccionar', t: 3 }]); spi([0x3c]);
  expect(spi([0,0,0]).lecturas[0]).toEqual(bytes.slice(0,3));
  expect(spi([0,0,0,0]).lecturas[0]).toEqual(bytes.slice(3));
  reg(4,0x10); expect(reg(0x3d).lecturas[0]?.[1]).toBe(255);
  const next = reg(4,2).salida?.token as number;
  run([{ tipo:'externo',t:3,datos:{tipo:'imagen',token,bytes:[255,216,255,217]} }]);
  expect(reg(0x42).lecturas[0]?.[1]).toBe(7);
  expect(reg(0x3d).lecturas[0]?.[1]).toBe(216);
  run([{ tipo:'externo',t:3,datos:{tipo:'imagen',token:next,bytes:[255,216,255,217]} }]);
  expect(reg(0x42).lecturas[0]?.[1]).toBe(4);
  reg(4,1); expect(reg(0x42).lecturas[0]?.[1]).toBe(0);
  run([{ tipo: 'externo', t: 4, datos: { tipo: 'imagen', token, bytes } }]);
  expect(reg(0x41).lecturas[0]?.[1]).toBe(0);
});

it('valida las entradas externas y rechaza objetos del servidor o imágenes excesivas', () => {
  const def = cargarChips().find(c => c.id === 'arduchip');
  const s = new SandboxChip('arduchip', def?.codigo ?? '');
  const externo = (datos: unknown) => s.correr([{ tipo:'externo',t:0,datos } as EventoChip],{},{});
  expect(() => externo({tipo:'imagen',token:1,bytes:[256]})).toThrow();
  expect(() => externo({tipo:'imagen',token:1,bytes:Array(1048577).fill(0)})).toThrow();
  expect(() => externo({tipo:'configuracion',soportada:true,servidor:{}})).toThrow();
});
