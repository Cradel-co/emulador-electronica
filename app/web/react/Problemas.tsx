import { useEstado } from './estado.js';
import { acciones, estado, vistas } from './puente.js';
import { fmtMa, fmtMw, fmtOhm, fmtV } from '../formato.js';

/**
 * Cuatro pedazos que generaban HTML a mano (#9): los problemas (errores de compilación y avisos
 * del circuito), los errores debajo del editor, la alimentación del panel Debug y el resultado de
 * una importación. Cada uno sobre su nodo de siempre.
 */

interface ErrorCompilacion { file?: string | null; line?: number | null; message: string }
interface Aviso { message: string; pin?: number | null }

/**
 * Dónde está un aviso del circuito. Los que son del circuito entero llegan con `pin: -1`, y antes
 * se mostraban como "GPIO-1"; ahora dicen "circuito", igual que los que llegan sin pin.
 */
const dondeAviso = (pin?: number | null) => (pin == null || pin < 0 ? 'circuito' : `GPIO${pin}`);
const dondeError = (e: ErrorCompilacion) => (e.file ? `${e.file}:${e.line ?? '?'}` : '');

/** La pestaña Problemas (`#problemas`): primero los errores de compilación, después los avisos. */
export function Problemas() {
  const errores = useEstado(() => estado().errores as ErrorCompilacion[]);
  const avisos = useEstado(() => estado().avisosDibujo as Aviso[]);
  const items = [
    ...(errores ?? []).map((e) => ({ error: true, texto: e.message, donde: dondeError(e), e })),
    ...(avisos ?? []).map((w) => ({ error: false, texto: w.message, donde: dondeAviso(w.pin), e: null as ErrorCompilacion | null })),
  ];
  if (!items.length) return <p className="vacio">Sin problemas. El circuito y el código coinciden.</p>;
  return (
    <>
      {items.map((it, i) => (
        <button
          key={`${it.error ? 'e' : 'a'}-${i}-${it.texto}`}
          type="button"
          className={`problema${it.error ? ' error' : ''}`}
          onClick={() => { if (it.e?.line) acciones().irALinea(it.e.file ?? null, it.e.line); }}
        >
          <span className="ico">{it.error ? '✕' : '⚠'}</span>
          <span>{it.texto}</span>
          <span className="donde">{it.donde}</span>
        </button>
      ))}
    </>
  );
}

/** Los errores de la última compilación, debajo del editor (`#avisos`). */
export function ErroresCompilacion() {
  const errores = useEstado(() => estado().errores as ErrorCompilacion[]);
  return (
    <>
      {(errores ?? []).map((e, i) => (
        <div className="error" key={`${i}-${e.message}`}>
          {e.file ? `${e.file}:${e.line ?? '?'} — ${e.message}` : e.message}
        </div>
      ))}
    </>
  );
}

const TITULO_MODO: Record<string, (f: any) => string> = {
  CC: (f) => `Limitando corriente: la carga pediría ~${fmtMa(f.demandaMa)}`,
  corto: () => 'Salida en cortocircuito',
  apagada: () => 'Salida apagada: ▶ energiza el circuito',
};

