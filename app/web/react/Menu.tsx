import { useEffect, useState, type KeyboardEvent } from 'react';
import { useVersion } from './estado.js';
import { estado, menu } from './puente.js';

/**
 * El menú principal (hamburguesa): un grupo por menú (Archivo, Editar, Ver…) y, adentro, las
 * acciones de ese grupo con su atajo.
 *
 * Migrado a React (#9). Las acciones salen de la misma lista `ACCIONES` de `app.ts` que alimenta
 * la paleta de comandos y los atajos de teclado, así que acá no se define ninguna: solo se pintan.
 *
 * Se monta sobre el `#menu` de siempre; cuándo se muestra lo sigue decidiendo `app.ts` con
 * `hidden`. Lo que sí es de acá es qué grupo está abierto y la navegación con el teclado.
 */
export function Menu() {
  // `habilitada()` lee el estado (¿hay simulación?, ¿hay selección?): se reevalúa en cada cambio.
  useVersion();
  const abiertoMenu = estado().menuAbierto as boolean;
  const { grupos, acciones, cerrar } = menu();
  const [grupoAbierto, setGrupoAbierto] = useState<string | null>(null);

  // Al cerrarse el menú se olvida qué grupo estaba abierto, como antes (se rearmaba de cero).
  useEffect(() => { if (!abiertoMenu) setGrupoAbierto(null); }, [abiertoMenu]);

  // Flechas arriba/abajo entre items del mismo nivel; izquierda vuelve al grupo.
  const alTeclado = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'ArrowLeft') return;
    const actual = document.activeElement as HTMLElement | null;
    if (!actual) return;
    if (ev.key === 'ArrowLeft') {
      (actual.closest('.menu-item.sub') as HTMLElement | null)?.focus();
      ev.preventDefault();
      return;
    }
    const nivel = actual.parentElement;
    if (!nivel) return;
    const hermanos = [...nivel.children].filter((c) => c.matches('.menu-item:not(:disabled)')) as HTMLElement[];
    const i = hermanos.indexOf(actual);
    hermanos[(i + (ev.key === 'ArrowDown' ? 1 : -1) + hermanos.length) % hermanos.length]?.focus();
    ev.preventDefault();
    ev.stopPropagation();
  };

  return (
    // El teclado se escucha en cada grupo: las teclas de los botones del submenú burbujean hasta
    // su grupo, así un solo handler cubre los dos niveles.
    <>
      {grupos.map((grupo) => (
        <div
          key={grupo}
          className={`menu-item sub${grupoAbierto === grupo ? ' abierto' : ''}`}
          tabIndex={0}
          role="menuitem"
          aria-haspopup="menu"
          onMouseEnter={() => setGrupoAbierto(grupo)}
          onFocus={() => setGrupoAbierto(grupo)}
          onKeyDown={(ev) => {
            if (ev.target === ev.currentTarget && (ev.key === 'ArrowRight' || ev.key === 'Enter')) {
              setGrupoAbierto(grupo);
              (ev.currentTarget.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
              ev.preventDefault();
              return;
            }
            alTeclado(ev);
          }}
        >
          {grupo}
          <div className="menu submenu" role="menu">
            {acciones.filter((a) => a.menu === grupo).map((a) => (
              <button
                key={a.id}
                type="button"
                className="menu-item"
                role="menuitem"
                disabled={Boolean(a.habilitada && !a.habilitada())}
                onClick={(ev) => {
                  ev.stopPropagation();
                  cerrar();
                  a.hacer();
                }}
              >
                <span>{a.titulo}</span>
                {a.atajo && <span className="atajo">{a.atajo}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
