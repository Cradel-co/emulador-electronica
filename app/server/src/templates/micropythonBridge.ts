// Puente de simulación para MicroPython (sección 8.8): equivalente en Python del
// componente C++ `firmware/components/sim_bridge`. Se sube al dispositivo por el
// REPL en crudo antes de cada corrida (emulator.ts → uploadMicroPython) — no es
// parte del código del usuario, así que no lo ve si mira solo su main.py.
//
// Protocolo (7.1): igual al de ESPHome — habla por UART1 (pines 17/18, los mismos
// que usa sim_bridge en C++, ya reservados en PINES_RESERVADOS de diagramOps.ts).
//
// Entradas (7.2): el pad NO se puede inyectar de forma confiable en esp-emu (así
// lo dice el propio sim_bridge.cpp: "la lógica interna de entrada no ve el cambio").
// Por eso el puente reemplaza `machine.Pin` al arrancar (antes de main.py): es el Pin
// real, pero si la app maneja ese pin como entrada (un botón cableado, por `@IN`),
// `value()` devuelve ese nivel y las `irq()` se disparan con sus flancos. Así el código
// MicroPython de siempre (`Pin(6, Pin.IN, Pin.PULL_UP)`) funciona igual que en una placa
// real, sin nada específico del emulador. `simbridge.pin(n)` queda por compatibilidad.
//
// Salidas: si se pueden leer de verdad, sondeando GPIO_OUT_REG/GPIO_OUT1_REG (las
// mismas direcciones que usa el C++, confirmadas contra
// .cache/idf/frameworks/5.5.5/components/soc/esp32s3/register/soc/gpio_reg.h).
//
// Por placa (descriptor del module.json): los pines de UART1 (`board.io`) y la
// dirección de GPIO_OUT_REG (`languages.micropython.options.gpioOutRegs`) cambian de
// chip a chip (S3/C3: 0x60004004, C6: 0x60091004; C3 y C6 tienen menos de 32 GPIO y
// no tienen OUT1).

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

export interface PlacaMicroPython {
  chip: string;
  uart: number;
  tx: number;
  rx: number;
  /** [GPIO_OUT_REG (pines 0-31), GPIO_OUT1_REG (32..) si el chip lo tiene]. */
  gpioOutRegs: number[];
}

export function microPythonSimbridgePara(p: PlacaMicroPython): string {
  const [out, out1] = p.gpioOutRegs;
  if (out === undefined) throw new Error('falta gpioOutRegs en las opciones de micropython');
  const linea1 =
    out1 === undefined
      ? `_GPIO_OUT1_REG = None        # ${p.chip}: menos de 32 GPIO, no hay OUT1`
      : `_GPIO_OUT1_REG = ${hex(out1)}  # DR_REG_GPIO_BASE + 0x10 (pines 32-48 en el bit 0..)`;
  return SIMBRIDGE.replace('@@CHIP@@', p.chip)
    .replace('@@OUT@@', `_GPIO_OUT_REG = ${hex(out)}   # DR_REG_GPIO_BASE + 0x4  (pines 0-31)`)
    .replace('@@OUT1@@', linea1)
    .replace('@@UART@@', `_uart = machine.UART(${p.uart}, baudrate=115200, tx=${p.tx}, rx=${p.rx})`);
}

