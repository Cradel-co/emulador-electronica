import type { CameraCapture, CameraDescriptor, CameraSession, CameraStatus, CameraTimings } from '@emu/shared';

interface Dependencias { media: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>; fetch: typeof fetch; permissions?: Pick<Permissions, 'query'> }
export interface EstadoCamara { phase: 'inactive' | 'starting' | 'active'; pending: boolean; error: string; stream: MediaStream | null; image: string; capture: CameraCapture | null; devices: MediaDeviceInfo[] }
const limitesIniciales: CameraDescriptor = { maxWidth: 640, maxHeight: 480, maxBytes: 1048576, quality: 0.8 };
let actual: ControladorCamara | null = null;
const controladores = new Map<string, ControladorCamara>();
const clave = (project: string, instance: string) => JSON.stringify([project, instance]);
export function crearControladorCamara(project: string, instance: string, base: string, deps?: Dependencias, limites?: CameraDescriptor) {
  const id = clave(project, instance), existente = controladores.get(id);
  if (existente) return existente;
  const control = new ControladorCamara(base, deps, limites, project, instance);
  controladores.set(id, control);
  return control;
}
export function desconectarCamara() { for (const control of controladores.values()) control.fallar('Se perdió la conexión con el servidor. Activá nuevamente la cámara.'); }
export function errorCamara(project: string, instance: string, mensaje: string) { controladores.get(clave(project, instance))?.errorFirmware(project, instance, mensaje); }
export function solicitarCaptura(project: string, instance: string, requestId: string) { void controladores.get(clave(project, instance))?.solicitud(project, instance, requestId); }
export function eventoCamara(project: string, instance: string, state: CameraStatus) { controladores.get(clave(project, instance))?.evento(project, instance, state); }
export function detenerCamarasDeOtrosProyectos(project: string | null) {
  for (const [id, control] of controladores) if (control.project !== project) { control.destruir(); controladores.delete(id); }
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => detenerCamarasDeOtrosProyectos(null));

