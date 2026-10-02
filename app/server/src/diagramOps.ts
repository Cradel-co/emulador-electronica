import {
  BOARD_MODULE_ID,
  gpioDePin,
  motivoReservado,
  nombreDePin,
  type BoardDescriptor,
  type Language,
  type ModuleDef,
  type ModuleInstance,
  type Project,
  type Wire,
} from '@emu/shared';

/**
 * Operaciones sobre el dibujo de un proyecto (módulos y cables), con las mismas
 * reglas que aplica la UI (web/app.js). Las usa el MCP: son funciones puras que
 * devuelven el proyecto modificado; quien llama decide guardarlo.
 */

export class DiagramError extends Error {
  readonly statusCode = 400;
}

/**
 * Pines que usa la propia simulación en el ESP32-S3: no se pueden cablear (guía 6.3 y 8.2).
 * Los de cada placa están en su descriptor (`board.reservedPins` del module.json).
 */
export const PINES_RESERVADOS = new Map<number, string>([
  [17, 'lo usa el puente de simulación (UART1 TX)'],
  [18, 'lo usa el puente de simulación (UART1 RX)'],
  [43, 'es la consola del emulador (UART0 TX)'],
  [44, 'es la consola del emulador (UART0 RX)'],
]);

type BuscarDef = (type: string) => ModuleDef | undefined;

/** Descriptor de la placa del proyecto (del catálogo), o undefined si no hay catálogo a mano. */
export function descriptorDe(project: Project, buscar?: BuscarDef): BoardDescriptor | undefined {
  return project.board ? buscar?.(project.board)?.board : undefined;
}

/**
 * Pin lógico de una punta de cable que va a la placa: "board.GPIO6" → 6 en un ESP32,
 * "board.D13" → 13 y "board.A0" → 14 en el Uno (según `board.pins` del descriptor).
 * Sin descriptor, entiende "GPIOn" (proyectos y pruebas viejas).
 */
export function gpioDeRef(ref: string, desc?: BoardDescriptor): number | null {
  if (!ref.startsWith(`${BOARD_MODULE_ID}.`)) return null;
  return gpioDePin(desc, ref.slice(BOARD_MODULE_ID.length + 1));
}

export function partirRef(ref: string): { id: string; pin: string } {
  const punto = ref.indexOf('.');
  if (punto <= 0 || punto === ref.length - 1) {
    throw new DiagramError(`"${ref}" no es un pin: usá "módulo.PIN", por ejemplo "btn1.OUT" o "board.GPIO6"`);
  }
  return { id: ref.slice(0, punto), pin: ref.slice(punto + 1) };
}

/**
 * Acepta "GPIO6", "6" o "board.GPIO6" para los pines de un ESP32, y "D13", "13", "A0"
 * o "board.D13" para los del Uno. Devuelve siempre "board.<nombre del pin>".
 */
export function normalizarRef(ref: string, desc?: BoardDescriptor): string {
  const r = ref.trim();
  const numero = /^(?:board\.)?(\d{1,3})$/i.exec(r);
  if (numero) return `board.${nombreDePin(desc, Number(numero[1]))}`;
  const nombre = /^(?:board\.)?([A-Za-z][\w-]*)$/.exec(r);
  if (nombre && !r.includes('.') ) {
    // Un nombre de pin de la placa, sin importar mayúsculas ("gpio21", "d13").
    const exacto = desc ? Object.keys(desc.pins).find((k) => k.toLowerCase() === nombre[1]!.toLowerCase()) : undefined;
    if (exacto) return `board.${exacto}`;
    if (!desc && /^GPIO\d{1,2}$/i.test(nombre[1]!)) return `board.GPIO${nombre[1]!.slice(4)}`;
  }
  if (/^board\./i.test(r) && desc) {
    const pin = r.slice(6);
    const exacto = Object.keys(desc.pins).find((k) => k.toLowerCase() === pin.toLowerCase());
    if (exacto) return `board.${exacto}`;
  }
  return r;
}

