/** Datos de muestra para diseñar la navegación; las lecciones se incorporarán en MDX. */
export const temasAprendizaje = [
  { id: 'fundamentos', titulo: 'Fundamentos de electrónica', detalle: 'Voltaje, corriente y componentes', icono: 'circuito' },
  { id: 'circuitos', titulo: 'Circuitos y conexiones', detalle: 'Del esquema a la simulación', icono: 'circuito' },
  { id: 'arduino', titulo: 'Arduino', detalle: 'Programación y entradas digitales', icono: 'placa' },
  { id: 'esp32', titulo: 'ESP32', detalle: 'Microcontroladores y conectividad', icono: 'placa' },
  { id: 'micropython', titulo: 'MicroPython', detalle: 'Código para tus placas', icono: 'codigo' },
  { id: 'sensores', titulo: 'Sensores y actuadores', detalle: 'Medir e interactuar con el entorno', icono: 'circuito' },
  { id: 'comunicacion', titulo: 'Protocolos de comunicación', detalle: 'I²C, SPI y UART', icono: 'codigo' },
  { id: 'depuracion', titulo: 'Simulación y depuración', detalle: 'Observar, probar y resolver', icono: 'placa' },
] as const;

export const rutasAprendizaje = [
  { id: 'primer-circuito', titulo: 'Tu primer circuito', detalle: 'De los componentes a un circuito que funciona.', tema: 'fundamentos', nivel: 'Inicial', icono: 'circuito' },
  { id: 'programar-placas', titulo: 'Programá tu primera placa', detalle: 'Conectá el código con el mundo de la electrónica.', tema: 'micropython', nivel: 'Inicial', icono: 'codigo' },
  { id: 'sensores-en-accion', titulo: 'Sensores en acción', detalle: 'Explorá entradas, mediciones y respuestas.', tema: 'sensores', nivel: 'Intermedio', icono: 'placa' },
] as const;
