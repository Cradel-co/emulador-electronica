import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AvrSimulador } from '../avrSim.js';
import { armarBusChips } from './armarBus.js';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';
import type { ChipEnBus } from './proyectoChips.js';

/**
 * ST7735R (hoja Sitronix ST7735R V0.2): comandos con D/CX en 0, parámetros y píxeles con D/CX en 1,
 * ventana CASET/RASET, MADCTL (MX, MY, MV, RGB/BGR), COLMOD de 12/16/18 bits, sueño, inversión,
 * RESX. Lo que se ve depende de la variante del panel (pestaña negra/roja/verde).
 */

const st = cargarChips().find((c) => c.id === 'sitronix-st7735')!;
const CS = 10, DC = 9;

interface Pantalla { ancho: number; alto: number; encendida: boolean; rgb565: string }
function pixeles(p: Pantalla): (x: number, y: number) => number {
  const b = Buffer.from(p.rgb565, 'base64');
  return (x, y) => b.readUInt16BE((y * p.ancho + x) * 2);
}
const ROJO = 0xf800, VERDE = 0x07e0, AZUL = 0x001f, BLANCO = 0xffff, AMARILLO = 0xffe0, NEGRO = 0;

function conPantalla(pestana = 'negra', entradas?: Record<number, string>) {
  const m = new MaestroVirtual();
  m.conectar(st, { id: 'tft', props: { pestana }, entradas, spi: { csGpio: CS, dcGpio: DC, modos: [0, 3], lsbPrimero: false, soloEscritura: true, maxHz: 15e6 } });
  m.pin(CS, 1);
  const cmd = (c: number, ...p: number[]) => {
    m.spi(CS, [c], { dc: { gpio: DC, nivel: 0 } });
    if (p.length) m.spi(CS, p, { dc: { gpio: DC, nivel: 1 } });
  };
  const ver = () => { m.esperar(60); return m.salidas.get('tft') as Pantalla; };
  return { m, cmd, ver };
}

/** Lo mínimo para ver algo: salir del sueño, encender, 16 bits por píxel. */
function iniciar(cmd: (c: number, ...p: number[]) => void, madctl = 0xc0) {
  cmd(0x01); cmd(0x11); cmd(0x3a, 0x05); cmd(0x36, madctl); cmd(0x29);
}
function rellenar(cmd: (c: number, ...p: number[]) => void, x0: number, y0: number, x1: number, y1: number, color: number) {
  cmd(0x2a, 0, x0, 0, x1); cmd(0x2b, 0, y0, 0, y1);
  const n = (x1 - x0 + 1) * (y1 - y0 + 1);
  cmd(0x2c, ...Array.from({ length: n }, () => [color >> 8, color & 0xff]).flat());
}

