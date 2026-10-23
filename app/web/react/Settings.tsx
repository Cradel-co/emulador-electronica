import { useState } from 'react';
import { placasDelProyecto, type Project } from '@emu/shared';
import { acciones, estado } from './puente.js';
import { useVersion } from './estado.js';
export function Settings() {
  useVersion();
  const [ocupado, setOcupado] = useState(false), [error, setError] = useState('');
  const s = estado(), p = s.proyecto as Project | null;
  const placas = p ? placasDelProyecto(p) : [];
  const disponible = placas.length === 1 && placas.every(b => b.language === 'micropython' && s.catalogo?.get(b.board)?.board?.chip?.startsWith('esp32'));
  const corriendo = Boolean(s.sim?.corriendo || s.sim?.listo || [...(s.sim?.estadosPorPlaca?.values() ?? [])].some((e: { running?: boolean }) => e.running));
  async function cambiar(motor: 'esp-emu' | 'propio') {
    setOcupado(true); setError('');
    try { await acciones().cambiarMotorEsp(motor); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setOcupado(false); }
  }
  const open = (id: string) => {
    (document.getElementById('dlg-ajustes') as HTMLDialogElement).close();
    (document.getElementById(id) as HTMLDialogElement).showModal();
  };
  return <form method="dialog" className="editor-preferences">
    <h2>Configuración</h2>
    {p && <fieldset disabled={ocupado || corriendo}>
      <legend>Simulación de este proyecto</legend>
      <label>Motor ESP32 <select aria-label="Motor ESP32" value={p.sim.motorEsp ?? 'esp-emu'} onChange={e => void cambiar(e.target.value as 'esp-emu' | 'propio')}>
        <option value="esp-emu">Motor del descriptor (ESP32: esp-emu)</option>
        <option value="propio" disabled={!disponible}>Propio · GPIO y temporización MicroPython</option>
      </select></label>
      <p>El motor propio corre main.py en TypeScript en el backend y usa el mismo circuito, Ejecutar, Parar y Reset. No necesita esp-emu.</p>
      <p>Soporte inicial: Pin, value/on/off, if/while, print y sleep/sleep_ms. No ejecuta firmware C/C++, ESPHome, Wi-Fi, PWM ni I2C/SPI. Para aplicar cambios de código, guardá y usá Parar y Ejecutar.</p>
      {corriendo && <p>Detené la simulación para cambiar el motor.</p>}
      {!disponible && <p>Para seleccionar el motor propio, el proyecto debe tener una placa ESP32 con MicroPython.</p>}
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    <div className="layout-settings-actions">
      <button type="button" onClick={() => open('dlg-editor-preferences')}>Ajustes del editor</button>
      <button type="button" onClick={() => open('dlg-layout-settings')}>Distribución de ventanas</button>
    </div>
    <div className="editor-preferences-actions"><button>Cerrar</button></div>
  </form>;
}
