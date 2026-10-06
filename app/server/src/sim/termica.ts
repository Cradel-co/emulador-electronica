/**
 * Un cuerpo isotermo: C·dT/dt = P − (T−Ta)/R, con ambiente fijo.
 * Solución exacta para P lineal entre muestras; no hay realimentación eléctrica,
 * radiación explícita ni acoplamiento entre cuerpos. Parámetros constantes declarados,
 * no propiedades inferidas del nombre del componente ni de theta-JA genérica.
 * Referencias y dominio: docs/ANALISIS-TEMPORAL-Y-EVIDENCIA.md.
 */
export interface ModeloTermicoRc {
  id: string;
  fuente: string;
  condiciones: string;
  resistenciaKPorW: number;
  capacidadJPorK: number;
  ambienteC: number;
  /** Temperatura en el instante de la primera muestra, no antes. */
  inicialC: number;
  rangoDeclaradoC: [number, number];
}

export interface ResultadoTermicoRc {
  perfil: 'termico-rc-unidireccional';
  caracterizadoEnLaboratorio: false;
  modelo: ModeloTermicoRc;
  inicioS: number;
  temperaturaC: number[];
  energiaDisipadaJ: number;
  energiaAlmacenadaDeltaJ: number;
  /** Integral del flujo (T−Ta)/R; negativa si el ambiente aporta calor. */
  energiaEvacuadaJ: number;
}

export function calcularTermicaRc(
  modelo: ModeloTermicoRc, tiempoS: readonly number[], potenciaDisipadaW: readonly number[],
): ResultadoTermicoRc {
  for (const campo of ['id', 'fuente', 'condiciones'] as const) {
    if (typeof modelo[campo] !== 'string' || !modelo[campo].trim() || modelo[campo].length > 2000) {
      throw new Error(`El modelo térmico necesita ${campo} explícito (hasta 2000 caracteres).`);
    }
  }
  const { resistenciaKPorW: r, capacidadJPorK: c, ambienteC: ta, inicialC: t0, rangoDeclaradoC: rango } = modelo;
  if (![r, c, r * c, ta, t0].every(Number.isFinite) || r <= 0 || c <= 0 || r * c <= 0 || ta < -273.15 || t0 < -273.15) {
    throw new Error('Parámetros térmicos inválidos: R y C deben ser positivos y finitos; temperatura sobre cero absoluto.');
  }
  if (!Array.isArray(rango) || rango.length !== 2 || !rango.every(Number.isFinite) || rango[0] < -273.15 || rango[0] >= rango[1]) {
    throw new Error('El modelo térmico necesita un rango de temperatura declarado válido.');
  }
  const enDominio = (t: number): number => {
    if (!Number.isFinite(t) || t < rango[0] || t > rango[1]) throw new Error('Resultado térmico fuera del dominio declarado.');
    return t;
  };
  enDominio(ta);
  enDominio(t0);
  if (tiempoS.length < 2 || tiempoS.length > 50000 || tiempoS.length !== potenciaDisipadaW.length) {
    throw new Error('La traza térmica necesita entre 2 y 50000 muestras de tiempo y potencia emparejadas.');
  }
  const muestras: { t: number; p: number }[] = [];
  let tiempoAnterior = -1;
  for (let i = 0; i < tiempoS.length; i++) {
    const t = tiempoS[i], p = potenciaDisipadaW[i];
    if (t === undefined || !Number.isFinite(t) || t < 0 || t <= tiempoAnterior) {
      throw new Error('El tiempo térmico debe ser finito, no negativo y estrictamente creciente.');
    }
    if (p === undefined || !Number.isFinite(p) || p < 0) throw new Error('La potencia disipada debe ser finita y no negativa.');
    muestras.push({ t, p });
    tiempoAnterior = t;
  }
  const primera = muestras[0];
  if (primera === undefined) throw new Error('Falta la muestra térmica inicial.');
  let anterior = primera;
  const tau = r * c;
  const temperaturaC = [t0];
  let theta = t0 - ta, energiaDisipadaJ = 0;
  for (const [i, muestra] of muestras.entries()) {
    if (i === 0) continue;
    const dt = muestra.t - anterior.t;
    const x = dt / tau;
    const f = -Math.expm1(-x);
    // g = 1 − (1−exp(−x))/x; serie evita cancelación al dividir pasos muy pequeños.
    const g = x < 1e-4 ? x / 2 - x * x / 6 + x * x * x / 24 : 1 - f / x;
    const p0 = anterior.p, p1 = muestra.p;
    theta += (r * p0 - theta) * f + r * (p1 - p0) * g;
    temperaturaC.push(enDominio(ta + theta));
    energiaDisipadaJ += (p0 / 2 + p1 / 2) * dt;
    anterior = muestra;
  }
  const energiaAlmacenadaDeltaJ = c * (theta - (t0 - ta));
  // Balance integrado del mismo modelo, no una segunda evidencia independiente.
  const energiaEvacuadaJ = energiaDisipadaJ - energiaAlmacenadaDeltaJ;
  if (![energiaDisipadaJ, energiaAlmacenadaDeltaJ, energiaEvacuadaJ].every(Number.isFinite)) {
    throw new Error('La energía térmica no es finita.');
  }
  return {
    perfil: 'termico-rc-unidireccional', caracterizadoEnLaboratorio: false,
    modelo: structuredClone(modelo), inicioS: primera.t, temperaturaC,
    energiaDisipadaJ, energiaAlmacenadaDeltaJ, energiaEvacuadaJ,
  };
}
