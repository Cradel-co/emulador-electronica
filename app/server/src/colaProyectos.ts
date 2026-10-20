import { AsyncLocalStorage } from 'node:async_hooks';

const colas = new Map<string, Promise<unknown>>();
const contexto = new AsyncLocalStorage<{ clave: string; activo: boolean }>();

/** Cola por ruta de proyecto, compartida por stores de la misma raíz en este proceso. */
export function enProyecto<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const actual = contexto.getStore();
  if (actual?.activo && actual.clave === clave) return tarea();
  const job = (colas.get(clave) ?? Promise.resolve()).catch(() => {}).then(() => {
    const token = { clave, activo: true };
    return contexto.run(token, async () => {
      try { return await tarea(); }
      finally { token.activo = false; }
    });
  });
  colas.set(clave, job);
  const limpiar = () => { if (colas.get(clave) === job) colas.delete(clave); };
  void job.then(limpiar, limpiar);
  return job;
}
