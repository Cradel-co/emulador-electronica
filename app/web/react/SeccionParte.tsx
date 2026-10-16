/**
 * "Pieza real" del panel: el nivel del módulo (dibujo → simula → probado → fabricable), qué se
 * compra (número de parte según sus props, hoja de datos) y cómo sale en el esquemático. Todo
 * viene del module.json (`parte`, `esquematico`) y de `nivel`, que calcula el server.
 */

const NIVELES: Record<string, string> = {
  dibujo: 'Solo dibujo: se cablea, pero no se simula',
  simula: 'Simula: tiene modelo, todavía sin pruebas propias',
  probado: 'Probado: pasa sus pruebas contra la hoja de datos',
  fabricable: 'Fabricable: probado, con número de parte y huella para el esquemático',
};

const FABRICACION: Record<string, string> = {
  modulo: 'se compra el módulo y se enchufa',
  discreto: 'sus piezas van soldadas en la placa',
  externo: 'no va en la placa',
};

const rotuloOhms = (x: number): string => {
  const [d, suf] = x >= 1e6 ? [1e6, 'M'] : x >= 1e3 ? [1e3, 'k'] : [1, ''];
  const v = +(x / d).toFixed(2);
  return Number.isInteger(v) ? `${v}${suf}` : String(v).replace('.', suf || 'R');
};

/** `{{props.x}}`, `{{props.x|ohms}}` (4k7), `{{props.x|codigoR}}` (4K7, 220R) o un mapa por valor de la prop. */
function textoConProps(t: any, props: Record<string, unknown>): string {
  if (!t) return '';
  if (typeof t !== 'string') return t.map?.[String(props[t.prop])] ?? t.default ?? '';
  return t.replace(/\{\{\s*props\.(\w+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_: string, k: string, f?: string) => {
    const v = props[k];
    if (typeof v === 'number' && f === 'ohms') return rotuloOhms(v);
    if (typeof v === 'number' && f === 'codigoR') {
      const r = rotuloOhms(v).toUpperCase();
      return /^\d+$/.test(r) ? `${r}R` : r;
    }
    return v === undefined ? '' : String(v);
  });
}

export function SeccionParte({ inst, def }: { inst: any; def: any }) {
  const nivel = def?.nivel;
  const parte = def?.parte;
  if (!nivel && !parte) return null;
  const props = {
    ...Object.fromEntries(Object.entries(def.props ?? {}).map(([k, p]: [string, any]) => [k, p.default])),
    ...inst.props,
  };
  const falta: string[] = nivel?.falta ?? [];
  // Un módulo importado no puede meter `javascript:` en la UI: solo enlaces https.
  const datasheetOk = /^https:\/\//.test(parte?.datasheet ?? '');
  return (
    <>
      <h3>Pieza real</h3>
      {nivel && (
        <p className="insp-nivel" data-nivel={nivel.nivel}>
          <span className="nivel-tag">{nivel.nivel}</span> {NIVELES[nivel.nivel] ?? ''}
        </p>
      )}
      {parte && (
        <p className="insp-desc">
          <b>{textoConProps(parte.mpn, props)}</b> · {parte.fabricante}
          {parte.generico && <> <span className="sub">(genérico)</span></>}
          {parte.descripcion && <><br />{parte.descripcion}</>}
          {datasheetOk && (
            <><br /><a href={parte.datasheet} target="_blank" rel="noopener noreferrer">Hoja de datos</a></>
          )}
          {def.esquematico && (
            <><br /><span className="sub">
              Esquemático: {def.esquematico.simbolo ?? 'caja con sus pines'} · {FABRICACION[def.esquematico.fabricacion ?? 'modulo']}
            </span></>
          )}
        </p>
      )}
      {falta.length > 0 && (
        <details className="insp-limites">
          <summary>Qué le falta</summary>
          <ul>{falta.map((f) => <li key={f}>{f}</li>)}</ul>
        </details>
      )}
    </>
  );
}
