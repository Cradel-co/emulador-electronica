import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { ProjectSchema } from '@emu/shared';
import { loadCatalog } from '../catalog.js';
import { buscarPlaca } from '../boardRegistry.js';
import { chipsDelProyecto } from './proyectoChips.js';
import { PuenteChips } from './puenteChips.js';
import { analizarCircuito } from '../sim/analisis.js';

it('cableado, alimentación, SPI con CS sostenido y rechazo de MISO incorrecto', async () => {
  const p = ProjectSchema.parse(JSON.parse(readFileSync('../projects/_template/arducam-esp32-s3/project.json','utf8')));
  const catalogo = await loadCatalog(), buscar = (t: string) => catalogo.find(c => c.type === t);
  const placa = await buscarPlaca(p.board ?? '');
  const electrico = await analizarCircuito(p, buscar, {});
  expect(electrico.modulos.camara?.ui?.on).toBe(true);
  const { chips } = chipsDelProyecto(p, buscar, placa?.desc,undefined, id => electrico.modulos[id]?.ui?.on);
  expect(chips).toHaveLength(2);
  expect(chips[0]?.i2cGpio).toEqual({ sda:8,scl:9 });
  expect(chips[1]?.spi).toMatchObject({ sck:12,mosi:11,miso:13,csGpio:10 });
  const respuestas: string[] = [], acciones: Record<string, unknown>[] = [];
  const b = new PuenteChips(chips, { enviar: l => respuestas.push(l), alSalida: (_id,s) => acciones.push(s) });
  let t = 0;
  const pin = (v: number) => b.recibir(`@P 10 ${v} ${++t}`);
  const spi = (bytes: number[], miso = 13) => {
    b.recibir(`@SPI 1 ${++t} 12 11 ${miso} 1000000 0 0 ${Buffer.from(bytes).toString('base64')} 1`);
    return [...Buffer.from(respuestas.at(-1)?.split(' ')[2] ?? '', 'base64')];
  };
  pin(0); spi([0x80]); spi([0x55]); pin(1);
  pin(0); spi([0]); expect(spi([0])).toEqual([0x55]); pin(1);
  pin(0); expect(spi([0,0], 14)).toEqual([255,255]); pin(1);
  b.entradaCamara('camara', { tipo:'configuracion',soportada:true });
  pin(0); spi([0x84,2]); pin(1);
  const token = [...acciones].reverse().find(x => x.cameraAction === 'capture')?.token;
  expect(typeof token).toBe('number');
  b.entradaCamara('camara', { tipo:'imagen',token: Number(token),bytes:[255,216,1,2,255,217] });
  pin(0); spi([0x3c]); expect(spi([0,0])).toEqual([255,216]); expect(spi([0,0,0,0])).toEqual([1,2,255,217]); pin(1);
  b.apagar(); expect(acciones.at(-1)).toMatchObject({cameraAction:'cancel'});
  const sinFuente = { ...p, wires: p.wires.filter(w => w.from !== 'camara.VCC') };
  const off = await analizarCircuito(sinFuente,buscar,{});
  expect(off.modulos.camara?.ui?.on).toBe(false);
  expect(chipsDelProyecto(sinFuente,buscar,placa?.desc,undefined,id=>off.modulos[id]?.ui?.on).chips.every(c=>!c.alimentado)).toBe(true);
}, 20_000);

it('perder alimentación o quitar el módulo cancela la solicitud pendiente', async () => {
  const p = ProjectSchema.parse(JSON.parse(readFileSync('../projects/_template/arducam-esp32-s3/project.json','utf8')));
  const catalogo = await loadCatalog(), buscar = (t: string) => catalogo.find(c => c.type === t);
  const {chips} = chipsDelProyecto(p,buscar,(await buscarPlaca(p.board ?? ''))?.desc);
  const salidas: Record<string, unknown>[] = [];
  const b = new PuenteChips(chips,{enviar:()=>{},alSalida:(_id,s)=>salidas.push(s)});
  b.entradaCamara('camara',{tipo:'configuracion',soportada:true});
  b.recibir('@P 10 0 1'); b.recibir('@SPI 1 2 12 11 13 1000000 0 0 hAI= 1');
  expect(salidas.at(-1)).toMatchObject({cameraAction:'capture'});
  b.actualizarCamaras([]);
  expect(salidas.at(-1)).toMatchObject({cameraAction:'cancel'});
  expect(chips.every(c=>!c.alimentado)).toBe(true);
  b.entradaCamara('camara',{tipo:'imagen',token:2,bytes:[255,216,255,217]});
  expect(salidas.at(-1)).toMatchObject({cameraAction:'cancel'});
});

it('comparte SCLK/MOSI entre ArduCAM y TFT con CS independientes', async () => {
  const p = ProjectSchema.parse(JSON.parse(readFileSync('../projects/_template/arducam-tft-esp32-s3/project.json', 'utf8')));
  const catalogo = await loadCatalog(), buscar = (t: string) => catalogo.find(c => c.type === t);
  const placa = await buscarPlaca(p.board ?? '');
  const electrico = await analizarCircuito(p, buscar, {});
  const { chips } = chipsDelProyecto(p, buscar, placa?.desc, undefined, id => electrico.modulos[id]?.ui?.on);
  expect(chips).toHaveLength(3);
  const arducam = chips.find(c => c.chip === 'arduchip');
  const tft = chips.find(c => c.chip === 'sitronix-st7735');
  expect(arducam?.spi).toMatchObject({ sck: 12, mosi: 11, miso: 13, csGpio: 10 });
  expect(tft?.spi).toMatchObject({ sck: 12, mosi: 11, csGpio: 14, dcGpio: 15 });

  const salidas: Record<string, unknown>[] = [];
  const puente = new PuenteChips(chips, { enviar: () => {}, alSalida: (_id, salida) => salidas.push(salida) });
  // La secuencia de comandos/datos de la TFT no debe seleccionar la FIFO de la cámara.
  puente.recibir('@P 14 0 1');
  puente.recibir('@P 15 0 2');
  puente.recibir('@SPI 1 3 12 11 13 1000000 0 0 gA== 1'); // SWRESET
  puente.recibir('@P 15 1 4');
  puente.recibir('@SPI 1 5 12 11 13 1000000 0 0 AA== 1'); // dato TFT
  puente.recibir('@P 14 1 6');
  expect(salidas.some(s => s.cameraAction === 'capture')).toBe(false);

  // El CS de la ArduCAM sí conserva el protocolo y genera una solicitud independiente.
  puente.entradaCamara('camara', { tipo: 'configuracion', soportada: true });
  puente.recibir('@P 10 0 7');
  puente.recibir('@SPI 1 8 12 11 13 1000000 0 0 hAI= 1'); // CAP_DONE_MASK / CAP_START
  puente.recibir('@P 10 1 9');
  expect(salidas.some(s => s.cameraAction === 'capture')).toBe(true);
  puente.apagar();
});
