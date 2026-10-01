import { useLayoutEffect, useRef } from 'react';
import { crearLienzo } from '../canvas.js';
import { entregarLienzo, tomarCtx } from './puente.js';

/**
 * El canvas del circuito, montado por React pero manejado por `canvas.ts` como siempre (#9).
 *
 * React solo rinde el `<svg>` y lo crea una única vez: todo lo que pasa adentro —los nodos del
 * dibujo, el drag, los cables, el zoom— lo sigue haciendo `canvas.ts` de forma imperativa. No
 * está envuelto en estado de React a propósito: el dibujo se actualiza decenas de veces por
 * segundo (los niveles de pin del firmware) y meter eso en el ciclo de render del framework
 * tiraría abajo el trabajo de #13.
 *
 * `useLayoutEffect` y no `useEffect` porque `app.ts` necesita el lienzo ya creado en cuanto
 * termina de montar (ver `montarReact`): con el efecto diferido, lo primero que dibuja la app
 * se perdería.
 */
export function Lienzo() {
  const ref = useRef<SVGSVGElement>(null);
  const creado = useRef(false);

  useLayoutEffect(() => {
    if (creado.current || !ref.current) return;
    creado.current = true; // en React 19 con StrictMode el efecto corre dos veces
    entregarLienzo(crearLienzo(ref.current, tomarCtx()));
  }, []);

  return <svg id="lienzo" ref={ref} xmlns="http://www.w3.org/2000/svg" data-react="lienzo" />;
}