describe('ST7735 por el maestro virtual', () => {
  it('al encender está dormido y con la pantalla apagada: se ve blanco (panel TN, normalmente blanco)', () => {
    const { ver } = conPantalla();
    const p = ver();
    expect(p.encendida).toBe(false);
    expect(pixeles(p)(64, 80)).toBe(BLANCO);
  });

  it('la memoria arranca con basura: SLPOUT + DISPON sin escribir muestra ruido, no un color parejo', () => {
    const { cmd, ver } = conPantalla();
    cmd(0x11); cmd(0x29);
    const px = pixeles(ver());
    const colores = new Set(Array.from({ length: 50 }, (_, i) => px(i * 2, i * 3)));
    expect(colores.size).toBeGreaterThan(20);
  });

  it('pestaña negra: con MX+MY (como Adafruit en rotación 0) el (0,0) es la esquina de arriba a la izquierda', () => {
    const { cmd, ver } = conPantalla('negra');
    iniciar(cmd);
    rellenar(cmd, 0, 0, 127, 159, AZUL);
    rellenar(cmd, 0, 0, 0, 0, ROJO);
    rellenar(cmd, 127, 159, 127, 159, VERDE);
    const px = pixeles(ver());
    expect(px(0, 0)).toBe(ROJO);
    expect(px(127, 159)).toBe(VERDE);
    expect(px(64, 80)).toBe(AZUL);
  });

  it('sin MX ni MY la imagen sale girada 180°: así está pegado el panel a la memoria', () => {
    const { cmd, ver } = conPantalla('negra');
    iniciar(cmd, 0x00);
    rellenar(cmd, 0, 0, 127, 159, NEGRO);
    rellenar(cmd, 0, 0, 0, 0, ROJO);
    expect(pixeles(ver())(127, 159)).toBe(ROJO);
  });

  it('la ventana CASET/RASET recorta y el puntero vuelve al principio al llegar al final', () => {
    const { cmd, ver } = conPantalla();
    iniciar(cmd);
    rellenar(cmd, 0, 0, 127, 159, NEGRO);
    // Ventana de 2×2 y 6 píxeles: los dos últimos pisan los dos primeros.
    cmd(0x2a, 0, 10, 0, 11); cmd(0x2b, 0, 20, 0, 21);
    cmd(0x2c, ...[ROJO, ROJO, ROJO, ROJO, VERDE, AZUL].flatMap((c) => [c >> 8, c & 0xff]));
    const px = pixeles(ver());
    expect([px(10, 20), px(11, 20), px(10, 21), px(11, 21)]).toEqual([VERDE, AZUL, ROJO, ROJO]);
    expect(px(12, 20)).toBe(NEGRO);
  });

  it('MV intercambia filas y columnas (rotación 1 de Adafruit: MY+MV)', () => {
    const { cmd, ver } = conPantalla();
    iniciar(cmd, 0xa0); // MY | MV
    rellenar(cmd, 0, 0, 159, 127, NEGRO);  // en esta orientación la ventana es de 160 × 128
    rellenar(cmd, 0, 0, 0, 0, ROJO);
    rellenar(cmd, 159, 0, 159, 0, VERDE);
    const px = pixeles(ver());
    // Visto con el panel parado: el origen queda abajo a la izquierda y X sube.
    expect(px(0, 159)).toBe(ROJO);
    expect(px(0, 0)).toBe(VERDE);
  });

  it('el bit RGB/BGR de MADCTL contra el filtro del panel: si no coinciden, rojo y azul se cambian', () => {
    const negra = conPantalla('negra');
    iniciar(negra.cmd, 0xc8); // BGR en un panel RGB
    rellenar(negra.cmd, 0, 0, 0, 0, ROJO);
    expect(pixeles(negra.ver())(0, 0)).toBe(AZUL);
    const roja = conPantalla('roja');
    iniciar(roja.cmd, 0xc8); // BGR en un panel BGR: bien
    rellenar(roja.cmd, 0, 0, 0, 0, ROJO);
    expect(pixeles(roja.ver())(0, 0)).toBe(ROJO);
  });

  it('COLMOD 18 bits (06h, el de fábrica) y 12 bits (03h, dos píxeles en tres bytes)', () => {
    const { cmd, ver } = conPantalla();
    iniciar(cmd);
    cmd(0x3a, 0x06);
    cmd(0x2a, 0, 0, 0, 0); cmd(0x2b, 0, 0, 0, 0);
    cmd(0x2c, 0xfc, 0x00, 0x00); // rojo al máximo en 6 bits
    cmd(0x3a, 0x03);
    cmd(0x2a, 0, 1, 0, 2); cmd(0x2b, 0, 0, 0, 0);
    cmd(0x2c, 0x0f, 0x0f, 0x00); // RGB444: 0F0 (verde) y F00 (rojo)
    const px = pixeles(ver());
    expect(px(0, 0)).toBe(0xf800);
    expect(px(1, 0)).toBe(0x0780); // verde F0h: los 4 bits van a los altos
    expect(px(2, 0)).toBe(0xf000);
  });

  it('INVON invierte, DISPOFF y SLPIN dejan de mostrar la memoria (y no la borran)', () => {
    const { cmd, ver } = conPantalla();
    iniciar(cmd);
    rellenar(cmd, 0, 0, 0, 0, ROJO);
    cmd(0x21);
    expect(pixeles(ver())(0, 0)).toBe(0x07ff); // cian
    cmd(0x20); cmd(0x28);
    let p = ver();
    expect(p.encendida).toBe(false);
    expect(pixeles(p)(0, 0)).toBe(BLANCO);
    cmd(0x29); cmd(0x10);
    expect(ver().encendida).toBe(false);
    cmd(0x11);
    p = ver();
    expect(p.encendida).toBe(true);
    expect(pixeles(p)(0, 0)).toBe(ROJO);
  });

  it('RESX en bajo reinicia: vuelve a dormir con la pantalla apagada', () => {
    const { m, cmd, ver } = conPantalla('negra', { 8: 'RESX' });
    m.pin(8, 1);
    iniciar(cmd);
    expect(ver().encendida).toBe(true);
    m.pin(8, 0);
    m.pin(8, 1);
    expect(ver().encendida).toBe(false);
  });

  it('pestaña verde: la memoria es de 132 × 162 y el panel empieza en la columna 2 y la fila 1', () => {
    const { cmd, ver } = conPantalla('verde');
    iniciar(cmd, 0xc8);
    rellenar(cmd, 2, 1, 129, 160, AZUL);
    rellenar(cmd, 2, 1, 2, 1, ROJO);
    const px = pixeles(ver());
    expect(px(0, 0)).toBe(ROJO);
    expect(px(127, 159)).toBe(AZUL);
  });
});

