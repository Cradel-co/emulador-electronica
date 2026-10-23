import { parser } from '@lezer/python';

type Nodo = ReturnType<typeof parser.parse>['topNode'];
export type Expresion = { tipo: 'literal'; valor: number | string | boolean | null }
  | { tipo: 'nombre'; nombre: string } | { tipo: 'miembro'; objeto: Expresion; nombre: string }
  | { tipo: 'llamada'; funcion: Expresion; argumentos: Expresion[] }
  | { tipo: 'binaria'; op: string; a: Expresion; b: Expresion }
  | { tipo: 'unaria'; op: string; valor: Expresion }
  | { tipo: 'condicion'; condicion: Expresion; si: Expresion; no: Expresion };
export type Instruccion = { linea: number } & (
  { tipo: 'asignar'; nombre: string; valor: Expresion } | { tipo: 'evaluar'; valor: Expresion }
  | { tipo: 'saltar'; destino: number } | { tipo: 'condicion'; valor: Expresion; destino: number });
export interface ProgramaPropio { instrucciones: Instruccion[]; imports: string[]; pines: { gpio: number; salida: boolean; pull?: 'up' | 'down' }[] }
export class ErrorProgramaPropio extends Error {
  constructor(mensaje: string, readonly linea: number) { super(`main.py:${linea}: ${mensaje}`); }
}
const hijos = (n: Nodo) => { const r: Nodo[] = []; for (let h = n.firstChild; h; h = h.nextSibling) r.push(h); return r; };

