import { DefinicionComponenteSchema, SolicitudBancoComponentesSchema, ResultadoBancoComponentesSchema,
  type DefinicionComponente, type ReferenciaComponente, type SolicitudBancoComponentes, type ResultadoBancoComponentes } from '@emu/shared';
import { CatalogoComponentes, huellaDefinicion } from './catalogo.js';
import { PaquetesComponentes } from './paquetes.js';
import { SimulacionTemporalComponentes } from './temporal.js';

const PS_POR_MS = 1_000_000_000n;
const puerto = (id: string) => ({ id, dominio: 'electrico', direccion: 'bidireccional', ancho: 1 });
const externo = (puerto: string) => ({ tipo: 'externo', puerto });
const hijo = (instancia: string, puerto: string) => ({ tipo: 'hijo', instancia, puerto });
const referencia = (d: DefinicionComponente): ReferenciaComponente => ({ id: d.id, version: d.version, sha256: huellaDefinicion(d) });

/** Driver didáctico de dos terminales: Ron=10 Ω / Roff=10 MΩ, fuga explícita.
 * No es un GPIO ni un transistor caracterizado. El LED y la fuente usan modelos del catálogo.
 */
export function estadoBanco(s: SolicitudBancoComponentes, instanteMs: number) {
  let control = s.cambios[0];
  for (const c of s.cambios) if (c.instanteMs <= instanteMs) control = c;
  if (!control) throw new Error('Historia sin estado inicial');
  const estado = !control.alimentacion ? 'apagado' : control.reset ? 'reset'
    : Math.floor(instanteMs / 250) % 2 === 0 ? 'alto' : 'alta-impedancia';
  return { ...control, estado, ohms: estado === 'alto' ? 10 : 10_000_000 } as const;
}

