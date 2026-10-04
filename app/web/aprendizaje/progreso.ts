export const CLAVE_PROGRESO_APRENDIZAJE = 'emu.aprendizaje.v1';

export interface AlmacenAprendizaje {
  getItem(clave: string): string | null;
  setItem(clave: string, valor: string): void;
}

export interface ProgresoLeccion {
  revision: number;
  ultimoPasoId?: string;
  completada: boolean;
  completadaEn?: string;
  proyectoNombre?: string;
}

export interface ProgresoAprendizaje {
  version: 1;
  lecciones: Record<string, ProgresoLeccion>;
}

function vacio(): ProgresoAprendizaje { return { version: 1, lecciones: {} }; }
function copiar(documento: ProgresoAprendizaje): ProgresoAprendizaje {
  return { version: 1, lecciones: Object.fromEntries(Object.entries(documento.lecciones).map(([id, registro]) => [id, { ...registro }])) };
}

let respaldoSinAlmacenamiento = vacio();
const respaldosPorAlmacenamiento = new WeakMap<AlmacenAprendizaje, ProgresoAprendizaje>();

function recordar(almacen: AlmacenAprendizaje | null | undefined, documento: ProgresoAprendizaje): ProgresoAprendizaje {
  const respaldo = copiar(documento);
  if (almacen) respaldosPorAlmacenamiento.set(almacen, respaldo);
  else respaldoSinAlmacenamiento = respaldo;
  return copiar(respaldo);
}

export function almacenLocalAprendizaje(): AlmacenAprendizaje | null {
  try { return window.localStorage; } catch { return null; }
}

export function leerProgreso(almacen: AlmacenAprendizaje | null | undefined): ProgresoAprendizaje {
  const respaldo = almacen ? respaldosPorAlmacenamiento.get(almacen) ?? vacio() : respaldoSinAlmacenamiento;
  if (!almacen) return copiar(respaldo);
  let texto: string | null;
  try {
    texto = almacen.getItem(CLAVE_PROGRESO_APRENDIZAJE);
  } catch {
    return copiar(respaldo);
  }
  if (!texto) return copiar(respaldo);

  let valor: unknown;
  try { valor = JSON.parse(texto); }
  catch { return recordar(almacen, vacio()); }
  try {
    if (!valor || typeof valor !== 'object' || !('version' in valor) || valor.version !== 1
      || !('lecciones' in valor) || !valor.lecciones || typeof valor.lecciones !== 'object' || Array.isArray(valor.lecciones)) return recordar(almacen, vacio());
    const lecciones: Record<string, ProgresoLeccion> = {};
    for (const [id, registro] of Object.entries(valor.lecciones)) {
      if (!id || !registro || typeof registro !== 'object') continue;
      const dato = registro as Record<string, unknown>;
      if (!Number.isInteger(dato.revision) || (dato.revision as number) < 1 || typeof dato.completada !== 'boolean') continue;
      if (dato.ultimoPasoId !== undefined && typeof dato.ultimoPasoId !== 'string') continue;
      if (dato.completadaEn !== undefined && typeof dato.completadaEn !== 'string') continue;
      if (dato.proyectoNombre !== undefined && typeof dato.proyectoNombre !== 'string') continue;
      lecciones[id] = {
        revision: dato.revision as number,
        ...(typeof dato.ultimoPasoId === 'string' ? { ultimoPasoId: dato.ultimoPasoId } : {}),
        completada: dato.completada,
        ...(typeof dato.completadaEn === 'string' ? { completadaEn: dato.completadaEn } : {}),
        ...(typeof dato.proyectoNombre === 'string' ? { proyectoNombre: dato.proyectoNombre } : {}),
      };
    }
    return recordar(almacen, { version: 1, lecciones });
  } catch {
    return copiar(respaldo);
  }
}

/** Registro más reciente aunque pertenezca a una revisión anterior de la lección. */
export function registroDeLeccion(almacen: AlmacenAprendizaje | null | undefined, id: string): ProgresoLeccion | undefined {
  const registro = leerProgreso(almacen).lecciones[id];
  return registro ? { ...registro } : undefined;
}

/** Un borrado externo del registro invalida también el respaldo en memoria de esta pestaña. */
export function restablecerRespaldoProgreso(almacen: AlmacenAprendizaje | null | undefined): void {
  recordar(almacen, vacio());
}

export function progresoDeLeccion(almacen: AlmacenAprendizaje | null | undefined, id: string, revision: number): ProgresoLeccion | undefined {
  const registro = registroDeLeccion(almacen, id);
  return registro?.revision === revision ? registro : undefined;
}

export function registrarPaso(
  almacen: AlmacenAprendizaje | null | undefined,
  id: string,
  revision: number,
  pasoId: string,
): void {
  const documento = leerProgreso(almacen);
  const previo = documento.lecciones[id];
  documento.lecciones[id] = {
    revision,
    ultimoPasoId: pasoId,
    completada: previo?.revision === revision && previo.completada,
    ...(previo?.revision === revision && previo.completadaEn ? { completadaEn: previo.completadaEn } : {}),
    ...(previo?.proyectoNombre ? { proyectoNombre: previo.proyectoNombre } : {}),
  };
  guardar(almacen, documento);
}

export function completarLeccion(
  almacen: AlmacenAprendizaje | null | undefined,
  id: string,
  revision: number,
  pasoId: string,
  completadaEn = new Date().toISOString(),
): void {
  const documento = leerProgreso(almacen);
  const proyectoNombre = documento.lecciones[id]?.proyectoNombre;
  documento.lecciones[id] = {
    revision, ultimoPasoId: pasoId, completada: true, completadaEn,
    ...(proyectoNombre ? { proyectoNombre } : {}),
  };
  guardar(almacen, documento);
}

export function asociarProyecto(
  almacen: AlmacenAprendizaje | null | undefined,
  id: string,
  revision: number,
  proyectoNombre: string,
): void {
  const documento = leerProgreso(almacen);
  const previo = documento.lecciones[id];
  documento.lecciones[id] = {
    revision,
    ...(previo?.ultimoPasoId ? { ultimoPasoId: previo.ultimoPasoId } : {}),
    completada: previo?.revision === revision && previo.completada,
    ...(previo?.revision === revision && previo.completadaEn ? { completadaEn: previo.completadaEn } : {}),
    proyectoNombre,
  };
  guardar(almacen, documento);
}

export function quitarAsociacionProyecto(
  almacen: AlmacenAprendizaje | null | undefined,
  id: string,
  revision: number,
): void {
  const documento = leerProgreso(almacen);
  const previo = documento.lecciones[id];
  if (!previo?.proyectoNombre) return;
  documento.lecciones[id] = {
    revision,
    ...(previo.ultimoPasoId ? { ultimoPasoId: previo.ultimoPasoId } : {}),
    completada: previo.revision === revision && previo.completada,
    ...(previo.revision === revision && previo.completadaEn ? { completadaEn: previo.completadaEn } : {}),
  };
  guardar(almacen, documento);
}

function guardar(almacen: AlmacenAprendizaje | null | undefined, documento: ProgresoAprendizaje): void {
  const guardado = recordar(almacen, documento);
  try { almacen?.setItem(CLAVE_PROGRESO_APRENDIZAJE, JSON.stringify(guardado)); } catch { /* Se conserva el respaldo en memoria. */ }
}
