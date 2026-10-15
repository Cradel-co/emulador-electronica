import type { ProjectBoard } from './project-boards.js';
export interface GpioDestination { boardId: string; gpio: number }
interface Module { id: string; type: string }
interface Wire { from: string; to: string }
type Definition = { board?: { pins?: Record<string, { gpio?: number }> }; passthrough?: boolean; pins?: { name: string }[] };
export function gpioEnPlaca(ref: string, boards: ProjectBoard[], catalog: ReadonlyMap<string, Definition>): GpioDestination | null {
  const dot = ref.indexOf('.');
  const id = ref.slice(0, dot);
  const board = boards.find(b => b.id === id);
  if (!board || dot < 1) return null;
  const pin = ref.slice(dot + 1);
  const descriptor = catalog.get(board.board)?.board;
  if (descriptor?.pins) {
    const gpio = descriptor.pins[pin]?.gpio;
    return typeof gpio === 'number' ? { boardId: id, gpio } : null;
  }
  const match = /^(?:GPIO|D)(\d{1,2})$/.exec(pin);
  return match ? { boardId: id, gpio: Number(match[1]) } : null;
}
/** Sigue cableado y pasivos de paso sin perder la identidad de la placa que conduce el GPIO. */
export function destinoGpio(ref: string, modules: Module[], wires: Wire[], boards: ProjectBoard[], catalog: ReadonlyMap<string, Definition>, visited = new Set<string>()): GpioDestination | null {
  const own = gpioEnPlaca(ref, boards, catalog);
  if (own) return own;
  if (visited.has(ref)) return null;
  visited.add(ref);
  for (const wire of wires) {
    if (wire.from !== ref && wire.to !== ref) continue;
    const other = wire.from === ref ? wire.to : wire.from;
    const direct = gpioEnPlaca(other, boards, catalog);
    if (direct) return direct;
    const dot = other.indexOf('.');
    const instance = modules.find(m => m.id === other.slice(0, dot));
    const definition = instance && catalog.get(instance.type);
    if (!definition?.passthrough || definition.pins?.length !== 2) continue;
    const next = definition.pins.find(p => p.name !== other.slice(dot + 1));
    if (next && instance) {
      const result = destinoGpio(`${instance.id}.${next.name}`, modules, wires, boards, catalog, visited);
      if (result) return result;
    }
  }
  return null;
}