describe('ST7735 con Adafruit_ST7735 1.11.0 (firmware real, SPI por hardware)', () => {
  function correr(pestana: string) {
    const serial: number[] = [];
    const sim = new AvrSimulador(readFileSync(new URL('../fixtures/chips/st7735-dibujo/st7735-dibujo.hex', import.meta.url), 'utf8'), {
      onSerial: (b) => serial.push(b), onPin: () => undefined,
    });
    const c: ChipEnBus = {
      id: 'tft', instancia: 'tft', chip: st.id, nombre: 'ST7735', codigo: st.codigo, props: { pestana }, entorno: {},
      alimentado: true, pinesGpio: { CSX: CS, 'D/CX': DC, RESX: 8 }, pullUps: [],
      spi: { csGpio: CS, dcGpio: DC, modos: [0, 3], lsbPrimero: false, soloEscritura: true, maxHz: 15e6 }, entradas: { 8: 'RESX' },
    };
    const cuadros: { t: number; serial: string; p: Pantalla }[] = [];
    const logs: string[] = [];
    const bus = armarBusChips([c], 66, {
      ahoraUs: () => sim.micros,
      alLog: (l) => logs.push(l),
      alSalida: (_id, s) => cuadros.push({ t: sim.micros, serial: Buffer.from(serial).toString(), p: s as unknown as Pantalla }),
      programar: (t, fn) => sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((t - sim.micros) / 1e6) * 16e6))),
    })!;
    sim.conectarChips(bus);
    sim.ejecutar(2400 * 16_000); // initR solo tarda ~1,16 s: reset por hardware (400 ms), SWRESET 150, SLPOUT 500, DISPON 100
    const lineas = Buffer.from(serial).toString().split('\n').map((x) => x.trim()).filter(Boolean);
    /** El primer cuadro publicado después de que el sketch avisó `paso`: lo que se ve en ese paso. */
    const cuadroDe = (paso: string) => [...cuadros].filter((q) => q.serial.includes(paso)).at(0);
    return { lineas, cuadros, cuadroDe, logs };
  }

  it('pestaña negra (la que pide el sketch): fondo azul, las cuatro esquinas, el rectángulo, inversión, giro y apagado', () => {
    const r = correr('negra');
    expect(r.lineas.map((l) => l.split(' ')[0])).toEqual(['INIT', 'DIBUJADO', 'INVERTIDO', 'ROTADO', 'APAGADO']);
    expect(r.logs.join('\n')).not.toMatch(/MHz|modo/);
    const dibujado = r.cuadroDe('DIBUJADO')!.p; // lo que se ve mientras el sketch espera
    const px = pixeles(dibujado);
    expect(dibujado.encendida).toBe(true);
    expect(px(64, 120)).toBe(AZUL);
    expect(px(0, 0)).toBe(ROJO);
    expect(px(127, 0)).toBe(VERDE);
    expect(px(0, 159)).toBe(BLANCO);
    expect(px(127, 159)).toBe(AMARILLO);
    expect([px(10, 20), px(39, 59), px(9, 20), px(40, 59)]).toEqual([ROJO, ROJO, AZUL, AZUL]);

    const invertido = pixeles(r.cuadroDe('INVERTIDO')!.p);
    expect(invertido(64, 120)).toBe(AZUL ^ 0xffff);

    // Rotación 1 (MY+MV): el rectángulo de 20 × 10 en el origen horizontal queda abajo a la izquierda.
    const rotado = pixeles(r.cuadroDe('ROTADO')!.p);
    expect(rotado(0, 159)).toBe(VERDE);
    expect(rotado(9, 140)).toBe(VERDE);
    expect(rotado(10, 159)).not.toBe(VERDE);
    expect(rotado(0, 139)).not.toBe(VERDE);

    expect(r.cuadros.at(-1)!.p.encendida).toBe(false);
  });

  it('pestaña verde con el sketch para la negra: imagen corrida, una franja de basura y rojo/azul cambiados (lo que pasa de verdad)', () => {
    const r = correr('verde');
    const px = pixeles(r.cuadroDe('DIBUJADO')!.p);
    // Corrida 2 columnas a la izquierda y 1 fila hacia arriba: el rectángulo rojo (10..39, 20..59)
    // empieza en (8, 19), y se ve azul porque el panel es BGR y el sketch manda RGB.
    expect(px(8, 19)).toBe(AZUL);
    expect(px(37, 58)).toBe(AZUL);
    expect(px(64, 120)).toBe(ROJO); // el fondo "azul"
    // Las dos últimas columnas y la última fila no se escribieron nunca: basura.
    const basura = new Set(Array.from({ length: 40 }, (_, i) => px(126 + (i % 2), i * 4)));
    expect(basura.size).toBeGreaterThan(5);
  });
});
