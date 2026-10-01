/**
 * Raíz de React (issue #9). Todavía no dibuja interfaz: la UI sigue siendo la de `app.ts`, y este
 * componente existe para que la cadena Vite → React → navegador esté armada y probada antes de
 * empezar a mover paneles.
 *
 * Lo único que rinde es una marca oculta, para que un e2e pueda comprobar que React montó de
 * verdad. Cuando empiecen a migrarse los paneles, esta marca se va y queda la interfaz.
 *
 * El plan es reemplazar de a uno los paneles que hoy se pintan a mano (consola, problemas,
 * catálogo, propiedades, debug, diálogos), conservando los `id` del DOM para que los e2e sigan
 * sirviendo de red. `canvas.ts` no se migra: se monta tal cual detrás de un `ref`.
 */
export function App() {
  return <span id="react-listo" hidden />;
}
