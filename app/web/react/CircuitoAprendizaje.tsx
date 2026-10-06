import { useId } from 'react';
import { ejemploPorId, formatoMagnitud, prediccionCircuito, type EjemploId } from '../aprendizaje/ejemplos.js';

/** Esquema didáctico con los mismos IDs y valores que la copia del emulador. */
export function CircuitoAprendizaje({ ejemplo = 'ohm' }: { ejemplo?: EjemploId }) {
  const circuito = ejemploPorId(ejemplo);
  const id = useId();
  if (!circuito) return <p role="alert">No encontramos el ejemplo de circuito.</p>;
  const prediccion = prediccionCircuito(circuito);
  const paralelo = circuito.topologia === 'paralelo';
  const divisor = circuito.topologia === 'divisor';
  const serie = circuito.topologia === 'serie';
  const abierta = paralelo && circuito.ramaAbierta;
  const tieneCarga = divisor && Boolean(circuito.r3);
  const resistencia = (valor: number) => formatoMagnitud(valor / 1000, 'kΩ');
  const corriente = (indice: number) => formatoMagnitud((prediccion.corrientes[indice] ?? 0) * 1000, 'mA');
  const flecha = (x: number, y: number, vertical = false) => <path d={vertical ? `M${x} ${y}v25m-5-5 5 5 5-5` : `M${x} ${y}h35m-5-5 5 5-5 5`} className="mdx-corriente" />;
  return <figure className="mdx-circuito" data-ejemplo={ejemplo}><svg viewBox="0 0 640 340" role="img" aria-labelledby={`${id}-titulo ${id}-descripcion`}>
    <title id={`${id}-titulo`}>{circuito.titulo}</title><desc id={`${id}-descripcion`}>Fuente de {circuito.tension} V, nodo A positivo, referencia GND abajo. {abierta ? 'La rama R2 está abierta en su extremo superior.' : `Resistencias en ${circuito.topologia}.`} Las flechas indican corriente convencional y las etiquetas muestran predicciones ideales.</desc>
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <circle cx="75" cy="170" r="28" /><path d={`M66 160h18m-9-9v18m-9 16h18M75 142V65h85M75 198v90h${divisor && !tieneCarga ? 285 : 485}`} />
      {paralelo ? <><path d="M160 65h400M340 65v70m0 70v83M560 205v83" /><rect x="328" y="135" width="24" height="70" /><rect x="548" y="135" width="24" height="70" />{abierta ? <><path d="M560 65v20m0 35v15m0-50 18 29" /><circle cx="560" cy="85" r="3" /><circle cx="560" cy="120" r="3" /></> : <path d="M560 65v70" />}</> : <><path d="M160 65h35m85 0h80" /><rect x="195" y="53" width="85" height="24" />{serie ? <><path d="M360 65h25m85 0h90v223" /><rect x="385" y="53" width="85" height="24" /></> : divisor ? <><path d="M360 65v70m0 70v83" /><rect x="348" y="135" width="24" height="70" />{tieneCarga && <><path d="M360 65h200v70m0 70v83" /><rect x="548" y="135" width="24" height="70" /></>}</> : <path d="M360 65h200v223" />}</>}
      <path d="M75 288v12m-15 0h30m-23 6h16m-12 6h8" />
      {flecha(120, 36)}{(paralelo || divisor) && flecha(paralelo ? 300 : 320, 142, true)}{tieneCarga && flecha(520, 142, true)}{paralelo && !abierta && flecha(520, 142, true)}
    </g>
    <g fill="currentColor" fontSize="15" fontFamily="inherit">
      <text x="15" y="224">{formatoMagnitud(circuito.tension, 'V')}</text><text x="12" y="245">fuente1</text><text x="90" y="320">GND · 0 V</text>
      <text x="110" y="22">I = {formatoMagnitud(prediccion.iFuente * 1000, 'mA')}</text>
      <circle cx="160" cy="65" r="4" /><text x="155" y="92">A</text>
      {paralelo ? <><text x="272" y="235">R1 · {resistencia(circuito.r1)}</text><text x="287" y="258">I1 = {corriente(0)}</text><text x="488" y="235">R2 · {resistencia(circuito.r2)}</text><text x="503" y="258">I2 = {corriente(1)}</text>{abierta && <text x="590" y="102" textAnchor="end">abierta</text>}</> : <><text x="195" y="112">R1 · {resistencia(circuito.r1)}</text><text x="195" y="134">ΔV = {formatoMagnitud(prediccion.caidas[0] ?? 0, 'V')}</text>{serie && <><circle cx="350" cy="65" r="4" /><text x="343" y="92">B · {formatoMagnitud(prediccion.caidas[1] ?? 0, 'V')}</text><text x="385" y="112">R2 · {resistencia(circuito.r2)}</text><text x="385" y="134">ΔV = {formatoMagnitud(prediccion.caidas[1] ?? 0, 'V')}</text></>}{divisor && <><circle cx="360" cy="65" r="4" /><text x="375" y="47">B · {formatoMagnitud(prediccion.caidas[1] ?? 0, 'V')}</text><text x="292" y="235">R2 · {resistencia(circuito.r2)}</text><text x="310" y="258">I2 = {corriente(1)}</text>{tieneCarga && <><text x="488" y="235">R3 · {resistencia(circuito.r3 ?? 0)}</text><text x="503" y="258">I3 = {corriente(2)}</text></>}</>}</>}
    </g>
  </svg><figcaption>{circuito.titulo}. Predicciones para el circuito ideal energizado. GND es la referencia de tensión; las flechas indican el sentido convencional de la corriente.</figcaption></figure>;
}
