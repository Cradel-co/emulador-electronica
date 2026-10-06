import { describe, expect, it, vi } from 'vitest';
import { ControladorAudio } from '../../web/audio.js';
import type { EventoSonido } from '../../shared/src/audio.js';

/**
 * El adaptador de audio del navegador. La Web Audio API entra por un puerto propio
 * (`ContextoAudio`), así que acá se verifica la decisión sin tocar el navegador: cuándo se crea
 * el contexto, cuándo se reusa una voz y qué ganancia termina aplicada.
 */

/** Un contexto de audio de mentira que anota todo lo que le piden. */
const fake = () => {
  const voces: { hz: number[]; gan: number[]; formas: string[]; ciclos: number[]; detenida: number }[] = [];
  const crearVoz = vi.fn(() => {
    const v = { hz: [] as number[], gan: [] as number[], formas: [] as string[], ciclos: [] as number[], detenida: 0 };
    voces.push(v);
    return {
      frecuencia: (h: number) => { v.hz.push(h); },
      ganancia: (g: number) => { v.gan.push(g); },
      forma: (f: string) => { v.formas.push(f); },
      ciclo: (d: number) => { v.ciclos.push(d); },
      detener: () => { v.detenida += 1; },
    };
  });
  const reanudar = vi.fn(async () => {});
  const cerrar = vi.fn(async () => {});
  const crearContexto = vi.fn(() => ({ crearVoz, reanudar, cerrar }));
  return { crearContexto, crearVoz, reanudar, cerrar, voces };
};

const zumba = (modulo = 'bz1', ganancia = 1, hz = 2400): EventoSonido =>
  ({ modulo, sonando: true, ganancia, hz, forma: 'cuadrada' });
const calla = (modulo = 'bz1'): EventoSonido => ({ modulo, sonando: false, ganancia: 0, hz: 2400 });

it('sin habilitar no crea el contexto: la política de autoplay exige un gesto del usuario', () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  c.aplicar(zumba());
  expect(f.crearContexto).not.toHaveBeenCalled();
  expect(c.snapshot.habilitado).toBe(false);
});

it('el snapshot dice qué zumba aunque el sonido no esté habilitado todavía', () => {
  const c = new ControladorAudio(fake().crearContexto);
  c.aplicar(zumba('bz1'));
  expect(c.snapshot.sonando).toEqual(['bz1']);
});

it('habilitar crea el contexto una sola vez y lo reanuda', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar(); await c.habilitar();
  expect(f.crearContexto).toHaveBeenCalledOnce();
  expect(f.reanudar).toHaveBeenCalled();
  expect(c.snapshot.habilitado).toBe(true);
});

it('al habilitar arranca lo que ya venía zumbando', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  c.aplicar(zumba('bz1'));
  await c.habilitar();
  expect(f.voces).toHaveLength(1);
  expect(f.voces[0]!.hz).toEqual([2400]);
});

it('un evento que zumba crea una voz con su frecuencia, su forma y su ganancia', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.cambiarVolumen(1);
  c.aplicar(zumba('bz1', 1, 440));
  expect(f.voces[0]!.hz).toEqual([440]);
  expect(f.voces[0]!.formas).toEqual(['cuadrada']);
  expect(f.voces[0]!.gan.at(-1)).toBe(1);
});

it('cambiar de frecuencia reusa la voz: recrearla haría un clic', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar(zumba('bz1', 1, 440));
  c.aplicar(zumba('bz1', 1, 880));
  expect(f.crearVoz).toHaveBeenCalledOnce();
  expect(f.voces[0]!.hz).toEqual([440, 880]);
});

it('el mismo evento repetido no vuelve a tocar la voz', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar(zumba('bz1', 1, 440));
  c.aplicar(zumba('bz1', 1, 440));
  expect(f.voces[0]!.hz).toEqual([440]);
});

it('cuando deja de zumbar la silencia pero conserva la voz para reusarla', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar(zumba('bz1'));
  c.aplicar(calla('bz1'));
  expect(f.voces[0]!.detenida).toBe(1);
  expect(c.snapshot.sonando).toEqual([]);
  c.aplicar(zumba('bz1'));
  expect(f.crearVoz).toHaveBeenCalledOnce();
});

it('un módulo que nunca sonó y llega callado no crea ninguna voz', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar(calla('bz9'));
  expect(f.crearVoz).not.toHaveBeenCalled();
});

it('la ganancia del evento se multiplica por el volumen general', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.cambiarVolumen(0.5);
  c.aplicar(zumba('bz1', 0.6));
  expect(f.voces[0]!.gan.at(-1)).toBeCloseTo(0.3, 6);
});

it('silenciar lleva la ganancia a cero sin olvidar qué zumba', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar(zumba('bz1'));
  c.silenciar(true);
  expect(f.voces[0]!.gan.at(-1)).toBe(0);
  expect(c.snapshot.sonando).toEqual(['bz1']);
  expect(c.snapshot.silenciado).toBe(true);
});

