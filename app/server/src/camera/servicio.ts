import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { CameraDescriptorSchema, type CameraCapture, type CameraDescriptor, type CameraSession, type CameraStatus, type ServerEvent } from '@emu/shared';

export class ErrorCamara extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
interface Solicitud { id: string; expiresAt: number; completar: (bytes: Buffer) => void; fallar: (mensaje: string) => void }
interface Recurso { solicitud?: Solicitud; project: string; instance: string; session?: CameraSession; capture?: { bytes: Buffer; meta: CameraCapture }; number: number; pending?: boolean }
/** Sesiones y fotos efímeras: nunca se serializan en el proyecto. */
export class ServicioCamara {
  private recursos = new Map<string, Recurso>();
  constructor(private emitir: (e: ServerEvent) => void, private ahora = Date.now, private presupuesto = 16 * 1024 * 1024) {}
  private clave(p: string, i: string) { return JSON.stringify([p, i]); }
  private recurso(p: string, i: string): Recurso {
    const k = this.clave(p, i);
    let r = this.recursos.get(k);
    if (!r) { r = { project: p, instance: i, number: 0 }; this.recursos.set(k, r); }
    if (r.session && r.session.expiresAt <= this.ahora()) { this.cancelar(p, i, 'La sesión de cámara finalizó.'); delete r.session; this.avisar(r); }
    return r;
  }
  private avisar(r: Recurso) {
    this.emitir({ type: 'camera.state', project: r.project, instance: r.instance, state: { active: !!r.session, expiresAt: r.session?.expiresAt ?? null, capture: r.capture?.meta ?? null } });
  }
  estado(p: string, i: string): CameraStatus {
    const r = this.recurso(p, i);
    return { active: !!r.session, expiresAt: r.session?.expiresAt ?? null, capture: r.capture?.meta ?? null };
  }
  abrir(p: string, i: string): CameraSession {
    const r = this.recurso(p, i);
    if (r.session) throw new ErrorCamara('CAMERA_BUSY', 'La cámara está siendo utilizada en otra sesión.');
    r.session = { id: randomUUID(), expiresAt: this.ahora() + 45_000 };
    this.avisar(r); return { ...r.session };
  }
  private propietario(p: string, i: string, id: string) {
    const r = this.recurso(p, i);
    if (!r.session || r.session.id !== id) throw new ErrorCamara('SESSION_EXPIRED', 'La sesión de cámara no está disponible. Activala nuevamente.');
    return r;
  }
  renovar(p: string, i: string, id: string): CameraSession {
    const r = this.propietario(p, i, id);
    if (!r.session) throw new ErrorCamara('SESSION_EXPIRED', 'La sesión venció.');
    r.session.expiresAt = this.ahora() + 45_000;
    return { ...r.session };
  }
  cerrar(p: string, i: string, id: string) {
    const r = this.recurso(p, i);
    if (r.session?.id === id) { this.cancelar(p, i, 'La sesión de cámara finalizó.'); delete r.session; this.avisar(r); }
  }
  solicitar(p: string, i: string, completar: (bytes: Buffer) => void, fallar: (mensaje: string) => void): string {
    const r = this.recurso(p, i);
    if (!r.session) throw new ErrorCamara('SESSION_EXPIRED', 'Activá la webcam antes de capturar desde el firmware.');
    if (r.solicitud || r.pending) throw new ErrorCamara('CAPTURE_BUSY', 'Ya hay una captura pendiente.');
    const id = randomUUID();
    r.solicitud = { id, expiresAt: this.ahora() + 10_000, completar, fallar };
    this.emitir({ type: 'camera.capture.request', project: p, instance: i, requestId: id });
    return id;
  }
  cancelar(p: string, i: string, mensaje: string) {
    const r = this.recursos.get(this.clave(p, i)), solicitud = r?.solicitud;
    if (r) delete r.solicitud;
    solicitud?.fallar(mensaje);
  }
  errorSolicitud(p: string, i: string, sesion: string, requestId: string) {
    const r = this.propietario(p, i, sesion);
    if (r.solicitud?.id !== requestId) throw new ErrorCamara('REQUEST_EXPIRED', 'La solicitud de captura ya no está disponible.');
    this.cancelar(p, i, 'El navegador no pudo tomar la fotografía solicitada.');
  }
  async capturar(p: string, i: string, id: string, bytes: Buffer, limites: CameraDescriptor = CameraDescriptorSchema.parse({}), requestId?: string): Promise<CameraCapture> {
    const r = this.propietario(p, i, id);
    const solicitud = r.solicitud;
    if (requestId && (!solicitud || solicitud.id !== requestId || solicitud.expiresAt <= this.ahora())) throw new ErrorCamara('REQUEST_EXPIRED', 'La solicitud de captura venció o fue cancelada.');
    if (!requestId && solicitud) throw new ErrorCamara('CAPTURE_BUSY', 'El firmware está esperando su fotografía.');
    if (r.pending) throw new ErrorCamara('CAPTURE_BUSY', 'Ya hay una captura pendiente.');
    if (bytes.length > limites.maxBytes) throw new ErrorCamara('CAPTURE_TOO_LARGE', 'La fotografía supera el tamaño permitido.', 413);
    r.pending = true;
    try {
      let width: number, height: number;
      try {
        const image = sharp(bytes, { limitInputPixels: limites.maxWidth * limites.maxHeight, failOn: 'warning' });
        const meta = await image.metadata();
        if (meta.format !== 'jpeg') throw new ErrorCamara('UNSUPPORTED_IMAGE', 'Solo se admiten fotografías JPEG.', 415);
        if (!meta.width || !meta.height || meta.width > limites.maxWidth || meta.height > limites.maxHeight) throw new ErrorCamara('INVALID_IMAGE', 'Las dimensiones exceden el límite permitido.', 400);
        await image.raw().toBuffer();
        width = meta.width; height = meta.height;
      } catch (err) {
        if (err instanceof ErrorCamara) throw err;
        throw new ErrorCamara('INVALID_IMAGE', 'La fotografía JPEG es inválida o supera el límite de píxeles.', 400);
      }
      // La sesión o el módulo pudieron desaparecer durante la decodificación.
      if (this.recursos.get(this.clave(p, i)) !== r || this.propietario(p, i, id) !== r) throw new ErrorCamara('SESSION_EXPIRED', 'La sesión cambió durante la captura.');
      if (requestId && (r.solicitud !== solicitud || !solicitud || solicitud.expiresAt <= this.ahora())) throw new ErrorCamara('REQUEST_EXPIRED', 'La solicitud cambió durante la captura.');
      if (requestId) {
        bytes = await sharp(bytes).resize(320, 240, { fit: 'contain', background: 'black' }).jpeg({ quality: 80 }).toBuffer();
        width = 320; height = 240;
        if (bytes.length > limites.maxBytes) throw new ErrorCamara('CAPTURE_TOO_LARGE', 'La fotografía normalizada supera el límite.', 413);
        if (this.recursos.get(this.clave(p, i)) !== r || this.propietario(p, i, id) !== r || r.solicitud !== solicitud || !solicitud || solicitud.expiresAt <= this.ahora()) throw new ErrorCamara('REQUEST_EXPIRED', 'La solicitud fue cancelada durante la normalización.');
      }
      const meta: CameraCapture = { id: randomUUID(), project: p, instance: i, number: ++r.number, width, height, size: bytes.length, receivedAt: this.ahora(), ...(requestId ? { requestId } : {}), sha256: createHash('sha256').update(bytes).digest('hex') };
      r.capture = { bytes: Buffer.from(bytes), meta };
      let total = [...this.recursos.values()].reduce((n, v) => n + (v.capture?.bytes.length ?? 0), 0);
      for (const viejo of [...this.recursos.values()].filter(v => v.capture && v !== r).sort((a,b) => (a.capture?.meta.receivedAt ?? 0) - (b.capture?.meta.receivedAt ?? 0))) {
        if (total <= this.presupuesto) break;
        total -= viejo.capture?.bytes.length ?? 0; delete viejo.capture; this.avisar(viejo);
      }
      if (total > this.presupuesto) { delete r.capture; throw new ErrorCamara('CAPTURE_TOO_LARGE', 'La fotografía supera el presupuesto de memoria.', 413); }
      if (requestId && solicitud) { delete r.solicitud; solicitud.completar(Buffer.from(bytes)); }
      this.avisar(r); return meta;
    } finally { r.pending = false; }
  }
  imagen(p: string, i: string, id?: string) {
    const r = this.recurso(p, i);
    if (!r.capture) throw new ErrorCamara('CAPTURE_NOT_FOUND', 'No hay una captura disponible.', 404);
    if (id && id !== r.capture.meta.id) throw new ErrorCamara('CAPTURE_REPLACED', 'La captura fue reemplazada.');
    return r.capture;
  }
  reconciliar(p: string, ids: string[]) {
    for (const [k, r] of this.recursos) if (r.project === p && !ids.includes(r.instance)) {
      this.cancelar(p, r.instance, 'El módulo de cámara fue eliminado.'); delete r.session; delete r.capture; this.avisar(r); this.recursos.delete(k);
    }
  }
  vencer() {
    for (const [k, r] of this.recursos) {
      this.recurso(r.project, r.instance);
      if (r.solicitud && r.solicitud.expiresAt <= this.ahora()) this.cancelar(r.project, r.instance, 'La captura venció después de 10 segundos.');
      if (!r.session && !r.capture && !r.pending) this.recursos.delete(k);
    }
  }
}
