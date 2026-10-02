import ts from 'typescript';

/**
 * El código de un módulo está escrito en TypeScript (`model.ts`). El server lo pasa a JavaScript
 * al cargarlo y ese JavaScript es lo que corre en el sandbox (sim/sandbox.ts).
 *
 * Solo se quitan los tipos (`transpileModule`): no se resuelve ningún import ni se chequean los
 * tipos, así que es rápido y no ejecuta nada del módulo. Los tipos se verifican aparte, con el
 * `tsconfig.json` de `modules/` (`npm run typecheck:modulos`, y el test del catálogo).
 *
 * Un módulo no puede importar nada en tiempo de ejecución: el sandbox no tiene `require`. Sí puede
 * (y debe) importar tipos: `import type { ModeloModulo } from '@emu/shared'` se borra al transpilar.
 */

export class ErrorTranspilar extends Error {}

export const esTypeScript = (archivo: string): boolean => /\.ts$/.test(archivo);

export function transpilarModelo(codigo: string, archivo: string): string {
  const r = ts.transpileModule(codigo, {
    fileName: archivo,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      isolatedModules: true,
      sourceMap: false,
      importHelpers: false,
      // Un import que solo trae tipos se borra aunque no diga `import type`.
      verbatimModuleSyntax: false,
    },
  });
  const errores = (r.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errores.length > 0) {
    const d = errores[0]!;
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 200);
    const linea = d.file && d.start !== undefined ? ` (línea ${d.file.getLineAndCharacterOfPosition(d.start).line + 1})` : '';
    throw new ErrorTranspilar(`${archivo}${linea}: ${msg}`);
  }
  if (/\brequire\s*\(/.test(r.outputText)) {
    throw new ErrorTranspilar(`${archivo}: un módulo no puede importar nada en tiempo de ejecución (solo \`import type\`)`);
  }
  return r.outputText;
}
