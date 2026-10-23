import { AgendaTemporal, BRIDGE_PROTOCOL_VERSION } from '@emu/shared';
import type { Emulador, OpcionesArranque, PuenteSim } from '../emulatorBackend.js';
import type { EmulatorEvents, EmulatorStatus } from '../emulator.js';
import type { BuildArtifacts } from '../buildService.js';
import { compilarProgramaPropio, EjecutorProgramaPropio, type ProgramaPropio } from './programa.js';

const PS_POR_MS = 1_000_000_000n;
const vacio = (): EmulatorStatus => ({ motor: 'propio', state: 'stopped', running: false, pid: null, project: null, ports: null, usesWeb: false, ip: null, startedAt: null, exitInfo: null });

/** Backend funcional propio. No crea procesos, UART, puertos ni firmware del ESP32. */
export class EmuladorPropio implements Emulador {
  private status = vacio();
  private logs: string[] = [];
  private agenda = new AgendaTemporal([[]]);
  private ejecutor: EjecutorProgramaPropio | null = null;
  private temporizador: ReturnType<typeof setTimeout> | null = null;
  private pinesActivos: ProgramaPropio['pines'] = [];
  private generacion = 0;
  private sincronizar: () => Promise<void> = async () => {};
  private entradas = new Map<number, 0 | 1 | null>();
  private snapshot: { nombre: string; artefactos: BuildArtifacts; opciones: OpcionesArranque } | null = null;
  constructor(private readonly eventos: EmulatorEvents) {}
  getStatus(): EmulatorStatus { return { ...this.status }; }
  getRecentLog(limit = 100): string[] { return this.logs.slice(-limit); }
  private log(linea: string): void { this.logs.push(linea.slice(0, 2048)); if (this.logs.length > 200) this.logs.shift(); this.eventos.onLog(linea.slice(0, 2048)); }
  private estado(status: EmulatorStatus): void { this.status = status; this.eventos.onState(this.getStatus()); }
  private limpiar(): void {
    this.generacion++;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null; this.agenda.detener(); this.ejecutor = null; this.entradas.clear(); this.pinesActivos = [];
  }
  private fallar(error: unknown): void {
    const mensaje = error instanceof Error ? error.message : String(error);
    this.limpiar(); this.log(`[motor propio] ${mensaje}`); this.eventos.onBridgeState(false);
    this.estado({ ...this.status, state: 'crashed', running: false, exitInfo: mensaje });
  }
  async start(nombre: string, artefactos: BuildArtifacts, opciones: OpcionesArranque = {}): Promise<EmulatorStatus> {
    if (!artefactos.codigoPropio) throw new Error('Falta el programa validado para el motor propio.');
    if (opciones.chips?.length || opciones.perfilAnalogicoEsp || opciones.perfilAnalogicoAvr) throw new Error('Motor propio: buses y ADC todavía no están implementados.');
    const programa = compilarProgramaPropio(artefactos.codigoPropio.main);
    if (programa.pines.some(p => !opciones.pinesPropios?.includes(p.gpio))) throw new Error('El programa usa un GPIO que no existe en esta placa.');
    if (opciones.capacidadesPropias && programa.pines.some(p => !opciones.capacidadesPropias?.some(c => c.gpio === p.gpio && (p.salida ? c.salida : c.entrada)))) throw new Error('El GPIO no admite el modo digital solicitado según el descriptor de la placa.');
    this.limpiar();
    const { sincronizarEntradasPropias, ...datosOpciones } = opciones;
    this.sincronizar = sincronizarEntradasPropias ?? (async () => {});
    this.snapshot = { nombre, artefactos: structuredClone(artefactos), opciones: structuredClone(datosOpciones) };
    this.pinesActivos = structuredClone(programa.pines);
    this.logs = []; this.agenda = new AgendaTemporal([[]], { pendientes: 1, eventosPorAvance: 1 });
    for (const e of opciones.entradasPropias ?? []) this.entradas.set(e.gpio, e.nivel);
    const generacion = this.generacion;
    this.ejecutor = new EjecutorProgramaPropio(programa, {
      leer: gpio => this.entradas.get(gpio) ?? null,
      escribir: (pin, level) => { if (generacion === this.generacion) { this.invalidarEntradasDigitales(); this.eventos.onBridgeMessage({ type: 'OUT', pin, level }); } },
      log: linea => this.log(linea),
    }, new Set(opciones.pinesPropios ?? []));
    this.estado({ ...vacio(), state: 'starting', running: true, project: nombre, startedAt: Date.now() });
    this.log('[motor propio] GPIO y temporización funcional en TypeScript; sin esp-emu, CPU ni firmware nativo.');
    this.eventos.onBridgeState(true); this.eventos.onBridgeMessage({ type: 'READY', version: BRIDGE_PROTOCOL_VERSION });
    this.markBridgeReady();
    this.agenda.programar({ ruta: [], fase: 'modelo', instantePs: 0n, tipo: 'programa' });
    try { await this.avanzar(0n, generacion); }
    catch (e) { if (generacion === this.generacion) this.fallar(e); throw e; }
    return this.getStatus();
  }
  private async avanzar(instantePs: bigint, generacion: number): Promise<void> {
    let siguiente: bigint | null = null;
    await this.agenda.avanzarHasta(instantePs, async () => {
      for (let barreras = 0; ; barreras++) {
        if (barreras >= 64) throw new Error('Presupuesto de barreras eléctricas agotado; agregá una espera al programa.');
        if (generacion !== this.generacion || !this.ejecutor) return;
        const paso = this.ejecutor.avanzar(true);
        if (paso.cambioElectrico) { await this.sincronizar(); if (generacion !== this.generacion) return; }
        if (paso.terminado) { this.log('[motor propio] Programa finalizado; salidas conservadas hasta Parar o Reset.'); return; }
        if (paso.esperaMs === null && paso.cambioElectrico) continue;
        if (paso.esperaMs === null) throw new Error('El programa no cedió el control.');
        siguiente = instantePs + BigInt(paso.esperaMs) * PS_POR_MS;
        this.agenda.programar({ ruta: [], fase: 'modelo', instantePs: siguiente, tipo: 'programa' });
        return;
      }
    });
    if (siguiente !== null && generacion === this.generacion) {
      const t = siguiente;
      this.temporizador = setTimeout(() => {
        this.temporizador = null;
        if (generacion === this.generacion) void this.avanzar(t, generacion).catch(e => { if (generacion === this.generacion) this.fallar(e); });
      }, Number((t - instantePs) / PS_POR_MS));
    }
  }
  async stop(): Promise<void> { this.limpiar(); this.estado(vacio()); this.eventos.onBridgeState(false); }
  async reset(): Promise<string> {
    if (!this.status.running || !this.snapshot) throw new Error('El motor propio no está ejecutándose.');
    const s = this.snapshot;
    const entradasPropias = [...this.entradas].map(([gpio, nivel]) => ({ gpio, nivel }));
    await this.start(s.nombre, s.artefactos, { ...s.opciones, entradasPropias, sincronizarEntradasPropias: this.sincronizar });
    return 'Motor propio reiniciado desde el programa validado.';
  }
  direccionesGpio() { return this.status.running ? structuredClone(this.pinesActivos) : null; }
  invalidarEntradasDigitales(): void { for (const gpio of this.entradas.keys()) this.entradas.set(gpio, null); }
  actualizarEntradaDigital(gpio: number, nivel: 0 | 1 | null): void { if (this.status.running) this.entradas.set(gpio, nivel); }
  getBridge(): PuenteSim | null {
    if (!this.status.running) return null;
    return { watch() {}, setInput: (gpio, nivel) => {
      if (nivel !== 0 && nivel !== 1) throw new Error('Entrada propia exige 0/1; X se entrega por el adaptador eléctrico.');
      this.actualizarEntradaDigital(gpio, nivel);
    }, sendRf() { throw new Error('Motor propio: radio aún no implementada.'); } };
  }
  markBridgeReady(): void { if (this.status.running && this.status.state !== 'bridge') this.estado({ ...this.status, state: 'bridge' }); }
  writeConsole(): boolean { this.log('[motor propio] REPL interactivo aún no soportado. Editá main.py y volvé a Ejecutar.'); return false; }
  actualizarAlimentacionChips(): void {}
  async shutdown(): Promise<void> { await this.stop(); }
}
