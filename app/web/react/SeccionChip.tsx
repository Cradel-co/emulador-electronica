import { useEffect, useRef, useState } from 'react';
import { acciones, estado } from './puente.js';

/**
 * La sección de chips del panel: qué chip tiene adentro el módulo, qué mide, y los controles para
 * mover su entorno en vivo (temperatura, aceleración...).
 *
 * Venía del PR de chips (#24) como `seccionChip` + `conectarControlesChip`: HTML a mano más
 * handlers enganchados después. Al pasarlo a React se arregla de paso el problema del foco que
 * tenía: el guard de repintado solo miraba `[data-entorno]` (el slider), así que escribir en la
 * caja de número repintaba el panel y te sacaba el foco. Acá el valor es estado del componente y
 * no se repinta nada de afuera.
 */
export function SeccionChip({ inst, def }: { inst: any; def: any }) {
  const catalogoChips = estado().chips as Map<string, any>;
  const usados = (def?.chips ?? []) as { id: string }[];
  const faltan = usados.filter((u) => !catalogoChips.has(u.id));
  const chips = usados.map((u) => catalogoChips.get(u.id)).filter(Boolean);

  const magnitudes: Record<string, any> = Object.assign({}, ...chips.map((c) => c.entorno ?? {}));
  const claves = Object.keys(magnitudes);
  const limites = chips.flatMap((c) => (c.limitaciones ?? []).map((l: string) => ({ chip: c.nombre, texto: l })));

  return (
    <>
      {faltan.map((u) => (
        <div className="insp-badge advertencia" key={u.id}>
          ⚠ El chip <b>{u.id}</b> no está en el catálogo: no va a responder.
        </div>
      ))}

      {chips.length > 0 && (
        <>
          <h3>{chips.length > 1 ? 'Chips' : 'Chip'}</h3>
          {chips.map((chip) => (
            <p className="insp-desc" key={chip.id ?? chip.nombre}>
              <b>{chip.nombre}</b>
              {chip.fabricante ? ` · ${chip.fabricante}` : ''}
              {chip.i2c ? ' · I2C' : ''}
              {chip.hojaDeDatos && <><br /><span className="sub">Según {chip.hojaDeDatos}</span></>}
            </p>
          ))}

          {claves.length > 0 && (
            <>
              <h3>Entorno</h3>
              <div className="insp-props">
                {claves.map((k) => <Magnitud key={k} inst={inst} clave={k} m={magnitudes[k]} />)}
              </div>
              <p className="hint">
                Lo que mide el sensor. Con la simulación corriendo, el programa lo ve en la próxima
                medición, sin reiniciar.
              </p>
            </>
          )}

          {limites.length > 0 && (
            <details className="insp-limites">
              <summary>Qué no se emula</summary>
              <ul>
                {limites.map((l, i) => (
                  <li key={i}>{chips.length > 1 && <b>{l.chip}: </b>}{l.texto}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}

/** Una magnitud del entorno: el slider y la caja de número, atados al mismo valor. */
function Magnitud({ inst, clave, m }: { inst: any; clave: string; m: any }) {
  const [valor, setValor] = useState(() => Number(inst.entorno?.[clave] ?? m.default));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paso = m.paso ?? (m.max - m.min) / 200;

  // Mientras se arrastra el slider salen muchos valores: se manda como mucho uno cada 150 ms.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const poner = (v: number) => {
    if (!Number.isFinite(v)) return;
    setValor(v);
    inst.entorno = { ...inst.entorno, [clave]: v };
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      acciones().moverEntorno(inst.id, { [clave]: Number(inst.entorno[clave]) });
    }, 150);
  };

  return (
    <label className="insp-entorno">
      {m.etiqueta ?? clave}
      <span className="fila">
        <input
          type="range" data-entorno={clave}
          min={m.min} max={m.max} step={paso} value={valor}
          onChange={(e) => poner(Number(e.target.value))}
        />
        <input
          type="number" data-entorno-num={clave}
          min={m.min} max={m.max} step={paso} value={valor}
          onChange={(e) => {
            // Mientras se tipea solo se aplica si ya es un valor válido dentro del rango.
            const v = Number(e.target.value);
            if (e.target.value.trim() === '') { setValor(e.target.value as unknown as number); return; }
            if (Number.isFinite(v) && v >= Number(m.min) && v <= Number(m.max)) poner(v);
            else setValor(v);
          }}
        />
        <span className="unidad">{m.unidad}</span>
      </span>
    </label>
  );
}
