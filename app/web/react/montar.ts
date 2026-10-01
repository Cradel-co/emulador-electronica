import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './App.js';

/**
 * Monta React en `#react-root` si ese nodo existe. Se llama desde `app.ts` al final del arranque:
 * mientras la UI vieja siga en pie, React no tiene que interferir con nada.
 */
export function montarReact(): void {
  const nodo = document.getElementById('react-root');
  if (!nodo) return;
  createRoot(nodo).render(createElement(App));
}
