import ts from 'typescript';

/**
 * Compila solo a texto: la ejecución sigue dentro del sandbox sin imports del host.
 *
 * Solo se quitan los tipos (`transpileModule`): no se resuelve ningún import ni se chequean los
 * tipos, así que es rápido y no ejecuta nada del módulo. Un `import type` se borra al transpilar;
 * un import en tiempo de ejecución deja un `require` y se rechaza acá (el sandbox no tiene
 * `require`). Los tipos se verifican aparte, con el `tsconfig.json` de `modules/` (`npm run
 * typecheck:modulos`, y el test del catálogo).
 */
export function compilarFuente(codigo: string, nombre: string): string {
  if (!nombre.endsWith('.ts')) return codigo;
  const r = ts.transpileModule(codigo, {
    fileName: nombre,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
      sourceMap: false,
      importHelpers: false,
      verbatimModuleSyntax: false,
    },
  });
  const errores = (r.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errores.length > 0) {
    const d = errores[0]!;
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 200);
    const linea = d.file && d.start !== undefined ? ` (línea ${d.file.getLineAndCharacterOfPosition(d.start).line + 1})` : '';
    throw new Error(`${nombre}${linea}: ${msg}`);
  }
  if (/\brequire\s*\(/.test(r.outputText)) {
    throw new Error(`${nombre}: un módulo no puede importar nada en tiempo de ejecución (solo \`import type\`)`);
  }
  return r.outputText;
}
