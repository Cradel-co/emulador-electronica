import { expect, it } from 'vitest';
import { direccionesDeCodigo } from './pinScan.js';
import type { Language } from '@emu/shared';
it.each<[Language, string]>([
  ['micropython', 'Pin(7, Pin.OPEN_DRAIN)'],
  ['arduino', 'pinMode(7, OUTPUT_OPEN_DRAIN);'],
  ['idf-c', 'gpio_set_direction(GPIO_NUM_7, GPIO_MODE_OUTPUT_OD);'],
  ['idf-cpp', 'gpio_config_t io = { .pin_bit_mask = (1ULL << 7), .mode = GPIO_MODE_INPUT_OUTPUT_OD };'],
  ['esphome', 'output:\n  - platform: gpio\n    pin:\n      number: 7\n      mode:\n        output: true\n        open_drain: true'],
])('%s conserva la diferencia eléctrica entre open-drain y push-pull', (lenguaje, codigo) => {
  expect(direccionesDeCodigo(lenguaje, codigo).get(7)).toMatchObject({ salida: true, openDrain: true });
});
