import { useLayoutEffect, useRef } from 'react';
import { miniatura } from '../modulos.js';

/**
 * El dibujo chico de un módulo en el catálogo.
 *
 * `miniatura()` construye un `<svg>` nodo por nodo —reusa `dibujarModulo`, el mismo código que
 * pinta el circuito— así que no se puede expresar como JSX sin duplicarlo. Se inserta con un ref,
 * que es la salida prevista de React para este caso. El `def` de un módulo no cambia mientras la
 * app vive, así que se dibuja una sola vez.
 */
export function Miniatura({ def }: { def: any }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const nodo = ref.current;
    if (!nodo) return;
    nodo.replaceChildren(miniatura(def));
  }, [def]);

  return <span ref={ref} className="miniatura-wrap" />;
}
