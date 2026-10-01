import { describe, expect, it } from 'vitest';
import {
  aMundoModulo, curva, girar, medioDeCurva, resolverPin, rotacionDe, salida, semiCaja, tipoCable,
} from '../../web/geometria.js';

/**
 * Geometría del dibujo, probada sin navegador. Es el primer test de la carpeta web: se pudo
 * escribir porque el cálculo salió de canvas.ts, que necesita DOM, a geometria.ts, que no.
 */

const LED = { width: 50, height: 74, pins: [{ name: 'IN', x: 10, y: 74, kind: 'digital-in' }, { name: 'GND', x: 40, y: 74, kind: 'ground' }] };
const PLACA = { width: 100, height: 200, pins: [{ name: 'GPIO7', x: 0, y: 50, kind: 'digital-io' }, { name: '3V3', x: 100, y: 20, kind: 'power' }] };
const catalogo = { led: LED, board: PLACA };
const def = (t: string) => catalogo[t];
const modules = [
  { id: 'led1', type: 'led', x: 200, y: 300 },
  { id: 'board', type: 'board', x: 0, y: 0, rotation: 90 },
];

describe('rotacionDe', () => {
  it('normaliza a 0..359, incluso negativos y vueltas de más', () => {
    expect(rotacionDe({ rotation: 0 })).toBe(0);
    expect(rotacionDe({ rotation: 90 })).toBe(90);
    expect(rotacionDe({ rotation: 360 })).toBe(0);
    expect(rotacionDe({ rotation: 450 })).toBe(90);
    expect(rotacionDe({ rotation: -90 })).toBe(270);
    expect(rotacionDe({ rotation: -450 })).toBe(270);
  });

  it('sin rotación declarada es 0 (los proyectos viejos no la traen)', () => {
    expect(rotacionDe({})).toBe(0);
    expect(rotacionDe(undefined)).toBe(0);
  });
});

describe('girar', () => {
  it('gira en sentido horario, porque el eje y del SVG apunta abajo', () => {
    const [x, y] = girar(1, 0, 90);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(1, 10); // (1,0) a 90° cae mirando "abajo" en pantalla
  });

  it('no cambia el largo del vector', () => {
    for (const g of [0, 17, 90, 180, 237, 359]) {
      const [x, y] = girar(3, 4, g);
      expect(Math.hypot(x, y)).toBeCloseTo(5, 10);
    }
  });

  it('cuatro giros de 90° vuelven al punto de partida', () => {
    let v = [7, -2];
    for (let i = 0; i < 4; i++) v = girar(v[0], v[1], 90);
    expect(v[0]).toBeCloseTo(7, 10);
    expect(v[1]).toBeCloseTo(-2, 10);
  });
});

describe('aMundoModulo', () => {
  it('sin rotar, suma la posición del módulo', () => {
    const p = aMundoModulo({ x: 200, y: 300 }, LED, 10, 74);
    expect(p).toEqual({ x: 210, y: 374 });
  });

  it('el centro del dibujo no se mueve al rotar: es el eje del giro', () => {
    for (const rotation of [0, 45, 90, 180, 270]) {
      const p = aMundoModulo({ x: 200, y: 300, rotation }, LED, LED.width / 2, LED.height / 2);
      expect(p.x).toBeCloseTo(225, 10);
      expect(p.y).toBeCloseTo(337, 10);
    }
  });

  it('rotar 180° refleja el pin respecto del centro', () => {
    const sin = aMundoModulo({ x: 0, y: 0 }, LED, 10, 74);
    const con = aMundoModulo({ x: 0, y: 0, rotation: 180 }, LED, 10, 74);
    expect(con.x).toBeCloseTo(LED.width - sin.x, 10);
    expect(con.y).toBeCloseTo(LED.height - sin.y, 10);
  });
});

describe('semiCaja', () => {
  it('sin rotar es la mitad del ancho y del alto', () => {
    expect(semiCaja(LED, 0)).toEqual([25, 37]);
  });

  it('a 90° se intercambian', () => {
    const [sx, sy] = semiCaja(LED, 90);
    expect(sx).toBeCloseTo(37, 10);
    expect(sy).toBeCloseTo(25, 10);
  });

  it('la caja rotada nunca es más chica que la original', () => {
    for (const g of [0, 30, 45, 60, 90, 135, 200]) {
      const [sx, sy] = semiCaja(LED, g);
      expect(sx).toBeGreaterThanOrEqual(Math.min(25, 37) - 1e-9);
      expect(sy).toBeGreaterThanOrEqual(Math.min(25, 37) - 1e-9);
    }
  });
});

describe('resolverPin', () => {
  it('resuelve "modulo.pin" a su instancia, def y posición', () => {
    const r = resolverPin('led1.IN', modules, def);
    expect(r?.inst.id).toBe('led1');
    expect(r?.pin.name).toBe('IN');
    expect(r?.x).toBe(210);
    expect(r?.y).toBe(374);
  });

  it('respeta la rotación del módulo', () => {
    const r = resolverPin('board.GPIO7', modules, def);
    // La placa está a 90°: el pin del borde izquierdo pasa a mirar hacia arriba.
    const sinRotar = aMundoModulo({ x: 0, y: 0 }, PLACA, 0, 50);
    expect(r?.x).not.toBeCloseTo(sinRotar.x, 1);
  });

  it('devuelve null si falta el módulo, el pin o el punto', () => {
    expect(resolverPin('noexiste.IN', modules, def)).toBeNull();
    expect(resolverPin('led1.NOEXISTE', modules, def)).toBeNull();
    expect(resolverPin('led1', modules, def)).toBeNull();
    expect(resolverPin('.IN', modules, def)).toBeNull();
  });

  it('un pin con punto en el nombre se parte en el primer punto', () => {
    expect(resolverPin('led1.IN.extra', modules, def)).toBeNull();
  });
});

