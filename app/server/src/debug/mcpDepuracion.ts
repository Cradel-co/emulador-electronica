import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Depurador } from './depurador.js';
import type { TipoEvento } from './grabadora.js';
import { TIPOS_EVENTO } from './rutas.js';

/**
 * Herramientas MCP del modo debug: para que un agente de IA depure el firmware que
 * corre en el emulador sin mirar la UI. Las descripciones le explican cómo usarlas.
 */

type Resultado = { content: { type: 'text'; text: string }[]; isError?: boolean };
const json = (titulo: string, datos: unknown): Resultado => ({ content: [{ type: 'text', text: `${titulo}\n${JSON.stringify(datos, null, 2)}` }] });
const falla = (t: string): Resultado => ({ content: [{ type: 'text', text: t }], isError: true });

function seguro<A>(fn: (a: A) => Promise<Resultado>): (a: A) => Promise<Resultado> {
  return async (a) => {
    try {
      return await fn(a);
    } catch (err) {
      return falla(`Error: ${(err as Error).message}`);
    }
  };
}

export const INSTRUCCIONES_DEBUG =
  'Depuración (siempre activa): debug_snapshot da TODO el estado en un JSON (pines, circuito con corrientes, consola, errores ' +
  'detectados, variables del firmware); debug_trace dice qué pasó y cuándo (cambios de pin, consola, errores); debug_variables / ' +
  'debug_evaluate leen variables del programa; debug_set_breakpoints + debug_control (pause/continue/next/stepIn/stepOut) para ' +
  'frenar y avanzar paso a paso (Arduino Uno y ESP32 con C/C++/ESPHome; MicroPython solo variables).';

