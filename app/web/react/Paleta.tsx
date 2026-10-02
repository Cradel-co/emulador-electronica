import { useEffect, useRef, useState } from 'react';
import { useEstado } from './estado.js';
import { estado, paleta } from './puente.js';
import { filtrar, palabrasDe, tramos } from '../paleta.js';

/**
 * La paleta de comandos ("Buscar en todo", Ctrl+Shift+P): una entrada y la lista de lo que
 * coincide, entre acciones, proyectos, archivos, módulos del circuito y del catálogo.
 *
 * Migrada a React (#9). Se monta sobre el `<dialog id="dlg-buscar">` de siempre: abrirlo y
 * cerrarlo (`showModal`/`close`, Esc, click en el fondo) lo sigue manejando `app.ts`, y la
 * búsqueda en sí es pura (`paleta.ts`). Lo de acá es la consulta, la selección y el teclado.
 */
export function Paleta() {
  // Sube cada vez que se abre: la paleta arranca de cero aunque la vez anterior quedara escrita.
  const vez = useEstado(() => estado().paletaVez as number);
  const [consulta, setConsulta] = useState('');
  const [sel, setSel] = useState(0);
  const entrada = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setConsulta('');
    setSel(0);
    entrada.current?.focus();
  }, [vez]);

  // Los candidatos dependen del estado de la app (qué acciones están disponibles, qué proyecto
  // está abierto): se piden de nuevo en cada render, que es barato.
  const items = filtrar(paleta().candidatos(), consulta);
  const palabras = palabrasDe(consulta);

  // La selección siempre visible, aunque la lista scrollee.
  useEffect(() => {
    lista.current?.querySelector<HTMLElement>('li.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const ejecutar = (i: number) => {
    const it = items[i];
    (document.getElementById('dlg-buscar') as HTMLDialogElement | null)?.close();
    it?.hacer();
  };

  return (
    <>
      <div className="pc-cabecera">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input
          id="pc-entrada"
          ref={entrada}
          placeholder="Escribí una acción, un proyecto, un módulo o un archivo"
          autoComplete="off"
          value={consulta}
          onChange={(e) => { setConsulta(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
              e.preventDefault();
              setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              ejecutar(sel);
            }
          }}
        />
      </div>
      <ul id="pc-lista" className="pc-lista" role="listbox" ref={lista}>
        {items.length === 0
          ? <li className="pc-vacio">Nada coincide.</li>
          : items.map((it, i) => (
            <li key={`${it.tipo}-${it.titulo}-${i}`} role="option" data-i={i}
              className={i === sel ? 'sel' : ''} onClick={() => ejecutar(i)}>
              <span className="pc-tipo">{it.tipo}</span>
              <span className="pc-titulo">
                {tramos(it.titulo, palabras).map((t, j) => (t.marcado ? <mark key={j}>{t.texto}</mark> : t.texto))}
              </span>
              {it.atajo && <span className="atajo">{it.atajo}</span>}
            </li>
          ))}
      </ul>
      <div className="pc-pie"><kbd>↑</kbd><kbd>↓</kbd> elegir · <kbd>Enter</kbd> ejecutar · <kbd>Esc</kbd> cerrar</div>
    </>
  );
}
