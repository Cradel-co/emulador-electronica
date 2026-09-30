import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultProject, lenguajesDe, type FirmwareMessage, type Language } from '@emu/shared';
import { PATHS } from './paths.js';
import type { BuildService } from './buildService.js';
import { EmulatorManager, type EmulatorEvents } from './emulator.js';
import type { Emulador } from './emulatorBackend.js';
import { ENGINES } from './engines/index.js';
import { TOOLCHAINS } from './toolchains/index.js';
import type { NivelSoporte, Placa } from './boardRegistry.js';

/**
 * Certificación de una placa: corre su circuito de prueba de punta a punta, con el
 * código y el motor reales —compila la plantilla, arranca el emulador, aprieta el
 * botón (`board.demo.input`) y mira que el LED (`board.demo.output`) cambie— y deja
 * un reporte con el nivel de soporte comprobado:
 *   "emula"        compila, arranca, el LED sigue al botón.
 *   "compila"      compila, pero la emulación no llegó (o no hay motor / no hay demo).
 *   "solo-dibujo"  ni compila: la placa sirve para dibujar, no para correr código.
 *
 * Todo pasa en .build/_certificar/<placa>-<lenguaje>/ (nunca en projects/) y con una
 * instancia propia del motor: no toca la simulación que tenga abierta el usuario.
 */

export interface PasoCertificacion {
  paso: string;
  ok: boolean;
  detalle: string;
  ms: number;
}

export interface ReporteCertificacion {
  placa: string;
  lenguaje: Language | null;
  nivel: NivelSoporte;
  fecha: string;
  duracionMs: number;
  pasos: PasoCertificacion[];
  /** Últimas líneas de compilación y del emulador (para diagnosticar). */
  log: string[];
}

/** Orden de preferencia de toolchains: los más rápidos primero (esp-idf baja ~3 GB la primera vez). */
const PREFERENCIA = ['arduino-cli', 'micropython', 'esphome', 'esp-idf', 'platformio'];

export function lenguajeParaCertificar(placa: Placa): Language | null {
  const disponibles = lenguajesDe(placa.desc).filter((l) => TOOLCHAINS[placa.desc.languages[l]!.toolchain]?.disponible);
  disponibles.sort(
    (a, b) => PREFERENCIA.indexOf(placa.desc.languages[a]!.toolchain) - PREFERENCIA.indexOf(placa.desc.languages[b]!.toolchain),
  );
  return disponibles[0] ?? null;
}

export function archivoCertificacion(id: string): string {
  return path.join(PATHS.cache, 'certificaciones', `${id}.json`);
}

export async function leerCertificacion(id: string): Promise<ReporteCertificacion | null> {
  try {
    return JSON.parse(await fs.readFile(archivoCertificacion(id), 'utf8')) as ReporteCertificacion;
  } catch {
    return null;
  }
}

export interface OpcionesCertificacion {
  builder: BuildService;
  lenguaje?: Language;
  onLine?: (line: string) => void;
  /** Cuánto esperar a que el emulador quede listo (esp-emu + MicroPython pueden tardar). */
  timeoutArranqueMs?: number;
}

/**
 * Una certificación a la vez: dos esp-emu arrancando juntos pueden elegir el mismo
 * puerto libre (ports.ts prueba y suelta) y uno de los dos no arranca.
 */
let cola: Promise<unknown> = Promise.resolve();

export function certificar(placa: Placa, opts: OpcionesCertificacion): Promise<ReporteCertificacion> {
  const job = cola.then(() => certificarAhora(placa, opts));
  cola = job.catch(() => undefined);
  return job;
}

