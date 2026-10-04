const CLAVE = 'emu.aprendizaje.v1';

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

export function almacenLocalAprendizaje(): AlmacenAprendizaje | null {
  try { return window.localStorage; } catch { return null; }
}

export function leerProgreso(almacen: AlmacenAprendizaje | null | undefined): ProgresoAprendizaje {
  try {
    const texto = almacen?.getItem(CLAVE);
    if (!texto) return vacio();
    const valor: unknown = JSON.parse(texto);
    if (!valor || typeof valor !== 'object' || !('version' in valor) || valor.version !== 1
      || !('lecciones' in valor) || !valor.lecciones || typeof valor.lecciones !== 'object' || Array.isArray(valor.lecciones)) return vacio();
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
    return { version: 1, lecciones };
  } catch {
    return vacio();
  }
}

export function progresoDeLeccion(almacen: AlmacenAprendizaje | null | undefined, id: string, revision: number): ProgresoLeccion | undefined {
  const registro = leerProgreso(almacen).lecciones[id];
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
  try { almacen?.setItem(CLAVE, JSON.stringify(documento)); } catch { /* La lectura no depende del almacenamiento local. */ }
}
