/** Firmware generado: ADC del SEN0232 y evolución del nivel en una ST7735 por SPI. */
export const sonometroTftMain = String.raw`# Generado desde app/server/src/templates/sonometroTft.ts.
# El nivel del sensor emulado NO es una medición acústica calibrada del computador.
from machine import ADC, SPI, Pin
from st7735 import ST7735
import framebuf
import time

GPIO_SONOMETRO = 4
CERO_V = 0.0
FONDO_V = 3.1
CUENTAS = 4096
DBA_MIN = 30
V_MIN = 0.6
V_POR_DB = 0.02
PERIODO_MS = 250
VENTANA_MS = 10000
CAPACIDAD = 40


def voltios(cuentas):
    return CERO_V + cuentas / CUENTAS * (FONDO_V - CERO_V)


def decibeles(cuentas):
    return DBA_MIN + (voltios(cuentas) - V_MIN) / V_POR_DB


class HistorialNivel:
    def __init__(self):
        self.muestras = [None] * CAPACIDAD
        self.siguiente = 0
        self.cantidad = 0

    def agregar(self, instante, nivel):
        self.muestras[self.siguiente] = (instante, nivel)
        self.siguiente = (self.siguiente + 1) % CAPACIDAD
        self.cantidad = min(CAPACIDAD, self.cantidad + 1)

    def visibles(self, ahora):
        resultado = []
        for i in range(self.cantidad):
            instante, nivel = self.muestras[(self.siguiente - self.cantidad + i) % CAPACIDAD]
            edad = time.ticks_diff(ahora, instante)
            if 0 <= edad < VENTANA_MS:
                resultado.append((edad, nivel))
        return resultado


def color(rgb565):
    # framebuf guarda RGB565 en little endian; SPI/ST7735 recibe el byte alto primero.
    return ((rgb565 & 255) << 8) | (rgb565 >> 8)


class GraficaNivel:
    def __init__(self, pantalla):
        self.pantalla = pantalla
        self.datos = bytearray(128 * 160 * 2)
        self.f = framebuf.FrameBuffer(self.datos, 128, 160, framebuf.RGB565)
        self.anterior = None
        self.bloque = bytearray(1024)

    def enviar_cambios(self):
        if self.anterior is None:
            self.pantalla.dibujar_rgb565(self.datos, 0, 0, 128, 160)
            self.anterior = bytearray(self.datos)
            return
        # Dos zonas: encabezado y gráfico. Agrupar reduce los cambios de CS/DC y evita
        # saturar el puente de GPIO con una transferencia por cada banda pequeña.
        for y0, y1 in ((0, 40), (40, 160)):
            xmin, xmax, ymin, ymax = 128, -1, 160, -1
            for y in range(y0, y1):
                inicio = y * 256
                if self.datos[inicio:inicio + 256] == self.anterior[inicio:inicio + 256]:
                    continue
                for x in range(128):
                    i = inicio + x * 2
                    if self.datos[i] != self.anterior[i] or self.datos[i + 1] != self.anterior[i + 1]:
                        xmin, xmax = min(xmin, x), max(xmax, x)
                        ymin, ymax = min(ymin, y), max(ymax, y)
            if xmax < xmin:
                continue
            ancho, alto = xmax - xmin + 1, ymax - ymin + 1
            longitud_fila = ancho * 2
            if len(self.bloque) < ancho * alto * 2:
                self.bloque = bytearray(ancho * alto * 2)
            for fila in range(alto):
                inicio = ((ymin + fila) * 128 + xmin) * 2
                destino = fila * longitud_fila
                self.bloque[destino:destino + longitud_fila] = self.datos[inicio:inicio + longitud_fila]
            self.pantalla.dibujar_rgb565(memoryview(self.bloque)[:ancho * alto * 2], xmin, ymin, ancho, alto)
        self.anterior[:] = self.datos

    def pintar(self, historial, ahora, nivel):
        f = self.f
        blanco, gris, verde = color(0xffff), color(0x4208), color(0x07e0)
        f.fill(0)
        f.text('SONOMETRO', 0, 0, blanco)
        f.text('dB simulados', 0, 12, blanco)
        f.text('---' if nivel is None else '%.1f' % nivel, 0, 26, verde)
        # La tensión leída puede exceder ligeramente 130 por cuantización. El dibujo se acota.
        for valor, y in ((130, 46), (80, 88), (30, 130)):
            f.text(str(valor), 0, y - 3, blanco)
            f.hline(28, y, 99, gris)
        f.vline(28, 46, 85, gris)
        f.text('-10s', 28, 144, blanco)
        f.text('0s', 110, 144, blanco)
        anterior = None
        for edad, lectura in historial.visibles(ahora):
            if lectura is None:
                anterior = None
                continue
            x = 126 - int(edad * 98 / VENTANA_MS)
            y = 130 - int((max(30, min(130, lectura)) - 30) * 84 / 100)
            if anterior is not None:
                f.line(anterior[0], anterior[1], x, y, verde)
            f.pixel(x, y, verde)
            anterior = (x, y)
        self.enviar_cambios()


def iniciar():
    canal = ADC(Pin(GPIO_SONOMETRO), atten=ADC.ATTN_11DB)
    spi = SPI(1, baudrate=10000000, polarity=0, phase=0, sck=Pin(12), mosi=Pin(11))
    pantalla = ST7735(spi, Pin(10, Pin.OUT, value=1), Pin(9, Pin.OUT, value=0), Pin(8, Pin.OUT, value=1))
    pantalla.iniciar()
    historial = HistorialNivel()
    grafica = GraficaNivel(pantalla)
    siguiente = time.ticks_ms()
    ultimo_log = time.ticks_add(siguiente, -1000)
    while True:
        ahora = time.ticks_ms()
        espera = time.ticks_diff(siguiente, ahora)
        if espera > 0:
            time.sleep_ms(espera)
        instante = time.ticks_ms()
        try:
            crudo = canal.read()
        except OSError as error:
            # Un error agrega un hueco, no una lectura cero ni la lectura anterior.
            nivel = None
            if time.ticks_diff(instante, ultimo_log) >= 1000:
                print('el ADC no pudo leer:', error)
                ultimo_log = instante
        else:
            nivel = decibeles(crudo)
            if time.ticks_diff(instante, ultimo_log) >= 1000:
                print('%4d cuentas   %.2f V   %.1f dBA' % (crudo, voltios(crudo), nivel))
                ultimo_log = instante
        historial.agregar(instante, nivel)
        grafica.pintar(historial, instante, nivel)
        siguiente = time.ticks_add(instante, PERIODO_MS)
        # Si SPI tarda más que el período no se inventan puntos para recuperar el tiempo perdido.


iniciar()
`;