/** Controla recursos del navegador y descarta resultados de operaciones canceladas. */
export class ControladorCamara {
  snapshot: EstadoCamara = { phase: 'inactive', pending: false, error: '', stream: null, image: '', capture: null, devices: [] };
  video: HTMLVideoElement | null = null;
  private vistaCaptura: HTMLVideoElement | null = null;
  private oyentes = new Set<() => void>();
  private generation = 0;
  private session: CameraSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private destruido = false;
  private reanudacionBloqueada = false;
  private onEnded = () => this.fallar('La cámara se desconectó.');
  constructor(readonly base: string, private deps: Dependencias = { media: navigator.mediaDevices, fetch: window.fetch.bind(window), permissions: navigator.permissions }, private limites = limitesIniciales, readonly project = '', readonly instance = '') {}
  suscribir = (fn: () => void) => { this.oyentes.add(fn); return () => { this.oyentes.delete(fn); }; };
  leer = () => this.snapshot;
  private cambiar(c: Partial<EstadoCamara>) { this.snapshot = { ...this.snapshot, ...c }; for (const f of this.oyentes) f(); }
  private async pedir(ruta: string, init: RequestInit = {}) {
    const r = await this.deps.fetch(this.base + ruta, { ...init, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (!r.ok) { const e = await r.json().catch(() => ({})) as { message?: string }; throw new Error(e.message ?? 'No se pudo completar la operación de cámara.'); }
    return r;
  }
  private async cerrar(id: string) { await this.pedir('/session/' + encodeURIComponent(id), { method: 'DELETE', keepalive: true }).catch(() => {}); }
  private liberar(stream: MediaStream) { for (const t of stream.getTracks()) { t.removeEventListener('ended', this.onEnded); t.stop(); } }
  async reanudarSiAutorizada() {
    if (this.reanudacionBloqueada) return;
    try {
      if ((await this.deps.permissions?.query({ name: 'camera' as PermissionName }))?.state === 'granted') await this.activar();
    } catch { /* Safari y algunos navegadores no exponen el permiso camera: se mantiene el botón manual. */ }
  }
  async activar(deviceId?: string) {
    if (this.destruido || this.snapshot.phase !== 'inactive') return;
    this.reanudacionBloqueada = false;
    if (actual && actual !== this) await actual.detener();
    actual = this;
    const g = ++this.generation;
    this.cambiar({ phase: 'starting', error: '' });
    let stream: MediaStream | null = null;
    try {
      if (!this.deps.media) throw new Error('El navegador no permite acceder a la cámara. Abrí la aplicación en localhost.');
      stream = await this.deps.media.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true });
      if (g !== this.generation) { this.liberar(stream); return; }
      this.cambiar({ stream });
      for (const t of stream.getVideoTracks()) t.addEventListener('ended', this.onEnded);
      if (typeof document !== 'undefined') {
        const fuente = document.createElement('video');
        fuente.autoplay = true; fuente.muted = true; fuente.playsInline = true;
        fuente.setAttribute('aria-hidden', 'true');
        fuente.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-2px;top:-2px';
        fuente.srcObject = stream;
        document.body.appendChild(fuente);
        this.vistaCaptura = fuente;
        this.video = fuente;
        void fuente.play().catch(() => {});
      }
      const session = await (await this.pedir('/session', { method: 'POST' })).json() as CameraSession;
      if (g !== this.generation) { await this.cerrar(session.id); return; }
      this.session = session;
      this.cambiar({ phase: 'active' });
      this.timer = setInterval(() => { void this.renovar(g); }, 15_000);
      await this.dispositivos();
    } catch (err) {
      if (g !== this.generation) return;
      if (stream && this.snapshot.stream !== stream) this.liberar(stream);
      this.fallar(mensaje(err));
    }
  }
  async dispositivos() {
    if (!this.deps.media) return;
    const devices = await this.deps.media.enumerateDevices().catch(() => []);
    if (!this.destruido) this.cambiar({ devices: devices.filter(d => d.kind === 'videoinput') });
  }
  private async renovar(g: number) {
    const s = this.session;
    if (!s) return;
    try { await this.pedir('/session/' + s.id + '/heartbeat', { method: 'POST' }); }
    catch (err) { if (g === this.generation) this.fallar(mensaje(err)); }
  }
  async detener(manual = false) {
    if (manual) this.reanudacionBloqueada = true;
    ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.session; this.session = null;
    if (this.snapshot.stream) this.liberar(this.snapshot.stream);
    this.vistaCaptura?.remove(); this.vistaCaptura = null; this.video = null;
    if (actual === this) actual = null;
    this.cambiar({ phase: 'inactive', stream: null, pending: false });
    if (s) await this.cerrar(s.id);
  }
  fallar(error: string) { void this.detener(); this.cambiar({ error }); }
  evento(project: string, instance: string, state: CameraStatus) {
    if (project === this.project && instance === this.instance && !state.active && this.session) this.fallar('La sesión de cámara finalizó. Activala nuevamente.');
  }
  async cargarUltima() {
    const g = this.generation;
    try {
      const status = await (await this.pedir('/status')).json() as CameraStatus;
      if (status.capture) await this.recuperar(status.capture, g);
    } catch (err) { if (g === this.generation && !this.destruido) this.cambiar({ error: mensaje(err) }); }
  }
  private async recuperar(meta: CameraCapture, g: number) {
    const r = await this.pedir('/capture?id=' + encodeURIComponent(meta.id));
    if (r.headers.get('x-capture-id') !== meta.id) throw new Error('La fotografía recibida no coincide con la captura.');
    const blob = await r.blob();
    if (g !== this.generation || this.destruido) return;
    const image = URL.createObjectURL(blob);
    if (this.snapshot.image) URL.revokeObjectURL(this.snapshot.image);
    this.cambiar({ image, capture: meta });
  }
  errorFirmware(project: string, instance: string, error: string) { if (project === this.project && instance === this.instance) this.cambiar({ error }); }
  async solicitud(project: string, instance: string, requestId: string) {
    if (project !== this.project || instance !== this.instance || !this.session) return;
    if (!this.video || this.video.readyState < 2 || this.snapshot.pending) {
      await this.pedir('/session/' + this.session.id + '/requests/' + encodeURIComponent(requestId) + '/error', { method: 'POST' }).catch(() => {});
      this.cambiar({ error: 'No se pudo tomar la fotografía solicitada por el firmware.' }); return;
    }
    await this.capturar(this.video, requestId);
  }
  async capturar(video: HTMLVideoElement, requestId?: string) {
    if (!this.session || this.snapshot.pending || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const g = this.generation, session = this.session;
    this.cambiar({ pending: true, error: '' });
    let enviado = false;
    try {
      const canvas = document.createElement('canvas');
      const escala = Math.min(1, this.limites.maxWidth / video.videoWidth, this.limites.maxHeight / video.videoHeight);
      canvas.width = Math.max(1, Math.floor(video.videoWidth * escala)); canvas.height = Math.max(1, Math.floor(video.videoHeight * escala));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No se pudo preparar la captura.');
      const inicioFotograma = performance.now();
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frameMs = performance.now() - inicioFotograma;
      const inicioJpeg = performance.now();
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo codificar la fotografía.')), 'image/jpeg', this.limites.quality));
      const browserJpegMs = performance.now() - inicioJpeg;
      if (g !== this.generation) return;
      if (blob.size > this.limites.maxBytes) throw new Error('La fotografía supera el tamaño permitido.');
      enviado = true;
      const inicioEnvio = performance.now();
      const meta = await (await this.pedir('/session/' + session.id + '/captures' + (requestId ? '?requestId=' + encodeURIComponent(requestId) : ''), { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob })).json() as CameraCapture;
      const uploadRoundTripMs = performance.now() - inicioEnvio;
      const backendMs = (meta.timings?.backendValidateMs ?? 0) + (meta.timings?.backendNormalizeMs ?? 0);
      const timings: CameraTimings = {
        ...meta.timings,
        frameMs,
        browserJpegMs,
        uploadRoundTripMs,
        outsideSharpMs: Math.max(0, uploadRoundTripMs - backendMs),
      };
      if (g === this.generation) await this.recuperar({ ...meta, timings }, g);
    } catch (err) {
      if (g === this.generation) {
        if (requestId) await this.pedir('/session/' + session.id + '/requests/' + encodeURIComponent(requestId) + '/error', { method: 'POST' }).catch(() => {});
        if (enviado) this.fallar(mensaje(err)); else this.cambiar({ error: mensaje(err) });
      }
    } finally { if (g === this.generation) this.cambiar({ pending: false }); }
  }
  destruir() { this.destruido = true; void this.detener(); if (this.snapshot.image) URL.revokeObjectURL(this.snapshot.image); this.oyentes.clear(); if (actual === this) actual = null; if (controladores.get(clave(this.project, this.instance)) === this) controladores.delete(clave(this.project, this.instance)); }
}
function mensaje(err: unknown) {
  if (err instanceof Error && err.name === 'NotAllowedError') return 'Permiso de cámara denegado. Revisá los permisos del navegador.';
  if (err instanceof Error && err.name === 'NotFoundError') return 'No se encontró una webcam.';
  if (err instanceof Error && err.name === 'NotReadableError') return 'No se pudo abrir la webcam. Puede estar ocupada.';
  return err instanceof Error ? err.message : 'No se pudo utilizar la cámara.';
}