/** La columna "Alimentación" del panel Debug (`#dbg-alimentacion`): cómo anda la placa y las fuentes. */
export function DebugAlimentacion() {
  const a = useEstado(() => estado().alimentacion as any);
  const fuentes = useEstado(() => estado().fuentes as any[]);
  const mediciones = useEstado(() => estado().mediciones as MedicionElectrica[]);
  const tensiones = useEstado(() => estado().tensiones as Record<string, number>);
  const energizado = useEstado(() => estado().energizado as boolean);
  const sinPlaca = vistas().sinPlaca();

  const [clase, texto] = sinPlaca
    ? [energizado ? 'ok' : 'sin', energizado ? 'Sin placa · circuito energizado' : 'Sin placa · circuito apagado (▶ lo energiza)']
    : !a
      ? ['', '—']
      : a.quemada
        ? ['quemada', 'Quemada']
        : a.estado === 'ok'
          ? ['ok', a.via === 'usb' ? 'Por USB' : a.via === 'fuente' ? `Por ${a.fuenteId} (${a.pin})${a.consumoMa ? ` · consume ~${a.consumoMa} mA` : ''}` : 'Alimentada']
          : ['sin', a.estado === 'baja' ? 'Tensión insuficiente' : 'Sin alimentación'];

  const fuenteActiva = fuentes.find((f) => f.id === a?.fuenteId);
  const entradaUsb = mediciones.find((m) => m.modulo === 'board' && m.elemento === 'usb');
  const tensionEntrada = a?.via === 'fuente' && fuenteActiva ? fuenteActiva.vSalida : a?.v ?? null;
  const consumoMa = a?.via === 'usb'
    ? (entradaUsb ? Math.abs(entradaUsb.corrienteMa) : null)
    : a?.via === 'fuente' && fuenteActiva
      ? fuenteActiva.mA
      : null;
  const potenciaMw = a?.via === 'usb'
    ? (entradaUsb ? Math.abs(entradaUsb.potenciaMw) : null)
    : a?.via === 'fuente' && fuenteActiva
      ? fuenteActiva.potenciaW * 1000
      : null;
  const medicionesVisibles = mediciones.filter((m) => m.modulo !== 'board');
  const pines = Object.entries(tensiones).sort(([a], [b]) => a.localeCompare(b, 'es'));

  return (
    <>
      <p className={`dbg-alim-placa ${clase}`} title={a?.mensaje ?? ''}>
        <b>{sinPlaca ? 'Circuito' : vistas().nombrePlaca()}</b> {texto}
      </p>
      {!sinPlaca && a?.estado === 'ok' && (
        <div className="dbg-alim-resumen" aria-label="Magnitudes de alimentación en vivo">
          <div><span>Tensión</span><b>{tensionEntrada == null ? '—' : fmtV(tensionEntrada)}</b></div>
          <div><span>{a?.via === 'usb' ? 'Corriente USB' : 'Corriente fuente'}</span><b>{fmtMa(consumoMa)}</b></div>
          <div><span>Potencia</span><b>{potenciaMw == null ? '—' : fmtMw(potenciaMw)}</b></div>
        </div>
      )}
      <p className="dbg-medicion-nota">Valores calculados por la simulación eléctrica.</p>
      {(fuentes ?? []).length > 0
        ? (
          <>
            <h5 className="dbg-subtitulo">Fuentes regulables</h5>
            <table className="dbg-fuentes">
              <thead><tr><th>Fuente</th><th>Ajuste</th><th>Salida</th><th>Consumo</th><th>Potencia</th><th>Modo</th></tr></thead>
              <tbody>
                {fuentes.map((f) => (
                  <tr key={f.id}>
                    <td>{f.id}</td>
                    <td>{fmtV(f.vAjuste)} · ≤{f.limiteMa ?? '—'} mA</td>
                    <td>{fmtV(f.vSalida)}</td>
                    <td><b>{fmtMa(f.mA)}</b></td>
                    <td>{f.potenciaW.toFixed(2)} W</td>
                    <td>
                      <span className={`modo-fuente ${f.modo}`} title={(TITULO_MODO[f.modo] ?? (() => 'Voltaje constante'))(f)}>
                        {f.modo}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
        : <p className="dbg-vacio">Sin fuentes regulables en el circuito.</p>}
      <details className="dbg-mediciones">
        <summary>Componentes · {medicionesVisibles.length} mediciones</summary>
        {medicionesVisibles.length > 0
          ? (
            <table>
              <thead><tr><th>Componente</th><th title="Caída de tensión">ΔV</th><th title="Corriente en miliamperios">mA</th><th title="Resistencia en ohmios">Ω</th><th title="Potencia">P</th></tr></thead>
              <tbody>
                {medicionesVisibles.map((m) => (
                  <tr key={`${m.modulo}.${m.elemento}`}>
                    <td title={`${m.tipo} · ${m.modulo}.${m.elemento}`}><b>{m.moduloNombre}</b><small>{m.modulo}.{m.elemento}</small></td>
                    <td>{fmtV(m.tensionV)}</td>
                    <td>{fmtMa(m.corrienteMa)}</td>
                    <td>{fmtOhm(m.resistenciaOhm)}</td>
                    <td>{fmtMw(m.potenciaMw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          : <p className="dbg-vacio">Todavía no hay mediciones de componentes.</p>}
      </details>
      <details className="dbg-mediciones dbg-tensiones">
        <summary>Tensión por pin · {pines.length}</summary>
        {pines.length > 0
          ? <ul>{pines.map(([pin, v]) => <li key={pin}><span>{pin}</span><b>{fmtV(v)}</b></li>)}</ul>
          : <p className="dbg-vacio">No hay pines cableados para medir.</p>}
      </details>
    </>
  );
}

interface MedicionElectrica {
  modulo: string;
  moduloNombre: string;
  elemento: string;
  tipo: string;
  tensionV: number;
  corrienteMa: number;
  potenciaMw: number;
  resistenciaOhm: number | null;
}

type Importacion =
  | null
  | { tipo: 'cargando'; soloValidar: boolean }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'resultado'; datos: { importados: any[]; errores: any[]; avisos: any[] } };

/** Lo que pasó con la última importación de módulos (`#imp-resultado`). */
export function ResultadoImportacion() {
  const imp = useEstado(() => estado().importacion as Importacion);
  if (!imp) return null;
  if (imp.tipo === 'cargando') return <p className="hint">{imp.soloValidar ? 'Validando' : 'Importando'}…</p>;
  if (imp.tipo === 'error') return <ul><li className="error">✗ {imp.mensaje}</li></ul>;
  const { importados, errores, avisos } = imp.datos;
  if (!importados.length && !errores.length && !avisos.length) return null;
  return (
    <ul>
      {importados.map((m) => <li className="ok" key={`ok-${m.type}`}>✓ <b>{m.name}</b> <code>{m.type}</code></li>)}
      {errores.map((e, i) => (
        <li className="error" key={`e-${i}`}>✗ <code>{e.origen}</code><ul>{e.mensajes.map((x: string, j: number) => <li key={j}>{x}</li>)}</ul></li>
      ))}
      {avisos.map((a, i) => (
        <li className="aviso" key={`a-${i}`}>⚠ <code>{a.origen}</code><ul>{a.mensajes.map((x: string, j: number) => <li key={j}>{x}</li>)}</ul></li>
      ))}
    </ul>
  );
}
