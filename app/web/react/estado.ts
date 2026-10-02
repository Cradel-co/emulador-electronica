import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/**
 * Hace observable el estado de `app.ts` para que React pueda leerlo, **sin tocar las ~3000
 * líneas que ya lo mutan** (#9).
 *
 * El plan original era reemplazar `state` por un store de Zustand, pero eso obliga a reescribir
 * cada `state.x = y` del archivo antes de que haya un solo componente que lea nada: mucho riesgo
 * y cero beneficio hasta el final. Con un Proxy, escribir un campo avisa a React y el código de
 * siempre sigue funcionando igual, así los paneles se pueden migrar de a uno.
 *
 * Límite a tener en cuenta: el Proxy ve las escrituras *de primer nivel* (`state.avisosDibujo =
 * [...]`), no las de adentro de un Map o un array (`state.sim.niveles.set(...)`). Para esos casos
 * está `notificar()`. En la práctica alcanza, porque casi todo el estado que mira la UI se
 * reasigna entero.
 */

const oyentes = new Set<() => void>();
let version = 0;

/** Avisa a React que el estado cambió. Solo hace falta para mutaciones de adentro de un Map/array. */
export function notificar(): void {
  version++;
  for (const oyente of oyentes) oyente();
}

function suscribir(cb: () => void): () => void {
  oyentes.add(cb);
  return () => oyentes.delete(cb);
}

/** Envuelve el estado: cada escritura de primer nivel avisa a React. */
export function observable<T extends object>(obj: T): T {
  return new Proxy(obj, {
    set(destino, clave, valor) {
      (destino as Record<string | symbol, unknown>)[clave] = valor;
      notificar();
      return true;
    },
  });
}

/**
 * Lee del estado dentro de un componente y vuelve a renderizar cuando cambia.
 *
 * `leer` tiene que devolver algo estable mientras nada cambie (una referencia, un número, un
 * string): si arma un objeto o un array nuevo en cada llamada, React avisa que el snapshot no
 * está cacheado y entra en un bucle de renders. Lo correcto es devolver el valor crudo del
 * estado y derivar lo que haga falta dentro del componente.
 */
export function useEstado<T>(leer: () => T): T {
  return useSyncExternalStore(suscribir, leer, leer);
}

/**
 * Para los componentes que leen estructuras que se mutan en el lugar: `state.diagrama.wires` con
 * `splice`, los `Map` de `state.sim`, las props de un módulo.
 *
 * `useEstado` no sirve en esos casos y el motivo no es obvio: devuelve la misma referencia, y
 * `useSyncExternalStore` compara el snapshot con `Object.is`, así que React no vuelve a renderizar
 * aunque se haya llamado a `notificar()`. Acá el snapshot es un contador que sube con cada aviso,
 * así que siempre cambia.
 *
 * Es menos preciso —re-renderiza ante cualquier cambio del estado— pero correcto, y para los
 * paneles (que se repintan por cada acción del usuario, no 60 veces por segundo) alcanza de sobra.
 */
export function useVersion(): number {
  const leer = () => version;
  return useSyncExternalStore(suscribir, leer, leer);
}

/**
 * Aplica un cambio de estado y deja a React pintado **antes de volver**.
 *
 * Hace falta cuando `app.ts` cambia algo y en la línea siguiente lee o escribe el DOM que React
 * rinde a partir de eso. El caso típico es un `<select>`: llenar las opciones y fijar su `value`
 * en el mismo instante. Sin esto React pinta las opciones después, y el `value` se fija sobre
 * opciones que todavía no existen — el navegador lo ignora en silencio.
 */
export function ahora(cambio: () => void): void {
  flushSync(cambio);
}
