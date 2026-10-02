/** Cómo se muestran las magnitudes eléctricas en la UI. Puro, lo usan app.ts y los componentes. */

export const fmtV = (v: number) => `${v.toFixed(2)} V`;

/** Con un decimal por debajo de 10 mA (ahí importa), sin decimales arriba. `null` = sin dato. */
export const fmtMa = (ma: number | null) => (ma === null ? '—' : `${ma.toFixed(ma < 10 ? 1 : 0)} mA`);
