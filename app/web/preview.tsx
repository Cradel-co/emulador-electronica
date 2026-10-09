import { salidaDesdeFisica } from './estado-electrico.js';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { crearLienzo } from './canvas.js';

interface Snapshot {
  name: string;
  active: boolean;
  diagram: { modules: Array<{ id: string; type: string; props?: Record<string, unknown> }>; wires: unknown[] };
  catalog: Array<{ type: string; switch?: unknown; [key: string]: unknown }>;
  live: { cerrados: string[]; electrico: { resuelto: boolean; modulos: Record<string, { on?: boolean }>; leds: Array<{ id: string; mA: number; mAFijo: number }> } } | null;
}
const token = location.hash.slice(1);
const endpoint = `/api/previews/${encodeURIComponent(token)}`;
async function request(path = '', data?: unknown): Promise<Snapshot> {
  const response = await fetch(endpoint + path, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'No se pudo conectar con la simulación.');
  return result;
}

/** Visor propio: comparte el renderer del editor, sin montar su estado ni sus herramientas. */
function Preview() {
  const svg = useRef<SVGSVGElement>(null);
  const current = useRef<Snapshot | null>(null);
  const canvas = useRef<ReturnType<typeof crearLienzo> | null>(null);
  const queue = useRef(Promise.resolve());
  const pressed = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const result = await request();
        if (disposed) return;
        current.current = result;
        setSnapshot(result);
        setError('');
        if (!canvas.current && svg.current) {
          const noop = () => {};
          canvas.current = crearLienzo(svg.current, {
            readonly: true,
            diagrama: () => current.current!.diagram,
            def: type => current.current!.catalog.find(def => def.type === type),
            seleccion: () => null,
            vivo: inst => ({
              presionado: current.current?.live?.cerrados.includes(inst.id) ?? false,
              activo: current.current?.live?.cerrados.includes(inst.id) ?? false,
              on: salidaDesdeFisica({
                valida: current.current?.live?.electrico.resuelto === true,
                led: current.current?.live?.electrico.leds.find(led => led.id === inst.id),
                modelo: current.current?.live?.electrico.modulos[inst.id],
              }),
            }),
            clasePin: () => '', descripcionPin: () => '', enCorto: () => false, cortoExplotando: () => false,
            seleccionar: noop, moverModulo: noop, rotarModulo: noop, conectar: noop, soltarModulo: noop,
            alternarUsb: noop, puedeEmpezarCable: () => false,
            control(inst, control, _index, event) {
              if (!current.current?.active || !current.current.catalog.find(def => def.type === inst.type)?.switch) return;
              if (control !== 'momentary' && event !== 'down') return;
              const closed = control === 'momentary' ? event === 'down' : !current.current.live?.cerrados.includes(inst.id);
              if (control === 'momentary') {
                if (closed) pressed.current.add(inst.id); else pressed.current.delete(inst.id);
              }
              // Conserva el orden down/up incluso con latencia en la red local.
              queue.current = queue.current.then(async () => {
                await request('/controls', { id: inst.id, cerrado: closed });
              }).catch(reason => { if (!disposed) setError(String(reason.message)); });
            },
          });
          canvas.current.render();
          canvas.current.ajustar();
        } else canvas.current?.pedirRender();
      } catch (reason) {
        if (!disposed) {
          if (current.current) current.current = { ...current.current, live: null };
          setError(String((reason as Error).message));
          canvas.current?.pedirRender();
        }
      }
      // Un solo pedido pendiente por visor; no acumula procesos ni polls en segundo plano.
      if (!disposed) timer = setTimeout(update, document.hidden ? 3000 : 700);
    };
    const release = () => {
      for (const id of pressed.current) {
        queue.current = queue.current.then(async () => {
          await fetch(endpoint + '/controls', { method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cerrado: false }) });
        }).catch(() => {});
      }
      pressed.current.clear();
    };
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    void update();
    return () => { disposed = true; clearTimeout(timer); release(); window.removeEventListener('blur', release); window.removeEventListener('pagehide', release); };
  }, []);
  const share = async () => {
    // El servidor entrega direcciones LAN en el primer GET, sin solicitar acceso al editor.
    try {
      const response = await fetch(endpoint);
      const result = await response.json();
      setLinks(result.links ?? []);
    } catch { setError('No se pudo obtener el enlace de red local.'); }
  };
  return <main className="preview-shell">
    <header className="preview-toolbar"><strong>{snapshot?.name ?? 'Circuito'}</strong>
      <span role="status">{snapshot ? snapshot.active ? snapshot.live?.electrico.resuelto === true && !error ? 'En vivo' : 'Sin medición eléctrica válida' : 'Esta ejecución terminó o cambió. Abrí un nuevo enlace desde el editor.' : 'Conectando…'}</span>
      <button onClick={() => canvas.current?.ajustar()}>Ajustar</button><button onClick={share}>Compartir en red local</button>
    </header>
    {links.length > 0 && <section className="preview-links" aria-label="Enlaces de red local">
      <p>Abrí uno de estos enlaces desde otro equipo de la misma red. Esta computadora debe permanecer encendida.</p>
      {links.map(link => <div key={link}><input aria-label="Enlace compartido" readOnly value={link} onFocus={event => event.target.select()} />
        <button onClick={async () => { try { await navigator.clipboard.writeText(link); } catch { setError('Seleccioná y copiá el enlace con Ctrl+C.'); } }}>Copiar</button></div>)}
    </section>}
    {error && <p role="alert">{error}</p>}
    <svg id="lienzo" ref={svg} xmlns="http://www.w3.org/2000/svg" aria-label="Circuito de prueba" />
  </main>;
}
createRoot(document.getElementById('preview-root')!).render(<Preview />);