export async function ejecutarBancoComponentes(entrada: SolicitudBancoComponentes, signal?: AbortSignal, paquetes = new PaquetesComponentes()): Promise<ResultadoBancoComponentes> {
  const s = SolicitudBancoComponentesSchema.parse(entrada);
  const comprobar = () => { if (signal?.aborted) throw new Error('Consulta cancelada'); };
  comprobar();
  const definiciones: DefinicionComponente[] = [];
  const agregar = (datos: Record<string, unknown>) => {
    const d = DefinicionComponenteSchema.parse({ schemaVersion: 1, version: '1.0.0', ...datos });
    definiciones.push(d); return d;
  };
  const hoja = async (id: string, modulo: string, pines: string[], parametros: Record<string, unknown>) => agregar({ id, nombre: id,
    tipo: 'hoja-legada', puertos: pines.map(puerto), parametros,
    modulo: { id: modulo, sha256: (await paquetes.inspeccionar(modulo)).sha256 },
  });
  const resistencia = await hoja('resistencia', 'resistor', ['1', '2'], {
    ohms: { tipo: 'numero', default: 10_000_000, min: 1, max: 10_000_000, unidad: 'ohm' },
  });
  const fuente = await hoja('fuente', 'fuente-regulable', ['V', 'GND'], {
    voltage: { tipo: 'numero', default: 3.3, min: -12, max: 12, unidad: 'V' },
    currentLimitMa: { tipo: 'numero', default: 100, min: 1, max: 5000, unidad: 'mA' },
  });
  const led = await hoja('led', 'led', ['IN', 'GND'], { color: { tipo: 'texto', default: 'red', valores: ['red', 'green', 'blue', 'yellow', 'white'] } });
  const envolver = (id: string, interior: DefinicionComponente, instancia: string, alternativa?: DefinicionComponente) => agregar({
    id, nombre: id, tipo: 'compuesto', puertos: ['1', '2'].map(puerto), parametros: resistencia.parametros,
    instancias: [{ id: instancia, definicion: referencia(interior), parametros: { ohms: { parametro: 'ohms' } } }],
    conexiones: ['1', '2'].map((p, i) => ({ id: `terminal-${i}`, terminales: [externo(p), hijo(instancia, p)] })),
    ...(alternativa ? { representaciones: { equivalente: referencia(alternativa), predeterminada: 'interno' } } : {}),
  });
  const interior = envolver('interior-driver', resistencia, 'resistencia');
  const driver = envolver('driver', interior, 'interior', resistencia);
  const raiz = agregar({ id: 'banco-led', nombre: 'Banco jerárquico LED', tipo: 'compuesto', puertos: [],
    instancias: [{ id: 'fuente', definicion: referencia(fuente), parametros: {} },
      { id: 'driver', definicion: referencia(driver), parametros: {} },
      { id: 'limite', definicion: referencia(resistencia), parametros: { ohms: 330 } },
      { id: 'led', definicion: referencia(led), parametros: {} }],
    conexiones: [
      { id: 'alimentacion', terminales: [hijo('fuente', 'V'), hijo('driver', '1')] },
      { id: 'salida', terminales: [hijo('driver', '2'), hijo('limite', '1')] },
      { id: 'anodo', terminales: [hijo('limite', '2'), hijo('led', 'IN')] },
      { id: 'retorno', terminales: [hijo('fuente', 'GND'), hijo('led', 'GND')] },
    ],
  });
  comprobar();
  const rutaFuncional = ['driver', 'interior', 'resistencia'];
  const sim = new SimulacionTemporalComponentes(new CatalogoComponentes(definiciones), referencia(raiz), paquetes, {
    representaciones: [{ ruta: ['driver'], seleccion: s.representacion === 'completa' ? 'interno' : { electrico: 'equivalente', funcional: 'interno' } }],
    acoplamientos: s.representacion === 'completa' ? [] : [{ origen: { ruta: rutaFuncional, parametro: 'ohms' }, destino: { ruta: ['driver', 'equivalente'], parametro: 'ohms' } }],
    crearModelo: i => {
      const esDriver = JSON.stringify(i.ruta) === JSON.stringify(rutaFuncional), esFuente = i.ruta.length === 1 && i.ruta[0] === 'fuente';
      if (!esDriver && !esFuente) return undefined;
      return {
        iniciar(ctx) {
          const estado = estadoBanco(s, 0);
          ctx.ponerParametro(esDriver ? 'ohms' : 'voltage', esDriver ? estado.ohms : estado.alimentacion ? 3.3 : 0);
          const instantes = new Set(s.cambios.slice(1).map(c => c.instanteMs));
          if (esDriver) for (let t = 250; t <= s.hastaMs; t += 250) instantes.add(t);
          for (const t of [...instantes].sort((a, b) => a - b)) ctx.programarEn(BigInt(t) * PS_POR_MS, 'actualizar', undefined, 'entrada');
        },
        evento(ctx) {
          const estado = estadoBanco(s, Number(ctx.ahoraPs / PS_POR_MS));
          ctx.ponerParametro(esDriver ? 'ohms' : 'voltage', esDriver ? estado.ohms : estado.alimentacion ? 3.3 : 0);
        },
      };
    },
  });
  try {
    const muestras: ResultadoBancoComponentes['muestras'] = [], avisos = new Set<string>();
    const instantes = new Set([0, s.hastaMs, ...s.cambios.map(c => c.instanteMs)]);
    for (let t = 250; t <= s.hastaMs; t += 250) instantes.add(t);
    for (const t of [...instantes].sort((a, b) => a - b)) {
      comprobar(); await sim.avanzarHasta(BigInt(t) * PS_POR_MS); comprobar();
      const dc = sim.resultado?.dc;
      if (!dc?.resuelto) throw new Error('Banco sin solución eléctrica válida');
      const tension = (ruta: string, p: string) => {
        const v = dc.tensiones.find(t => t.ruta.join('/') === ruta && t.puerto === p)?.voltios;
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Terminal sin tensión: ${ruta}/${p}`);
        return v;
      };
      const diodo = dc.elementos.find(e => e.ruta.join('/') === 'led' && e.local === 'led');
      if (!diodo || !Number.isFinite(diodo.i)) throw new Error('LED sin corriente resuelta');
      const estado = estadoBanco(s, t);
      muestras.push({ instanteMs: t, alimentacion: estado.alimentacion, reset: estado.reset, estado: estado.estado,
        fuenteV: tension('fuente', 'V') - tension('fuente', 'GND'),
        salidaV: tension('driver', '2') - tension('fuente', 'GND'),
        ledV: tension('led', 'IN') - tension('led', 'GND'), corrienteMa: diodo.i * 1000, ledEncendido: diodo.i * 1000 > 0.5 });
      for (const d of dc.diagnosticos) avisos.add(d.mensaje);
    }
    return ResultadoBancoComponentesSchema.parse({ motor: 'componentes-propios', muestras, avisos: [...avisos],
      instancias: sim.grafoActual.instancias.map(i => ({ ruta: i.ruta, tipo: i.tipo, dominios: i.dominiosActivos ?? ['electrico', 'funcional'] })),
    });
  } catch (error) {
    const fallo = sim.ultimoFallo;
    const diagnosticos = fallo?.dc?.diagnosticos.map(d => d.mensaje).join('; ');
    throw new Error(diagnosticos || (error instanceof Error ? error.message : String(error)));
  } finally { sim.detener(); }
}
