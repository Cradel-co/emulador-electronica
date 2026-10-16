import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ModuleInstaller,
  convertirChipWokwi,
  importar,
  leerZip,
  paquetesDeArchivos,
  paquetesDeUrl,
  problemasSvg,
  urlGithub,
  validarPaquete,
} from '../../../server/src/moduleImporter.js';
import { PATHS } from '../../../server/src/paths.js';

const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 50"><rect x="0" y="0" width="60" height="38" fill="#333"/><g data-ctrl="momentary"><circle cx="30" cy="19" r="10"/></g></svg>';

const moduloOk = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'boton-grande',
    name: 'Botón grande',
    category: 'Entradas',
    width: 60,
    height: 50,
    pins: [
      { name: 'SIG', x: 20, y: 50, kind: 'digital-out' },
      { name: 'GND', x: 40, y: 50, kind: 'ground' },
    ],
    bridge: { role: 'input', pin: 'SIG', activeLevel: 0 },
    controls: [{ kind: 'momentary' }],
    ...extra,
  });

const INVERSOR_WOKWI = JSON.stringify({ name: 'Inverter', author: 'Uri Shaked', pins: ['IN', 'OUT', '', 'GND', 'VCC'] });

function dirTemporal(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'emu-mod-'));
}

/** fetch falso: responde según la URL (sin red). */
function fetchFalso(rutas: Record<string, Uint8Array | string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const cuerpo = rutas[url];
    if (cuerpo === undefined) return new Response('no', { status: 404 });
    return new Response(typeof cuerpo === 'string' ? cuerpo : cuerpo, { status: 200 });
  }) as typeof fetch;
}

describe('problemasSvg', () => {
  it('acepta un SVG simple con data-si/data-ctrl', () => {
    expect(problemasSvg(SVG_OK)).toEqual([]);
  });

  it.each([
    ['<svg><script>alert(1)</script></svg>', 'elementos no permitidos'],
    ['<svg><rect onclick="alert(1)"/></svg>', 'eventos'],
    ['<svg><foreignObject><div/></foreignObject></svg>', 'elementos no permitidos'],
    ['<svg><use href="https://x.com/a.svg#b"/></svg>', 'href'],
    ['<svg><a xlink:href="javascript:alert(1)"><rect/></a></svg>', 'no permitidos'],
    ['<svg><rect fill="url(https://x.com/y)"/></svg>', 'url('],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', 'DOCTYPE'],
    ['<div>hola</div>', 'no es un SVG'],
  ])('rechaza %s', (svg, esperado) => {
    expect(problemasSvg(svg).join(' ')).toContain(esperado);
  });

  it('permite referencias internas (#id)', () => {
    const svg = '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>';
    expect(problemasSvg(svg)).toEqual([]);
  });
});

describe('validarPaquete', () => {
  const p = (json: string, svg: string | undefined = SVG_OK) => validarPaquete({ json, svg, origen: 'x', kind: 'carpeta' });

  it('acepta un módulo correcto', () => {
    const v = p(moduloOk());
    expect(v.errores).toEqual([]);
    expect(v.def?.type).toBe('boton-grande');
  });

  it('explica los errores con el campo', () => {
    expect(p('{ no es json').errores[0]).toContain('no es JSON válido');
    expect(p(moduloOk({ type: 'Con Espacios' })).errores.join()).toContain('type');
    expect(p(moduloOk({ pins: [{ name: 'A', x: 500, y: 0 }] })).errores.join()).toContain('fuera del módulo');
    expect(p(moduloOk({ pins: [{ name: 'A', x: 0, y: 0 }, { name: 'A', x: 10, y: 0 }] })).errores.join()).toContain('repetido');
    expect(p(moduloOk({ bridge: { role: 'input', pin: 'NOEXISTE' } })).errores.join()).toContain('bridge.pin');
    expect(p(moduloOk({ programmable: true })).errores.join()).toContain('programable');
    expect(p(moduloOk(), '<svg><script/></svg>').errores.join()).toContain('module.svg');
  });

  it('sin SVG, avisa pero acepta', () => {
    const v = validarPaquete({ json: moduloOk(), svg: undefined, origen: 'x', kind: 'carpeta' });
    expect(v.errores).toEqual([]);
    expect(v.avisos.join()).toContain('no trae dibujo');
  });

  it('ignora un "origin" que venga en el paquete (lo pone el importador)', () => {
    const v = p(moduloOk({ origin: { kind: 'zip', from: 'trucho', importedAt: 'x' } }));
    expect(v.def?.origin).toBeUndefined();
  });
});

