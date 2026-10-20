import { DefinicionComponenteSchema, type DefinicionComponente } from '../../../../shared/src/componentes/contratos.js';
import { PaquetesComponentes } from '../../../../server/src/componentes/paquetes.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { divisor, doble, hijo, puerto, referencia, resistor } from './divisor.js';

export async function divisoresAlimentados(paquetes = new PaquetesComponentes(), envolver = false) {
  const r = resistor();
  if (r.tipo !== 'hoja-legada') throw new Error('fixture incorrecto');
  r.modulo.sha256 = (await paquetes.inspeccionar('resistor')).sha256;
  const d = divisor(r), dos = doble(d);
  const f = DefinicionComponenteSchema.parse({
    schemaVersion: 1, id: 'fuente', version: '1.0.0', nombre: 'Fuente', tipo: 'hoja-legada',
    modulo: { id: 'fuente-regulable', sha256: (await paquetes.inspeccionar('fuente-regulable')).sha256 },
    puertos: [puerto('V'), puerto('GND')],
    parametros: { voltage: { tipo: 'numero', default: 5, min: -12, max: 12, unidad: 'V' }, currentLimitMa: { tipo: 'numero', default: 1000, min: 1, max: 5000, unidad: 'mA' } },
  });
  if (dos.tipo !== 'compuesto') throw new Error('fixture incorrecto');
  dos.instancias.push({ id: 'fuente', definicion: referencia(f), parametros: {} });
  dos.conexiones.push(
    { id: 'vcc', terminales: [hijo('fuente', 'V'), hijo('izquierda', 'VIN'), hijo('derecha', 'VIN')] },
    { id: 'gnd', terminales: [hijo('fuente', 'GND'), hijo('izquierda', 'GND'), hijo('derecha', 'GND')] },
  );
  const definiciones: DefinicionComponente[] = [r, d, f, dos];
  let raiz: DefinicionComponente = dos;
  if (envolver) {
    raiz = DefinicionComponenteSchema.parse({ schemaVersion: 1, id: 'envoltura', version: '1.0.0', nombre: 'Caja', tipo: 'compuesto', puertos: [], instancias: [{ id: 'caja', definicion: referencia(dos), parametros: {} }], conexiones: [] });
    definiciones.push(raiz);
  }
  return { paquetes, definiciones, raiz, referencia: referencia(raiz), catalogo: new CatalogoComponentes(definiciones) };
}
