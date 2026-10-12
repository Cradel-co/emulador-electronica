import type { RespuestaAc } from '@emu/shared';
import { trazaFisica } from '../analisis-fisico.js';
export function BodeAc({ resultado }: { resultado: RespuestaAc }) {
  const log = resultado.frecuenciaHz.map(Math.log10);
  return <div className="bode-ac">{([
    ['Ganancia', 'dB', resultado.gananciaDb], ['Fase', '°', resultado.faseGrados],
  ] as const).map(([nombre, unidad, valores]) => {
    const traza = trazaFisica(log, valores);
    return <figure key={nombre}><figcaption>{nombre} · salida/entrada ({unidad})</figcaption>
      <svg viewBox="0 0 640 265" role="img" aria-label={`Bode: ${nombre} en ${unidad}`}>
        <path d="M95,30 V220 H620" fill="none" stroke="currentColor"/>
        <text x="90" textAnchor="end" y="25">{traza.max.toPrecision(4)} {unidad}</text><text x="90" textAnchor="end" y="220">{traza.min.toPrecision(4)}</text>
        {[0, 0.25, 0.5, 0.75, 1].map(fraccion => <g key={fraccion}>
          <path d={`M${95 + 525 * fraccion},220 v5`} stroke="currentColor"/>
          <text x={95 + 525 * fraccion} textAnchor={fraccion === 0 ? 'start' : fraccion === 1 ? 'end' : 'middle'} y="247">{(10 ** (traza.inicio + (traza.fin - traza.inicio) * fraccion)).toPrecision(3)}</text>
        </g>)}
        <path data-testid={`bode-${nombre === 'Ganancia' ? 'ganancia' : 'fase'}`} d={traza.path} fill="none" stroke="#35c798" strokeWidth="2"/>
      </svg></figure>;
  })}<p>Frecuencia en Hz · escala logarítmica. Fase principal entre −180° y 180°. Los huecos indican transferencia nula.</p>
    <p>{resultado.frecuenciaHz.length} frecuencias. La descarga conserva todos los fasores y las curvas.</p>
  </div>;
}
