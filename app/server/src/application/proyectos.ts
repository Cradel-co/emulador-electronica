import { DEFAULT_BOARD, lenguajesDe, placasDelProyecto, type Language, type Project } from '@emu/shared';
import { ponerPlaca } from '../diagramOps.js';
import type { Placa } from '../boardRegistry.js';
import { ProjectError, type ProjectStore } from '../projectStore.js';
import type { ModuloCatalogo } from '../catalog.js';

export interface DepsServicioProyectos {
  store: ProjectStore;
  catalogo(): Promise<ModuloCatalogo[]>;
  buscarPlaca(id: string): Promise<Placa | undefined>;
  listarPlacas(): Promise<Placa[]>;
  plantillaToolchain(lenguaje: Language, placa: Placa): Record<string, string>;
  estaEnergizado(nombre: string): boolean;
  apagarCircuito(nombre: string): void;
}

/** Casos de uso para crear proyectos y sumarles una placa. */
export function crearServicioProyectos(deps: DepsServicioProyectos) {
  async function placaConArchivos(board: string, lenguaje: Language) {
    const placa = await deps.buscarPlaca(board);
    if (!placa) {
      const ids = (await deps.listarPlacas()).map(p => p.id).join(', ');
      throw new ProjectError(`Placa desconocida: "${board}". Placas: ${ids}`, 400);
    }

    const destino = placa.desc.languages[lenguaje];
    if (!destino) {
      throw new ProjectError(
        `${placa.nombre} no se puede programar en ${lenguaje}. Lenguajes de esta placa: ${lenguajesDe(placa.desc).join(', ')}.`,
        400,
      );
    }

    const archivosPropios = placa.desc.templates[lenguaje]?.files;
    const archivos = archivosPropios && Object.keys(archivosPropios).length > 0
      ? archivosPropios
      : deps.plantillaToolchain(lenguaje, placa);
    return { placa, archivos };
  }

  async function crearProyecto(
    nombre: string,
    lenguaje: Language | null,
    board: string | null = DEFAULT_BOARD,
    plantilla?: string,
  ): Promise<Project> {
    if (plantilla) {
      const datos = (await deps.store.listTemplates()).find(t => t.id === plantilla);
      if (!datos) throw new ProjectError(`No hay una plantilla "${plantilla}" en projects/_template/`, 404);
      if (datos.board && !(await deps.buscarPlaca(datos.board))) {
        throw new ProjectError(`La plantilla "${plantilla}" usa la placa "${datos.board}", que no está en el catálogo.`, 400);
      }
      return deps.store.createFromTemplate(nombre, plantilla);
    }
    if (board === null) return deps.store.crearSinPlaca(nombre);
    if (!lenguaje) throw new ProjectError('Falta el lenguaje de la placa', 400);
    const { placa, archivos } = await placaConArchivos(board, lenguaje);
    return deps.store.create(nombre, lenguaje, { id: placa.id, desc: placa.desc }, archivos);
  }

  async function agregarPlaca(
    nombre: string,
    board: string,
    lenguaje: Language,
    pos: { x?: number; y?: number } = {},
  ): Promise<Project> {
    return deps.store.transaccion(nombre, async () => {
      const { placa, archivos } = await placaConArchivos(board, lenguaje);
      const def = (await deps.catalogo()).find(modulo => modulo.type === placa.id);
      if (!def) throw new ProjectError(`La placa "${board}" no está en el catálogo`, 400);
      const actual = await deps.store.read(nombre);
      const puesta = ponerPlaca(actual, def, lenguaje, pos);
      // Al incorporar el procesador queda activa la recarga al guardar.
      const nuevo = { ...puesta, sim: { ...puesta.sim, autoReload: true } };
      // Con placa, el circuito deja de estar energizado aparte.
      if (deps.estaEnergizado(nombre)) deps.apagarCircuito(nombre);
      const agregada = placasDelProyecto(nuevo).find(placaNueva => !placasDelProyecto(actual).some(placaActual => placaActual.id === placaNueva.id));
      await deps.store.escribirSiFalta(nombre, lenguaje, archivos, agregada?.id);
      return deps.store.save(nuevo);
    });
  }

  return { crearProyecto, agregarPlaca };
}
