// Copia de las consultas antes de extraerlas: oráculo independiente de equivalencia.
export function consultasOriginales(state) {
  const BOARD_ID = 'board';
  const descriptorPlaca = () => state.placa?.board ?? null;
  const cablesDe = (ref) => state.diagrama.wires.filter(w => w.from === ref || w.to === ref);
  function gpioDeRef(ref) {
    if (!ref.startsWith(`${BOARD_ID}.`)) return null;
    const pin = ref.slice(BOARD_ID.length + 1);
    const d = descriptorPlaca();
    if (d?.pins) {
      const g = d.pins[pin]?.gpio;
      return typeof g === 'number' ? g : null;
    }
    const m = /^GPIO(\d{1,2})$/.exec(pin);
    return m ? Number(m[1]) : null;
  }
  
  function nombrePinGpio(g) {
    const d = descriptorPlaca();
    const nombre = d?.pins && Object.keys(d.pins).find((k) => d.pins[k]?.gpio === g);
    return nombre ?? `GPIO${g}`;
  }
  
  function gpioDe(id, pin, visitados = new Set()) {
    const ref = `${id}.${pin}`;
    if (visitados.has(ref)) return null; // corta un lazo
    visitados.add(ref);
    for (const w of cablesDe(ref)) {
      const otro = w.from === ref ? w.to : w.from;
      const g = gpioDeRef(otro);
      if (g !== null) return g;
      const punto = otro.indexOf('.');
      const otroId = otro.slice(0, punto);
      const otroInst = state.diagrama.modules.find((m) => m.id === otroId);
      const otroDef = otroInst && state.catalogo.get(otroInst.type);
      if (!otroDef?.passthrough || otroDef.pins.length !== 2) continue;
      const siguientePin = otroDef.pins.find((p) => p.name !== otro.slice(punto + 1));
      if (siguientePin) {
        const g2 = gpioDe(otroId, siguientePin.name, visitados);
        if (g2 !== null) return g2;
      }
    }
    return null;
  }
  return { gpioDeRef, nombrePinGpio, gpioDe };
}
