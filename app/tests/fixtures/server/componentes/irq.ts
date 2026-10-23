import { circuitoDigital } from './digital.js';
import { hijo, externo, referencia } from './divisor.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import type { DefinicionComponente } from '../../../../shared/src/componentes/contratos.js';

/** Dos capas de interfaz, dos copias y fan-out; el paquete físico conserva sus cinco pines. */
export async function circuitoIrq() {
  const c = await circuitoDigital();
  const bloque = c.definiciones.find(d => d.id === 'bloque');
  if (!bloque || bloque.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
  const puertos = [
    { id: 'IRQ_OUT', dominio: 'interrupcion' as const, direccion: 'salida' as const, ancho: 1 },
    { id: 'IRQ_IN', dominio: 'interrupcion' as const, direccion: 'entrada' as const, ancho: 1 },
  ];
  c.digital.puertos.push(...puertos);
  bloque.puertos.push(...puertos);
  const chip = bloque.instancias[0]; if (!chip) throw new Error('fixture');
  chip.definicion = referencia(c.digital);
  for (const p of puertos) bloque.conexiones.push({ id: p.id === 'IRQ_OUT' ? 'irq-out' : 'irq-in', terminales: [externo(p.id), hijo('chip', p.id)] });
  const envoltura: Extract<DefinicionComponente, { tipo: 'compuesto' }> = { ...structuredClone(bloque), id: 'envoltura', nombre: 'Segunda capa',
    instancias: [{ id: 'interior', definicion: referencia(bloque), parametros: {} }],
    conexiones: bloque.puertos.map((p, i) => ({ id: `puerto-${i}`, terminales: [externo(p.id), hijo('interior', p.id)] })),
  };
  for (const i of c.raiz.instancias) if (i.id === 'a' || i.id === 'b') i.definicion = referencia(envoltura);
  c.raiz.conexiones.push({ id: 'irq', terminales: [hijo('a', 'IRQ_OUT'), hijo('a', 'IRQ_IN'), hijo('b', 'IRQ_IN')] });
  c.definiciones.push(envoltura);
  return { ...c, envoltura, referencia: referencia(c.raiz), catalogo: new CatalogoComponentes(c.definiciones) };
}
