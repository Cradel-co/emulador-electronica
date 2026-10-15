/**
 * Junta los fragmentos de `changelog.d/` en un bloque de CHANGELOG.md. Se corre al cerrar una
 * versión; durante el desarrollo cada rama solo agrega su archivo.
 *
 *   npm run changelog -- 0.2.0            # imprime el bloque
 *   npm run changelog -- 0.2.0 --escribir # lo pone arriba de CHANGELOG.md y borra los fragmentos
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.js';
import { armarChangelog, leerFragmento, type Fragmento } from './changelog.js';

const DIR = path.join(PATHS.root, 'changelog.d');
const DESTINO = path.join(PATHS.root, 'CHANGELOG.md');

function main(): void {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--'));
  const escribir = args.includes('--escribir');
  if (!version) {
    console.error('Falta la versión: npm run changelog -- 0.2.0 [--escribir]');
    process.exit(2);
  }
  if (!existsSync(DIR)) {
    console.error(`No existe ${DIR}.`);
    process.exit(2);
  }

  const archivos = readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  const fragmentos: Fragmento[] = [];
  const errores: string[] = [];
  for (const a of archivos) {
    const r = leerFragmento(a, readFileSync(path.join(DIR, a), 'utf8'));
    if (r.fragmento) fragmentos.push(r.fragmento);
    errores.push(...r.errores);
  }
  if (errores.length > 0) {
    console.error('Fragmentos con problemas:\n' + errores.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }

  const fecha = new Date().toISOString().slice(0, 10);
  const bloque = armarChangelog(fragmentos, { version, fecha });
  if (!escribir) {
    process.stdout.write(bloque);
    return;
  }

  const anterior = existsSync(DESTINO) ? readFileSync(DESTINO, 'utf8') : '';
  const cabecera = '# Changelog\n\nLas entradas se escriben durante el desarrollo en `changelog.d/`.\nVer `changelog.d/README.md`.\n';
  const cuerpo = anterior.startsWith('# Changelog') ? anterior.slice(anterior.indexOf('\n## ')) : anterior;
  writeFileSync(DESTINO, `${cabecera}\n${bloque}${cuerpo}`);
  for (const a of archivos) rmSync(path.join(DIR, a));
  console.log(`CHANGELOG.md actualizado con ${fragmentos.length} entradas; ${archivos.length} fragmentos consumidos.`);
}

main();
