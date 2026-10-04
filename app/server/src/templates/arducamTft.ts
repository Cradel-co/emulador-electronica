/** Programa de demostración: cada Enter solicita una foto y la muestra en la ST7735. */
export const arducamTftMain = String.raw`from machine import I2C, SPI, Pin
from arducam import ArduCAM
from jpeg import decodificar_rgb565
from st7735 import ST7735
import hashlib
import binascii

i2c = I2C(0, sda=Pin(8), scl=Pin(9), freq=100000)
spi = SPI(1, baudrate=1000000, polarity=0, phase=0, sck=Pin(12), mosi=Pin(11), miso=Pin(13))
camara = ArduCAM(i2c, spi, Pin(10, Pin.OUT, value=1))
pantalla = ST7735(spi, Pin(14, Pin.OUT, value=1), Pin(15, Pin.OUT, value=1), Pin(16, Pin.OUT, value=1))
camara.inicializar()
pantalla.iniciar()
pantalla.limpiar()
print('ArduCAM + ST7735 listas: JPEG 320 x 240 -> RGB565 128 x 96')

def capturar_y_mostrar():
    foto = camara.capturar()
    huella = binascii.hexlify(hashlib.sha256(foto).digest()).decode()
    print('ArduCAM JPEG bytes=' + str(len(foto)) + ' sha256=' + huella)
    print('Decodificando JPEG para la ST7735...')
    pixeles = decodificar_rgb565(foto, 128, 96)
    pantalla.limpiar()
    pantalla.dibujar_rgb565(pixeles, 0, 32, 128, 96)
    print('ST7735 actualizada con la captura ' + huella)

capturar_y_mostrar()
while True:
    input('Enter para solicitar otra foto; Ctrl+C para terminar: ')
    try:
        capturar_y_mostrar()
    except Exception as error:
        print('Error cámara/pantalla:', error)
`;
