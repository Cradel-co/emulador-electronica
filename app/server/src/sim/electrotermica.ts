import { calcularTermicaRc, type ModeloTermicoRc } from './termica.js';

/** Fuentes primarias: COMSOL, ecuación linealizada y acoplamiento bidireccional.
 * https://doc.comsol.com/6.3/doc/com.comsol.help.models.mems.microresistor_beam/microresistor_beam.html
 * https://www.comsol.com/support/learning-center/article/Setting-Up-and-Solving-Electromagnetic-Heating-Problems-with-High-Frequency-Loads-46881
 * No se toman de estas fuentes coeficientes universales ni parámetros de una pieza concreta.
 */
export interface ModeloResistenciaElectrotermica {
  resistenciaReferenciaOhm: number;
  temperaturaReferenciaC: number;
  coeficientePorK: number;
  dominioElectrico: { tensionMaxAbsV: number; corrienteMaxAbsA: number; potenciaMaxW: number };
  termica: ModeloTermicoRc;
}
export interface ParametrosElectrotermicos {
  duracionS: number; pasoInicialS: number; pasoMinimoS: number; pasoMaximoS: number; toleranciaC: number;
}
export type ResolverElectrotermica = (resistencias: ReadonlyMap<string, number>) => Promise<ReadonlyMap<string, { v: number; i: number; p: number }>>;
export const MAX_MODELOS_ELECTROTERMICOS = 8;
export const MAX_EVALUACIONES_ELECTROTERMICAS = 256;
export const MAX_PASOS_ELECTROTERMICOS = 256;
export const MAX_PLAZO_ELECTROTERMICO_MS = 20_000;

export interface SerieElectrotermica {
  modelo: ModeloResistenciaElectrotermica;
  temperaturaC: number[]; resistenciaOhm: number[]; v: number[]; i: number[]; p: number[];
  energiaDisipadaJ: number; energiaEvacuadaJ: number; energiaAlmacenadaDeltaJ: number; residuoEnergiaJ: number;
}
export interface ResultadoElectrotermico {
  perfil: 'electrotermico-rc-cuasiestatico';
  caracterizadoEnLaboratorio: false;
  t: number[];
  elementos: Record<string, SerieElectrotermica>;
  estadisticas: { evaluacionesElectricas: number; pasosAceptados: number; pasosRechazados: number; errorLocalMaxEstimadoC: number };
  advertencias: string[];
}

export function resistenciaATemperatura(m: ModeloResistenciaElectrotermica, temperaturaC: number): number {
  const [min, max] = m.termica.rangoDeclaradoC;
  if (!Number.isFinite(temperaturaC) || temperaturaC < min || temperaturaC > max) throw new Error('Temperatura fuera del dominio electro térmico declarado.');
  const r = m.resistenciaReferenciaOhm * (1 + m.coeficientePorK * (temperaturaC - m.temperaturaReferenciaC));
  if (!Number.isFinite(r) || r <= 0) throw new Error('R(T) debe ser finita y positiva en el dominio declarado.');
  return r;
}

/** Se usa también antes de cargar el proyecto en la ruta pública. */
export function validarElectrotermica(modelos: Record<string, ModeloResistenciaElectrotermica>, p: ParametrosElectrotermicos): void {
  const entradas = Object.entries(modelos);
  if (entradas.length < 1 || entradas.length > MAX_MODELOS_ELECTROTERMICOS) throw new Error('El acoplamiento admite entre 1 y 8 resistencias térmicas.');
  if (![p.duracionS, p.pasoInicialS, p.pasoMinimoS, p.pasoMaximoS, p.toleranciaC].every(v => Number.isFinite(v) && v > 0)
    || p.pasoMinimoS > p.pasoInicialS || p.pasoInicialS > p.pasoMaximoS || p.pasoMaximoS > p.duracionS
    || p.duracionS / p.pasoMaximoS > MAX_PASOS_ELECTROTERMICOS) throw new Error('Pasos, duración o tolerancia electro térmica fuera de límites.');
  for (const [id, m] of entradas) {
    if (!id || id.length > 200) throw new Error('Identificador electro térmico inválido.');
    if (![m.resistenciaReferenciaOhm, m.temperaturaReferenciaC, m.coeficientePorK].every(Number.isFinite) || m.resistenciaReferenciaOhm <= 0) throw new Error('Rref, Tref y coeficiente deben ser explícitos y finitos; Rref positiva.');
    // Reusa las validaciones del cuerpo RC: fuente, montaje, temperaturas y rango declarados.
    calcularTermicaRc(m.termica, [0, 1], [0, 0]);
    resistenciaATemperatura(m, m.temperaturaReferenciaC);
    for (const t of m.termica.rangoDeclaradoC) resistenciaATemperatura(m, t);
    const d = m.dominioElectrico;
    if (![d.tensionMaxAbsV, d.corrienteMaxAbsA, d.potenciaMaxW].every(v => Number.isFinite(v) && v > 0)) throw new Error('El dominio eléctrico necesita límites positivos y finitos.');
  }
}

