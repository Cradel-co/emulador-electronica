import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AvrSimulador } from '../avrSim.js';
import { armarBusChips } from './armarBus.js';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

/** Solomon SSD1306 (chips/solomon-ssd1306): comandos de la hoja Rev 1.1 y firmware real de Adafruit. */

const chip = cargarChips().find((c) => c.id === 'solomon-ssd1306')!;
type Imagen = { tipo: string; ancho: number; alto: number; encendida: boolean; brillo: number; filas: string[] };
const pixel = (img: Imagen, x: number, y: number) => (parseInt(img.filas[y]!.slice((x >> 3) * 2, (x >> 3) * 2 + 2), 16) >> (7 - (x & 7))) & 1;
const encendidos = (img: Imagen) => img.filas.join('').split('').reduce((n, h) => n + [...parseInt(h, 16).toString(2)].filter((b) => b === '1').length, 0);

/** La secuencia de inicio de Adafruit_SSD1306 para 128x64 con bomba de carga (begin con SWITCHCAPVCC). */
const INIT = [0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0x2e, 0xaf];

function pantalla(props: Record<string, unknown> = {}) {
  const m = new MaestroVirtual();
  m.conectar(chip, { id: 'oled', props });
  const comandos = (...c: number[]) => expect(m.escribir(0x3c, [0x00, ...c])).toBe(true);
  /** Manda una imagen de 128x64 como Adafruit (ventana entera en horizontal), desde un búfer de páginas. */
  const datos = (buf: number[]) => {
    comandos(0x22, 0, 7, 0x21, 0, 127);
    for (let i = 0; i < buf.length; i += 31) m.escribir(0x3c, [0x40, ...buf.slice(i, i + 31)]);
  };
  const ver = (): Imagen => { m.esperar(25); return m.salidas.get('oled') as Imagen; };
  return { m, comandos, datos, ver };
}
const bufConPixeles = (pts: [number, number][]) => {
  const b = Array<number>(1024).fill(0);
  for (const [x, y] of pts) b[x + (y >> 3) * 128]! |= 1 << (y & 7);
  return b;
};

describe('SSD1306: interfaz', () => {
  it('0x3C con SA0 en bajo, 0x3D en alto', () => {
    expect(pantalla().m.sondear(0x3c)).toBe(true);
    expect(pantalla({ sa0: 'alto' }).m.sondear(0x3d)).toBe(true);
    expect(pantalla({ sa0: 'alto' }).m.sondear(0x3c)).toBe(false);
  });

  it('al encender la pantalla está apagada (AEh) aunque la RAM tenga basura', () => {
    const { ver } = pantalla();
    const img = ver();
    expect(img.encendida).toBe(false);
    expect(encendidos(img)).toBe(0);
  });

  it('prenderla sin borrar muestra la basura de la RAM (como el chip real)', () => {
    const { comandos, ver } = pantalla();
    comandos(...INIT);
    expect(encendidos(ver())).toBeGreaterThan(1000);
  });

  it('sin la bomba de carga (8Dh 14h) la pantalla queda negra aunque esté en AFh', () => {
    const { comandos, ver } = pantalla();
    comandos(...INIT.filter((_, i) => i !== 8 && i !== 9)); // saca 8Dh 14h
    expect(ver().encendida).toBe(false);
  });
});

