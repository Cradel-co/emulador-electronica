import { createRoot } from 'react-dom/client';
import { createElement, type FunctionComponent } from 'react';
import { flushSync } from 'react-dom';
import { Lienzo } from './Lienzo.js';
import { Avisos } from './Avisos.js';
import { Catalogo } from './Catalogo.js';
import { Proyectos } from './Proyectos.js';
import { PanelDerecho } from './PanelDerecho.js';

/**
 * Monta las islas de React sobre la UI de `app.ts` (#9).
 *
 * Son raíces separadas, una por pedazo migrado, en vez de un árbol único: así cada panel se puede
 * mover cuando le toque, sin reordenar el `index.html` ni envolver lo que todavía es imperativo.
 * A medida que avance la migración, las islas se van juntando.
 *
 * El montaje es sincrónico (`flushSync` + `useLayoutEffect` en `<Lienzo>`): al volver de acá el
 * lienzo ya existe y `app.ts` puede seguir con su arranque como siempre.
 */
const ISLAS: [string, FunctionComponent, boolean][] = [
  // [id del nodo, componente, si es obligatorio]
  ['react-lienzo', Lienzo, true],
  ['react-avisos', Avisos, false],
  ['react-catalogo', Catalogo, false],
  ['react-proyectos', Proyectos, false],
  // Acá la isla es el nodo que ya existía: `createRoot` conserva el contenedor y maneja sus hijos,
  // así `app.ts` sigue decidiendo cuándo se muestra (`hidden`) y el id que esperan el CSS y los e2e
  // no cambia.
  ['panel-modulo', PanelDerecho, false],
];

export function montarReact(): void {
  for (const [id, Componente, obligatorio] of ISLAS) {
    const nodo = document.getElementById(id);
    if (!nodo) {
      if (obligatorio) throw new Error(`falta #${id} en index.html: el canvas no tiene dónde montarse`);
      continue;
    }
    const root = createRoot(nodo);
    flushSync(() => root.render(createElement(Componente)));
  }
}