/** Proyectos anteriores al canvas no tienen la placa en el dibujo. Sin placa, no hay nada que agregar. */
export function conPlaca(project: Project): Project {
  if (!project.board || project.modules.some((m) => m.id === BOARD_MODULE_ID)) return project;
  return { ...project, modules: [{ id: BOARD_MODULE_ID, type: project.board, x: 0, y: 0, props: {} }, ...project.modules] };
}

/**
 * Pone una placa en un proyecto sin placa (la placa es un módulo más, que se agrega y se
 * quita). El código lo maneja quien llama (index.ts): acá solo cambia el dibujo.
 */
export function ponerPlaca(project: Project, def: ModuleDef, lenguaje: Language, opciones: { x?: number; y?: number } = {}): Project {
  if (!def.programmable || !def.board) throw new DiagramError(`"${def.name}" no es una placa`);
  if (project.board) {
    throw new DiagramError(`el proyecto ya tiene su placa (${project.board}): la simulación corre un solo microcontrolador. Quitala primero.`);
  }
  if (!def.board.languages[lenguaje]) {
    throw new DiagramError(`${def.name} no se programa en ${lenguaje}. Lenguajes: ${Object.keys(def.board.languages).join(', ')}`);
  }
  const placa = { id: BOARD_MODULE_ID, type: def.type, x: opciones.x ?? 0, y: opciones.y ?? 0, props: {} };
  return { ...project, board: def.type, language: lenguaje, modules: [placa, ...project.modules.filter((m) => m.id !== BOARD_MODULE_ID)] };
}

/** Saca la placa y sus cables: el proyecto queda sin placa (solo circuito). El código no se toca. */
export function sacarPlaca(project: Project): Project {
  if (!project.board) throw new DiagramError('el proyecto no tiene placa');
  const prefijo = `${BOARD_MODULE_ID}.`;
  return {
    ...project,
    board: null,
    language: null,
    modules: project.modules.filter((m) => m.id !== BOARD_MODULE_ID),
    wires: project.wires.filter((w) => !w.from.startsWith(prefijo) && !w.to.startsWith(prefijo)),
  };
}

const PREFIJOS: Record<string, string> = {
  button: 'btn', switch: 'sw', led: 'led', relay: 'rele', resistor: 'r', rxb6: 'rx', stx882: 'tx',
  'remote-433': 'control', 'door-sensor-433': 'puerta', 'siren-433': 'sirena',
};

export function nuevoId(project: Project, type: string): string {
  const base = PREFIJOS[type] ?? (type.replace(/[^a-z0-9]/g, '').slice(0, 10) || 'mod');
  const usados = new Set(project.modules.map((m) => m.id));
  let n = 1;
  while (usados.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function instancia(project: Project, id: string): ModuleInstance {
  const inst = project.modules.find((m) => m.id === id);
  if (!inst) {
    const ids = project.modules.map((m) => m.id).join(', ') || '(ninguno)';
    throw new DiagramError(`no hay ningún módulo "${id}" en el circuito. Módulos: ${ids}`);
  }
  return inst;
}

function validarProps(def: ModuleDef, props: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    const pd = def.props[k];
    if (!pd) throw new DiagramError(`"${def.name}" no tiene la propiedad "${k}". Tiene: ${Object.keys(def.props).join(', ') || '(ninguna)'}`);
    if (pd.type === 'number' && typeof v !== 'number') throw new DiagramError(`${k} tiene que ser un número`);
    if (pd.type === 'boolean' && typeof v !== 'boolean') throw new DiagramError(`${k} tiene que ser true/false`);
    if (pd.type === 'string' && typeof v !== 'string') throw new DiagramError(`${k} tiene que ser texto`);
    if (pd.enum && !pd.enum.includes(String(v))) throw new DiagramError(`${k} tiene que ser uno de: ${pd.enum.join(', ')}`);
    out[k] = v as string | number | boolean;
  }
  return out;
}

export function agregarModulo(
  project: Project,
  def: ModuleDef,
  opciones: { id?: string; x?: number; y?: number; rotation?: number; props?: Record<string, unknown> } = {},
): { project: Project; id: string } {
  if (def.programmable) {
    throw new DiagramError(project.board
      ? `el proyecto ya tiene su placa (${project.board}): la simulación corre un solo microcontrolador`
      : `"${def.name}" es una placa: se agrega eligiendo su lenguaje (ponerPlaca)`);
  }
  const base = conPlaca(project);
  const id = opciones.id ?? nuevoId(base, def.type);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id)) throw new DiagramError(`id inválido: "${id}"`);
  if (base.modules.some((m) => m.id === id)) throw new DiagramError(`ya hay un módulo con id "${id}"`);
  const props: Record<string, string | number | boolean> = {};
  for (const [k, p] of Object.entries(def.props)) if (p.default !== undefined) props[k] = p.default;
  Object.assign(props, validarProps(def, opciones.props ?? {}));
  // Por defecto, a la izquierda de la placa, uno debajo del otro.
  const x = opciones.x ?? -260;
  const y = opciones.y ?? 40 + (base.modules.length - 1) * 110;
  const giro = opciones.rotation === undefined ? {} : { rotation: ((Math.round(opciones.rotation) % 360) + 360) % 360 };
  return { project: { ...base, modules: [...base.modules, { id, type: def.type, x, y, ...giro, props }] }, id };
}

