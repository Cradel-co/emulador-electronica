import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaquetesComponentes } from '../../../../server/src/componentes/paquetes.js';
import { resistor } from '../../../fixtures/server/componentes/divisor.js';
import { ROOT } from '../../../../server/src/paths.js';

const temporales: string[] = [];
afterEach(async () => { for (const carpeta of temporales.splice(0)) await fs.rm(carpeta, { recursive: true, force: true }); });
async function copia(tipo = 'resistor') {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'componentes-paquete-')); temporales.push(raiz);
  await fs.cp(path.join(ROOT, 'modules', tipo), path.join(raiz, tipo), { recursive: true });
  return { raiz, carpeta: path.join(raiz, tipo), paquetes: new PaquetesComponentes({ modulos: raiz, chips: path.join(ROOT, 'chips') }) };
}

describe('verificación de paquetes de componentes', () => {
  it('verifica archivos reales y compila la fuente fijada por hash', async () => {
    const { paquetes } = await copia(), paquete = await paquetes.inspeccionar('resistor');
    const hoja = resistor();
    if (hoja.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
    hoja.modulo.sha256 = paquete.sha256;
    const modelo = await paquetes.verificar(hoja);
    expect(modelo.type).toBe('resistor');
    expect(modelo.modeloCodigo).toContain('circuito');
    expect(paquete.archivos.map(a => a.nombre)).toEqual(expect.arrayContaining(['model.ts', 'module.svg', 'tests.json']));
    modelo.name = 'mutado';
    expect((await paquetes.verificar(hoja)).name).not.toBe('mutado');
  });
  it.each(['model.ts', 'module.svg', 'tests.json'])('rechaza cambios en %s contra la referencia ya fijada', async archivo => {
    const { carpeta, paquetes } = await copia(), hoja = resistor();
    if (hoja.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
    hoja.modulo.sha256 = (await paquetes.inspeccionar('resistor')).sha256;
    await fs.appendFile(path.join(carpeta, archivo), '\n');
    await expect(paquetes.verificar(hoja)).rejects.toMatchObject({ codigo: 'HASH_DISTINTO' });
  });
  it('descriptor canónico: formato no cambia el hash; cambiar un valor sí', async () => {
    const { carpeta, paquetes } = await copia(), anterior = await paquetes.inspeccionar('resistor');
    const archivo = path.join(carpeta, 'module.json');
    const raw = JSON.parse(await fs.readFile(archivo, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(archivo, JSON.stringify(Object.fromEntries(Object.entries(raw).reverse())));
    expect((await paquetes.inspeccionar('resistor')).sha256).toBe(anterior.sha256);
    await fs.writeFile(archivo, JSON.stringify({ ...raw, name: 'Otra resistencia' }));
    expect((await paquetes.inspeccionar('resistor')).sha256).not.toBe(anterior.sha256);
  });
  it('incluye el comportamiento del chip y falla si falta una dependencia', async () => {
    const { raiz, paquetes } = await copia('arducam-mini-2mp-plus');
    const chips = path.join(raiz, 'chips');
    for (const id of ['ov2640', 'arduchip']) await fs.cp(path.join(ROOT, 'chips', id), path.join(chips, id), { recursive: true });
    const local = new PaquetesComponentes({ modulos: raiz, chips });
    const anterior = await local.inspeccionar('arducam-mini-2mp-plus');
    await fs.appendFile(path.join(chips, 'ov2640/comportamiento.ts'), '\n');
    expect((await local.inspeccionar('arducam-mini-2mp-plus')).sha256).not.toBe(anterior.sha256);
    await fs.rm(path.join(chips, 'ov2640/chip.json'));
    await expect(local.inspeccionar('arducam-mini-2mp-plus')).rejects.toMatchObject({ codigo: 'PAQUETE_INVALIDO' });
    expect((await paquetes.inspeccionar('arducam-mini-2mp-plus')).descriptor.type).toBe('arducam-mini-2mp-plus');
  });
  it('rechaza puertos incompletos y contratos que amplían el rango del módulo', async () => {
    const { paquetes } = await copia(), hoja = resistor();
    if (hoja.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
    hoja.modulo.sha256 = (await paquetes.inspeccionar('resistor')).sha256;
    const incompleta = { ...hoja, puertos: hoja.puertos.slice(0, 1) };
    await expect(paquetes.verificar(incompleta)).rejects.toMatchObject({ codigo: 'PUERTO_INCOMPATIBLE' });
    const ampliada = { ...hoja, parametros: { ohms: { tipo: 'numero' as const, default: 1000, min: 0, max: 1e8 } } };
    await expect(paquetes.verificar(ampliada)).rejects.toMatchObject({ codigo: 'PARAMETRO' });
    await expect(paquetes.verificar({ ...hoja, parametros: { mentira: { tipo: 'numero', default: 1 } } })).rejects.toMatchObject({ codigo: 'PARAMETRO' });
  });
  it('rechaza modelo ausente, rutas fuera del paquete y enlaces simbólicos externos', async () => {
    const { carpeta, paquetes } = await copia();
    await fs.rm(path.join(carpeta, 'model.ts'));
    await expect(paquetes.inspeccionar('resistor')).rejects.toMatchObject({ codigo: 'PAQUETE_INVALIDO' });
    await fs.symlink(path.join(ROOT, 'modules/led/model.ts'), path.join(carpeta, 'model.ts'));
    await expect(paquetes.inspeccionar('resistor')).rejects.toMatchObject({ codigo: 'PAQUETE_INVALIDO' });
    await expect(paquetes.inspeccionar('../resistor')).rejects.toMatchObject({ codigo: 'PAQUETE_INVALIDO' });
  });
  it('no acepta un modelo grande y no sustituye errores por flags', async () => {
    const { carpeta, paquetes } = await copia();
    await fs.writeFile(path.join(carpeta, 'model.ts'), ' '.repeat(128 * 1024 + 1));
    await expect(paquetes.inspeccionar('resistor')).rejects.toMatchObject({ codigo: 'LIMITE' });
  });
  it('rechaza un modelo fijado que intenta importar del host, aunque haya flags de respaldo', async () => {
    const { carpeta, paquetes } = await copia(), hoja = resistor();
    if (hoja.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
    await fs.writeFile(path.join(carpeta, 'model.ts'), 'import fs from "node:fs"; console.log(fs); export default {};');
    hoja.modulo.sha256 = (await paquetes.inspeccionar('resistor')).sha256;
    await expect(paquetes.verificar(hoja)).rejects.toMatchObject({ codigo: 'MODELO_INVALIDO' });
  });
  it('verifica el hash antes de compilar contenido cambiado', async () => {
    const { carpeta, paquetes } = await copia(), hoja = resistor();
    if (hoja.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
    hoja.modulo.sha256 = (await paquetes.inspeccionar('resistor')).sha256;
    await fs.writeFile(path.join(carpeta, 'model.ts'), 'export default {');
    await expect(paquetes.verificar(hoja)).rejects.toMatchObject({ codigo: 'HASH_DISTINTO' });
  });
  it('rechaza tipos y defaults incompatibles con las propiedades del paquete', async () => {
    const { paquetes } = await copia(), hoja = resistor();
    if (hoja.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
    hoja.modulo.sha256 = (await paquetes.inspeccionar('resistor')).sha256;
    await expect(paquetes.verificar({ ...hoja, parametros: { ohms: { tipo: 'texto', default: '1000' } } })).rejects.toMatchObject({ codigo: 'PARAMETRO' });
    await expect(paquetes.verificar({ ...hoja, parametros: { ohms: { tipo: 'numero', default: 0, min: 0, max: 10_000_000 } } })).rejects.toMatchObject({ codigo: 'PARAMETRO' });
    await expect(paquetes.verificar({ ...hoja, puertos: hoja.puertos.map(p => ({ ...p, dominio: 'logico' as const })) })).rejects.toMatchObject({ codigo: 'PUERTO_INCOMPATIBLE' });
  });
});
