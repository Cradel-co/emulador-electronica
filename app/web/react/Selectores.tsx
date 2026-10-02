import { useEstado } from './estado.js';
import { estado } from './puente.js';
import { NOMBRE_LENGUAJE_PROYECTO, SIN_PLACA } from '../constantes.js';

/**
 * Las opciones de los `<select>` que se llenan con datos del server (#9). Cada componente se monta
 * sobre su `<select>` de siempre y rinde solo sus `<option>`: el `value` lo siguen fijando y
 * leyendo `app.ts` y los formularios de los diálogos.
 *
 * Donde `app.ts` cambia los datos y fija el `value` en el mismo instante, el cambio va envuelto en
 * `ahora()` (ver react/estado.ts), para que las opciones existan antes de elegir una.
 */

interface Placa { id: string; nombre?: string; name?: string; lenguajes?: string[]; languages?: string[] }
const nombreDe = (b: Placa) => b.nombre ?? b.name ?? b.id;

/** El selector de proyectos de la barra (`#proyecto`). */
export function OpcionesProyectos() {
  const proyectos = useEstado(() => estado().proyectos as { name: string; board: string | null; language: string | null }[]);
  return (
    <>
      {/* Vacía y oculta: sin ella un <select> nativo muestra el primero como elegido aunque no haya ninguno abierto. */}
      <option value="" hidden />
      {(proyectos ?? []).map((p) => (
        <option key={p.name} value={p.name}>{`${p.name} (${p.board ? p.language : 'sin placa'})`}</option>
      ))}
    </>
  );
}

/** Las placas del diálogo "Nuevo proyecto" (`#nuevo-placa`), más la opción de no usar ninguna. */
export function OpcionesPlacaNueva() {
  const placas = useEstado(() => estado().placas as Placa[]);
  return (
    <>
      {(placas ?? []).map((b) => <option key={b.id} value={b.id}>{nombreDe(b)}</option>)}
      {/* Sin placa: solo un circuito (fuente regulable + componentes), sin código. */}
      <option value={SIN_PLACA}>Sin placa (solo circuito)</option>
    </>
  );
}

/** Las plantillas del diálogo "Nuevo proyecto" (`#nuevo-plantilla`). */
export function OpcionesPlantillas() {
  const plantillas = useEstado(() => estado().plantillas as { id: string; nombre: string }[]);
  return (
    <>
      <option value="">Vacío: botón y LED de la placa</option>
      {(plantillas ?? []).map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
    </>
  );
}

/** Las placas del diálogo "Agregar placa" (`#placa-nueva`). */
export function OpcionesPlacas() {
  const placas = useEstado(() => estado().placas as Placa[]);
  return <>{(placas ?? []).map((b) => <option key={b.id} value={b.id}>{nombreDe(b)}</option>)}</>;
}

/** Los lenguajes de la placa elegida en "Agregar placa" (`#placa-lenguaje`). */
export function OpcionesLenguajePlaca() {
  const placas = useEstado(() => estado().placas as Placa[]);
  const id = useEstado(() => estado().placaNuevaId as string);
  const placa = (placas ?? []).find((b) => b.id === id);
  const lenguajes = placa?.lenguajes ?? placa?.languages ?? Object.keys(NOMBRE_LENGUAJE_PROYECTO);
  return <>{lenguajes.map((l) => <option key={l} value={l}>{NOMBRE_LENGUAJE_PROYECTO[l] ?? l}</option>)}</>;
}
