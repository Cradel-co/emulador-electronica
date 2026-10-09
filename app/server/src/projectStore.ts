import { escribirAtomico } from './escrituraAtomica.js';
import { enProyecto } from './colaProyectos.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  defaultProject,
  BOARD_MODULE_ID,
  PROJECT_BOARD_ID_RE,
  proyectoSinPlaca,
  isAllowedFileName,
  isValidProjectName,
  MAIN_FILE,
  ProjectSchema,
  type BoardDescriptor,
  type Language,
  type Project,
} from '@emu/shared';
import { arducamDriver, arducamMain } from './templates/arducam.js';
import { arducamTftMain } from './templates/arducamTft.js';
import { decodificadorJpegMicroPython } from './templates/jpegDecoder.js';
import { st7735MicroPython } from './templates/st7735MicroPython.js';
import { PATHS } from './paths.js';

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface PlantillaProyecto {
  id: string;
  nombre: string;
  descripcion: string;
  /** null: plantilla sin placa (solo circuito). */
  board: string | null;
  language: Language | null;
}

export interface ProjectFile {
  path: string;
  size: number;
  modified: number;
}

const SUFFIXES: Record<Language, string> = {
  esphome: '.yaml',
  'idf-c': '.c',
  'idf-cpp': '.cpp',
  arduino: '.cpp',
  micropython: '.py',
};

/** Archivos que la app escribe y el usuario no debería ver en el editor. */
function isHiddenFile(rel: string): boolean {
  return rel.split('/').some(segment => segment.startsWith('.'));
}

export class ProjectStore {
  constructor(readonly root = PATHS.projects) {}
  /** Recursos efímeros asociados al diagrama, también para cambios por MCP. */
  alCambiar?: (name: string, modules: Project['modules']) => void | Promise<void>;

  /** Agrupa lectura, validación y escrituras; no usar Promise.all para mutaciones anidadas. */
  transaccion<T>(name: string, tarea: () => Promise<T>): Promise<T> {
    return enProyecto(path.resolve(this.projectDir(name)), tarea);
  }

  actualizar(name: string, cambio: (actual: Project) => Project | Promise<Project>): Promise<Project> {
    return this.transaccion(name, async () => this.save(await cambio(await this.read(name))));
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  projectDir(name: string): string {
    if (!isValidProjectName(name)) {
      throw new ProjectError(`Nombre de proyecto inválido: ${name}`, 400);
    }
    return path.join(this.root, name);
  }

  /** La placa histórica usa la raíz; las adicionales tienen código independiente. */
  projectCodeDir(name: string, boardId = BOARD_MODULE_ID): string {
    if (!PROJECT_BOARD_ID_RE.test(boardId)) throw new ProjectError('Id de placa inválido', 400);
    const projectDir = this.projectDir(name);
    return boardId === BOARD_MODULE_ID ? projectDir : path.join(projectDir, 'boards', boardId);
  }

  /** Rechaza enlaces simbólicos en proyectos/código; la raíz configurada es de confianza. */
  private async assertSafePath(full: string): Promise<void> {
    const root = path.resolve(this.root);
    const relative = path.relative(root, path.resolve(full));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ProjectError('Ruta fuera de proyectos', 403);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return;
      if (stat.isSymbolicLink()) throw new ProjectError('No se permiten enlaces simbólicos en proyectos', 403);
    }
  }