export function quitarModulo(project: Project, id: string): Project {
  if (id === BOARD_MODULE_ID) return sacarPlaca(project);
  instancia(project, id);
  const prefijo = `${id}.`;
  return {
    ...project,
    modules: project.modules.filter((m) => m.id !== id),
    wires: project.wires.filter((w) => !w.from.startsWith(prefijo) && !w.to.startsWith(prefijo)),
  };
}

export function moverModulo(project: Project, id: string, x: number, y: number, rotation?: number): Project {
  const base = conPlaca(project);
  instancia(base, id);
  // Rotación en grados [0, 360); sin indicar, se conserva la que tenía.
  const giro = rotation === undefined ? undefined : ((Math.round(rotation) % 360) + 360) % 360;
  return {
    ...base,
    modules: base.modules.map((m) =>
      m.id === id ? { ...m, x: Math.round(x), y: Math.round(y), ...(giro === undefined ? {} : { rotation: giro }) } : m,
    ),
  };
}

export function configurarModulo(project: Project, id: string, def: ModuleDef, props: Record<string, unknown>): Project {
  instancia(project, id);
  const nuevas = validarProps(def, props);
  return { ...project, modules: project.modules.map((m) => (m.id === id ? { ...m, props: { ...m.props, ...nuevas } } : m)) };
}

/** Verifica que "id.PIN" exista en el dibujo y en la definición del módulo. */
function validarPin(project: Project, ref: string, buscar: BuscarDef): void {
  const { id, pin } = partirRef(ref);
  const inst = instancia(project, id);
  const def = buscar(inst.type);
  if (!def) throw new DiagramError(`el módulo "${id}" (${inst.type}) no está en el catálogo`);
  if (!def.pins.some((p) => p.name === pin)) {
    throw new DiagramError(`"${def.name}" (${id}) no tiene el pin "${pin}". Pines: ${def.pins.map((p) => p.name).join(', ') || '(ninguno: es inalámbrico)'}`);
  }
  const desc = descriptorDe(project, buscar);
  const g = gpioDeRef(ref, desc);
  const motivo = g === null ? null : desc ? motivoReservado(desc, g) : PINES_RESERVADOS.get(g) ?? null;
  if (motivo) throw new DiagramError(`${nombreDePin(desc, g!)} no se puede usar: ${motivo}`);
}

export function conectar(project: Project, a: string, b: string, buscar: BuscarDef): { project: Project; wire: Wire } {
  const base = conPlaca(project);
  const desc = descriptorDe(base, buscar);
  const ra = normalizarRef(a, desc);
  const rb = normalizarRef(b, desc);
  validarPin(base, ra, buscar);
  validarPin(base, rb, buscar);
  if (partirRef(ra).id === partirRef(rb).id) throw new DiagramError('los dos pines son del mismo módulo');
  if (base.wires.some((w) => (w.from === ra && w.to === rb) || (w.from === rb && w.to === ra))) {
    throw new DiagramError('esos dos pines ya están conectados');
  }
  // Convención de la guía (6.1): el módulo en `from`, la placa en `to`.
  const wire = partirRef(ra).id === BOARD_MODULE_ID ? { from: rb, to: ra } : { from: ra, to: rb };
  return { project: { ...base, wires: [...base.wires, wire] }, wire };
}

