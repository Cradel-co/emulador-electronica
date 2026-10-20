import { ServerEventSchema, type ServerEvent } from '@emu/shared';

/** Sólo necesita la salida del socket: la sesión y su seguridad quedan en el adaptador. */
export interface ClienteEventos {
  readonly readyState: number;
  send(contenido: string): void;
}

export function crearTransporteEventos(clientes: Iterable<ClienteEventos>, registrar: (linea: string) => void) {
  function enviar(contenido: string): void {
    for (const cliente of clientes) if (cliente.readyState === 1) cliente.send(contenido);
  }
  function log(linea: string): void {
    registrar(linea);
    enviar(JSON.stringify({ type: 'emu.log', line: linea } satisfies ServerEvent));
  }
  function publicar(evento: ServerEvent): void {
    const parsed = ServerEventSchema.safeParse(evento);
    if (!parsed.success) {
      log(`evento inválido: ${parsed.error.message}`);
      return;
    }
    enviar(JSON.stringify(parsed.data));
  }
  return { publicar, log };
}
