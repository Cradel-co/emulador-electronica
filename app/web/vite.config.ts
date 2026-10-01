import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * La UI se compila a `web/dist/app.js`, el mismo archivo que `index.html` pide y que el server
 * verifica al arrancar. Se usa el modo librería justamente para eso: un único bundle con nombre
 * fijo, sin hash y sin que Vite reescriba `index.html`. Así nada cambia del lado del server —
 * sigue sirviendo `web/` como estático — y el proyecto sigue siendo un solo proceso en el 5180.
 *
 * `vite build --watch` reemplaza al `tsc -w` que había antes; el typecheck sigue siendo de `tsc`,
 * porque Vite (esbuild) transpila sin chequear tipos.
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  // En modo librería Vite no reemplaza `process.env.NODE_ENV`, así que React se bundlea con todo
  // su código de desarrollo: pesa el doble y hace chequeos extra en cada render. Con esto queda el
  // build de producción.
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    // Minificado con el sourcemap al lado: el bundle pesa ~5 veces menos y el navegador sigue
    // mostrando el código original al depurar. Sin minificar son 1,7 MB, casi todo react-dom.
    sourcemap: true,
    lib: {
      entry: 'app.ts',
      formats: ['es'],
      fileName: () => 'app.js',
    },
  },
});