describe('módulos de fábrica', () => {
  const dirs = readdirSync(PATHS.modules, { withFileTypes: true }).filter((d) => d.isDirectory());

  it.each(dirs.map((d) => d.name))('%s cumple el formato, su SVG es seguro y su modelo carga', (nombre) => {
    const dir = path.join(PATHS.modules, nombre);
    const json = readFileSync(path.join(dir, 'module.json'), 'utf8');
    const svg = readFileSync(path.join(dir, 'module.svg'), 'utf8');
    const model = (JSON.parse(json) as { model?: string }).model;
    const modelo = model ? readFileSync(path.join(dir, model), 'utf8') : undefined;
    expect(problemasSvg(svg)).toEqual([]);
    const v = validarPaquete({ json, svg, modelo, origen: nombre, kind: 'carpeta' });
    // Las placas (programables) pasan si su bloque "board" es válido.
    expect(v.errores).toEqual([]);
  });
});

describe('convertirChipWokwi', () => {
  it('arma un DIP: primera mitad a la izquierda, segunda a la derecha de abajo hacia arriba', () => {
    const { json, svg } = convertirChipWokwi(INVERSOR_WOKWI);
    const def = JSON.parse(json);
    expect(def.type).toBe('inverter');
    const pin = (n: string) => def.pins.find((p: { name: string }) => p.name === n);
    expect(pin('IN')).toMatchObject({ x: 0 });
    expect(pin('OUT').x).toBe(0);
    expect(pin('OUT').y).toBeGreaterThan(pin('IN').y);
    expect(pin('VCC').x).toBe(def.width); // último: arriba a la derecha
    expect(pin('VCC').y).toBe(pin('IN').y);
    expect(pin('GND').kind).toBe('ground');
    expect(pin('VCC').kind).toBe('power');
    expect(def.pins).toHaveLength(4); // el "" es un hueco
    expect(def.bridge).toBeUndefined();
    expect(problemasSvg(svg)).toEqual([]);
    expect(validarPaquete({ json, svg, origen: 'x', kind: 'wokwi' }).errores).toEqual([]);
  });

  it('con rol, conecta el puente al primer pin de señal (o al elegido)', () => {
    expect(JSON.parse(convertirChipWokwi(INVERSOR_WOKWI, { role: 'output' }).json).bridge).toEqual({ role: 'output', pin: 'IN' });
    expect(JSON.parse(convertirChipWokwi(INVERSOR_WOKWI, { role: 'input', pin: 'OUT' }).json).bridge.pin).toBe('OUT');
  });

  it('escapa el nombre en el SVG', () => {
    const { svg } = convertirChipWokwi(JSON.stringify({ name: '<script>x</script>', pins: ['A'] }), { type: 'raro' });
    expect(svg).not.toContain('<script>');
    expect(problemasSvg(svg)).toEqual([]);
  });

  it('rechaza lo que no es un chip', () => {
    expect(() => convertirChipWokwi('{"name": "x"}')).toThrow('no parece un chip de Wokwi');
    expect(() => convertirChipWokwi('nope')).toThrow('JSON válido');
  });
});

describe('zip y carpetas', () => {
  it('encuentra varios módulos y chips de Wokwi en subcarpetas', () => {
    const zip = zipSync({
      'coleccion/boton-grande/module.json': strToU8(moduloOk()),
      'coleccion/boton-grande/module.svg': strToU8(SVG_OK),
      'coleccion/otro/module.json': strToU8(moduloOk({ type: 'otro', name: 'Otro' })),
      'coleccion/chips/inverter.chip.json': strToU8(INVERSOR_WOKWI),
      'coleccion/README.md': strToU8('# ignorado'),
      '__MACOSX/coleccion/._module.json': strToU8('basura'),
    });
    const archivos = leerZip(zip);
    expect([...archivos.keys()].some((k) => k.endsWith('README.md') || k.includes('__MACOSX'))).toBe(false);
    const { paquetes } = paquetesDeArchivos(archivos, 'zip');
    expect(paquetes.map((p) => p.origen).sort()).toEqual([
      'coleccion/boton-grande/module.json',
      'coleccion/chips/inverter.chip.json',
      'coleccion/otro/module.json',
    ]);
    expect(paquetes.find((p) => p.origen.includes('boton-grande'))!.svg).toBe(SVG_OK);
  });

  it('avisa si no hay ningún módulo', () => {
    const { errores } = paquetesDeArchivos(new Map([['a.json', '{}']]), 'carpeta');
    expect(errores[0]!.mensajes[0]).toContain('no se encontró');
  });

  it('rechaza archivos enormes dentro del zip', () => {
    const zip = zipSync({ 'x/module.json': new Uint8Array(600 * 1024) }, { level: 9 });
    expect(() => leerZip(zip)).toThrow('demasiado grande');
  });
});