  /** Valida toda la plantilla antes de copiar para que un rechazo no deje copias parciales. */
  private async assertSafeTemplate(dir: string): Promise<void> {
    await this.assertSafePath(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new ProjectError('La plantilla contiene enlaces simbólicos', 403);
      if (entry.isDirectory()) await this.assertSafeTemplate(path.join(dir, entry.name));
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await fs.stat(path.join(this.projectDir(name), 'project.json'));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<Project[]> {
    await this.init();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const out: Project[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const project = await this.read(e.name).catch(() => null);
      if (project) out.push(project);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<Project> {
    const file = path.join(this.projectDir(name), 'project.json');
    await this.assertSafePath(file);
    const raw = await fs.readFile(file, 'utf8');
    return ProjectSchema.parse(JSON.parse(raw));
  }

  /**
   * Crea un proyecto para una placa. Los archivos iniciales los decide quien llama
   * (index.ts: la plantilla de la placa o la de su toolchain); acá solo se escriben.
   * La compatibilidad placa ↔ lenguaje también la chequea quien llama (registro de placas).
   */
  async create(
    name: string,
    language: Language,
    placa: { id: string; desc?: BoardDescriptor },
    archivos: Record<string, string>,
  ): Promise<Project> {
    return this.transaccion(name, async () => {
      if (!isValidProjectName(name)) {
        throw new ProjectError(
          `Nombre inválido: "${name}". Solo [a-z0-9-], hasta 40 caracteres, sin "..".`,
          400,
        );
      }
      if (await this.exists(name)) {
        throw new ProjectError(`El proyecto "${name}" ya existe`, 409);
      }
      const project = defaultProject(name, language, placa.id, placa.desc);
      const dir = this.projectDir(name);
      await this.assertSafePath(dir);
      await fs.mkdir(dir, { recursive: true });
      for (const [rel, content] of Object.entries(archivos)) {
        // Mismas reglas que un archivo que escribe el usuario: sin traversal ni extensiones raras.
        const full = this.resolveFile(name, rel, language);
        await this.assertSafePath(full);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await escribirAtomico(full, content.replaceAll('${name}', name));
      }
      await this.save(project);
      return project;
    });
  }

  /** Proyecto sin placa: solo un circuito con una fuente regulable, sin código. */
  async crearSinPlaca(name: string): Promise<Project> {
    return this.transaccion(name, async () => {
      if (!isValidProjectName(name)) {
        throw new ProjectError(`Nombre inválido: "${name}". Solo [a-z0-9-], hasta 40 caracteres, sin "..".`, 400);
      }
      if (await this.exists(name)) throw new ProjectError(`El proyecto "${name}" ya existe`, 409);
      return this.save(proyectoSinPlaca(name));
    });
  }

  /**
   * Escribe los archivos iniciales de una placa recién agregada, sin pisar los que ya
   * estén (si la placa se quitó y se vuelve a poner, su código sigue ahí).
   */
  async escribirSiFalta(name: string, language: Language, archivos: Record<string, string>, boardId = BOARD_MODULE_ID): Promise<void> {
    return this.transaccion(name, async () => {
      for (const [rel, content] of Object.entries(archivos)) {
        const full = this.resolveFile(name, rel, language, boardId);
        await this.assertSafePath(full);
        const existe = await fs.stat(full).then(() => true, () => false);
        if (existe) continue;
        await fs.mkdir(path.dirname(full), { recursive: true });
        await escribirAtomico(full, content.replaceAll('${name}', name));
      }
    });
  }

  /**
   * Proyectos plantilla: projects/_template/<id>/, cada uno un proyecto completo (project.json +
   * código + README.md). No aparecen en la lista de proyectos ("_" no es un nombre válido).
   */
  get templatesDir(): string {
    return path.join(this.root, '_template');
  }

  /** Plantillas disponibles; nombre y descripción salen del título y primer párrafo del README.md. */
  async listTemplates(): Promise<PlantillaProyecto[]> {
    const entries = await fs.readdir(this.templatesDir, { withFileTypes: true }).catch(() => []);
    const out: PlantillaProyecto[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !isValidProjectName(e.name)) continue;
      const dir = path.join(this.templatesDir, e.name);
      try {
        await this.assertSafePath(path.join(dir, 'project.json'));
        await this.assertSafePath(path.join(dir, 'README.md'));
        const p = ProjectSchema.parse(JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')));
        const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8').catch(() => '');
        const nombre = /^#\s+(.+)$/m.exec(readme)?.[1]?.trim() ?? e.name;
        const descripcion = readme.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#')) ?? '';
        out.push({ id: e.name, nombre, descripcion: descripcion.replace(/\s*\n\s*/g, ' '), board: p.board, language: p.language });
      } catch {
        // Una plantilla rota no tumba la lista.
      }
    }
    return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  /** Crea `name` copiando la plantilla `templateId` tal cual (circuito, código, README). */
  async createFromTemplate(name: string, templateId: string): Promise<Project> {
    return this.transaccion(name, async () => {
      if (!isValidProjectName(name)) {
        throw new ProjectError(`Nombre inválido: "${name}". Solo [a-z0-9-], hasta 40 caracteres, sin "..".`, 400);
      }
      if (!isValidProjectName(templateId)) throw new ProjectError(`Plantilla inválida: "${templateId}"`, 400);
      if (await this.exists(name)) throw new ProjectError(`El proyecto "${name}" ya existe`, 409);
      const origen = path.join(this.templatesDir, templateId);
      await this.assertSafePath(path.join(origen, 'project.json'));
      await this.assertSafePath(this.projectDir(name));
      const raw = await fs.readFile(path.join(origen, 'project.json'), 'utf8').catch(() => {
        throw new ProjectError(`No hay una plantilla "${templateId}"`, 404);
      });
      const base = ProjectSchema.parse(JSON.parse(raw));
      await this.assertSafeTemplate(origen);
      // Sin archivos ocultos (caché de compilación, etc.): solo lo que el autor dejó a propósito.
      await fs.cp(origen, this.projectDir(name), {
        recursive: true,
        filter: (src) => src === origen || !path.basename(src).startsWith('.'),
      });
      if (templateId === 'arducam-esp32-s3') {
        await escribirAtomico(path.join(this.projectDir(name), 'arducam.py'), arducamDriver);
        await escribirAtomico(path.join(this.projectDir(name), 'main.py'), arducamMain);
      }
      if (templateId === 'arducam-tft-esp32-s3') {
        await escribirAtomico(path.join(this.projectDir(name), 'arducam.py'), arducamDriver);
        await escribirAtomico(path.join(this.projectDir(name), 'jpeg.py'), decodificadorJpegMicroPython);
        await escribirAtomico(path.join(this.projectDir(name), 'st7735.py'), st7735MicroPython);
        await escribirAtomico(path.join(this.projectDir(name), 'main.py'), arducamTftMain);
      }
      return this.save({ ...base, name });
    });
  }

  async save(project: Project): Promise<Project> {
    return this.transaccion(project.name, async () => {
      const dir = this.projectDir(project.name);
      await this.assertSafePath(path.join(dir, 'project.json'));
      await fs.mkdir(dir, { recursive: true });
      const parsed = ProjectSchema.parse(project);
      await escribirAtomico(path.join(dir, 'project.json'), JSON.stringify(parsed, null, 2) + '\n');
      await this.alCambiar?.(parsed.name, parsed.modules);
      return parsed;
    });
  }

  async delete(name: string): Promise<void> {
    return this.transaccion(name, async () => {
      await fs.rm(this.projectDir(name), { recursive: true, force: true });
      await this.alCambiar?.(name, []);
    });
  }

  /** Resuelve una ruta relativa dentro del proyecto, sin salir de la carpeta. */
  resolveFile(name: string, relPath: string, language: Language | null, boardId = BOARD_MODULE_ID): string {
    if (relPath.includes('\0')) throw new ProjectError('Ruta inválida', 400);
    if (!language) throw new ProjectError('Proyecto sin placa: no tiene código. Agregá una placa para programarla.', 400);
    if (isHiddenFile(relPath)) throw new ProjectError('Archivo oculto o generado', 403);
    if (relPath.split('/')[0] === 'boards') throw new ProjectError('La carpeta de otras placas es privada', 403);
    if (boardId !== BOARD_MODULE_ID && relPath === 'project.json') throw new ProjectError('El proyecto es compartido; no es un archivo de placa', 403);
    if (!isAllowedFileName(language, relPath)) {
      throw new ProjectError(`Archivo no permitido para ${language}: ${relPath}`, 400);
    }
    const dir = this.projectCodeDir(name, boardId);
    const full = path.resolve(dir, relPath);
    const rel = path.relative(dir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ProjectError('Ruta fuera del proyecto', 403);
    }
    return full;
  }

  /** Carpetas de código, con las mismas fronteras que los archivos y sin extensiones obligatorias. */
  private resolveDirectory(name: string, relPath: string, language: Language | null, boardId: string): string {
    if (!language) throw new ProjectError('Proyecto sin placa: no tiene código. Agregá una placa para programarla.', 400);
    if (!relPath || relPath.length > 200 || relPath.includes('\\') || /[\x00-\x1f\x7f]/.test(relPath)) throw new ProjectError('Ruta de carpeta inválida', 400);
    const segments = relPath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new ProjectError('Ruta de carpeta inválida', 400);
    if (isHiddenFile(relPath)) throw new ProjectError('Carpeta oculta o generada', 403);
    if (segments[0] === 'boards') throw new ProjectError('La carpeta de otras placas es privada', 403);
    const dir = this.projectCodeDir(name, boardId);
    const full = path.resolve(dir, relPath);
    const relative = path.relative(dir, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ProjectError('Ruta fuera del proyecto', 403);
    return full;
  }

  /** Crea carpetas físicas: las vacías también sobreviven al reiniciar y volver a listar. */
  async createDirectory(name: string, relPath: string, language: Language | null, boardId = BOARD_MODULE_ID): Promise<string> {
    return this.transaccion(name, async () => {
      const full = this.resolveDirectory(name, relPath, language, boardId);
      try {
        await this.assertSafePath(full);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.mkdir(full);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTDIR') throw new ProjectError('Ya existe un archivo o carpeta con ese nombre', 409);
        throw error;
      }
      return path.relative(this.projectCodeDir(name, boardId), full).split(path.sep).join('/');
    });
  }

  /** Apertura exclusiva: dos solicitudes simultáneas nunca pisan un archivo ya creado. */
  async createFile(name: string, relPath: string, language: Language | null, content: string, boardId = BOARD_MODULE_ID): Promise<string> {
    return this.transaccion(name, async () => {
      if (relPath === 'project.json') throw new ProjectError('El proyecto es compartido; no es un archivo de placa', 403);
      const full = this.resolveFile(name, relPath, language, boardId);
      try {
        await this.assertSafePath(full);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await escribirAtomico(full, content, true);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTDIR') throw new ProjectError('Ya existe un archivo o carpeta con ese nombre', 409);
        throw error;
      }
      return path.relative(this.projectCodeDir(name, boardId), full).split(path.sep).join('/');
    });
  }

  async readFile(name: string, relPath: string, language: Language | null, boardId = BOARD_MODULE_ID): Promise<string> {
    const full = this.resolveFile(name, relPath, language, boardId);
    await this.assertSafePath(full);
    return fs.readFile(full, 'utf8');
  }

  async writeFile(name: string, relPath: string, language: Language | null, content: string, boardId = BOARD_MODULE_ID): Promise<void> {
    return this.transaccion(name, async () => {
      const full = this.resolveFile(name, relPath, language, boardId);
      await this.assertSafePath(full);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await escribirAtomico(full, content);
    });
  }

  async deleteFile(name: string, relPath: string, language: Language | null, boardId = BOARD_MODULE_ID): Promise<void> {
    return this.transaccion(name, async () => {
      if (language && relPath === MAIN_FILE[language]) {
        throw new ProjectError('No se puede borrar el archivo principal', 400);
      }
      const full = this.resolveFile(name, relPath, language, boardId);
      await this.assertSafePath(full);
      await fs.rm(full, { force: true });
    });
  }

  /** Recorrido compartido: ignora datos privados y enlaces, conserva carpetas sin archivos. */
  private async listCodeEntries(name: string, language: Language | null, boardId: string): Promise<{ files: ProjectFile[]; directories: string[] }> {
    const files: ProjectFile[] = [];
    const directories: string[] = [];
    if (!language) return { files, directories };
    const dir = this.projectCodeDir(name, boardId);
    await this.assertSafePath(dir);
    const walk = async (rel: string): Promise<void> => {
      const abs = path.join(dir, rel);
      const entries = await fs.readdir(abs, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || isHiddenFile(childRel) || (rel === '' && entry.name === 'boards')) continue;
        if (entry.isDirectory()) {
          directories.push(childRel);
          await walk(childRel);
        } else if (entry.isFile()) {
          const stat = await fs.stat(path.join(dir, childRel));
          files.push({ path: childRel, size: stat.size, modified: stat.mtimeMs });
        }
      }
    };
    await walk('');
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort((a, b) => a.localeCompare(b)) };
  }

  /** Archivos de código. Sin placa, ninguno (el código anterior queda conservado en disco). */
  async listFiles(name: string, language: Language | null, boardId = BOARD_MODULE_ID): Promise<ProjectFile[]> {
    return (await this.listCodeEntries(name, language, boardId)).files;
  }

  async listDirectories(name: string, language: Language | null, boardId = BOARD_MODULE_ID): Promise<string[]> {
    return (await this.listCodeEntries(name, language, boardId)).directories;
  }

  /** Sufijo para crear un archivo nuevo desde la UI. */
  suffixFor(language: Language): string {
    return SUFFIXES[language];
  }
}
