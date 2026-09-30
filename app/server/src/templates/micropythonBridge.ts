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

    def value(self, *args):
        if args:
            return self._p.value(*args)
        if self._n in _input_levels:
            return _input_levels[self._n]
        return self._p.value()

    def __call__(self, *args):
        return self.value(*args)

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


def _instalar_pin():
    """Hace que main.py use este Pin: \`from machine import Pin\` y \`machine.Pin(...)\`."""
    try:
        machine.Pin = Pin
        return 'machine.Pin'
    except Exception:
        pass
    import sys

    class _Machine:
        def __getattr__(self, nombre):
            return getattr(machine, nombre)

    m = _Machine()
    m.Pin = Pin
    sys.modules['machine'] = m
    return 'sys.modules'


def _read_out(n):
    if n < 32 or _GPIO_OUT1_REG is None:
        return (machine.mem32[_GPIO_OUT_REG] >> n) & 1
    return (machine.mem32[_GPIO_OUT1_REG] >> (n - 32)) & 1


def _send(line):
    try:
        _uart.write(line + '\\n')
    except Exception:
        pass


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
    elif tag == 'DUMP':
        _responder(parts[1] if len(parts) > 1 else '0', _dump())
    elif tag == 'EVAL':
        _responder(parts[1] if len(parts) > 1 else '0', _evaluar(parts[2] if len(parts) > 2 else ''))
    # RF y mensajes desconocidos: no implementado todavía para MicroPython (queda para más adelante).


def _loop():
    buf = ''
    _send('@READY 1 micropython')
    while True:
        try:
            n = _uart.any()
            if n:
                buf += _uart.read(n).decode('utf-8', 'ignore')
                while '\\n' in buf:
                    line, buf = buf.split('\\n', 1)
                    _handle(line)
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