describe('URLs', () => {
  it('reconoce repos de GitHub', () => {
    expect(urlGithub('https://github.com/wokwi/inverter-chip')).toEqual({
      zip: 'https://github.com/wokwi/inverter-chip/archive/HEAD.zip',
      subcarpeta: '',
    });
    expect(urlGithub('https://github.com/yo/mods/tree/main/modulos/rf')).toEqual({
      zip: 'https://github.com/yo/mods/archive/main.zip',
      subcarpeta: 'modulos/rf',
    });
    expect(urlGithub('https://example.com/x.zip')).toBeNull();
  });

  it('baja un repo de GitHub y toma solo la subcarpeta pedida', async () => {
    const zip = zipSync({
      'mods-main/modulos/rf/boton-grande/module.json': strToU8(moduloOk()),
      'mods-main/modulos/rf/boton-grande/module.svg': strToU8(SVG_OK),
      'mods-main/otros/x/module.json': strToU8(moduloOk({ type: 'fuera' })),
    });
    const f = fetchFalso({ 'https://github.com/yo/mods/archive/main.zip': zip });
    const { paquetes } = await paquetesDeUrl('https://github.com/yo/mods/tree/main/modulos/rf', {}, f);
    expect(paquetes.map((p) => JSON.parse(p.json).type)).toEqual(['boton-grande']);
    expect(paquetes[0]!.kind).toBe('github');
  });

  it('un module.json suelto busca su SVG al lado', async () => {
    const f = fetchFalso({
      'https://x.com/mods/boton/module.json': moduloOk(),
      'https://x.com/mods/boton/module.svg': SVG_OK,
    });
    const { paquetes } = await paquetesDeUrl('https://x.com/mods/boton/module.json', {}, f);
    expect(paquetes[0]!.svg).toBe(SVG_OK);
  });

  it('un .chip.json por URL se convierte', async () => {
    const f = fetchFalso({ 'https://x.com/inverter.chip.json': INVERSOR_WOKWI });
    const { paquetes } = await paquetesDeUrl('https://x.com/inverter.chip.json', { role: 'output' }, f);
    expect(JSON.parse(paquetes[0]!.json).bridge.role).toBe('output');
  });

  it('solo https', async () => {
    await expect(paquetesDeUrl('http://x.com/a.zip', {}, fetchFalso({}))).rejects.toThrow('https');
    await expect(paquetesDeUrl('file:///etc/passwd', {}, fetchFalso({}))).rejects.toThrow('https');
  });
});

