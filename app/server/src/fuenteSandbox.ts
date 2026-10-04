import ts from 'typescript';
/** Compila solo a texto: la ejecución sigue dentro del sandbox sin imports del host. */
export function compilarFuente(codigo: string, nombre: string): string {
  if (!nombre.endsWith('.ts')) return codigo;
  const r = ts.transpileModule(codigo, { fileName: nombre, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const errores = r.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errores.length) throw new Error(errores.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; '));
  return r.outputText;
}
