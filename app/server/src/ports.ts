import net from 'node:net';

export const DEFAULT_PORT_BASE = 20000;
export const PORTS_PER_INSTANCE = 4;

/**
 * Reserva N puertos TCP libres a partir de `base`, ligados solo a 127.0.0.1.
 *
 * Nunca asumir puertos fijos (el 8080 está ocupado en esta PC): se abre un
 * servidor en el puerto, se cierra y se devuelve. La comprobación real la
 * hace bind: si algo se lo adjudica entremedio, esp-emu avisa
 * ("bind TCP ... failed: Address already in use") y el llamador reintenta.
 */
export async function reservePorts(count = PORTS_PER_INSTANCE, base = DEFAULT_PORT_BASE): Promise<number[]> {
  if (count <= 0) throw new Error('reservePorts: count debe ser > 0');
  const taken = new Set<number>();
  const servers: net.Server[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = await bindFirstFree(base, taken);
      servers.push(server);
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        throw new Error('reservePorts: no se pudo obtener el puerto reservado');
      }
      taken.add(addr.port);
    }
    return [...taken];
  } finally {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }
}

async function bindFirstFree(base: number, taken: Set<number>): Promise<net.Server> {
  const LAST = 65535 - PORTS_PER_INSTANCE;
  for (let port = base; port <= LAST; port++) {
    if (taken.has(port)) continue;
    const server = net.createServer();
    const ok = await tryListen(server, port);
    if (ok) return server;
  }
  throw new Error(`reservePorts: no hay ${taken.size + 1} puertos libres desde ${base}`);
}

function tryListen(server: net.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener('listening', onListening);
      resolve(false);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** ¿Está libre este puerto en 127.0.0.1? */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** Espera a que un puerto esté libre (tras apagar el emulador anterior). */
export async function waitPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
