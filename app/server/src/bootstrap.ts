import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'node:http';

export interface OpcionesArranqueServidor {
  app: FastifyInstance;
  host: string;
  port: number;
  registrarRutas(app: FastifyInstance, pluginEstatico: typeof import('@fastify/static').default): Promise<void>;
  conectarWebSocket(server: Server): void;
  inicializar(): Promise<void>;
  cerrarRecursos(): Promise<void>;
  precalentar(): Promise<void>;
}

export function crearAppServer(): FastifyInstance {
  return Fastify({ logger: false });
}

/** Arranque HTTP y cierre del proceso; las dependencias de dominio las compone el punto de entrada. */
export async function iniciarServidor(opciones: OpcionesArranqueServidor): Promise<{ close: () => Promise<void>; port: number }> {
  const pluginEstatico = (await import('@fastify/static')).default;
  await opciones.inicializar();
  await opciones.registrarRutas(opciones.app, pluginEstatico);

  await opciones.app.listen({ port: opciones.port, host: opciones.host });
  opciones.conectarWebSocket(opciones.app.server);
  console.log(`Emulador listo en http://${opciones.host}:${opciones.port}`);
  void opciones.precalentar().catch(error => console.error(`[motor eléctrico] no arrancó: ${(error as Error).message}`));

  const close = async (): Promise<void> => {
    await opciones.cerrarRecursos();
    await opciones.app.close();
  };
  const shutdown = async (): Promise<void> => {
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  return { close, port: opciones.port };
}
