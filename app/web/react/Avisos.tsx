import { useState } from 'react';
import { useEstado } from './estado.js';
import { estado } from './puente.js';

/** Cuántos avisos se muestran cuando el panel está desplegado. */
const TOPE = 6;

/**
 * Los avisos del dibujo (`#avisos-dibujo`): lo que el server encontró en el circuito —un pin que
 * el código usa y no está cableado, un LED sobreexigido, un cortocircuito—.
 *
 * Primer panel migrado a React (#9). Compacto por defecto, una línea más "+N más", para que el
 * circuito no pierda lugar; se despliega al tocarlo. Conserva el `id`, las clases y el
 * `data-mas` que esperan el CSS y los e2e.
 */
export function Avisos() {
  const avisos = useEstado(() => estado().avisosDibujo);
  const [abiertos, setAbiertos] = useState(false);
  const lista = avisos ?? [];
  // Sin avisos no hay nada que desplegar: como antes, el panel se cierra solo.
  const desplegado = abiertos && lista.length > 0;

  return (
    <div
      id="avisos-dibujo"
      className={`avisos${desplegado ? ' abiertos' : ''}`}
      data-mas={lista.length > 1 ? `+${lista.length - 1} más` : ''}
      onClick={() => setAbiertos((a) => !a)}
    >
      {lista.slice(0, TOPE).map((w, i) => (
        <div key={`${w.pin}-${i}-${w.message}`} data-pin={String(w.pin)}>{w.message}</div>
      ))}
    </div>
  );
}
