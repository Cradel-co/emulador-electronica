import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  defaultProject,
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
  const base = rel.split('/').pop() ?? '';
  return base.startsWith('.') || rel.includes('/.esphome/') || rel.includes('.esphome/');
}

export class ProjectStore {
  readonly root = PATHS.projects;
  /** Recursos efímeros asociados al diagrama, también para cambios por MCP. */
  alCambiar?: (name: string, modules: Project['modules']) => void | Promise<void>;

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  projectDir(name: string): string {
    if (!isValidProjectName(name)) {
      throw new ProjectError(`Nombre de proyecto inválido: ${name}`, 400);
    }
    return path.join(this.root, name);
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
      if (!e.isDirectory()) continue;
      const project = await this.read(e.name).catch(() => null);
      if (project) out.push(project);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<Project> {
    const file = path.join(this.projectDir(name), 'project.json');
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
    await fs.mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(archivos)) {
      // Mismas reglas que un archivo que escribe el usuario: sin traversal ni extensiones raras.
      const full = rel === 'secrets.yaml' ? path.join(dir, rel) : this.resolveFile(name, rel, language);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content.replaceAll('${name}', name), 'utf8');
    }
    await this.save(project);
    return project;
  }

  /** Proyecto sin placa: solo un circuito con una fuente regulable, sin código. */
  async crearSinPlaca(name: string): Promise<Project> {
    if (!isValidProjectName(name)) {
      throw new ProjectError(`Nombre inválido: "${name}". Solo [a-z0-9-], hasta 40 caracteres, sin "..".`, 400);
    }
    if (await this.exists(name)) throw new ProjectError(`El proyecto "${name}" ya existe`, 409);
    return this.save(proyectoSinPlaca(name));
  }

  /**
   * Escribe los archivos iniciales de una placa recién agregada, sin pisar los que ya
   * estén (si la placa se quitó y se vuelve a poner, su código sigue ahí).
   */
  async escribirSiFalta(name: string, language: Language, archivos: Record<string, string>): Promise<void> {
    const dir = this.projectDir(name);
    for (const [rel, content] of Object.entries(archivos)) {
      const full = rel === 'secrets.yaml' ? path.join(dir, rel) : this.resolveFile(name, rel, language);
      const existe = await fs.stat(full).then(() => true, () => false);
      if (existe) continue;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content.replaceAll('${name}', name), 'utf8');
    }
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
    if (!isValidProjectName(name)) {
      throw new ProjectError(`Nombre inválido: "${name}". Solo [a-z0-9-], hasta 40 caracteres, sin "..".`, 400);
    }
    if (!isValidProjectName(templateId)) throw new ProjectError(`Plantilla inválida: "${templateId}"`, 400);
    if (await this.exists(name)) throw new ProjectError(`El proyecto "${name}" ya existe`, 409);
    const origen = path.join(this.templatesDir, templateId);
    const raw = await fs.readFile(path.join(origen, 'project.json'), 'utf8').catch(() => {
      throw new ProjectError(`No hay una plantilla "${templateId}"`, 404);
    });
    const base = ProjectSchema.parse(JSON.parse(raw));
    // Sin archivos ocultos (caché de compilación, etc.): solo lo que el autor dejó a propósito.
    await fs.cp(origen, this.projectDir(name), {
      recursive: true,
      filter: (src) => src === origen || !path.basename(src).startsWith('.'),
    });
    if (templateId === 'arducam-esp32-s3') {
      await fs.writeFile(path.join(this.projectDir(name), 'arducam.py'), arducamDriver);
      await fs.writeFile(path.join(this.projectDir(name), 'main.py'), arducamMain);
    }
    return this.save({ ...base, name });
  }

  async save(project: Project): Promise<Project> {
    const dir = this.projectDir(project.name);
    await fs.mkdir(dir, { recursive: true });
    const parsed = ProjectSchema.parse(project);
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    await this.alCambiar?.(parsed.name, parsed.modules);
    return parsed;
  }

  async delete(name: string): Promise<void> {
    await fs.rm(this.projectDir(name), { recursive: true, force: true });
    await this.alCambiar?.(name, []);
  }

  /** Resuelve una ruta relativa dentro del proyecto, sin salir de la carpeta. */
  resolveFile(name: string, relPath: string, language: Language | null): string {
    if (relPath.includes('\0')) throw new ProjectError('Ruta inválida', 400);
    if (!language) throw new ProjectError('Proyecto sin placa: no tiene código. Agregá una placa para programarla.', 400);
    if (isHiddenFile(relPath)) throw new ProjectError('Archivo oculto o generado', 403);
    if (!isAllowedFileName(language, relPath)) {
      throw new ProjectError(`Archivo no permitido para ${language}: ${relPath}`, 400);
    }
    const dir = this.projectDir(name);
    const full = path.resolve(dir, relPath);
    const rel = path.relative(dir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ProjectError('Ruta fuera del proyecto', 403);
    }
    return full;
  }

  async readFile(name: string, relPath: string, language: Language | null): Promise<string> {
    return fs.readFile(this.resolveFile(name, relPath, language), 'utf8');
  }

  async writeFile(name: string, relPath: string, language: Language | null, content: string): Promise<void> {
    const full = this.resolveFile(name, relPath, language);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  async deleteFile(name: string, relPath: string, language: Language | null): Promise<void> {
    if (language && relPath === MAIN_FILE[language]) {
      throw new ProjectError('No se puede borrar el archivo principal', 400);
    }
    await fs.rm(this.resolveFile(name, relPath, language), { force: true });
  }

  /** Archivos de código. Sin placa, ninguno (si se quitó la placa, su código queda en disco). */
  async listFiles(name: string, language: Language | null): Promise<ProjectFile[]> {
    if (!language) return [];
    const dir = this.projectDir(name);
    const out: ProjectFile[] = [];
    const walk = async (rel: string): Promise<void> => {
      const abs = path.join(dir, rel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (isHiddenFile(childRel)) continue;
        if (e.isDirectory()) {
          await walk(childRel);
        } else {
          const st = await fs.stat(path.join(dir, childRel));
          out.push({ path: childRel, size: st.size, modified: st.mtimeMs });
        }
      }
    };
    await walk('');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Sufijo para crear un archivo nuevo desde la UI. */
  suffixFor(language: Language): string {
    return SUFFIXES[language];
  }
}