describe('importar + instalar', () => {
  it('instala, protege lo de fábrica, pide permiso para reemplazar y quita', async () => {
    const dir = dirTemporal();
    // Uno "de fábrica" (sin origin) en la carpeta.
    await fs.mkdir(path.join(dir, 'led'));
    await fs.writeFile(path.join(dir, 'led', 'module.json'), moduloOk({ type: 'led' }));
    const inst = new ModuleInstaller(dir);

    const r1 = await importar({ fuente: 'archivos', archivos: { 'm/module.json': moduloOk(), 'm/module.svg': SVG_OK } }, inst);
    expect(r1.importados.map((m) => m.type)).toEqual(['boton-grande']);
    const guardado = JSON.parse(readFileSync(path.join(dir, 'boton-grande', 'module.json'), 'utf8'));
    expect(guardado.origin.kind).toBe('carpeta');
    expect(readFileSync(path.join(dir, 'boton-grande', 'module.svg'), 'utf8')).toBe(SVG_OK);

    const r2 = await importar({ fuente: 'archivos', archivos: { 'm/module.json': moduloOk() } }, inst);
    expect(r2.errores[0]!.mensajes[0]).toContain('reemplazar');
    const r3 = await importar({ fuente: 'archivos', archivos: { 'm/module.json': moduloOk({ name: 'Nuevo' }) } }, inst, { sobrescribir: true });
    expect(r3.importados[0]!.name).toBe('Nuevo');

    const r4 = await importar({ fuente: 'archivos', archivos: { 'm/module.json': moduloOk({ type: 'led' }) } }, inst, { sobrescribir: true });
    expect(r4.errores[0]!.mensajes[0]).toContain('de fábrica');

    await expect(inst.quitar('led')).rejects.toThrow('de fábrica');
    await inst.quitar('boton-grande');
    expect(existsSync(path.join(dir, 'boton-grande'))).toBe(false);
  });

  it('solo validar no escribe nada', async () => {
    const dir = dirTemporal();
    const r = await importar({ fuente: 'wokwi', chipJson: INVERSOR_WOKWI }, new ModuleInstaller(dir), { soloValidar: true });
    expect(r.importados.map((m) => m.type)).toEqual(['inverter']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('informa por módulo: los buenos entran aunque otro falle', async () => {
    const dir = dirTemporal();
    const r = await importar(
      { fuente: 'archivos', archivos: { 'a/module.json': moduloOk(), 'b/module.json': moduloOk({ type: 'malo', pins: 3 }) } },
      new ModuleInstaller(dir),
    );
    expect(r.importados.map((m) => m.type)).toEqual(['boton-grande']);
    expect(r.errores[0]!.origen).toBe('b/module.json');
  });
});

describe('módulos con código (modelo eléctrico)', () => {
  const modeloTs = `const ron: number = 0.05;
module.exports = { circuito(ctx) { ctx.interruptor(ctx.pin('SIG'), ctx.pin('GND'), ctx.control, { ron }, 'contacto'); } };`;

  it.each(['zip', 'github'] as const)('instala y valida model.ts desde %s sin perder su fuente', async fuente => {
    const dir = dirTemporal();
    const zip = zipSync({
      'repo-main/modulo/module.json': strToU8(moduloOk({ model: 'model.ts' })),
      'repo-main/modulo/module.svg': strToU8(SVG_OK),
      'repo-main/modulo/model.ts': strToU8(modeloTs),
    });
    const solicitud = fuente === 'zip'
      ? { fuente: 'zip' as const, base64: Buffer.from(zip).toString('base64') }
      : { fuente: 'url' as const, url: 'https://github.com/yo/mods' };
    const resultado = await importar(solicitud, new ModuleInstaller(dir), {},
      fetchFalso({ 'https://github.com/yo/mods/archive/HEAD.zip': zip }));
    expect(resultado.errores).toEqual([]);
    expect(resultado.importados.map(m => m.type)).toEqual(['boton-grande']);
    expect(readFileSync(path.join(dir, 'boton-grande', 'model.ts'), 'utf8')).toBe(modeloTs);
  });

  // Un pulsador grande con su propio modelo: une SIG con GND mientras está apretado.
  const MODELO = `module.exports = { circuito(ctx) { ctx.interruptor(ctx.pin('SIG'), ctx.pin('GND'), ctx.control, { ron: 0.05 }, 'contacto'); } };`;
  const conModelo = (codigo?: string, extra: Record<string, unknown> = {}) => ({
    'm/module.json': moduloOk({ model: 'model.js', ...extra }),
    'm/module.svg': SVG_OK,
    ...(codigo === undefined ? {} : { 'm/model.js': codigo }),
  });

  it('instala el model.js junto al module.json (carpeta y zip)', async () => {
    const dir = dirTemporal();
    const inst = new ModuleInstaller(dir);
    const r = await importar({ fuente: 'archivos', archivos: conModelo(MODELO) }, inst);
    expect(r.errores).toEqual([]);
    expect(readFileSync(path.join(dir, 'boton-grande', 'model.js'), 'utf8')).toBe(MODELO);
    expect(JSON.parse(readFileSync(path.join(dir, 'boton-grande', 'module.json'), 'utf8')).model).toBe('model.js');

    const zip = zipSync(Object.fromEntries(Object.entries(conModelo(MODELO, { type: 'otro-boton' })).map(([k, v]) => [k, strToU8(v)])));
    const rz = await importar({ fuente: 'zip', base64: Buffer.from(zip).toString('base64') }, inst);
    expect(rz.errores).toEqual([]);
    expect(existsSync(path.join(dir, 'otro-boton', 'model.js'))).toBe(true);
  });

  it('un module.json por URL baja su modelo de al lado', async () => {
    const f = fetchFalso({
      'https://x.com/b/module.json': moduloOk({ model: 'model.js' }),
      'https://x.com/b/module.svg': SVG_OK,
      'https://x.com/b/model.js': MODELO,
    });
    const { paquetes } = await paquetesDeUrl('https://x.com/b/module.json', {}, f);
    expect(paquetes[0]!.modelo).toBe(MODELO);
  });

  it.each([
    ['falta el archivo', undefined, /el archivo no vino/],
    ['no es JavaScript', 'module.exports = {', /model\.js/],
    ['no exporta circuito', 'module.exports = {};', /no exporta circuito/],
    ['se cuelga', 'module.exports = { circuito() { for (;;) {} } };', /tardó demasiado/],
    ['usa un pin que no tiene', `module.exports = { circuito(ctx) { ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 100); } };`, /no tiene el pin "VCC"/],
    ['tira un error accionado', `module.exports = { circuito(ctx) { if (ctx.control) throw new Error('roto al apretar'); } };`, /roto al apretar/],
    ['es enorme', `// ${'x'.repeat(130 * 1024)}\nmodule.exports = { circuito() {} };`, /demasiado grande/],
  ])('rechaza un modelo que %s, sin instalar nada', async (_, codigo, error) => {
    const dir = dirTemporal();
    const r = await importar({ fuente: 'archivos', archivos: conModelo(codigo) }, new ModuleInstaller(dir));
    expect(r.importados).toEqual([]);
    expect(r.errores[0]!.mensajes.join(' ')).toMatch(error);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('módulos con sus propias pruebas (tests.json)', () => {
  // Un zumbador inventado: 5 V, 30 mA (≈167 Ω), con el máximo de su hoja de datos como regla.
  const MODELO = `module.exports = { circuito(ctx) { ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 167, 'bobina'); } };`;
  const zumbador = (pruebas: unknown[], extra: Record<string, unknown> = {}) => ({
    'z/module.json': JSON.stringify({
      type: 'zumbador-inventado', name: 'Zumbador', category: 'Salidas', width: 40, height: 40, model: 'model.js',
      pins: [{ name: 'VCC', x: 10, y: 40, kind: 'power' }, { name: 'GND', x: 30, y: 40, kind: 'ground' }],
      reglas: [{ tipo: 'tensionMax', entre: ['VCC', 'GND'], max: 6, mensaje: 'VCC en {v} V: es de 5 V.' }],
      ...extra,
    }),
    'z/module.svg': SVG_OK,
    'z/model.js': MODELO,
    'z/tests.json': JSON.stringify(pruebas),
  });
  const caso = (ma: [number, number]) => ({
    nombre: 'con 5 V toma ~30 mA', banco: { VCC: { fuente: 5 }, GND: 'tierra' }, espera: { corrienteMa: { bobina: ma }, sinAvisos: true },
  });

  it('si sus pruebas pasan, se instala con su tests.json', async () => {
    const dir = dirTemporal();
    const r = await importar({ fuente: 'archivos', archivos: zumbador([caso([29, 31])]) }, new ModuleInstaller(dir));
    expect(r.errores).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, 'zumbador-inventado', 'tests.json'), 'utf8'))[0].nombre).toBe('con 5 V toma ~30 mA');
  });

  it('si una prueba falla, no se instala y dice qué se midió', async () => {
    const dir = dirTemporal();
    const r = await importar({ fuente: 'archivos', archivos: zumbador([caso([50, 60])]) }, new ModuleInstaller(dir));
    expect(r.importados).toEqual([]);
    expect(r.errores[0]!.mensajes.join(' ')).toMatch(/con 5 V toma ~30 mA" falló: corriente de bobina = 29,9\d* mA, se esperaba entre 50 y 60 mA/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('una regla que nombra un pin que no existe, o un esquemático incompleto, no se instala', async () => {
    const dir = dirTemporal();
    const r = await importar({
      fuente: 'archivos',
      archivos: zumbador([caso([29, 31])], {
        reglas: [{ tipo: 'tensionMax', entre: ['VDD', 'GND'], max: 6 }],
        esquematico: { simbolo: 'Device:Buzzer', pines: { VCC: '1' } },
      }),
    }, new ModuleInstaller(dir));
    expect(r.importados).toEqual([]);
    const msj = r.errores[0]!.mensajes.join(' ');
    expect(msj).toMatch(/no tiene el pin "VDD"/);
    expect(msj).toMatch(/falta el pin "GND"/);
  });

  it('un tests.json que no cumple el formato se rechaza con el campo', async () => {
    const r = await importar({ fuente: 'archivos', archivos: zumbador([{ nombre: 'x', banco: { VCC: { fuente: 'cinco' } }, espera: {} }]) }, new ModuleInstaller(dirTemporal()), { soloValidar: true });
    expect(r.errores[0]!.mensajes.join(' ')).toMatch(/tests\.json: 0\.banco\.VCC/);
  });
});

describe('módulos escritos en TypeScript (model.ts)', () => {
  const MODELO_TS = `import type { ModeloModulo, AvisoModelo } from '@emu/shared';
const R_CARGA = 167;
export default {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), R_CARGA as number, 'bobina');
  },
  observar(l) {
    const avisos: AvisoModelo[] = [];
    const v: number = l.vEntre('VCC', 'GND');
    if (v > 6) avisos.push({ severidad: 'peligro', mensaje: \`VCC en \${v} V\` });
    return { ui: { on: v >= 3 }, avisos };
  },
} satisfies ModeloModulo;
`;
  const modulo = (codigo: string, nombre = 'model.ts') => ({
    't/module.json': JSON.stringify({
      type: 'zumbador-ts', name: 'Zumbador TS', category: 'Salidas', width: 40, height: 40, model: nombre,
      pins: [{ name: 'VCC', x: 10, y: 40, kind: 'power' }, { name: 'GND', x: 30, y: 40, kind: 'ground' }],
    }),
    't/module.svg': SVG_OK,
    [`t/${nombre}`]: codigo,
  });

  it('instala el model.ts tal cual (sin transpilar) y lo prueba antes', async () => {
    const dir = dirTemporal();
    const r = await importar({ fuente: 'archivos', archivos: modulo(MODELO_TS) }, new ModuleInstaller(dir));
    expect(r.errores).toEqual([]);
    expect(readFileSync(path.join(dir, 'zumbador-ts', 'model.ts'), 'utf8')).toBe(MODELO_TS);
    expect(JSON.parse(readFileSync(path.join(dir, 'zumbador-ts', 'module.json'), 'utf8')).model).toBe('model.ts');
  });

  it('también se importa por URL: el model.ts se busca al lado del module.json', async () => {
    const f = fetchFalso({
      'https://x.com/t/module.json': modulo(MODELO_TS)['t/module.json'],
      'https://x.com/t/module.svg': SVG_OK,
      'https://x.com/t/model.ts': MODELO_TS,
    });
    const { paquetes } = await paquetesDeUrl('https://x.com/t/module.json', {}, f);
    expect(paquetes[0]!.modelo).toBe(MODELO_TS);
  });

  it('un model.js de antes sigue andando (los importados viejos)', async () => {
    const js = `module.exports = { circuito(ctx) { ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 100); } };`;
    const r = await importar({ fuente: 'archivos', archivos: modulo(js, 'model.js') }, new ModuleInstaller(dirTemporal()), { soloValidar: true });
    expect(r.errores).toEqual([]);
  });

  it.each([
    ['un error de sintaxis, con su línea', 'export default {\n  circuito(ctx) {\n    ctx.resistencia(;\n  },\n};', /model\.ts \(línea 3\)/],
    ['un import en tiempo de ejecución', `import { algo } from 'fs';\nexport default { circuito() { algo(); } };`, /no puede importar nada en tiempo de ejecución/],
    ['no exporta circuito', 'export default {};', /no exporta circuito/],
    ['usa un pin que no tiene', `export default { circuito(ctx: any) { ctx.resistencia(ctx.pin('X'), ctx.pin('GND'), 100); } };`, /no tiene el pin "X"/],
  ])('rechaza un model.ts con %s, sin instalar nada', async (_, codigo, error) => {
    const dir = dirTemporal();
    const r = await importar({ fuente: 'archivos', archivos: modulo(codigo as string) }, new ModuleInstaller(dir));
    expect(r.importados).toEqual([]);
    expect(r.errores[0]!.mensajes.join(' ')).toMatch(error as RegExp);
    expect(readdirSync(dir)).toEqual([]);
  });
});

it('cancela una descarga chunked al superar el presupuesto durante la lectura', async () => {
  let cancelado = false;
  let leidos = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { leidos++; if (leidos <= 20) c.enqueue(new Uint8Array(1024 * 1024)); else c.close(); },
    cancel() { cancelado = true; },
  });
  const fetcher: typeof fetch = async () => new Response(stream);
  await expect(paquetesDeUrl('https://x.com/grande.zip', {}, fetcher)).rejects.toThrow('demasiado grande');
  expect(cancelado).toBe(true);
  expect(leidos).toBeLessThan(20);
});
