/** Cómo se muestran las magnitudes eléctricas en la UI. Puro, lo usan app.ts y los componentes. */

export const fmtV = (v: number) => `${v.toFixed(2)} V`;

/** Con un decimal por debajo de 10 mA (ahí importa), sin decimales arriba. `null` = sin dato. */
export const fmtMa = (ma: number | null) => (ma === null ? '—' : `${ma.toFixed(ma < 10 ? 1 : 0)} mA`);

/** Resistencia en la escala legible, preservando precisión para valores pequeños. */
export const fmtOhm = (ohm: number | null) => {
  if (ohm === null) return '—';
  if (Math.abs(ohm) >= 1_000_000) return `${(ohm / 1_000_000).toFixed(2)} MΩ`;
  if (Math.abs(ohm) >= 1_000) return `${(ohm / 1_000).toFixed(2)} kΩ`;
  return `${ohm.toFixed(ohm < 10 ? 2 : 0)} Ω`;
};

export const fmtMw = (mw: number) => Math.abs(mw) >= 1000 ? `${(mw / 1000).toFixed(2)} W` : `${mw.toFixed(Math.abs(mw) < 10 ? 2 : 0)} mW`;
