import { readFile } from 'node:fs/promises';
import { evaluarMedicion } from './mediciones.js';
import { fixtureSintetico } from './fixtureSintetico.js';

/** Desde app/: node --import tsx server/src/evidencia/verificarMediciones.ts archivo.json
 * Demo explícitamente sintética: mismo comando con --sintetico en lugar de archivo.
 * Exit 0 aceptado, 1 rechazo/indeterminado, 2 entrada no evaluable/fuera de dominio.
 * No firma, acredita ni verifica autenticidad de los metadatos declarados.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usá un archivo JSON o --sintetico.');
  const arg = args[0];
  if (!arg) throw new Error('Falta entrada.');
  const entrada: unknown = arg === '--sintetico' ? fixtureSintetico() : JSON.parse(await readFile(arg, 'utf8'));
  const informe = evaluarMedicion(entrada);
  console.log(JSON.stringify(informe, null, 2));
  process.exitCode = informe.estado === 'aceptado' ? 0 : ['rechazado', 'indeterminado'].includes(informe.estado) ? 1 : 2;
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ estado: 'no-evaluable', certificacion: false, diagnosticos: [error instanceof Error ? error.message : String(error)] }));
  process.exitCode = 2;
});
