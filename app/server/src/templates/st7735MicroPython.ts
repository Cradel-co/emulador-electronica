/** Driver MicroPython mínimo para dibujar una imagen RGB565 en la ST7735 del circuito. */
export const st7735MicroPython = String.raw`from machine import Pin
import time

class ST7735:
    ANCHO = 128
    ALTO = 160

    def __init__(self, spi, cs, dc, reset):
        self.spi = spi
        self.cs = cs
        self.dc = dc
        self.reset = reset
        self.cs.value(1)
        self.dc.value(1)

    def _cmd(self, comando, datos=b''):
        self.cs.value(0)
        try:
            self.dc.value(0)
            self.spi.write(bytes((comando,)))
            if datos:
                self.dc.value(1)
                self.spi.write(datos)
        finally:
            self.cs.value(1)

    def iniciar(self):
        self.cs.value(1)
        self.reset.value(0)
        time.sleep_ms(10)
        self.reset.value(1)
        time.sleep_ms(120)
        self._cmd(0x01)
        time.sleep_ms(150)
        self._cmd(0x11)
        time.sleep_ms(120)
        self._cmd(0x3a, b'\x05')
        self._cmd(0x36, b'\xc0')
        self._cmd(0x29)
        time.sleep_ms(20)

    def _ventana(self, x, y, ancho, alto):
        if x < 0 or y < 0 or ancho < 1 or alto < 1 or x + ancho > self.ANCHO or y + alto > self.ALTO:
            raise ValueError('ST7735: ventana fuera de la pantalla')
        x1 = x + ancho - 1
        y1 = y + alto - 1
        self._cmd(0x2a, bytes((0, x, 0, x1)))
        self._cmd(0x2b, bytes((0, y, 0, y1)))
        self._cmd(0x2c)

    def _pixels(self, datos):
        self.cs.value(0)
        try:
            self.dc.value(1)
            vista = memoryview(datos)
            for inicio in range(0, len(vista), 512):
                self.spi.write(vista[inicio:min(inicio + 512, len(vista))])
        finally:
            self.cs.value(1)

    def limpiar(self, color=0):
        color &= 0xffff
        fila = bytes((color >> 8, color & 255)) * self.ANCHO
        self._ventana(0, 0, self.ANCHO, self.ALTO)
        self.cs.value(0)
        try:
            self.dc.value(1)
            for _ in range(self.ALTO):
                self.spi.write(fila)
        finally:
            self.cs.value(1)

    def dibujar_rgb565(self, datos, x, y, ancho, alto):
        if len(datos) != ancho * alto * 2:
            raise ValueError('ST7735: longitud RGB565 inválida')
        self._ventana(x, y, ancho, alto)
        self._pixels(datos)
`;