it('el volumen se recorta a 0..1', () => {
  const c = new ControladorAudio(fake().crearContexto);
  c.cambiarVolumen(5); expect(c.snapshot.volumen).toBe(1);
  c.cambiarVolumen(-2); expect(c.snapshot.volumen).toBe(0);
});

it('dos módulos suenan con voces independientes', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.cambiarVolumen(1);
  c.aplicar(zumba('bz1', 1, 440));
  c.aplicar(zumba('bz2', 0.5, 880));
  expect(f.crearVoz).toHaveBeenCalledTimes(2);
  expect(f.voces[0]!.hz).toEqual([440]);
  expect(f.voces[1]!.hz).toEqual([880]);
  expect(c.snapshot.sonando).toEqual(['bz1', 'bz2']);
});

it('detener cierra el contexto y queda listo para volver a habilitarse', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar(zumba('bz1'));
  await c.detener();
  expect(f.cerrar).toHaveBeenCalledOnce();
  expect(c.snapshot.habilitado).toBe(false);
  expect(c.snapshot.sonando).toEqual([]);
  await c.habilitar();
  expect(f.crearContexto).toHaveBeenCalledTimes(2);
});

it('avisa a sus oyentes cada vez que cambia, y deja de avisar al desuscribirse', () => {
  const c = new ControladorAudio(fake().crearContexto);
  const oyente = vi.fn();
  const baja = c.suscribir(oyente);
  c.aplicar(zumba('bz1'));
  expect(oyente).toHaveBeenCalled();
  baja();
  oyente.mockClear();
  c.aplicar(calla('bz1'));
  expect(oyente).not.toHaveBeenCalled();
});

it('un evento sin frecuencia no rompe: silencio en vez de un NaN al oscilador', async () => {
  const f = fake(), c = new ControladorAudio(f.crearContexto);
  await c.habilitar();
  c.aplicar({ modulo: 'bz1', sonando: true, ganancia: 1 });
  expect(f.crearVoz).not.toHaveBeenCalled();
  expect(c.snapshot.sonando).toEqual([]);
});

describe('la forma de onda sigue al ciclo de trabajo (el timbre)', () => {
  const conDuty = (duty: number, ganancia = 1): EventoSonido =>
    ({ modulo: 'bz1', sonando: true, ganancia, hz: 440, forma: 'cuadrada', duty });

  it('un evento con duty pide la onda del pulso, no una cuadrada genérica', async () => {
    const f = fake(), c = new ControladorAudio(f.crearContexto);
    await c.habilitar();
    c.aplicar(conDuty(0.25));
    expect(f.voces[0]!.ciclos).toEqual([0.25]);
    expect(f.voces[0]!.formas, 'con duty la forma la da el pulso').toEqual([]);
  });

  it('cambiar solo el ciclo de trabajo no recrea la voz', async () => {
    const f = fake(), c = new ControladorAudio(f.crearContexto);
    await c.habilitar();
    c.aplicar(conDuty(0.5));
    c.aplicar(conDuty(0.1));
    expect(f.crearVoz).toHaveBeenCalledOnce();
    expect(f.voces[0]!.ciclos).toEqual([0.5, 0.1]);
  });

  it('el mismo duty no se vuelve a aplicar', async () => {
    const f = fake(), c = new ControladorAudio(f.crearContexto);
    await c.habilitar();
    c.aplicar(conDuty(0.5));
    c.aplicar(conDuty(0.5));
    expect(f.voces[0]!.ciclos).toEqual([0.5]);
  });

  it('sin duty (oscilador interno) se usa la forma declarada', async () => {
    const f = fake(), c = new ControladorAudio(f.crearContexto);
    await c.habilitar();
    c.aplicar({ modulo: 'bz1', sonando: true, ganancia: 1, hz: 2400, forma: 'cuadrada' });
    expect(f.voces[0]!.formas).toEqual(['cuadrada']);
    expect(f.voces[0]!.ciclos).toEqual([]);
  });

  it('un seno no tiene ciclo de trabajo: se ignora', async () => {
    const f = fake(), c = new ControladorAudio(f.crearContexto);
    await c.habilitar();
    c.aplicar({ modulo: 'bz1', sonando: true, ganancia: 1, hz: 440, forma: 'seno', duty: 0.25 });
    expect(f.voces[0]!.formas).toEqual(['seno']);
    expect(f.voces[0]!.ciclos).toEqual([]);
  });

  /** La forma y el volumen son cosas separadas: el duty no puede contarse dos veces. */
  it('el ciclo de trabajo no toca la ganancia', async () => {
    const f = fake(), c = new ControladorAudio(f.crearContexto);
    await c.habilitar();
    c.cambiarVolumen(1);
    c.aplicar(conDuty(0.25, 0.707));
    expect(f.voces[0]!.gan.at(-1)).toBeCloseTo(0.707, 6);
  });
});