async function certificarAhora(placa: Placa, opts: OpcionesCertificacion): Promise<ReporteCertificacion> {
  const inicio = Date.now();
  const pasos: PasoCertificacion[] = [];
  const log: string[] = [];
  const anotar = (l: string): void => {
    log.push(l);
    if (log.length > 400) log.shift();
    opts.onLine?.(`[certificar ${placa.id}] ${l}`);
  };
  let t0 = Date.now();
  const paso = (nombre: string, ok: boolean, detalle: string): boolean => {
    pasos.push({ paso: nombre, ok, detalle, ms: Date.now() - t0 });
    anotar(`${ok ? '✓' : '✗'} ${nombre}: ${detalle}`);
    t0 = Date.now();
    return ok;
  };
  const terminar = async (nivel: NivelSoporte, lenguaje: Language | null): Promise<ReporteCertificacion> => {
    const r: ReporteCertificacion = {
      placa: placa.id, lenguaje, nivel, fecha: new Date().toISOString(), duracionMs: Date.now() - inicio, pasos, log: log.slice(-120),
    };
    await fs.mkdir(path.dirname(archivoCertificacion(placa.id)), { recursive: true });
    await fs.writeFile(archivoCertificacion(placa.id), JSON.stringify(r, null, 2) + '\n', 'utf8');
    return r;
  };

  // 1) Lenguaje y plantilla
  const lenguaje = opts.lenguaje ?? lenguajeParaCertificar(placa);
  if (!lenguaje || !placa.desc.languages[lenguaje]) {
    paso('lenguaje', false, lenguaje ? `${placa.nombre} no tiene ${lenguaje}` : 'ningún lenguaje con toolchain disponible');
    return terminar('solo-dibujo', lenguaje ?? null);
  }
  const destino = placa.desc.languages[lenguaje]!;
  const tc = TOOLCHAINS[destino.toolchain];
  if (!tc?.disponible) {
    paso('toolchain', false, `"${destino.toolchain}" no existe o no está implementado`);
    return terminar('solo-dibujo', lenguaje);
  }
  const nombre = 'certificacion';
  const raiz = path.join(PATHS.builds, '_certificar', `${placa.id}-${lenguaje}`);
  const dirProyecto = path.join(raiz, 'proyecto');
  const dirBuild = path.join(raiz, 'build');
  await fs.rm(dirProyecto, { recursive: true, force: true });
  await fs.mkdir(dirProyecto, { recursive: true });
  const propia = placa.desc.templates[lenguaje]?.files;
  const archivos = propia && Object.keys(propia).length > 0 ? propia : tc.plantilla(lenguaje, placa, destino.options);
  for (const [rel, contenido] of Object.entries(archivos)) {
    const full = path.resolve(dirProyecto, rel);
    if (!full.startsWith(dirProyecto + path.sep)) continue; // sin traversal
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contenido.replaceAll('${name}', nombre), 'utf8');
  }
  paso('plantilla', true, `${lenguaje} con ${tc.nombre}: ${Object.keys(archivos).join(', ')}`);

  // 2) Compilación
  const project = defaultProject(nombre, lenguaje, placa.id, placa.desc);
  const build = await opts.builder.compilarEn(project, placa, dirProyecto, dirBuild, {
    onLine: anotar,
    onNotice: anotar,
  }, { clave: `_certificar-${placa.id}` });
  if (!build.ok || !build.artifacts) {
    paso('compilación', false, build.errors.map((e) => `${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.message}`).join(' | ') || 'falló');
    return terminar('solo-dibujo', lenguaje);
  }
  paso('compilación', true, `${path.basename(build.artifacts.firmware)} en ${(build.durationMs / 1000).toFixed(1)} s`);

  // 3) Emulación
  const motor = ENGINES[placa.desc.backend.engine];
  if (!motor?.disponible) {
    paso('motor', false, `"${placa.desc.backend.engine}" no existe o no está implementado`);
    return terminar('compila', lenguaje);
  }
  const demo = placa.desc.demo;
  const entrada = demo ? placa.desc.pins[demo.input]?.gpio : undefined;
  const salida = demo ? placa.desc.pins[demo.output]?.gpio : undefined;

  const mensajes: FirmwareMessage[] = [];
  let estado = 'stopped';
  const oyentes = new Set<() => void>();
  const avisar = (): void => oyentes.forEach((o) => o());
  let emu: Emulador | null = null;
  const eventos: EmulatorEvents = {
    onLog: (l) => anotar(`emu: ${l}`),
    onState: (s) => {
      estado = s.state;
      avisar();
    },
    onBridgeState: () => undefined,
    onBridgeMessage: (m) => {
      if (m.type === 'READY') emu?.markBridgeReady();
      mensajes.push(m);
      avisar();
    },
  };
  const esperar = (cumple: () => boolean, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (cumple()) return resolve(true);
      const o = (): void => {
        if (!cumple()) return;
        clearTimeout(timer);
        oyentes.delete(o);
        resolve(true);
      };
      const timer = setTimeout(() => {
        oyentes.delete(o);
        resolve(false);
      }, ms);
      oyentes.add(o);
    });

  emu = motor.crear(eventos);
  try {
    await emu.start(nombre, build.artifacts, motor.opcionesArranque(placa.desc, build.artifacts));
    const limiteArranque = opts.timeoutArranqueMs ?? 180_000;
    const repl = build.artifacts.repl;
    if (repl && emu instanceof EmulatorManager) {
      // MicroPython: el puente (simbridge.py) recién existe después de subirlo por el REPL,
      // así que no hay @READY hasta entonces. Mismo orden que runProject en index.ts.
      const booteo = await esperar(() => estado !== 'starting', limiteArranque);
      if (!booteo || estado === 'crashed' || estado === 'stopped') {
        paso('arranque', false, `el emulador no arrancó (estado: ${estado})`);
        return terminar('compila', lenguaje);
      }
      const delProyecto = await Promise.all(
        repl.delProyecto.map(async (r) => ({ path: r, content: await fs.readFile(path.join(dirProyecto, r), 'utf8').catch(() => '') })),
      );
      const subida = await emu.uploadMicroPython([...repl.generados, ...delProyecto]);
      if (!paso('subida por REPL', subida.ok, subida.output)) return terminar('compila', lenguaje);
    }
    const listo = await esperar(() => estado === 'bridge' || estado === 'crashed' || estado === 'stopped', limiteArranque);
    if (!listo || estado !== 'bridge') {
      paso('arranque', false, `el emulador no quedó listo (estado: ${estado})`);
      return terminar('compila', lenguaje);
    }
    paso('arranque', true, `${motor.nombre}: simulación lista`);

    if (entrada === undefined || salida === undefined) {
      paso('circuito de prueba', false, 'la placa no tiene board.demo: no se puede probar botón → LED');
      return terminar('compila', lenguaje);
    }
    const puente = emu.getBridge();
    if (!puente) {
      paso('pines', false, 'el motor no expone el puente de pines');
      return terminar('compila', lenguaje);
    }
    const nivelSalida = (): number | undefined => {
      for (let i = mensajes.length - 1; i >= 0; i--) {
        const m = mensajes[i]!;
        if (m.type === 'OUT' && m.pin === salida) return m.level;
      }
      return undefined;
    };
    puente.watch(salida);
    // El botón de la plantilla tira a GND con pull-up: suelto = 1, apretado = 0.
    puente.setInput(entrada, 1);
    await esperar(() => nivelSalida() !== undefined, 15_000);
    const antes = nivelSalida();
    if (!paso('LED apagado al arrancar', antes === 0, `${demo!.output} = ${antes ?? 'sin reporte'}`)) return terminar('compila', lenguaje);

    puente.setInput(entrada, 0);
    const prendio = await esperar(() => nivelSalida() === 1, 15_000);
    if (!paso('botón apretado → LED prendido', prendio, `${demo!.input} = 0 → ${demo!.output} = ${nivelSalida() ?? '?'}`)) {
      return terminar('compila', lenguaje);
    }
    puente.setInput(entrada, 1);
    const apago = await esperar(() => nivelSalida() === 0, 15_000);
    if (!paso('botón suelto → LED apagado', apago, `${demo!.input} = 1 → ${demo!.output} = ${nivelSalida() ?? '?'}`)) {
      return terminar('compila', lenguaje);
    }
    return terminar('emula', lenguaje);
  } catch (err) {
    paso('emulación', false, (err as Error).message);
    return terminar('compila', lenguaje);
  } finally {
    await emu.stop().catch(() => undefined);
  }
}