describe('SSD1306: imagen con la configuración de Adafruit (A1h, C8h, DAh 12h)', () => {
  it('un píxel en (0,0) queda arriba a la izquierda y uno en (127,63) abajo a la derecha', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT);
    datos(bufConPixeles([[0, 0], [127, 63], [5, 9]]));
    const img = ver();
    expect(pixel(img, 0, 0)).toBe(1);
    expect(pixel(img, 127, 63)).toBe(1);
    expect(pixel(img, 5, 9)).toBe(1);
    expect(encendidos(img)).toBe(3);
  });

  it('A0h (sin remapeo de segmentos) espeja la imagen de izquierda a derecha', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT, 0xa0);
    datos(bufConPixeles([[0, 0]]));
    expect(pixel(ver(), 127, 0)).toBe(1);
  });

  it('A1h/A0h solo afecta lo que se escribe después (lo que ya está en la RAM no cambia)', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT);
    datos(bufConPixeles([[0, 0]]));
    comandos(0xa0);
    expect(pixel(ver(), 0, 0)).toBe(1);
  });

  it('C0h (barrido normal) da vuelta la imagen de arriba a abajo, y se ve enseguida', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT);
    datos(bufConPixeles([[0, 0]]));
    comandos(0xc0);
    expect(pixel(ver(), 0, 63)).toBe(1);
  });

  it('DAh 02h (pines COM secuenciales) en un panel cableado alternado: la imagen sale intercalada', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT, 0xda, 0x02);
    datos(bufConPixeles([[0, 1]]));
    const img = ver();
    expect(pixel(img, 0, 1)).toBe(0);
    expect(encendidos(img)).toBe(1); // sigue habiendo un píxel, pero en otra línea
  });

  it('línea de inicio (40h + n) corre la imagen hacia arriba', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT, 0x40 | 8);
    datos(bufConPixeles([[3, 8]]));
    expect(pixel(ver(), 3, 0)).toBe(1);
  });

  it('inverso (A7h), todo encendido (A5h) y apagada (AEh)', () => {
    const { comandos, datos, ver } = pantalla();
    comandos(...INIT);
    datos(bufConPixeles([[0, 0]]));
    comandos(0xa7);
    let img = ver();
    expect(pixel(img, 0, 0)).toBe(0);
    expect(encendidos(img)).toBe(128 * 64 - 1);
    comandos(0xa6, 0xa5);
    expect(encendidos(ver())).toBe(128 * 64);
    comandos(0xa4, 0xae);
    img = ver();
    expect(img.encendida).toBe(false);
    expect(encendidos(img)).toBe(0);
  });

  it('el contraste (81h) se ve como brillo', () => {
    const { comandos, ver } = pantalla();
    comandos(...INIT, 0x81, 0x00);
    expect(ver().brillo).toBe(0);
    comandos(0x81, 0xff);
    expect(ver().brillo).toBe(1);
  });

  it('modo página: la columna vuelve al inicio sin pasar de página', () => {
    const { m, comandos, datos, ver } = pantalla();
    comandos(...INIT);
    datos(Array<number>(1024).fill(0)); // la RAM arranca con basura
    comandos(0x20, 0x02, 0xb3, 0x00 | 0x0e, 0x10 | 0x07); // página 3, columna 7Eh
    m.escribir(0x3c, [0x40, 0x01, 0x01, 0x01]); // 126, 127 y vuelve a la 0 de la página 3
    const img = ver();
    expect(pixel(img, 126, 24)).toBe(1);
    expect(pixel(img, 127, 24)).toBe(1);
    expect(pixel(img, 0, 24)).toBe(1);
    expect(pixel(img, 0, 32)).toBe(0);
  });

  it('modo vertical: avanza de página y después de columna', () => {
    const { m, comandos, datos, ver } = pantalla();
    comandos(...INIT);
    datos(Array<number>(1024).fill(0)); // la RAM arranca con basura
    comandos(0x20, 0x01, 0x21, 0, 127, 0x22, 0, 7);
    m.escribir(0x3c, [0x40, 0x01, 0x01]); // (0, página 0) y (0, página 1)
    const img = ver();
    expect(pixel(img, 0, 0)).toBe(1);
    expect(pixel(img, 0, 8)).toBe(1);
    expect(pixel(img, 1, 0)).toBe(0);
  });

  it('el scroll por hardware no se emula: se avisa', () => {
    const { m, comandos } = pantalla();
    comandos(...INIT, 0x26, 0, 0, 0, 7, 0, 0xff, 0x2f);
    m.esperar(11); // las escrituras a la pantalla se entregan en tanda (hasta 10 ms después)
    expect(m.logs.some((l) => /scroll por hardware/.test(l))).toBe(true);
  });

  it('panel de 128x32 con la configuración de Adafruit (A8h 1Fh, DAh 02h)', () => {
    const { comandos, datos, ver } = pantalla({ panel: '128x32' });
    comandos(0xae, 0xa8, 0x1f, 0xd3, 0, 0x40, 0x8d, 0x14, 0x20, 0, 0xa1, 0xc8, 0xda, 0x02, 0x81, 0x8f, 0xa4, 0xa6, 0xaf);
    datos(bufConPixeles([[0, 0], [127, 31]]).slice(0, 512).concat(Array<number>(512).fill(0)));
    const img = ver();
    expect(img.alto).toBe(32);
    expect(pixel(img, 0, 0)).toBe(1);
    expect(pixel(img, 127, 31)).toBe(1);
  });
});

