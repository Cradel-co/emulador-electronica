import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { crearServidorMcp, type McpContexto } from '../mcp.js';

export function registrarRutasMcp(app: FastifyInstance, contexto: McpContexto): void {
  app.post('/mcp', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const server = crearServidorMcp(contexto);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (error) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (error as Error).message }, id: null }));
      }
    }
  });

  // El transporte no mantiene sesión: solo acepta solicitudes POST.
  const sinSesion = async (_req: unknown, reply: { code(status: number): { send(body: unknown): void } }): Promise<void> => {
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido (MCP sin sesión: usar POST)' }, id: null });
  };
  app.get('/mcp', sinSesion);
  app.delete('/mcp', sinSesion);
}
