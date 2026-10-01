import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { App } from './App.js';

/**
 * Monta React donde estaba el `<svg>` del lienzo.
 *
 * Con `flushSync` el montaje es sincrónico: al volver de esta función el lienzo ya existe y
 * `app.ts` puede seguir con su arranque como siempre. Sin eso, React agenda el render para
 * después y el primer dibujo de la app se haría sin lienzo.
 */
export function montarReact(): void {
  const nodo = document.getElementById('react-lienzo');
  if (!nodo) throw new Error('falta #react-lienzo en index.html: el canvas no tiene dónde montarse');
  const root = createRoot(nodo);
  flushSync(() => root.render(createElement(App)));
}