export function desconectar(project: Project, a: string, b?: string, buscar?: BuscarDef): { project: Project; quitados: Wire[] } {
  const desc = descriptorDe(project, buscar);
  const ra = normalizarRef(a, desc);
  const rb = b === undefined ? undefined : normalizarRef(b, desc);
  const toca = (w: Wire): boolean =>
    rb === undefined ? w.from === ra || w.to === ra : (w.from === ra && w.to === rb) || (w.from === rb && w.to === ra);
  const quitados = project.wires.filter(toca);
  if (quitados.length === 0) throw new DiagramError(rb ? `no hay un cable entre ${ra} y ${rb}` : `${ra} no tiene cables`);
  return { project: { ...project, wires: project.wires.filter((w) => !toca(w)) }, quitados };
}

/**
 * GPIO (pin lógico) de la placa al que está cableado un pin de un módulo, o null.
 * Atraviesa componentes "de paso" (p. ej. una resistencia en serie con un LED):
 * para la lógica digital (qué GPIO prende qué salida) es como si el cable
 * siguiera derecho, aunque eléctricamente sí tengan su resistencia (Ley de Ohm).
 */
export function gpioDe(project: Project, id: string, pin: string, buscar?: BuscarDef, visitados = new Set<string>()): number | null {
  const ref = `${id}.${pin}`;
  if (visitados.has(ref)) return null; // corta un lazo (dos resistencias entre sí, etc.)
  visitados.add(ref);
  for (const w of project.wires) {
    if (w.from !== ref && w.to !== ref) continue;
    const otro = w.from === ref ? w.to : w.from;
    const g = gpioDeRef(otro, descriptorDe(project, buscar));
    if (g !== null) return g;
    if (!buscar) continue;
    const { id: otroId, pin: otroPin } = partirRef(otro);
    const otraInst = project.modules.find((m) => m.id === otroId);
    const otroDef = otraInst && buscar(otraInst.type);
    if (!otroDef?.passthrough || otroDef.pins.length !== 2) continue;
    const siguientePin = otroDef.pins.find((p) => p.name !== otroPin);
    if (siguientePin) {
      const g2 = gpioDe(project, otroId, siguientePin.name, buscar, visitados);
      if (g2 !== null) return g2;
    }
  }
  return null;
}

/**
 * Pines de alimentación (GND/VCC) de un módulo que no están cableados a nada.
 * Como en la vida real: sin tierra (y sin VCC si lo necesita) el módulo no funciona,
 * aunque su pin de señal sí esté conectado.
 */
export function pinesSinAlimentar(project: Project, instId: string, def: ModuleDef): string[] {
  const sinCable = (p: { name: string }) => {
    const ref = `${instId}.${p.name}`;
    return !project.wires.some((w) => w.from === ref || w.to === ref);
  };
  // Todas las tierras tienen que ir; de las alimentaciones alcanza con una: una placa con
  // regulador tiene VIN (entrada) y 3VO (SALIDA del regulador), y 3VO no hace falta cablearlo.
  const tierras = def.pins.filter((p) => p.kind === 'ground' && sinCable(p)).map((p) => p.name);
  const alimentaciones = def.pins.filter((p) => p.kind === 'power');
  const faltaAlimentacion = alimentaciones.length > 0 && alimentaciones.every(sinCable);
  return def.pins.filter((p) => tierras.includes(p.name) || (faltaAlimentacion && p.kind === 'power')).map((p) => p.name);
}

/** Módulos de un rol del puente, cableados a un GPIO y alimentados (p. ej. el receptor RF listo para recibir). */
export function cableadosConRol(project: Project, rol: string, buscar: BuscarDef): ModuleInstance[] {
  return project.modules.filter((inst) => {
    const def = buscar(inst.type);
    if (def?.bridge?.role !== rol) return false;
    if (gpioDe(project, inst.id, def.bridge.pin, buscar) === null) return false;
    return pinesSinAlimentar(project, inst.id, def).length === 0;
  });
}
