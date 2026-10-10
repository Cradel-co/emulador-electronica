import { useState } from 'react';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';
import type { ConflictoGuardado } from '../versiones-guardado.js';

function texto(contenido: string): string {
  try {
    const datos: unknown = JSON.parse(contenido);
    if (typeof datos === 'object' && datos !== null && 'content' in datos && typeof datos.content === 'string') return datos.content;
    return JSON.stringify(datos, null, 2);
  } catch { return contenido; }
}

export function ConflictosGuardado() {
  const conflicto = useEstado(() => estado().conflictoGuardado as ConflictoGuardado | null);
  const [ocupado, setOcupado] = useState(false);
  async function resolver(opcion: 'descargar' | 'remoto' | 'local') {
    setOcupado(true);
    try { await acciones().resolverConflicto(opcion); }
    finally { setOcupado(false); }
  }
  if (!conflicto) return null;
  return <aside className="conflicto-guardado" role="region" aria-label="Conflicto de guardado">
    <h2>{conflicto.titulo}: hay cambios de otra sesión</h2>
    <p>Tus cambios locales se conservan. Reemplazar la versión guardada requiere que no haya vuelto a cambiar.</p>
    <div className="conflicto-versiones">
      <details><summary>Mi versión al detectar el conflicto</summary><pre>{texto(conflicto.local)}</pre></details>
      <details><summary>Versión guardada</summary><pre>{texto(conflicto.remoto)}</pre></details>
    </div>
    <menu>
      <button disabled={ocupado} onClick={() => void resolver('descargar')}>Descargar mis cambios</button>
      <button disabled={ocupado || !conflicto.revisionRemota} onClick={() => void resolver('remoto')}>Cargar versión guardada</button>
      <button disabled={ocupado || !conflicto.revisionRemota} onClick={() => void resolver('local')}>Reemplazar versión guardada</button>
    </menu>
  </aside>;
}