describe('salida', () => {
  it('un pin del borde de abajo sale hacia abajo', () => {
    const r = resolverPin('led1.IN', modules, def)!;
    const [dx, dy] = salida(r);
    expect(dx).toBeCloseTo(0, 10);
    expect(dy).toBeCloseTo(1, 10);
  });

  it('un pin del borde izquierdo sale hacia la izquierda', () => {
    const r = { pin: { x: 0, y: 50 }, def: PLACA, inst: { rotation: 0 } };
    const [dx, dy] = salida(r);
    expect(dx).toBeCloseTo(-1, 10);
    expect(dy).toBeCloseTo(0, 10);
  });

  it('la dirección gira con el módulo', () => {
    const r = { pin: { x: 0, y: 50 }, def: PLACA, inst: { rotation: 90 } };
    const [dx, dy] = salida(r);
    expect(dx).toBeCloseTo(0, 10);
    expect(dy).toBeCloseTo(-1, 10);
  });
});

describe('curva', () => {
  it('empieza y termina en los pines', () => {
    const d = curva(0, 0, [0, 1], 100, 0, [0, -1]);
    expect(d.startsWith('M0 0 C')).toBe(true);
    expect(d.endsWith('100 0')).toBe(true);
  });

  it('los cables cortos no quedan con rulo: el control mínimo es 40', () => {
    const d = curva(0, 0, [1, 0], 10, 0, [-1, 0]);
    expect(d).toContain('C40 0');
  });
});

describe('medioDeCurva', () => {
  it('en una curva simétrica cae en el medio de la recta', () => {
    const m = medioDeCurva(0, 0, [0, -1], 100, 0, [0, -1]);
    expect(m.x).toBeCloseTo(50, 10);
  });

  it('se corre hacia donde apuntan los pines, no sobre la recta', () => {
    const m = medioDeCurva(0, 0, [0, 1], 100, 0, [0, 1]);
    expect(m.y).toBeGreaterThan(0); // la curva se arquea hacia abajo
  });

  it('cae a mitad del RECORRIDO, no en t = 0,5 (que en una curva asimétrica se corre mucho)', () => {
    const [x1, y1, x2, y2] = [10, 20, 210, 120];
    const d1 = [0, 1];
    const d2 = [0, 1]; // las dos puntas salen hacia abajo: curva bien asimétrica
    const k = Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.4);
    const c = [x1 + d1[0] * k, y1 + d1[1] * k, x2 + d2[0] * k, y2 + d2[1] * k];
    const bez = (p0: number, p1: number, p2: number, p3: number, t: number) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };
    // Referencia: longitud de arco integrada fino, igual que hacía getPointAtLength.
    const N = 20000;
    let largo = 0;
    const acum = [0];
    let px = x1, py = y1;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const cx = bez(x1, c[0]!, c[2]!, x2, t);
      const cy = bez(y1, c[1]!, c[3]!, y2, t);
      largo += Math.hypot(cx - px, cy - py);
      acum.push(largo);
      px = cx; py = cy;
    }
    const tArco = acum.findIndex((l) => l >= largo / 2) / N;
    const esperado = { x: bez(x1, c[0]!, c[2]!, x2, tArco), y: bez(y1, c[1]!, c[3]!, y2, tArco) };

    const m = medioDeCurva(x1, y1, d1, x2, y2, d2);
    // Menos de un píxel de diferencia contra la integración fina.
    expect(Math.hypot(m.x - esperado.x, m.y - esperado.y)).toBeLessThan(1);

    // Y queda lejos de t = 0,5, que es la aproximación ingenua que se descartó.
    const ingenuo = { x: bez(x1, c[0]!, c[2]!, x2, 0.5), y: bez(y1, c[1]!, c[3]!, y2, 0.5) };
    expect(Math.hypot(m.x - ingenuo.x, m.y - ingenuo.y)).toBeGreaterThan(5);
  });
});

describe('tipoCable', () => {
  const pin = (kind: string) => ({ pin: { kind } });

  it('la masa manda sobre todo lo demás', () => {
    expect(tipoCable(pin('ground'), pin('power'))).toBe('ground');
    expect(tipoCable(pin('power'), pin('ground'))).toBe('ground');
    expect(tipoCable(pin('ground'), pin('digital-in'))).toBe('ground');
  });

  it('después la alimentación', () => {
    expect(tipoCable(pin('power'), pin('digital-in'))).toBe('power');
  });

  it('el resto es señal', () => {
    expect(tipoCable(pin('digital-out'), pin('digital-in'))).toBe('signal');
    expect(tipoCable(pin('other'), pin('analog-in'))).toBe('signal');
  });
});