/** Adaptador sintáctico. El árbol de Lezer no sale de este archivo y nunca se evalúa como JS. */
export function compilarProgramaPropio(fuente: string): ProgramaPropio {
  if (Buffer.byteLength(fuente) > 64 * 1024) throw new ErrorProgramaPropio('El motor propio admite hasta 64 KiB en main.py.', 1);
  const arbol = parser.parse(fuente), instrucciones: Instruccion[] = [], imports: string[] = [];
  const linea = (n: Nodo) => fuente.slice(0, n.from).split('\n').length;
  const texto = (n: Nodo) => fuente.slice(n.from, n.to);
  const error = (n: Nodo, mensaje: string): never => { throw new ErrorProgramaPropio(mensaje, linea(n)); };
  const requerido = (n: Nodo, i: number): Nodo => hijos(n)[i] ?? error(n, 'Expresión incompleta.');
  const pines: ProgramaPropio['pines'] = [], constantes = new Map<string, number>();
  let cantidad = 0;
  const expr = (n: Nodo, profundidad = 0): Expresion => {
    if (++cantidad > 4096 || profundidad > 48) return error(n, 'Programa demasiado complejo.');
    const h = hijos(n), e = (i: number) => expr(requerido(n, i), profundidad + 1);
    switch (n.name) {
      case 'Number': {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(texto(n))) return error(n, 'Solo números decimales finitos.');
        const valor = Number(texto(n)); if (!Number.isFinite(valor) || Math.abs(valor) > Number.MAX_SAFE_INTEGER) return error(n, 'Número fuera de rango.');
        return { tipo: 'literal', valor };
      }
      case 'String': {
        const s = texto(n);
        if (!/^(['"])(?:[^\\\r\n]|\\[\\'"nrt])*\1$/.test(s) || s.length > 1024) return error(n, 'Cadena no soportada (hasta 1024 caracteres, sin interpolación).');
        return { tipo: 'literal', valor: s.slice(1, -1).replace(/\\([\\'"nrt])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c)) };
      }
      case 'Boolean': return { tipo: 'literal', valor: texto(n) === 'True' };
      case 'None': return { tipo: 'literal', valor: null };
      case 'VariableName': return { tipo: 'nombre', nombre: texto(n) };
      case 'MemberExpression': {
        if (h.length !== 3 || h[1]?.name !== '.' || h[2]?.name !== 'PropertyName') return error(n, 'Acceso no soportado.');
        return { tipo: 'miembro', objeto: e(0), nombre: texto(requerido(n, 2)) };
      }
      case 'CallExpression': {
        if (h.length !== 2 || h[1]?.name !== 'ArgList') return error(n, 'Llamada no soportada.');
        const args = hijos(h[1]).filter(a => !['(', ')', ','].includes(a.name));
        const llamada = texto(requerido(n, 0));
        if (['Pin', 'machine.Pin', 'simbridge.pin'].includes(llamada)) {
          if (n.parent?.name !== 'AssignStatement' || n.parent.parent?.name !== 'Script') return error(n, 'Declarar cada Pin una vez, al inicio de main.py.');
          const primero = args[0], modo = args[1], pull = args[2];
          const gpio = primero?.name === 'Number' ? Number(texto(primero)) : primero ? constantes.get(texto(primero)) : undefined;
          const salida = modo && ['Pin.OUT', 'machine.Pin.OUT'].includes(texto(modo));
          if (gpio === undefined || !Number.isInteger(gpio) || gpio < 0 || gpio > 48 || pines.some(p => p.gpio === gpio)
            || (llamada !== 'simbridge.pin' && (!modo || !['Pin.OUT', 'Pin.IN', 'machine.Pin.OUT', 'machine.Pin.IN'].includes(texto(modo))))) return error(n, 'Pin exige GPIO constante único y modo IN/OUT explícito.');
          pines.push({ gpio, salida: Boolean(salida), ...(llamada === 'simbridge.pin' ? { pull: 'up' as const }
            : pull ? { pull: texto(pull).endsWith('PULL_UP') ? 'up' as const : 'down' as const } : {}) });
        }
        if (args.length > 16) return error(n, 'Hasta 16 argumentos posicionales.');
        return { tipo: 'llamada', funcion: e(0), argumentos: args.map(a => expr(a, profundidad + 1)) };
      }
      case 'ParenthesizedExpression': return e(1);
      case 'UnaryExpression': {
        const op = texto(requerido(n, 0)); if (!['not', '-', '+'].includes(op)) return error(n, `Operador no soportado: ${op}`);
        return { tipo: 'unaria', op, valor: e(1) };
      }
      case 'BinaryExpression': {
        const op = texto(requerido(n, 1));
        if (h.length !== 3 || !['+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(op)) return error(n, `Operador no soportado: ${op}`);
        return { tipo: 'binaria', op, a: e(0), b: e(2) };
      }
      case 'ConditionalExpression': return { tipo: 'condicion', si: e(0), condicion: e(2), no: e(4) };
      default: return error(n, `Sintaxis aún no soportada por el motor propio: ${n.name}.`);
    }
  };
  const emitir = (i: Instruccion) => { if (instrucciones.length >= 4096) throw new ErrorProgramaPropio('Hasta 4096 instrucciones.', i.linea); instrucciones.push(i); };
  const bloque = (n: Nodo, bucle?: { salida: number[]; inicio: number }, nivel = 0): void => {
    if (nivel > 32) return error(n, 'Demasiados bloques anidados.');
    for (const s of hijos(n)) {
      if ([':', 'Comment'].includes(s.name)) continue;
      const l = linea(s), h = hijos(s);
      if (s.name === 'ImportStatement') {
        const contenido = texto(s).trim();
        if (!['import time', 'import machine', 'import simbridge', 'from machine import Pin', 'from time import sleep', 'from time import sleep_ms'].includes(contenido) || nivel !== 0 || instrucciones.length > 0) return error(s, `Import no soportado: ${contenido}`);
        imports.push(contenido); continue;
      }
      if (s.name === 'AssignStatement') {
        if (h.length !== 3 || h[0]?.name !== 'VariableName' || texto(requerido(s, 1)) !== '=') return error(s, 'Solo asignaciones simples a nombres.');
        const nombre = texto(requerido(s, 0));
        if (['Pin', 'time', 'machine', 'simbridge', 'sleep', 'sleep_ms', 'print'].includes(nombre)) return error(s, 'No se pueden redefinir las APIs del motor.');
        const valor = expr(requerido(s, 2));
        if (nivel === 0 && valor.tipo === 'literal' && typeof valor.valor === 'number') constantes.set(nombre, valor.valor);
        emitir({ tipo: 'asignar', nombre, valor, linea: l }); continue;
      }
      if (s.name === 'ExpressionStatement') { if (h.length !== 1) return error(s, 'Una expresión por sentencia.'); emitir({ tipo: 'evaluar', valor: expr(requerido(s, 0)), linea: l }); continue; }
      if (s.name === 'PassStatement') continue;
      if (s.name === 'WhileStatement') {
        if (h.length !== 3) return error(s, 'while/else no soportado.');
        const inicio = instrucciones.length, salida: number[] = [];
        emitir({ tipo: 'condicion', valor: expr(requerido(s, 1)), destino: -1, linea: l });
        bloque(requerido(s, 2), { inicio, salida }, nivel + 1);
        emitir({ tipo: 'saltar', destino: inicio, linea: l });
        const condicion = instrucciones[inicio]; if (condicion?.tipo === 'condicion') condicion.destino = instrucciones.length;
        for (const i of salida) { const salto = instrucciones[i]; if (salto?.tipo === 'saltar') salto.destino = instrucciones.length; }
        continue;
      }
      if (s.name === 'IfStatement') {
        const finales: number[] = [];
        for (let i = 0; i < h.length;) {
          const palabra = h[i]?.name;
          if (palabra === 'if' || palabra === 'elif') {
            const condicion = h[i + 1], cuerpo = h[i + 2]; if (!condicion || cuerpo?.name !== 'Body') return error(s, 'if incompleto.');
            const indice = instrucciones.length; emitir({ tipo: 'condicion', valor: expr(condicion), destino: -1, linea: l });
            bloque(cuerpo, bucle, nivel + 1); finales.push(instrucciones.length); emitir({ tipo: 'saltar', destino: -1, linea: l });
            const salto = instrucciones[indice]; if (salto?.tipo === 'condicion') salto.destino = instrucciones.length;
            i += 3;
          } else if (palabra === 'else') { const cuerpo = h[i + 1]; if (cuerpo?.name !== 'Body') return error(s, 'else incompleto.'); bloque(cuerpo, bucle, nivel + 1); i += 2; }
          else return error(s, 'Rama no soportada.');
        }
        for (const i of finales) { const salto = instrucciones[i]; if (salto?.tipo === 'saltar') salto.destino = instrucciones.length; } continue;
      }
      if (s.name === 'BreakStatement' || s.name === 'ContinueStatement') {
        if (!bucle) return error(s, 'break/continue fuera de un bucle.');
        if (s.name === 'BreakStatement') bucle.salida.push(instrucciones.length);
        emitir({ tipo: 'saltar', destino: s.name === 'ContinueStatement' ? bucle.inicio : -1, linea: l }); continue;
      }
      return error(s, `Sentencia aún no soportada por el motor propio: ${s.name}.`);
    }
  };
  const cursor = arbol.cursor(); do { if (cursor.type.isError) throw new ErrorProgramaPropio('Sintaxis Python inválida.', fuente.slice(0, cursor.from).split('\n').length); } while (cursor.next());
  bloque(arbol.topNode);
  if (!instrucciones.length) throw new ErrorProgramaPropio('El programa no tiene instrucciones ejecutables.', 1);
  return { instrucciones, imports, pines };
}

interface Pin { tipo: 'pin'; gpio: number; modo: 'entrada' | 'salida'; nivel: 0 | 1 }
interface Referencia { tipo: 'api'; nombre: string; pin?: Pin }
type Valor = number | string | boolean | null | Pin | Referencia;
export interface PuertosProgramaPropio { leer(gpio: number): 0 | 1 | null; escribir(gpio: number, nivel: 0 | 1): void; log(linea: string): void }
/** Intérprete de instrucciones propias, sin eval, filesystem, red ni objetos del host. */
export class EjecutorProgramaPropio {
  private pc = 0;
  private readonly variables = new Map<string, Valor>();
  private linea = 1;
  private espera: number | null = null;
  private logs = 0;
  private pasosSinEspera = 0;
  private cambioElectrico = false;
  private readonly pines = new Map<number, Pin>();
  constructor(private readonly programa: ProgramaPropio, private readonly puertos: PuertosProgramaPropio, private readonly permitidos: ReadonlySet<number>) {
    const api = (nombre: string): Referencia => ({ tipo: 'api', nombre });
    this.variables.set('print', api('print'));
    for (const i of programa.imports) {
      if (i === 'from machine import Pin') this.variables.set('Pin', api('Pin'));
      if (i.startsWith('import ')) this.variables.set(i.slice(7), api(i.slice(7)));
      if (i.startsWith('from time import ')) { const nombre = i.slice(17); this.variables.set(nombre, api(`time.${nombre}`)); }
    }
  }
  private fallo(m: string): never { throw new ErrorProgramaPropio(m, this.linea); }
  private numero(v: Valor): number { return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : this.fallo('Se esperaba un número finito.'); }
  private evaluar(e: Expresion): Valor {
    switch (e.tipo) {
      case 'literal': return e.valor;
      case 'nombre': return this.variables.has(e.nombre) ? this.variables.get(e.nombre) ?? null : this.fallo(`Nombre o API no soportada: ${e.nombre}`);
      case 'miembro': {
        const objeto = this.evaluar(e.objeto);
        if (typeof objeto !== 'object' || objeto === null) return this.fallo('Acceso a atributo no soportado.');
        if (objeto.tipo === 'pin') return { tipo: 'api', nombre: e.nombre, pin: objeto };
        const nombre = `${objeto.nombre}.${e.nombre}`;
        if (nombre === 'machine.Pin') return { tipo: 'api', nombre: 'Pin' };
        if (['Pin.IN', 'Pin.OUT', 'Pin.PULL_UP', 'Pin.PULL_DOWN'].includes(nombre)) return nombre;
        if (['time.sleep', 'time.sleep_ms', 'simbridge.pin'].includes(nombre)) return { tipo: 'api', nombre };
        return this.fallo(`API no soportada: ${nombre}`);
      }
      case 'condicion': return this.evaluar(this.evaluar(e.condicion) ? e.si : e.no);
      case 'unaria': { const v = this.evaluar(e.valor); return e.op === 'not' ? !v : e.op === '-' ? -this.numero(v) : this.numero(v); }
      case 'binaria': {
        const a = this.evaluar(e.a);
        if (e.op === 'and') return a ? this.evaluar(e.b) : a;
        if (e.op === 'or') return a ? a : this.evaluar(e.b);
        const b = this.evaluar(e.b);
        if (e.op === '==' || e.op === '!=') {
          const iguales = (typeof a === 'boolean' || typeof a === 'number') && (typeof b === 'boolean' || typeof b === 'number') ? Number(a) === Number(b) : a === b;
          return e.op === '==' ? iguales : !iguales;
        }
        const x = this.numero(a), y = this.numero(b);
        if (e.op === '<') return x < y; if (e.op === '>') return x > y; if (e.op === '<=') return x <= y; if (e.op === '>=') return x >= y;
        const r = e.op === '+' ? x + y : e.op === '-' ? x - y : e.op === '*' ? x * y : e.op === '/' ? x / y : x % y;
        return Number.isFinite(r) && Math.abs(r) <= Number.MAX_SAFE_INTEGER ? r : this.fallo('Resultado aritmético fuera de rango.');
      }
      case 'llamada': {
        const f = this.evaluar(e.funcion), a = e.argumentos.map(x => this.evaluar(x));
        if (typeof f !== 'object' || f?.tipo !== 'api') return this.fallo('Llamada no soportada.');
        if (f.pin) {
          const p = f.pin;
          if (!['value', 'on', 'off'].includes(f.nombre)) return this.fallo(`Método Pin no soportado: ${f.nombre}`);
          if (f.nombre === 'value' && !a.length) {
            const nivel = p.modo === 'salida' ? p.nivel : this.puertos.leer(p.gpio);
            return nivel === null ? this.fallo(`GPIO${p.gpio} sin nivel eléctrico referenciado (X).`) : nivel;
          }
          if (p.modo !== 'salida' || (f.nombre === 'value' ? a.length !== 1 : a.length !== 0)) return this.fallo('Escritura o argumentos de Pin inválidos.');
          const v = f.nombre === 'on' ? 1 : f.nombre === 'off' ? 0 : this.numero(a[0] ?? null);
          if (v !== 0 && v !== 1) return this.fallo('El drive digital exige 0 o 1.');
          if (p.nivel !== v) { p.nivel = v; this.cambioElectrico = true; this.puertos.escribir(p.gpio, v); } return null;
        }
        if (f.nombre === 'Pin' || f.nombre === 'simbridge.pin') {
          const gpio = this.numero(a[0] ?? null), modo = f.nombre === 'simbridge.pin' ? 'Pin.IN' : a[1];
          if (!Number.isInteger(gpio) || !this.permitidos.has(gpio) || !this.programa.pines.some(p => p.gpio === gpio && p.salida === (modo === 'Pin.OUT')) || (modo !== 'Pin.IN' && modo !== 'Pin.OUT') || (f.nombre === 'simbridge.pin' ? a.length !== 1 : a.length < 2 || a.length > 3)
            || (a.length === 3 && !['Pin.PULL_UP', 'Pin.PULL_DOWN'].includes(String(a[2])))) return this.fallo('GPIO, modo o argumentos Pin no soportados.');
          if (this.pines.has(gpio)) return this.fallo(`GPIO${gpio} declarado dos veces.`);
          const p: Pin = { tipo: 'pin', gpio, modo: modo === 'Pin.OUT' ? 'salida' : 'entrada', nivel: 0 };
          this.pines.set(gpio, p); if (p.modo === 'salida') { this.cambioElectrico = true; this.puertos.escribir(gpio, 0); } return p;
        }
        if (f.nombre === 'time.sleep' || f.nombre === 'time.sleep_ms') {
          const ms = this.numero(a[0] ?? null) * (f.nombre === 'time.sleep' ? 1000 : 1);
          if (a.length !== 1 || !Number.isSafeInteger(ms) || ms < 10 || ms > 60_000 || this.espera !== null) return this.fallo('sleep requiere de 10 a 60000 ms enteros y una llamada por instrucción.');
          this.espera = ms; return null;
        }
        if (f.nombre === 'print') {
          if (++this.logs > 16) return this.fallo('Demasiadas líneas de consola sin esperar.');
          this.puertos.log(a.map(v => typeof v === 'object' && v !== null ? this.fallo('print admite solo valores escalares.') : v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v)).join(' ')); return null;
        }
        return this.fallo(`API no soportada: ${f.nombre}`);
      }
    }
  }
  /** Ejecuta hasta dormir o terminar. Un bucle sin espera falla por presupuesto. */
  avanzar(cederPorSalida = false): { esperaMs: number | null; terminado: boolean; cambioElectrico: boolean } {
    if (this.espera !== null) { this.pasosSinEspera = 0; this.logs = 0; }
    this.espera = null; this.cambioElectrico = false;
    for (; this.pc < this.programa.instrucciones.length;) {
      if (this.pasosSinEspera++ >= 1000) this.fallo('Presupuesto de instrucciones agotado; agregá una espera al bucle.');
      const i = this.programa.instrucciones[this.pc++]; if (!i) break; this.linea = i.linea;
      if (i.tipo === 'saltar') this.pc = i.destino;
      else if (i.tipo === 'condicion') { if (!this.evaluar(i.valor)) this.pc = i.destino; }
      else if (i.tipo === 'evaluar') this.evaluar(i.valor);
      else { if (!this.variables.has(i.nombre) && this.variables.size >= 256) this.fallo('Hasta 256 variables.'); this.variables.set(i.nombre, this.evaluar(i.valor)); }
      if (this.espera !== null || (cederPorSalida && this.cambioElectrico)) return { esperaMs: this.espera, terminado: false, cambioElectrico: this.cambioElectrico };
    }
    return { esperaMs: null, terminado: true, cambioElectrico: this.cambioElectrico };
  }
}
