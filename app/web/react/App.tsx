import { Lienzo } from './Lienzo.js';

/**
 * Raíz de React (#9). Por ahora tiene el canvas y nada más: los paneles, la barra y los diálogos
 * los sigue pintando `app.ts`, y se irán migrando de a uno conservando los `id` del DOM para que
 * los e2e sigan sirviendo de red.
 */
export function App() {
  return <Lienzo />;
}
