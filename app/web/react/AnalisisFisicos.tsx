import { BodeAc } from './BodeAc.js';
import { ParametrosAcSchema, type OpcionesAc } from '@emu/shared';
import { camposTermicos, formularioTermicoVacio, modeloDesdeFormulario, elementosTermicos } from '../termica-fisica.js';
import { useEffect, useRef, useState } from 'react';
import { formatearMedidaInforme, ParametrosVistaTransitorio, type ResultadoVistaAnalisis } from '@emu/shared';
import { firmaVistaAnalisis, seriesFisicas, trazaFisica } from '../analisis-fisico.js';
import { acciones, estado } from './puente.js';
import { useVersion } from './estado.js';

export function AnalisisFisicosDialog() {
  useVersion();
  const s = estado();
  const nombre = s.proyecto?.name as string | undefined;
  const [modo, setModo] = useState<'dc' | 'transitorio' | 'termico' | 'ac'>('dc');
  const [duracion, setDuracion] = useState('0.005'), [paso, setPaso] = useState('0.00001');
  const [inicializacion, setInicializacion] = useState<'equilibrio' | 'explicita'>('explicita');
  const [resultado, setResultado] = useState<ResultadoVistaAnalisis | null>(null);
  const [error, setError] = useState(''), [ocupado, setOcupado] = useState(false), [senal, setSenal] = useState('');
  const [modelo, setModelo] = useState(formularioTermicoVacio);
  const [elementos, setElementos] = useState<string[]>([]), [elemento, setElemento] = useState(''), [firmaElementos, setFirmaElementos] = useState('');
  const [opcionesAc, setOpcionesAc] = useState<(OpcionesAc & { firmaVista: string }) | null>(null);
  const [fuenteAc, setFuenteAc] = useState(''), [entradaAc, setEntradaAc] = useState(''), [salidaAc, setSalidaAc] = useState('');
  const [inicioHz, setInicioHz] = useState('10'), [finHz, setFinHz] = useState('100000'), [puntosAc, setPuntosAc] = useState('20');
  const captura = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const cerrar = () => { captura.current?.abort(); captura.current = null; setOcupado(false); };
    const dialogo = panel.current?.closest('dialog');
    dialogo?.addEventListener('close', cerrar);
    return () => { cerrar(); dialogo?.removeEventListener('close', cerrar); };
  }, []);
  useEffect(() => { captura.current?.abort(); captura.current = null; setOcupado(false); setResultado(null); setError(''); setElementos([]); setElemento(''); setFirmaElementos(''); setModelo(formularioTermicoVacio()); setOpcionesAc(null); }, [nombre]);
  const obsoleto = resultado !== null && (resultado.firmaVista !== firmaVistaAnalisis(s.proyecto, s.diagrama) || s.editorSucio || s.conflictoGuardado != null);
  const seleccionVigente = firmaElementos === firmaVistaAnalisis(s.proyecto, s.diagrama);
  const temporal = resultado && (resultado.dominio === 'transitorio-diseno' || resultado.dominio === 'termico-diseno') ? resultado : null;
  const acVigente = opcionesAc?.firmaVista === firmaVistaAnalisis(s.proyecto, s.diagrama);
  const series = temporal ? seriesFisicas(temporal.resultado) : [];
  const serie = series.find(v => v.id === senal) ?? series[0];
  const traza = temporal && serie ? trazaFisica(temporal.resultado.t, serie.valores) : null;
  async function calcular() {
    captura.current?.abort(); const controller = new AbortController(); captura.current = controller;
    setResultado(null); setError(''); setOcupado(true);
    try {
      const validacion = ParametrosVistaTransitorio.safeParse({ pasoS: Number(paso), duracionS: Number(duracion), inicializacion });
      if (modo !== 'dc' && modo !== 'ac' && !validacion.success) throw new Error('Duración y paso deben ser positivos, paso no mayor que duración y hasta 20000 muestras estimadas.');
      const parametros = modo !== 'dc' && validacion.success ? validacion.data : { pasoS: 0.00001, duracionS: 0.005, inicializacion };
      if (modo === 'termico' && (!seleccionVigente || !elementos.includes(elemento))) throw new Error('Identificá de nuevo los elementos del circuito antes de calcular.');
      const configuracion = modo === 'termico' ? { elemento, modelo: modeloDesdeFormulario(modelo) } : undefined;
      if (modo === 'ac' && (!acVigente || !opcionesAc?.fuentes.includes(fuenteAc) || !opcionesAc.pines.includes(entradaAc) || !opcionesAc.pines.includes(salidaAc))) throw new Error('Identificá el circuito y elegí fuente, entrada y salida.');
      const pedidoAc = ParametrosAcSchema.safeParse({ fuente: fuenteAc, entrada: entradaAc, salida: salidaAc, inicioHz: Number(inicioHz), finHz: Number(finHz), puntosPorDecada: Number(puntosAc) });
      if (modo === 'ac' && !pedidoAc.success) throw new Error('AC requiere frecuencias positivas, fin mayor que inicio, 1 a 1000 puntos enteros por década y entre 2 y 10000 frecuencias.');
      const ac = modo === 'ac' && pedidoAc.success ? pedidoAc.data : undefined;
      const r = await acciones().analizarFisica(modo, parametros, controller.signal, configuracion, ac);
      if (!controller.signal.aborted && captura.current === controller) { setResultado(r); setSenal(''); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (captura.current === controller) { captura.current = null; setOcupado(false); } }
  }
  async function identificar() {
    captura.current?.abort(); const controller = new AbortController(); captura.current = controller;
    setOcupado(true); setError(''); setResultado(null); setElementos([]); setFirmaElementos('');
    try {
      const r = await acciones().analizarFisica('dc', { pasoS: 0.00001, duracionS: 0.005, inicializacion: 'equilibrio' }, controller.signal);
      if (!controller.signal.aborted && captura.current === controller && r.dominio === 'instantanea-dc') {
        const ids = elementosTermicos(r.resultado); setElementos(ids); setElemento(ids[0] ?? ''); setFirmaElementos(r.firmaVista);
        if (!ids.length) setError('No hay resistencias o contactos disipativos con medidas válidas. Revisá el circuito y su alimentación.');
      }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (captura.current === controller) { captura.current = null; setOcupado(false); } }
  }
  async function identificarFrecuencias() {
    captura.current?.abort(); const controller = new AbortController(); captura.current = controller;
    setOcupado(true); setError(''); setResultado(null); setOpcionesAc(null);
    try {
      const r = await acciones().identificarAc(controller.signal);
      if (!controller.signal.aborted && captura.current === controller) {
        setOpcionesAc(r); setFuenteAc(''); setEntradaAc(''); setSalidaAc('');
        if (!r.fuentes.length) setError('No hay fuentes de tensión activas. Energizá el circuito y volvé a identificar.');
      }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (captura.current === controller) { captura.current = null; setOcupado(false); } }
  }
  function descargar() {
    if (!resultado || obsoleto) return;
    // La firma local incluye configuración interna; no forma parte del informe público.
    const { firmaVista: _firma, ...publico } = resultado;
    const url = URL.createObjectURL(new Blob([JSON.stringify(publico, null, 2)], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${resultado.proyecto}-${resultado.dominio}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const medidas = resultado?.dominio === 'instantanea-dc' ? resultado.resultado.observacion.mediciones : [];
  return <section ref={panel} className="analisis-fisicos">
    <h2>Análisis físicos: {nombre ?? 'Sin proyecto'}</h2>
    <p>Instantáneas de diseño. El transitorio mantiene GPIO y topología fijos; no ejecuta firmware ni reproduce el audio del micrófono.</p>
    <div className="analisis-controles">
      <label>Análisis <select aria-label="Tipo de análisis" value={modo} disabled={ocupado} onChange={e => { setModo(e.target.value as typeof modo); setResultado(null); setError(''); }}>
        <option value="dc">DC · punto de funcionamiento</option><option value="transitorio">Transitorio · evolución temporal</option><option value="termico">Térmico · temperatura y energía</option><option value="ac">AC · respuesta en frecuencia</option>
      </select></label>
      {modo !== 'dc' && modo !== 'ac' && <>
        <label>Duración (s) <input type="number" step="any" min="0" value={duracion} onChange={e => { setDuracion(e.target.value); setResultado(null); }} disabled={ocupado}/></label>
        <label>Paso máximo (s) <input type="number" step="any" min="0" value={paso} onChange={e => { setPaso(e.target.value); setResultado(null); }} disabled={ocupado}/></label>
        <label>Inicialización <select aria-label="Inicialización" value={inicializacion} disabled={ocupado} onChange={e => { setInicializacion(e.target.value as typeof inicializacion); setResultado(null); }}>
          <option value="equilibrio">Equilibrio DC</option><option value="explicita">Condiciones C/L del proyecto</option>
        </select></label>
      </>}
      <button disabled={ocupado || !nombre} onClick={() => void calcular()}>{ocupado ? 'Calculando…' : 'Calcular'}</button>
    </div>
    {modo === 'ac' && <fieldset className="modelo-termico" disabled={ocupado}>
      <legend>Barrido AC de pequeña señal</legend>
      <p>Seleccioná una fuente y pines referidos a tierra. Se conserva la polarización DC; la ganancia usa salida/entrada. Configuración temporal del panel.</p>
      <button type="button" onClick={() => void identificarFrecuencias()}>Identificar circuito AC</button>
      <div className="termica-campos">{([
        ['Fuente AC', fuenteAc, setFuenteAc, opcionesAc?.fuentes ?? []],
        ['Entrada AC', entradaAc, setEntradaAc, opcionesAc?.pines ?? []],
        ['Salida AC', salidaAc, setSalidaAc, opcionesAc?.pines ?? []],
      ] as const).map(([titulo, valor, cambiar, ids]) => <label key={titulo}>{titulo}<select aria-label={titulo} value={acVigente ? valor : ''} onChange={e => { cambiar(e.target.value); setResultado(null); }}>
        <option value="">Identificá y seleccioná</option>{acVigente && ids.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>)}
      {([['Frecuencia inicial (Hz)', inicioHz, setInicioHz], ['Frecuencia final (Hz)', finHz, setFinHz], ['Puntos por década', puntosAc, setPuntosAc]] as const).map(([titulo, valor, cambiar]) => <label key={titulo}>{titulo}<input aria-label={titulo} type="number" step="any" min="0" value={valor} onChange={e => { cambiar(e.target.value); setResultado(null); }}/></label>)}
      </div><p>Hasta 10000 frecuencias; fin mayor que inicio y de 1 a 1000 puntos enteros por década.</p>
    </fieldset>}
    {modo === 'termico' && <fieldset className="modelo-termico" disabled={ocupado}>
      <legend>Modelo térmico explícito</legend>
      <p>Un cuerpo a temperatura uniforme y ambiente fijo, sin realimentación eléctrica. Declarar parámetros no acredita caracterización experimental.</p>
      <button type="button" onClick={() => void identificar()}>Identificar elementos</button>
      <label>Elemento disipativo <select aria-label="Elemento disipativo" value={seleccionVigente ? elemento : ''} onChange={e => { setElemento(e.target.value); setResultado(null); }}>
        <option value="">Identificá el circuito y elegí un elemento</option>
        {seleccionVigente && elementos.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <div className="termica-campos">{camposTermicos.map(([k, titulo, numerico]) => <label key={k}>{titulo}
        <input aria-label={titulo} type={numerico ? 'number' : 'text'} step={numerico ? 'any' : undefined} maxLength={numerico ? undefined : 2000} value={modelo[k]}
          onChange={e => { setModelo({ ...modelo, [k]: e.target.value }); setResultado(null); }}/>
      </label>)}</div>
      <p>Configuración temporal del panel; no modifica las propiedades del proyecto.</p>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    {resultado && <>
      <p>Dominio: <strong>{resultado.dominio}</strong> · Capturado: <time>{resultado.fechaUtc}</time></p>
      {obsoleto && <p role="alert">El circuito cambió. Recalculá para obtener resultados vigentes.</p>}
      {resultado.dominio === 'instantanea-dc' ? <>
        <p>Estado: {resultado.resultado.observacion.estado}</p>
        <div className="informe-tabla"><table><caption>Medidas DC</caption><thead><tr><th>Elemento</th><th>Tensión (V)</th><th>Corriente (mA)</th><th>Potencia (mW)</th><th>Validez</th></tr></thead>
          <tbody>{medidas.map((m, i) => <tr key={i}><td>{m.modulo}.{m.elemento}</td><td>{formatearMedidaInforme(m.tensionV)}</td><td>{formatearMedidaInforme(m.corrienteMa)}</td><td>{formatearMedidaInforme(m.potenciaMw)}</td><td>{m.validez}</td></tr>)}</tbody></table></div>
        {!medidas.length && <p>No hay medidas disponibles.</p>}
      </> : resultado.dominio === 'ac-diseno' ? <BodeAc resultado={resultado.resultado}/> : <>
        <label>Señal <select aria-label="Señal" value={serie?.id ?? ''} onChange={e => setSenal(e.target.value)}>{series.map(v => <option key={v.id} value={v.id}>{v.nombre} ({v.unidad})</option>)}</select></label>
        {traza && serie ? <svg viewBox="0 0 640 265" role="img" aria-label={`Gráfico de ${serie.nombre} en ${serie.unidad}`}>
          <path d="M95,30 V220 H620" fill="none" stroke="currentColor"/>
          <text x="90" textAnchor="end" y="25">{traza.max.toPrecision(4)} {serie.unidad}</text><text x="90" textAnchor="end" y="220">{traza.min.toPrecision(4)}</text>
          <text x="95" y="250">{traza.inicio.toPrecision(4)} s</text><text x="520" y="250">{traza.fin.toPrecision(4)} s</text>
          <path data-testid="traza-fisica" d={traza.path} fill="none" stroke="#35c798" strokeWidth="2"/>
        </svg> : <p>No hay señales referenciadas disponibles.</p>}
        <p>{resultado.resultado.t.length} muestras adaptativas. La descarga conserva todas las muestras.</p>
      </>}
      {resultado.dominio === 'termico-diseno' && <div className="informe-tabla"><table><caption>Energía del modelo térmico (J)</caption><thead><tr><th>Elemento</th><th>Disipada</th><th>Almacenada (Δ)</th><th>Evacuada</th><th>Rango declarado (°C)</th></tr></thead>
        <tbody>{Object.entries(resultado.resultado.termica ?? {}).map(([id, t]) => <tr key={id}><td>{id}</td><td>{t.energiaDisipadaJ.toPrecision(5)}</td><td>{t.energiaAlmacenadaDeltaJ.toPrecision(5)}</td><td>{t.energiaEvacuadaJ.toPrecision(5)}</td><td>{t.modelo.rangoDeclaradoC.join(' a ')}</td></tr>)}</tbody></table><p>La temperatura inicial corresponde a la primera muestra del transitorio. Energía evacuada negativa: el ambiente aporta calor. Sin caracterización de laboratorio acreditada.</p></div>}
      <ul>{(resultado.dominio === 'instantanea-dc' ? resultado.resultado.avisos : resultado.resultado.advertencias).map((a, i) => <li key={i}>{a}</li>)}</ul>
      <button disabled={obsoleto} onClick={descargar}>Descargar análisis JSON</button>
    </>}
    <button onClick={() => panel.current?.closest('dialog')?.close()}>Cerrar</button>
  </section>;
}
