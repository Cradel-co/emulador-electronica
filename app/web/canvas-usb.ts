import { el } from './modulos.js';

/** Control reutilizable de alimentación sobre el lienzo SVG. */
export function dibujarControlUsb(padre: SVGElement, opciones: {
  x: number; y: number; activo: boolean; nombre: string; alternar: () => void;
}): void {
  const boton = el('g', {
    class: `placa-usb${opciones.activo ? ' activa' : ''}`,
    transform: `translate(${opciones.x} ${opciones.y})`,
    role: 'button', tabindex: 0,
    'aria-label': `USB de ${opciones.nombre}`,
    'aria-pressed': String(opciones.activo),
  }, padre);
  el('rect', { width: 64, height: 22, rx: 5 }, boton);
  el('text', { x: 32, y: 15, 'text-anchor': 'middle' }, boton).textContent = opciones.activo ? 'USB ON' : 'USB OFF';
  el('title', {}, boton).textContent = `Alimentación USB ${opciones.activo ? 'activa' : 'apagada'}. Click para cambiar.`;
  // El control no inicia el arrastre de la placa ni selecciona sus pines.
  boton.addEventListener('mousedown', e => { e.stopPropagation(); });
  boton.addEventListener('click', e => { e.stopPropagation(); opciones.alternar(); });
  boton.addEventListener('keydown', e => {
    if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      opciones.alternar();
    }
  });
}
