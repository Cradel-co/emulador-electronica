// Resaltado de sintaxis del editor (colores del tema oscuro de Android Studio / IntelliJ).
// Sin dependencias: una sola regex por lenguaje que recorre el texto una vez. El
// textarea queda arriba (transparente, con el cursor) y esto se pinta en un <pre> abajo.

const KW_C = [
  'auto', 'bool', 'break', 'case', 'char', 'class', 'const', 'constexpr', 'continue', 'default', 'delete',
  'do', 'double', 'else', 'enum', 'extern', 'false', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'namespace', 'new', 'nullptr', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'template', 'this', 'true', 'typedef', 'typename', 'union', 'unsigned',
  'using', 'virtual', 'void', 'volatile', 'while', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t',
  'int16_t', 'int32_t', 'int64_t', 'size_t', 'NULL', 'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP',
];
const KW_PY = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'self', 'print',
];

// Cada regex usa grupos con nombre: el nombre del grupo que matcheó es la clase CSS (`t-<nombre>`).
// `pre` es un prefijo que se deja sin color (p. ej. la sangría antes de una clave YAML).
const REGLAS = {
  yaml: new RegExp(
    [
      String.raw`(?<com>(?:^|(?<=\s))#[^\n]*)`,
      String.raw`(?<str>"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`,
      String.raw`(?<pre>^[ \t]*(?:- )?)(?<key>[\w.\-]+)(?=[ \t]*:(?:[ \t]|$))`,
      String.raw`(?<tag>![\w]+)`,
      String.raw`\b(?<kw>true|false|yes|no|on|off|null)\b`,
      String.raw`(?<num>-?\b\d+(?:\.\d+)?(?:ms|s|min|h|Hz|kHz|MHz|V|mA|%)?\b)`,
    ].join('|'),
    'gm',
  ),
  c: new RegExp(
    [
      String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))`,
      String.raw`(?<str>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`,
      String.raw`(?<pp>^[ \t]*#[ \t]*\w+)`,
      String.raw`\b(?<num>0[xX][0-9a-fA-F]+[uUlL]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]*)\b`,
      String.raw`\b(?<kw>${KW_C.join('|')})\b`,
      String.raw`\b(?<fn>[A-Za-z_]\w*)(?=\s*\()`,
      String.raw`\b(?<const>[A-Z][A-Z0-9_]{2,})\b`,
    ].join('|'),
    'gm',
  ),
  python: new RegExp(
    [
      String.raw`(?<com>#[^\n]*)`,
      String.raw`(?<str>"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[bfr]?"(?:[^"\\\n]|\\.)*"|[bfr]?'(?:[^'\\\n]|\\.)*')`,
      String.raw`(?<dec>^[ \t]*@[\w.]+)`,
      String.raw`\b(?<num>0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b`,
      String.raw`\b(?<kw>${KW_PY.join('|')})\b`,
      String.raw`\b(?<fn>[A-Za-z_]\w*)(?=\s*\()`,
      String.raw`\b(?<const>[A-Z][A-Z0-9_]{2,})\b`,
    ].join('|'),
    'gm',
  ),
  cmake: new RegExp(
    [
      String.raw`(?<com>#[^\n]*)`,
      String.raw`(?<str>"(?:[^"\\\n]|\\.)*")`,
      String.raw`(?<fn>^[ \t]*\w+)(?=\s*\()`,
      String.raw`(?<const>\$\{[^}]*\}|\b[A-Z][A-Z0-9_]{2,}\b)`,
    ].join('|'),
    'gm',
  ),
};

/** Lenguaje de resaltado según la extensión del archivo. */
export function lenguajeDeArchivo(ruta) {
  const r = String(ruta ?? '').toLowerCase();
  if (/\.ya?ml$/.test(r)) return 'yaml';
  if (/\.(c|h|cpp|hpp|cc|ino)$/.test(r)) return 'c';
  if (/\.py$/.test(r)) return 'python';
  if (/cmakelists\.txt$|\.cmake$/.test(r)) return 'cmake';
  if (/sdkconfig|\.defaults$|\.txt$/.test(r)) return 'cmake'; // comentarios con # y MAYÚSCULAS
  return 'texto';
}

/** Nombre para mostrar en la barra de estado. */
export const NOMBRE_LENGUAJE = { yaml: 'YAML', c: 'C/C++', python: 'Python', cmake: 'CMake', texto: 'Texto' };

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

/** HTML resaltado de `texto`. Siempre termina en "\n" para que la última línea vacía tenga alto. */
export function resaltar(texto, lenguaje) {
  const re = REGLAS[lenguaje];
  if (!re) return esc(texto) + '\n';
  re.lastIndex = 0;
  let html = '';
  let ultimo = 0;
  for (let m = re.exec(texto); m; m = re.exec(texto)) {
    if (m[0] === '') {
      re.lastIndex++; // una alternativa vacía no puede trabar el recorrido
      continue;
    }
    html += esc(texto.slice(ultimo, m.index));
    const g = /** @type {Record<string, string | undefined>} */ (m.groups);
    if (g.pre !== undefined) {
      html += esc(g.pre) + `<span class="t-key">${esc(/** @type {string} */ (g.key))}</span>`;
    } else {
      for (const nombre in g) {
        if (g[nombre] !== undefined) {
          html += `<span class="t-${nombre}">${esc(m[0])}</span>`;
          break;
        }
      }
    }
    ultimo = m.index + m[0].length;
  }
  return html + esc(texto.slice(ultimo)) + '\n';
}
