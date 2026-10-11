import { nivelDesdeDbfs, ReferenciaSonidoSchema, type ReferenciaSonido } from '@emu/shared';
import { abrirCapturaMicrofono, dispositivosMicrofono, type CapturaMicrofono } from './microfono-captura.js';
import { analizarAudio, type VentanaAudio } from './microfono-senal.js';
interface Dependencias {
  abrir: typeof abrirCapturaMicrofono; dispositivos: typeof dispositivosMicrofono;
  fetch: typeof fetch;
}
export interface EstadoMicrofono {
  fase: 'inactivo' | 'iniciando' | 'activo'; error: string; ventana: VentanaAudio | null;
  frecuenciaHz: number; tiempoAudioS: number; referencia: ReferenciaSonido; ajustes: MediaTrackSettings;
  dispositivos: { deviceId: string; label: string }[];
}
let actual: ControladorMicrofono | null = null;
let liberacion: Promise<void> = Promise.resolve();
/** Captura de 10 Hz y transporte de 4 Hz, con una sola solicitud en curso y cancelación por generación. */
export class ControladorMicrofono {
  private estado: EstadoMicrofono = { fase: 'inactivo', error: '', ventana: null, frecuenciaHz: 0, tiempoAudioS: 0,
    referencia: { dbfs: -20, nivel: 80 }, ajustes: {}, dispositivos: [] };
  private oyentes = new Set<() => void>();
  private generacion = 0; private captura: CapturaMicrofono | null = null; private sesion: string | null = null;
  private capturaTimer: ReturnType<typeof setInterval> | null = null;
  private envioTimer: ReturnType<typeof setInterval> | null = null;
  private enviando: number | null = null; private secuencia = 0;
  constructor(readonly base: string, private deps: Dependencias = {
    abrir: abrirCapturaMicrofono, dispositivos: dispositivosMicrofono, fetch: window.fetch.bind(window),
  }) {}
  leer = (): EstadoMicrofono => this.estado;
  suscribir = (f: () => void): (() => void) => { this.oyentes.add(f); return () => { this.oyentes.delete(f); }; };
  private cambiar(c: Partial<EstadoMicrofono>): void { this.estado = { ...this.estado, ...c }; for (const f of this.oyentes) f(); }
  referencia(valor: ReferenciaSonido): void {
    const parsed = ReferenciaSonidoSchema.safeParse(valor);
    if (parsed.success) this.cambiar({ referencia: parsed.data });
  }
  private async pedir(ruta: string, init: RequestInit): Promise<Response> {
    const r = await this.deps.fetch(this.base + ruta, { ...init, signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!r.ok) { const e = await r.json().catch(() => ({})) as { message?: string }; throw new Error(e.message ?? 'No se pudo actualizar la entrada de sonido.'); }
    return r;
  }
  private async cerrarSesion(id: string): Promise<void> { await this.pedir('/session/' + encodeURIComponent(id), { method: 'DELETE', keepalive: true }).catch(() => {}); }
  async activar(deviceId?: string): Promise<void> {
    if (this.estado.fase !== 'inactivo') return;
    if (actual && actual !== this) await actual.detener();
    actual = this; const g = ++this.generacion;
    this.cambiar({ fase: 'iniciando', error: '', ventana: null });
    let captura: CapturaMicrofono | null = null;
    try {
      await liberacion;
      if (g !== this.generacion) return;
      captura = await this.deps.abrir(deviceId, mensaje => { if (g === this.generacion) void this.detener(mensaje); });
      if (g !== this.generacion) { await captura.cerrar(); return; }
      this.captura = captura;
      const r = await (await this.pedir('/session', { method: 'POST' })).json() as { id: string };
      if (typeof r.id !== 'string') throw new Error('Respuesta de sesión inválida.');
      if (g !== this.generacion) { await this.cerrarSesion(r.id); return; }
      this.sesion = r.id; this.secuencia = 0;
      this.cambiar({ fase: 'activo', ajustes: captura.ajustes });
      const dispositivos = await this.deps.dispositivos();
      if (g !== this.generacion) return;
      this.cambiar({ dispositivos });
      const muestrear = () => {
        if (g !== this.generacion || !this.captura) return;
        try {
          const v = this.captura.leer();
          this.cambiar({ ventana: analizarAudio(v.muestras), frecuenciaHz: v.frecuenciaHz, tiempoAudioS: v.tiempoAudioS });
        } catch (e) { void this.detener((e as Error).message); }
      };
      muestrear(); if (g !== this.generacion) return;
      this.capturaTimer = setInterval(muestrear, 100);
      this.envioTimer = setInterval(() => { void this.enviar(g); }, 250);
      await this.enviar(g);
    } catch (e) {
      if (g !== this.generacion) return;
      if (captura && captura !== this.captura) await captura.cerrar();
      const mensaje = (e as Error).name === 'NotAllowedError' ? 'Permiso de micrófono denegado. Podés seguir usando el nivel manual.' : (e as Error).message;
      await this.detener(mensaje);
    }
  }
  private async enviar(g: number): Promise<void> {
    const sesion = this.sesion, ventana = this.estado.ventana;
    if (g !== this.generacion || this.enviando === g || !sesion || !ventana) return;
    this.enviando = g;
    try {
      await this.pedir('/session/' + encodeURIComponent(sesion), { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secuencia: ++this.secuencia, dbfs: ventana.dbfs, referencia: this.estado.referencia }) });
    } catch (e) { if (g === this.generacion) await this.detener((e as Error).message); }
    finally { if (this.enviando === g) this.enviando = null; }
  }
  async detener(error = ''): Promise<void> {
    this.generacion++;
    if (this.capturaTimer) clearInterval(this.capturaTimer);
    if (this.envioTimer) clearInterval(this.envioTimer);
    this.capturaTimer = null; this.envioTimer = null;
    const captura = this.captura, sesion = this.sesion; this.captura = null; this.sesion = null;
    if (actual === this) actual = null;
    this.cambiar({ fase: 'inactivo', error, ventana: null, ajustes: {} });
    const previa = liberacion;
    liberacion = Promise.all([previa, captura?.cerrar(), sesion ? this.cerrarSesion(sesion) : undefined]).then(() => {});
    await liberacion;
  }
  nivelEstimado(): number | null { return this.estado.ventana ? nivelDesdeDbfs(this.estado.ventana.dbfs, this.estado.referencia) : null; }
}

export function desconectarMicrofono(): void { if (actual) void actual.detener('Se perdió la conexión con el servidor. Conectá nuevamente el micrófono.'); }