export function registrarHerramientasDepuracion(server: McpServer, dep: Depurador): void {
  server.registerTool(
    'debug_snapshot',
    {
      title: 'Depurar: instantánea del estado completo',
      description:
        'EMPEZÁ POR ACÁ para depurar. Devuelve en un solo JSON todo el estado actual de la simulación: proyecto/placa/lenguaje, estado ' +
        'del emulador (y si el depurador lo tiene pausado), cada GPIO con su nivel de salida (firmware) y de entrada (lo que puso la app) ' +
        'y qué módulo está conectado, el circuito con la Ley de Ohm (corriente por rama, LEDs, avisos de sobrecorriente), las últimas ' +
        'líneas de la consola, los errores detectados (Traceback de MicroPython con archivo:línea, Guru Meditation/abort/assert del ' +
        'ESP32 con el backtrace traducido a función y línea), la última compilación y las variables globales del firmware con sus valores ' +
        '(MicroPython: globales de main.py; Arduino Uno/ESP32: globales y static del código del usuario, con tipo). ' +
        'Si el programa está pausado incluye la pila de llamadas. Con variables=false no toca el firmware (más rápido).',
      inputSchema: {
        variables: z.boolean().default(true).describe('Leer las variables del firmware (en ESP32 frena el chip ~0,2 s)'),
        lineas_consola: z.number().int().min(0).max(300).default(40),
      },
    },
    seguro(async ({ variables, lineas_consola }) => json('Instantánea de depuración:', await dep.instantanea({ variables, lineasSerial: lineas_consola }))),
  );

  server.registerTool(
    'debug_trace',
    {
      title: 'Depurar: qué pasó y cuándo',
      description:
        'Línea de tiempo de la corrida actual (t = ms desde que arrancó), siempre grabando: cambios de pin (direccion salida/entrada, ' +
        'origen firmware/ui/mcp), líneas de consola, mensajes del puente, cambios de estado del emulador, compilación, avisos eléctricos, ' +
        'LEDs que se queman, errores y paradas del depurador. Para seguir lo nuevo: pasá desde = el ultimoSeq de la llamada anterior. ' +
        'Útil para preguntas como "¿el LED se prendió después de apretar el botón?" o "¿cuánto tardó en reaccionar?".',
      inputSchema: {
        desde: z.number().int().min(0).default(0).describe('Solo eventos con seq mayor a este'),
        tipos: z.array(z.enum(TIPOS_EVENTO)).optional().describe('Filtrar por tipo'),
        limite: z.number().int().min(1).max(2000).default(200).describe('Máximo de eventos (los más nuevos)'),
      },
    },
    seguro(async ({ desde, tipos, limite }) => json('Traza:', dep.traza(desde, tipos as TipoEvento[] | undefined, limite))),
  );

  server.registerTool(
    'debug_variables',
    {
      title: 'Depurar: variables del firmware',
      description:
        'Sin ref: devuelve los ámbitos (scopes) con sus variables de primer nivel — "Globales del programa" (las del código del usuario), ' +
        'registros de la CPU, etc. — y, si el programa está pausado, la pila de llamadas. Con ref (el variablesReference > 0 de una ' +
        'variable): expande un struct, arreglo, puntero, lista o dict. En ESP32 leer frena el chip un instante; en el Uno y en ' +
        'MicroPython no. Las variables locales de funciones no se ven (solo globales y static).',
      inputSchema: {
        ref: z.number().int().min(1).optional().describe('variablesReference a expandir'),
        incluir_costosos: z.boolean().default(false).describe('Leer también los ámbitos marcados expensive (globales del framework)'),
      },
    },
    seguro(async ({ ref, incluir_costosos }) => {
      if (ref !== undefined) return json(`Hijos de ${ref}:`, await dep.variables(ref));
      const scopes = await dep.scopes();
      const out: Record<string, unknown> = { estado: dep.estadoEjecucion() };
      for (const s of scopes) {
        out[s.name] = s.expensive && !incluir_costosos ? `(no leído: pasá incluir_costosos=true; ref ${s.variablesReference})` : await dep.variables(s.variablesReference);
      }
      if (dep.estadoEjecucion().status === 'stopped') out.pila = await dep.stackTrace().catch((e: Error) => e.message);
      return json('Variables:', out);
    }),
  );

  server.registerTool(
    'debug_evaluate',
    {
      title: 'Depurar: evaluar una expresión',
      description:
        'Evalúa una expresión en el firmware en ejecución, como el "Watch" de un IDE. C/C++ (Arduino Uno, ESP32 ESP-IDF/Arduino/ESPHome): ' +
        'globales y static por nombre (contador, config.umbral, buffer[3], *ptr, p->campo, loop::ultimo, esphome::App), aritmética y ' +
        'comparaciones, registros con $pc/$sp. MicroPython: cualquier expresión de Python sobre las globales de main.py (len(lista), ' +
        'estado["modo"], sensor.valor) — sin import/exec/open/sleep. Solo lectura.',
      inputSchema: { expresion: z.string().min(1).max(300) },
    },
    seguro(async ({ expresion }) => json(`${expresion} =`, await dep.evaluate(expresion))),
  );

  server.registerTool(
    'debug_set_breakpoints',
    {
      title: 'Depurar: poner breakpoints',
      description:
        'Pone breakpoints (reemplaza los de ese archivo, o todos los de función). Por línea: archivo ("sketch.cpp", "main/main.c", ' +
        '"main.cpp") + lineas. Por función: funciones ["miFuncion"]. Quedan guardados para el proyecto y se aplican solos en cada ' +
        'ejecución (también antes de que arranque). Al frenar en uno, debug_snapshot/debug_variables muestran la pila y los valores; ' +
        'seguí con debug_control. Lista vacía = quitar. Disponible en Arduino Uno (avr8js) y ESP32 con C/C++/ESPHome; no en MicroPython. ' +
        'Si una línea no tiene código, el breakpoint se corre a la siguiente que sí (verified/line lo dicen).',
      inputSchema: {
        archivo: z.string().max(200).optional(),
        lineas: z.array(z.number().int().positive()).max(200).optional(),
        funciones: z.array(z.string().max(200)).max(100).optional(),
        proyecto: z.string().optional().describe('Por defecto, el que está corriendo'),
      },
    },
    seguro(async ({ archivo, lineas, funciones, proyecto }) => {
      if (archivo === undefined && funciones === undefined) return falla('Indicá archivo (+ lineas) o funciones.');
      const bps = await dep.setBreakpoints({ source: archivo, lines: lineas ?? (archivo ? [] : undefined), functions: funciones }, proyecto);
      return json('Breakpoints:', bps);
    }),
  );

  server.registerTool(
    'debug_control',
    {
      title: 'Depurar: pausar, seguir, paso a paso',
      description:
        'pause (frena donde esté), continue (sigue hasta el próximo breakpoint), next (siguiente línea sin entrar a funciones), ' +
        'stepIn (entra a la función que se llama), stepOut (termina la función actual). Con esperar_ms > 0 espera a que vuelva a frenar ' +
        'y devuelve dónde (función, archivo:línea) y la pila. Mientras está pausado el tiempo simulado no avanza (el LED no cambia, el ' +
        'Serial no imprime). Arduino Uno y ESP32 con C/C++/ESPHome; MicroPython no se puede pausar.',
      inputSchema: {
        accion: z.enum(['pause', 'continue', 'next', 'stepIn', 'stepOut']),
        esperar_ms: z.number().int().min(0).max(120_000).default(5000),
      },
    },
    seguro(async ({ accion, esperar_ms }) => {
      let estado = await dep.control(accion);
      if (accion !== 'pause' && esperar_ms > 0 && estado.status === 'running') estado = await dep.esperarParada(esperar_ms);
      const pila = estado.status === 'stopped' ? await dep.stackTrace().catch(() => undefined) : undefined;
      return json(estado.status === 'stopped' ? `Frenado: ${estado.description ?? ''}` : 'Corriendo:', { estado, ...(pila ? { pila } : {}) });
    }),
  );

  server.registerTool(
    'debug_stack',
    {
      title: 'Depurar: pila de llamadas',
      description:
        'Pila de llamadas (función, archivo:línea) del programa. Exacta en ESP32-S3 (ventanas de Xtensa); aproximada en el Uno ' +
        '(escaneo de la pila) y en ESP32-C3/C6; en MicroPython es la del último Traceback.',
      inputSchema: {},
    },
    seguro(async () => json('Pila:', { estado: dep.estadoEjecucion(), stackFrames: await dep.stackTrace() })),
  );
}
