import { gpioAdc1EspValido } from '@emu/shared';

/** API de MicroPython v1.29.0, ports/esp32/machine_adc.c: ADC1 de 12 bits.
 * La transferencia voltios→cuentas pertenece al perfil del servidor; acá sólo API/UART.
 * https://github.com/micropython/micropython/blob/v1.29.0/ports/esp32/machine_adc.c
 */
export function microPythonAdcPara(chip: string): string {
  const id = chip.toLowerCase().replace(/[-_]/g, '');
  const pines = Array.from({ length: 11 }, (_, i) => i).filter(gpio => gpioAdc1EspValido(id, gpio));
  return ADC.replace('@@PINES_ADC1@@', JSON.stringify(pines));
}

const ADC = `# ADC1 por snapshot del solver: sin perfil explícito el servidor devuelve SIN_MODELO.
_adc_atenuaciones = {}
_adc_pines = @@PINES_ADC1@@


class ADC:
    ATTN_0DB = 0
    ATTN_2_5DB = 1
    ATTN_6DB = 2
    ATTN_11DB = 3
    WIDTH_12BIT = 12

    def __init__(self, pin, *, atten=3):
        if isinstance(pin, bool) or not isinstance(pin, (int, Pin, _Pin)):
            raise ValueError('ADC MicroPython: se requiere GPIO o Pin')
        self._gpio = _gpio(pin)
        if self._gpio not in _adc_pines:
            raise ValueError('ADC MicroPython: GPIO sin ADC1 modelado; ADC2/arbitraje no soportado')
        self.init(atten=atten)

    def init(self, *, atten=3):
        self.atten(atten)

    def atten(self, atenuacion):
        if isinstance(atenuacion, bool) or not isinstance(atenuacion, int) or atenuacion not in (0, 1, 2, 3):
            raise ValueError('ADC MicroPython: atenuación inválida')
        _adc_atenuaciones[self._gpio] = atenuacion

    def width(self, bits):
        if isinstance(bits, bool) or not isinstance(bits, int) or bits != 12:
            raise NotImplementedError('ADC MicroPython: sólo 12 bits modelados')

    def read(self):
        s = _pedir('ADC', '%d %d' % (self._gpio, _adc_atenuaciones[self._gpio]))
        if s.startswith('E:'):
            raise OSError(5, 'ADC MicroPython: ' + s[2:])
        if not s or not all(c in '0123456789' for c in s):
            raise OSError(5, 'ADC MicroPython: RESPUESTA_INVALIDA')
        raw = int(s)
        if raw > 4095:
            raise OSError(5, 'ADC MicroPython: RESPUESTA_INVALIDA')
        return raw

    def read_u16(self):
        raw = self.read()
        return (raw << 4) | (raw >> 8)

    def read_uv(self):
        raise NotImplementedError('ADC MicroPython: read_uv requiere modelo de calibración/eFuse')

    def block(self):
        raise NotImplementedError('ADC MicroPython: ADCBlock sin modelo')

    def deinit(self):
        raise NotImplementedError('ADC MicroPython: ciclo de vida de unidad ADC sin modelo')


class ADCBlock:
    def __init__(self, *args, **kw):
        raise NotImplementedError('ADC MicroPython: ADCBlock sin modelo')
`;