const SIMBRIDGE = `# Puente de simulación (generado por la app, no lo edites: se pisa en cada corrida).
# Chip: @@CHIP@@
import machine, _thread, utime, micropython

@@OUT@@
@@OUT1@@

@@UART@@
_input_levels = {}
_watched = {}


def pin(n):
    """Como machine.Pin pero de solo lectura: .value() da lo que puso la app (7.2),
    no lo que lee el pad (no es confiable en la simulación)."""
    return _SimPin(n)


class _SimPin:
    def __init__(self, n):
        self.n = n

    def value(self, *args):
        if args:
            return None  # de solo lectura: un módulo de entrada no se "escribe"
        return _input_levels.get(self.n, 1)  # reposo=1, como un pull-up sin apretar


_Pin = machine.Pin
_irqs = {}  # pin -> (trigger, handler, objeto Pin)


class Pin:
    """machine.Pin de la simulación: delega todo en el Pin real, salvo leer un pin que
    la app maneja como entrada (ahí manda el nivel simulado, y dispara las irq)."""

    def __init__(self, id, *args, **kw):
        self._p = _Pin(id, *args, **kw)
        self._n = id
        if kw.get('value') is not None:
            _avisar(id, kw['value'])

    def init(self, *args, **kw):
        if kw.get('value') is not None:
            _avisar(self._n, kw['value'])
        return self._p.init(*args, **kw)

    def value(self, *args):
        if args:
            _avisar(self._n, args[0])
            return self._p.value(*args)
        if self._n in _input_levels:
            return _input_levels[self._n]
        return self._p.value()

    def __call__(self, *args):
        return self.value(*args)

    def on(self):
        self.value(1)

    def off(self):
        self.value(0)

    def irq(self, handler=None, trigger=None, *args, **kw):
        if trigger is None:
            trigger = _Pin.IRQ_FALLING | _Pin.IRQ_RISING
        if handler is None:
            _irqs.pop(self._n, None)
        else:
            _irqs[self._n] = (trigger, handler, self)
        try:
            return self._p.irq(handler, trigger, *args, **kw)
        except Exception:
            return None

    def __getattr__(self, nombre):
        return getattr(self._p, nombre)


for _k in dir(_Pin):
    if _k[:1].isupper() and not hasattr(Pin, _k):
        setattr(Pin, _k, getattr(_Pin, _k))  # Pin.IN, Pin.OUT, Pin.PULL_UP, Pin.IRQ_FALLING…


_REEMPLAZOS = {}


def _instalar_pin():
    """Hace que main.py use este Pin (y los buses de los chips): \`from machine import Pin\`, \`machine.I2C(...)\`."""
    _REEMPLAZOS.update({'Pin': Pin, 'I2C': I2C, 'SoftI2C': SoftI2C, 'SPI': SPI, 'SoftSPI': SoftSPI})
    try:
        for k in _REEMPLAZOS:
            setattr(machine, k, _REEMPLAZOS[k])
        return 'machine.Pin'
    except Exception:
        pass
    import sys

    class _Machine:
        def __getattr__(self, nombre):
            return getattr(machine, nombre)

    m = _Machine()
    for k in _REEMPLAZOS:
        setattr(m, k, _REEMPLAZOS[k])
    sys.modules['machine'] = m
    return 'sys.modules'


def _read_out(n):
    if n < 32 or _GPIO_OUT1_REG is None:
        return (machine.mem32[_GPIO_OUT_REG] >> n) & 1
    return (machine.mem32[_GPIO_OUT1_REG] >> (n - 32)) & 1


_tx_lock = _thread.allocate_lock()


def _send(line):
    # El hilo del puente y el programa (los buses de los chips) escriben a la vez: una línea entera por vez.
    _tx_lock.acquire()
    try:
        _uart.write(line + '\\n')
    except Exception:
        pass
    _tx_lock.release()


# --- Chips del dibujo (server/src/bus/puenteChips.ts) --------------------------------
# esp-emu no acepta dispositivos I2C/SPI propios: machine.I2C, SoftI2C, SPI y SoftSPI se
# reemplazan por estas clases, que mandan cada llamada por el puente y esperan la respuesta
# de los chips emulados en la app. Los pines tienen que ser los del dibujo (la matriz GPIO
# deja cualquiera, como en la placa real). Los pines que vigilan los chips (CS, DC, RST)
# se avisan con @P al escribirlos, en orden con las transacciones.
_chip_pins = set()
_estado = {'chips': False}
_rx_lock = _thread.allocate_lock()
_rx = ['']
_resp = {}
_seq = [0]


def _avisar(n, v):
    # Antes del anuncio de pines también se conserva CS: main.py puede arrancar enseguida.
    if not _estado['chips'] or n in _chip_pins:
        _send('@P %d %d %d' % (n, 1 if v else 0, utime.ticks_us()))


def _bombear():
    """Lee lo que llegó por el puente y lo atiende (lo usan el hilo del puente y el que espera una respuesta)."""
    if not _rx_lock.acquire(0):
        return
    try:
        n = _uart.any()
        if n:
            _rx[0] += _uart.read(n).decode('utf-8', 'ignore')
            while '\\n' in _rx[0]:
                line, _rx[0] = _rx[0].split('\\n', 1)
                _handle(line)
    except Exception:
        pass
    _rx_lock.release()


def _pedir(tag, resto):
    _seq[0] += 1
    rid = _seq[0]
    _send('@%s %d %s' % (tag, rid, resto))
    t0 = utime.ticks_ms()
    while rid not in _resp:
        _bombear()
        if rid in _resp:
            break
        if utime.ticks_diff(utime.ticks_ms(), t0) > 5000:
            raise OSError(116)  # ETIMEDOUT: la app no contestó
        utime.sleep_ms(1)
    return _resp.pop(rid)


def _b64(b):
    import ubinascii
    return ubinascii.b2a_base64(bytes(b)).decode().strip()


def _de64(s):
    import ubinascii
    return ubinascii.a2b_base64(s) if s else b''


def _gpio(p):
    if p is None or isinstance(p, int):
        return p
    n = getattr(p, '_n', None)
    if isinstance(n, int):
        return n
    d = ''.join([c for c in str(p) if c.isdigit()])  # Pin(21)
    return int(d) if d else None


class I2C:
    def __init__(self, id=0, scl=None, sda=None, freq=400000, timeout=50000):
        self._scl = None
        self._sda = None
        self._freq = 400000
        self.init(scl=scl, sda=sda, freq=freq)

    def init(self, scl=None, sda=None, freq=None, timeout=None):
        if scl is not None:
            self._scl = _gpio(scl)
        if sda is not None:
            self._sda = _gpio(sda)
        if freq:
            self._freq = int(freq)
        if self._scl is None or self._sda is None:
            raise ValueError('simulación: indicá los pines del I2C (scl=Pin(..), sda=Pin(..)), los mismos del dibujo')

    def deinit(self):
        pass

    def _tx(self, ops):
        r = _pedir('I2C', '%d %d %d %d %s' % (utime.ticks_us(), self._sda, self._scl, self._freq, ';'.join(ops))).split(';')
        if 'N' in r:
            raise OSError(19)  # ENODEV: la dirección no contestó (NACK), como en la placa real
        return r

    def scan(self):
        r = _pedir('I2CS', '%d %d %d %d' % (utime.ticks_us(), self._sda, self._scl, self._freq))
        return [int(x, 16) for x in r.split(',') if x]

    def writeto(self, addr, buf, stop=True):
        return int(self._tx(['W%x:%s' % (addr, _b64(buf))] + (['P'] if stop else []))[0])

    def writevto(self, addr, vector, stop=True):
        return self.writeto(addr, b''.join([bytes(v) for v in vector]), stop)

    def readfrom(self, addr, nbytes, stop=True):
        return _de64(self._tx(['R%x:%d' % (addr, nbytes)] + (['P'] if stop else []))[0])

    def readfrom_into(self, addr, buf, stop=True):
        d = self.readfrom(addr, len(buf), stop)
        for i in range(len(d)):
            buf[i] = d[i]

    def _mem(self, memaddr, addrsize):
        n = addrsize // 8
        return bytes([(memaddr >> (8 * (n - 1 - i))) & 0xff for i in range(n)])

    def readfrom_mem(self, addr, memaddr, nbytes, addrsize=8):
        r = self._tx(['W%x:%s' % (addr, _b64(self._mem(memaddr, addrsize))), 'R%x:%d' % (addr, nbytes), 'P'])
        return _de64(r[1])

    def readfrom_mem_into(self, addr, memaddr, buf, addrsize=8):
        d = self.readfrom_mem(addr, memaddr, len(buf), addrsize)
        for i in range(len(d)):
            buf[i] = d[i]

    def writeto_mem(self, addr, memaddr, buf, addrsize=8):
        self._tx(['W%x:%s' % (addr, _b64(self._mem(memaddr, addrsize) + bytes(buf))), 'P'])


class SoftI2C(I2C):
    def __init__(self, scl, sda, freq=400000, timeout=50000):
        I2C.__init__(self, -1, scl=scl, sda=sda, freq=freq)


class SPI:
    MSB = 0
    LSB = 1

    def __init__(self, id=1, baudrate=1000000, polarity=0, phase=0, bits=8, firstbit=0, sck=None, mosi=None, miso=None):
        self._sck = None
        self._mosi = None
        self._miso = None
        self._baud = 1000000
        self._modo = 0
        self._lsb = 0
        self.init(baudrate, polarity, phase, bits, firstbit, sck, mosi, miso)

    def init(self, baudrate=None, polarity=None, phase=None, bits=None, firstbit=None, sck=None, mosi=None, miso=None):
        if baudrate:
            self._baud = int(baudrate)
        if polarity is not None or phase is not None:
            self._modo = (polarity or 0) * 2 + (phase or 0)
        if firstbit is not None:
            self._lsb = 1 if firstbit == SPI.LSB else 0
        if sck is not None:
            self._sck = _gpio(sck)
        if mosi is not None:
            self._mosi = _gpio(mosi)
        if miso is not None:
            self._miso = _gpio(miso)
        if self._sck is None or self._mosi is None:
            raise ValueError('simulación: indicá los pines del SPI (sck=Pin(..), mosi=Pin(..), miso=Pin(..)), los mismos del dibujo')

    def deinit(self):
        pass

    def _x(self, datos, espera):
        cab = '%d %d %d %d %d %d' % (self._sck, self._mosi, -1 if self._miso is None else self._miso, self._baud, self._modo, self._lsb)
        if not espera:
            # Solo escribir (una pantalla): no hace falta esperar, el orden con los @P se mantiene.
            for i in range(0, len(datos), 1536):
                _send('@SPI 0 %d %s %s 0' % (utime.ticks_us(), cab, _b64(datos[i:i + 1536])))
            return None
        return _de64(_pedir('SPI', '%d %s %s 1' % (utime.ticks_us(), cab, _b64(datos))))

    def write(self, buf):
        self._x(bytes(buf), False)

    def read(self, nbytes, write=0):
        return b''.join(self._x(bytes([write]) * min(512, nbytes - offset), True) for offset in range(0, nbytes, 512))

    def readinto(self, buf, write=0):
        d = self.read(len(buf), write)
        for i in range(len(d)):
            buf[i] = d[i]

    def write_readinto(self, write_buf, read_buf):
        d = b''.join(self._x(bytes(write_buf[offset:offset + 512]), True) for offset in range(0, len(write_buf), 512))
        for i in range(len(d)):
            read_buf[i] = d[i]


class SoftSPI(SPI):
    def __init__(self, baudrate=500000, polarity=0, phase=0, bits=8, firstbit=0, sck=None, mosi=None, miso=None):
        SPI.__init__(self, -1, baudrate, polarity, phase, bits, firstbit, sck, mosi, miso)


# --- Modo debug (server/src/debug/adaptadorMicropython.ts) ---------------------------
# @DUMP <id>: variables globales de main.py (el módulo __main__), memoria y reloj.
# @EVAL <id> <expr en base64>: evalúa una expresión en las globales de main.py.
# Responde en trozos cortos (el protocolo del puente es de líneas de <256 bytes):
#   @VARS <id> <i>/<n> <json en base64, trozo i de n>
_OCULTAS = ('bdev', 'vfs', 'inisetup', 'gc', 'sys')
_PROHIBIDO = ('import', 'exec', 'eval', 'compile', 'open', '__', 'reset', 'sleep', 'globals', 'locals', 'setattr', 'delattr', 'input')


def _responder(rid, obj):
    try:
        import json, ubinascii
        try:
            datos = json.dumps(obj)
        except Exception as e:
            datos = json.dumps({'error': 'no se pudo serializar: %s' % e})
        b = ubinascii.b2a_base64(datos.encode()).strip()
        n = (len(b) + 179) // 180
        for i in range(n):
            _send('@VARS %s %d/%d %s' % (rid, i + 1, n, b[i * 180:(i + 1) * 180].decode()))
    except Exception:
        pass


def _describir(v):
    t = type(v).__name__
    try:
        r = repr(v)
    except Exception as e:
        r = '<repr falló: %s>' % e
    if len(r) > 120:
        r = r[:120] + '...'
    n = None
    try:
        if isinstance(v, (list, tuple, dict, set, str, bytes, bytearray)):
            n = len(v)
    except Exception:
        pass
    expandible = isinstance(v, (list, tuple, dict, set)) and bool(n)
    if not expandible and t not in ('module', 'function', 'type', 'bound_method', 'closure', 'generator'):
        try:
            expandible = len(v.__dict__) > 0
        except Exception:
            pass
    return [t, r, n, expandible]


def _dump():
    import __main__, gc, sys
    vs = []
    fs = []
    try:
        items = list(__main__.__dict__.items())
    except Exception:
        items = []
    for k, v in items:
        if k[:2] == '__' or k in _OCULTAS:
            continue
        t = type(v).__name__
        if t == 'module':
            continue
        if t in ('function', 'closure', 'bound_method', 'type', 'generator'):
            fs.append([k, t])
            continue
        vs.append([k] + _describir(v))
    return {
        'vars': vs[:60],
        'truncado': len(vs) > 60,
        'funcs': fs[:60],
        'mem_free': gc.mem_free(),
        'mem_alloc': gc.mem_alloc(),
        'ticks_ms': utime.ticks_ms(),
        'entradas': [[k, v] for k, v in _input_levels.items()],
        'vigilados': [[k, v] for k, v in _watched.items()],
        'hilo_puente': _thread.get_ident(),
        'plataforma': sys.platform,
        'version': sys.version,
    }


def _evaluar(b64):
    try:
        import ubinascii
        expr = ubinascii.a2b_base64(b64).decode()
    except Exception as e:
        return {'error': 'expresión mal codificada: %s' % e}
    ids = []
    act = ''
    for c in expr + ' ':
        if c.isalpha() or c.isdigit() or c == '_':
            act += c
        else:
            if act:
                ids.append(act)
            act = ''
    for i in ids:
        if i in _PROHIBIDO or '__' in i or 'sleep' in i or 'reset' in i:
            return {'error': 'no permitido en evaluate: "%s" (solo lectura de valores)' % i}
    import __main__
    try:
        v = eval(expr, __main__.__dict__)
    except Exception as e:
        return {'error': '%s: %s' % (type(e).__name__, e)}
    d = _describir(v)
    hijos = []
    try:
        if isinstance(v, dict):
            for k in list(v.keys())[:50]:
                hijos.append([repr(k)] + _describir(v[k]))
        elif isinstance(v, (list, tuple)):
            for i in range(min(len(v), 50)):
                hijos.append([str(i)] + _describir(v[i]))
        elif isinstance(v, set):
            for x in list(v)[:50]:
                hijos.append(['*'] + _describir(x))
        else:
            for k, x in list(v.__dict__.items())[:50]:
                hijos.append(['.' + k] + _describir(x))
    except Exception:
        pass
    return {'tipo': d[0], 'repr': d[1], 'len': d[2], 'hijos': hijos}


def _handle(line):
    line = line.strip()
    if not line or line[0] != '@':
        return
    parts = line[1:].split(' ')
    tag = parts[0]
    if tag == 'HELLO':
        _send('@READY 1 micropython')
    elif tag == 'PING':
        _send('@PONG ' + (parts[1] if len(parts) > 1 else '0'))
    elif tag == 'WATCH':
        n = int(parts[1])
        lvl = _read_out(n)
        _watched[n] = lvl
        _send('@OUT %d %d' % (n, lvl))
    elif tag == 'IN':
        n = int(parts[1])
        lvl = int(parts[2])
        antes = _input_levels.get(n, 1)  # reposo = 1, como un pull-up sin apretar
        _input_levels[n] = lvl
        irq = _irqs.get(n)
        if irq and antes != lvl:
            trigger, handler, p = irq
            if (lvl == 0 and trigger & _Pin.IRQ_FALLING) or (lvl == 1 and trigger & _Pin.IRQ_RISING):
                micropython.schedule(handler, p)
    elif tag == 'I2CR' or tag == 'SPIR':
        _resp[int(parts[1])] = parts[2] if len(parts) > 2 else ''
    elif tag == 'CHIPPINS':
        _chip_pins.clear()
        for x in parts[1:]:
            if x:
                _chip_pins.add(int(x))
        _estado['chips'] = True
    elif tag == 'DUMP':
        _responder(parts[1] if len(parts) > 1 else '0', _dump())
    elif tag == 'EVAL':
        _responder(parts[1] if len(parts) > 1 else '0', _evaluar(parts[2] if len(parts) > 2 else ''))
    # RF y mensajes desconocidos: no implementado todavía para MicroPython (queda para más adelante).


def _loop():
    _send('@READY 1 micropython')
    latido = utime.ticks_ms()
    while True:
        try:
            _bombear()
            # El reloj del ESP32 para los chips (una conversión, un cuadro): aunque el programa no hable.
            if _estado['chips'] and utime.ticks_diff(utime.ticks_ms(), latido) >= 50:
                latido = utime.ticks_ms()
                _send('@T %d' % utime.ticks_us())
            for n in list(_watched.keys()):
                lvl = _read_out(n)
                if _watched[n] != lvl:
                    _watched[n] = lvl
                    _send('@OUT %d %d' % (n, lvl))
        except Exception:
            pass
        utime.sleep_ms(20)


def start():
    como = _instalar_pin()
    _thread.start_new_thread(_loop, ())
    return como
`;

/** El del ESP32-S3 (la placa de siempre). */
export const microPythonSimbridge = microPythonSimbridgePara({
  chip: 'ESP32-S3',
  uart: 1,
  tx: 17,
  rx: 18,
  gpioOutRegs: [0x60004004, 0x60004010],
});

export const microPythonBoot = `# boot.py (generado por la app): arranca el puente antes de main.py.
try:
    import simbridge
    print('simbridge: entradas simuladas en', simbridge.start())
except Exception as e:
    print('simbridge:', e)
`;
