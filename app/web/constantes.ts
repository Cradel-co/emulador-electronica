/** Valores que comparten app.ts y los componentes de React. */

/** Cómo se llama cada lenguaje de proyecto en la UI. */
export const NOMBRE_LENGUAJE_PROYECTO: Record<string, string> = {
  esphome: 'ESPHome', 'idf-c': 'ESP-IDF C', 'idf-cpp': 'ESP-IDF C++', arduino: 'Arduino', micropython: 'MicroPython',
};

/** Valor de la opción "Sin placa (solo circuito)" del diálogo de proyecto nuevo. */
export const SIN_PLACA = '__sin-placa__';
