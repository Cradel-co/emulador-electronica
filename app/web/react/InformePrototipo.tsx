import { formatearMedidaInforme, informeHtml, type InformePrototipo } from '@emu/shared';
import { useEstado } from './estado.js';
import { estado } from './puente.js';

const valor = formatearMedidaInforme;
function descargar(informe: InformePrototipo, formato: 'json' | 'html'): void {
  const contenido = formato === 'json' ? JSON.stringify(informe, null, 2) : informeHtml(informe);
  const url = URL.createObjectURL(new Blob([contenido], { type: formato === 'json' ? 'application/json;charset=utf-8' : 'text/html;charset=utf-8' }));
  const enlace = document.createElement('a');
  enlace.href = url; enlace.download = `${informe.proyecto}-informe.${formato}`;
  enlace.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function InformePrototipoDialog() {
  const informe = useEstado(() => estado().informePrototipo as InformePrototipo | null);
  if (!informe) return null;
  return <form method="dialog" className="informe-prototipo">
    <h2>Informe del prototipo: {informe.proyecto}</h2>
    <p>Instantánea capturada el <time>{informe.fechaUtc}</time>. No se actualiza mientras permanece abierta.</p>
    <p>Dominio: <strong>{informe.dominio}</strong> · Estado: <strong>{informe.observacion.estado}</strong></p>
    <p>Placas: {informe.circuito.placas.map(p => `${p.id} (${p.board})`).join(', ') || 'Sin placa'}. Corrida: {informe.observacion.contexto.corrida}.</p>
    <div className="informe-tabla"><table><caption>Medidas de la instantánea</caption><thead><tr>
      <th>Módulo</th><th>Elemento</th><th>Tensión (V)</th><th>Corriente (mA)</th><th>Potencia (mW)</th><th>Resistencia (ohm)</th><th>Validez</th>
    </tr></thead><tbody>{informe.observacion.mediciones.map((m, i) => <tr key={`${m.modulo}/${m.elemento}/${i}`}>
      <td>{m.modulo}</td><td>{m.elemento}</td><td>{valor(m.tensionV)}</td><td>{valor(m.corrienteMa)}</td><td>{valor(m.potenciaMw)}</td><td>{valor(m.resistenciaOhm)}</td><td>{m.validez}</td>
    </tr>)}</tbody></table></div>
    {!informe.observacion.mediciones.length && <p>No hay medidas disponibles en esta instantánea.</p>}
    <details><summary>Circuito y contexto completos</summary><pre>{JSON.stringify({ circuito: informe.circuito, contexto: informe.observacion.contexto, catalogo: informe.catalogo }, null, 2)}</pre></details>
    <ul>{informe.avisos.map((aviso, i) => <li key={i}>{aviso}</li>)}</ul>
    <div className="informe-acciones">
      <button type="button" onClick={() => descargar(informe, 'json')}>Descargar JSON</button>
      <button type="button" onClick={() => descargar(informe, 'html')}>Descargar HTML</button>
      <button>Cerrar</button>
    </div>
  </form>;
}