const requerido = <T>(mapa: ReadonlyMap<string, T>, id: string): T => {
  const valor = mapa.get(id);
  if (valor === undefined) throw new Error(`Falta la medida electro térmica de ${id}.`);
  return valor;
};
interface Etapa {
  temperaturas: Map<string, number>;
  resistencias: Map<string, number>;
  electricas: Awaited<ReturnType<ResolverElectrotermica>>;
  derivadas: Map<string, number>;
  evacuadas: Map<string, number>;
}

/**
 * C dT/dt = I²R(T) − (T−Ta)/Rth. RK2 de punto medio: compara un paso con dos
 * medios pasos y acepta estos últimos. El estimador local es |T2−T1|/3, no una
 * garantía del error global ni de exactitud del componente. Cada etapa recalcula
 * la red eléctrica. Los flujos de energía usan las mismas etapas, no se infieren
 * restando la energía almacenada. No hay radiación ni intercambio entre cuerpos.
 */
export async function integrarElectrotermica(
  modelosEntrada: Record<string, ModeloResistenciaElectrotermica>, parametrosEntrada: ParametrosElectrotermicos,
  resolver: ResolverElectrotermica, ahora: () => number = () => performance.now(), inicioPlazoMs = ahora(),
): Promise<ResultadoElectrotermico> {
  const modelos = structuredClone(modelosEntrada), parametros = { ...parametrosEntrada };
  validarElectrotermica(modelos, parametros);
  const inicio = inicioPlazoMs;
  const entradas = Object.entries(modelos);
  const estadisticas = { evaluacionesElectricas: 0, pasosAceptados: 0, pasosRechazados: 0, errorLocalMaxEstimadoC: 0 };
  const verificarPlazo = (): void => { if (ahora() - inicio >= MAX_PLAZO_ELECTROTERMICO_MS) throw new Error('Se excedió el plazo total electro térmico de 20 segundos.'); };
  const resolverDentroDelPlazo = async (resistencias: ReadonlyMap<string, number>): ReturnType<ResolverElectrotermica> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Como máximo queda una operación ya enviada al worker; no se programan más etapas.
      // El worker conserva su propio límite y la cola acotada compartida con DC.
      const vencimiento = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Se excedió el plazo total electro térmico de 20 segundos.')), Math.max(1, MAX_PLAZO_ELECTROTERMICO_MS - (ahora() - inicio))); });
      return await Promise.race([resolver(resistencias), vencimiento]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const evaluar = async (temperaturas: Map<string, number>): Promise<Etapa> => {
    verificarPlazo();
    if (estadisticas.evaluacionesElectricas >= MAX_EVALUACIONES_ELECTROTERMICAS) throw new Error('Se excedió el presupuesto de 256 evaluaciones eléctricas.');
    const resistencias = new Map(entradas.map(([id, m]) => [id, resistenciaATemperatura(m, requerido(temperaturas, id))]));
    estadisticas.evaluacionesElectricas++;
    const electricas = await resolverDentroDelPlazo(resistencias);
    verificarPlazo();
    const derivadas = new Map<string, number>(), evacuadas = new Map<string, number>();
    for (const [id, m] of entradas) {
      const e = requerido(electricas, id), r = requerido(resistencias, id), d = m.dominioElectrico;
      if (![e.v, e.i, e.p].every(Number.isFinite) || e.p < 0) throw new Error(`Medición eléctrica inválida o disipación negativa en ${id}.`);
      if (Math.abs(e.v) > d.tensionMaxAbsV || Math.abs(e.i) > d.corrienteMaxAbsA || e.p > d.potenciaMaxW) throw new Error(`Operación fuera del dominio eléctrico de ${id}.`);
      if (Math.abs(e.v - e.i * r) > 1e-9 + 1e-6 * Math.abs(e.v) || Math.abs(e.p - e.v * e.i) > 1e-12 + 1e-6 * e.p) throw new Error(`Medición inconsistente con R(T) y Joule en ${id}.`);
      const q = (requerido(temperaturas, id) - m.termica.ambienteC) / m.termica.resistenciaKPorW;
      const dt = (e.p - q) / m.termica.capacidadJPorK;
      if (!Number.isFinite(q) || !Number.isFinite(dt)) throw new Error('Flujo o derivada térmica no finitos.');
      derivadas.set(id, dt); evacuadas.set(id, q);
    }
    return { temperaturas, resistencias, electricas, derivadas, evacuadas };
  };
  const avanzar = (base: Etapa, derivadas: ReadonlyMap<string, number>, dt: number): Map<string, number> => new Map(
    entradas.map(([id]) => [id, requerido(base.temperaturas, id) + dt * requerido(derivadas, id)]),
  );
  const paso = async (base: Etapa, dt: number): Promise<{ temperaturas: Map<string, number>; media: Etapa }> => {
    const media = await evaluar(avanzar(base, base.derivadas, dt / 2));
    return { temperaturas: avanzar(base, media.derivadas, dt), media };
  };
  let etapa = await evaluar(new Map(entradas.map(([id, m]) => [id, m.termica.inicialC])));
  const t = [0];
  const elementos: Record<string, SerieElectrotermica> = Object.fromEntries(entradas.map(([id, modelo]) => {
    const e = requerido(etapa.electricas, id);
    return [id, { modelo, temperaturaC: [modelo.termica.inicialC], resistenciaOhm: [requerido(etapa.resistencias, id)], v: [e.v], i: [e.i], p: [e.p], energiaDisipadaJ: 0, energiaEvacuadaJ: 0, energiaAlmacenadaDeltaJ: 0, residuoEnergiaJ: 0 }];
  }));
  let tiempo = 0, dt = parametros.pasoInicialS;
  while (tiempo < parametros.duracionS) {
    verificarPlazo();
    if (estadisticas.pasosAceptados >= MAX_PASOS_ELECTROTERMICOS) throw new Error('Se excedió el presupuesto de pasos electro térmicos.');
    dt = Math.min(dt, parametros.duracionS - tiempo);
    if (tiempo + dt <= tiempo) throw new Error('El paso no permite avanzar el tiempo electro térmico.');
    const completo = await paso(etapa, dt), mitad = await paso(etapa, dt / 2);
    const intermedia = await evaluar(mitad.temperaturas), fina = await paso(intermedia, dt / 2);
    let error = 0;
    for (const [id] of entradas) error = Math.max(error, Math.abs(requerido(fina.temperaturas, id) - requerido(completo.temperaturas, id)) / 3);
    if (!Number.isFinite(error)) throw new Error('Error de integración no finito.');
    const factor = error === 0 ? 2 : Math.max(0.2, Math.min(2, 0.9 * (parametros.toleranciaC / error) ** (1 / 3)));
    if (error > parametros.toleranciaC) {
      estadisticas.pasosRechazados++;
      if (dt <= parametros.pasoMinimoS) throw new Error('Sin convergencia térmica dentro del paso mínimo declarado.');
      dt = Math.max(parametros.pasoMinimoS, dt * Math.min(0.9, factor));
      continue;
    }
    etapa = await evaluar(fina.temperaturas);
    tiempo += dt;
    t.push(tiempo);
    estadisticas.pasosAceptados++;
    estadisticas.errorLocalMaxEstimadoC = Math.max(estadisticas.errorLocalMaxEstimadoC, error);
    for (const [id, m] of entradas) {
      const serie = elementos[id];
      if (!serie) throw new Error(`Falta serie de ${id}.`);
      const e = requerido(etapa.electricas, id), temperatura = requerido(etapa.temperaturas, id);
      serie.temperaturaC.push(temperatura); serie.resistenciaOhm.push(requerido(etapa.resistencias, id));
      serie.v.push(e.v); serie.i.push(e.i); serie.p.push(e.p);
      serie.energiaDisipadaJ += dt / 2 * (requerido(mitad.media.electricas, id).p + requerido(fina.media.electricas, id).p);
      serie.energiaEvacuadaJ += dt / 2 * (requerido(mitad.media.evacuadas, id) + requerido(fina.media.evacuadas, id));
      serie.energiaAlmacenadaDeltaJ = m.termica.capacidadJPorK * (temperatura - m.termica.inicialC);
      serie.residuoEnergiaJ = serie.energiaDisipadaJ - serie.energiaEvacuadaJ - serie.energiaAlmacenadaDeltaJ;
      if (![serie.energiaDisipadaJ, serie.energiaEvacuadaJ, serie.energiaAlmacenadaDeltaJ, serie.residuoEnergiaJ].every(Number.isFinite)
        || Math.abs(serie.residuoEnergiaJ) > 1e-9 + 1e-9 * (Math.abs(serie.energiaDisipadaJ) + Math.abs(serie.energiaEvacuadaJ))) throw new Error(`Balance de energía térmica fuera de tolerancia en ${id}.`);
    }
    dt = Math.min(parametros.pasoMaximoS, Math.max(parametros.pasoMinimoS, dt * factor));
  }
  return { perfil: 'electrotermico-rc-cuasiestatico', caracterizadoEnLaboratorio: false, t, elementos, estadisticas,
    advertencias: [
      'La temperatura realimenta R(T) y ngspice recalcula la red eléctrica en cada etapa. Perfil cuasiestático: fuentes y controles fijos, sin dinámica eléctrica C/L ni firmware.',
      'R(T) lineal y un cuerpo térmico RC por resistencia dentro del dominio y montaje declarados; no incluye radiación ni intercambio entre cuerpos.',
      'Las resistencias sin modelo térmico mantienen su valor nominal. No se simulan eventos digitales ni reinicios por brownout.',
      'El error indicado es local de integración numérica; el balance de energía no constituye evidencia independiente ni caracterización de laboratorio. No se modela avería.',
    ] };
}