describe('SSD1306 con Adafruit_SSD1306 2.5.17 (firmware real)', () => {
  it('lo que muestra la pantalla es exactamente el búfer de la librería; después invierte, baja el brillo y se apaga', () => {
    const MS = 16_000;
    const serial: { b: number; t: number }[] = [];
    const salidas: { t: number; img: Imagen }[] = [];
    const sim = new AvrSimulador(readFileSync(new URL('../fixtures/chips/ssd1306-dibujo/ssd1306-dibujo.hex', import.meta.url), 'utf8'), {
      onSerial: (b) => serial.push({ b, t: sim.micros }), onPin: () => undefined,
    });
    const c: ChipEnBus = { id: 'oled', instancia: 'oled', chip: chip.id, nombre: 'SSD1306', codigo: chip.codigo, props: {}, entorno: entornoDe(chip), alimentado: true, pinesGpio: {}, pullUps: [] };
    const bus = armarBusChips([c], 66, {
      ahoraUs: () => sim.micros,
      alSalida: (_id, s) => salidas.push({ t: sim.micros, img: s as Imagen }),
      programar: (t, fn) => sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((t - sim.micros) / 1e6) * sim.frecuenciaHz))),
    })!;
    sim.conectarChips(bus);
    /** Líneas del Serial con el instante (µs de emulación) en que terminó cada una. */
    const lineas = () => {
      const out: { txt: string; t: number }[] = [];
      let txt = '';
      for (const { b, t } of serial) {
        if (b === 10) { if (txt.trim()) out.push({ txt: txt.trim(), t }); txt = ''; } else txt += String.fromCharCode(b);
      }
      return out;
    };
    const cuando = (txt: string) => lineas().find((l) => l.txt === txt)?.t;
    let n = 0;
    while (cuando('APAGADO') === undefined && n++ < 5000) sim.ejecutar(MS);
    sim.ejecutar(40 * MS);
    const primeroDespues = (t: number) => salidas.find((s) => s.t > t)!.img;

    // El cuadro que sale después de display() tiene que ser el búfer de la librería, píxel por píxel.
    const cuadro = primeroDespues(cuando('DIBUJADO')!);
    const buf: number[] = [];
    for (const l of lineas().filter((x) => /^P\d=/.test(x.txt))) for (let i = 3; i < l.txt.length; i += 2) buf.push(parseInt(l.txt.slice(i, i + 2), 16));
    expect(buf).toHaveLength(1024);
    let distintos = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (pixel(cuadro, x, y) !== ((buf[x + (y >> 3) * 128]! >> (y & 7)) & 1)) distintos++;
    expect(distintos).toBe(0);
    expect(cuadro.encendida).toBe(true);
    expect(encendidos(cuadro)).toBeGreaterThan(80);

    expect(encendidos(primeroDespues(cuando('INVERTIDO')!))).toBe(128 * 64 - encendidos(cuadro));
    expect(primeroDespues(cuando('TENUE')!).brillo).toBe(0); // dim(true): contraste 0
    expect(primeroDespues(cuando('APAGADO')!).encendida).toBe(false);

    // El volcado (8 × 261 = 2088 caracteres) a "115200" baudios —en el Uno, 117 647 reales con U2X—
    // a 10 bits por carácter tarda 177,5 ms como mínimo: el Serial emulado va a la velocidad real.
    const volcado = (lineas().find((l) => l.txt.startsWith('P7='))!.t - cuando('DIBUJADO')!) / 1000;
    expect(volcado).toBeGreaterThan(177);
    expect(volcado).toBeLessThan(200);
  });
});
