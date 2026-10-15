// Tablas adaptadas de ArduCAM/Arduino 066a7ea1ccae4813e9a9b9d04e55f96bb8b4039e.
// Copyright (C) 2011-2015 ArduCAM.com; LGPL-2.1-or-later. Driver independiente; requiere prueba física.
export const arducamDriver = String.raw`# Copyright (C) 2011-2015 ArduCAM.com.
# SPDX-License-Identifier: LGPL-2.1-or-later
# Tablas: https://github.com/ArduCAM/Arduino/tree/066a7ea1ccae4813e9a9b9d04e55f96bb8b4039e
# Licencia y garantía: ver ARDUCAM-LICENSE.txt del proyecto.
from machine import Pin, I2C, SPI
import time

_TABLAS = (
    ((255,0),(44,255),(46,223),(255,1),(60,50),(17,0),(9,2),(4,40),(19,229),(20,72),(44,12),(51,120),(58,51),(59,251),(62,0),(67,17),(22,16),(57,146),(53,218),(34,26),(55,195),(35,0),(52,192),(54,26),(6,136),(7,192),(13,135),(14,65),(76,0),(72,0),(91,0),(66,3),(74,129),(33,153),(36,64),(37,56),(38,130),(92,0),(99,0),(97,112),(98,128),(124,5),(32,128),(40,48),(108,0),(109,128),(110,0),(112,2),(113,148),(115,193),(18,64),(23,17),(24,67),(25,0),(26,75),(50,9),(55,192),(79,96),(80,168),(109,0),(61,56),(70,63),(79,96),(12,60),(255,0),(229,127),(249,192),(65,36),(224,20),(118,255),(51,160),(66,32),(67,24),(76,0),(135,213),(136,63),(215,3),(217,16),(211,130),(200,8),(201,128),(124,0),(125,0),(124,3),(125,72),(125,72),(124,8),(125,32),(125,16),(125,14),(144,0),(145,14),(145,26),(145,49),(145,90),(145,105),(145,117),(145,126),(145,136),(145,143),(145,150),(145,163),(145,175),(145,196),(145,215),(145,232),(145,32),(146,0),(147,6),(147,227),(147,5),(147,5),(147,0),(147,4),(147,0),(147,0),(147,0),(147,0),(147,0),(147,0),(147,0),(150,0),(151,8),(151,25),(151,2),(151,12),(151,36),(151,48),(151,40),(151,38),(151,2),(151,152),(151,128),(151,0),(151,0),(195,237),(164,0),(168,0),(197,17),(198,81),(191,128),(199,16),(182,102),(184,165),(183,100),(185,124),(179,175),(180,151),(181,255),(176,197),(177,148),(178,15),(196,92),(192,100),(193,75),(140,0),(134,61),(80,0),(81,200),(82,150),(83,0),(84,0),(85,0),(90,200),(91,150),(92,0),(211,0),(195,237),(127,0),(218,0),(229,31),(225,103),(224,0),(221,127),(5,0),(18,64),(211,4),(192,22),(193,18),(140,0),(134,61),(80,0),(81,44),(82,36),(83,0),(84,0),(85,0),(90,44),(91,36),(92,0)),
    ((255,0),(5,0),(218,16),(215,3),(223,0),(51,128),(60,64),(225,119),(0,0)),
    ((224,20),(225,119),(229,31),(215,3),(218,16),(224,0),(255,1),(4,8)),
    ((255,1),(18,64),(23,17),(24,67),(25,0),(26,75),(50,9),(79,202),(80,168),(90,35),(109,0),(57,18),(53,218),(34,26),(55,195),(35,0),(52,192),(54,26),(6,136),(7,192),(13,135),(14,65),(76,0),(255,0),(224,4),(192,100),(193,75),(134,53),(80,137),(81,200),(82,150),(83,0),(84,0),(85,0),(87,0),(90,80),(91,60),(92,0),(224,0)),
)

class ArduCAM:
    def __init__(self, i2c, spi, cs):
        self.i2c = i2c
        self.spi = spi
        self.cs = cs
        self.cs.value(1)

    def _sensor(self, reg, value):
        self.i2c.writeto_mem(0x30, reg, bytes((value,)))

    def _reg(self, reg, value=None):
        self.cs.value(0)
        try:
            self.spi.write(bytes((reg if value is None else reg | 0x80,)))
            if value is None:
                return self.spi.read(1)[0]
            self.spi.write(bytes((value,)))
        finally:
            self.cs.value(1)

    def inicializar(self):
        self._reg(0x00, 0x55)
        if self._reg(0x00) != 0x55:
            raise OSError('ArduCAM: SPI no responde; revisar CS/SCLK/MOSI/MISO y alimentación')
        self._sensor(0xff, 1)
        if self.i2c.readfrom_mem(0x30, 0x0a, 2) != b'\x26\x42':
            raise OSError('ArduCAM: sensor OV2640 ausente')
        self._sensor(0x12, 0x80)
        time.sleep_ms(100)
        for indice in range(len(_TABLAS)):
            for reg, value in _TABLAS[indice]:
                self._sensor(reg, value)
            if indice == 2:
                self._sensor(0xff, 1)
                self._sensor(0x15, 0)

    def capturar(self):
        self._reg(0x04, 0x01)
        self._reg(0x04, 0x02)
        inicio = time.ticks_ms()
        while not self._reg(0x41) & 0x08:
            if time.ticks_diff(time.ticks_ms(), inicio) > 15000:
                self._reg(0x04, 0x01)
                raise OSError('ArduCAM: captura vencida; revisar webcam, sesión y configuración')
            time.sleep_ms(20)
        n = self._reg(0x42) | self._reg(0x43) << 8 | (self._reg(0x44) & 0x7f) << 16
        if n < 4 or n > 1048576:
            raise ValueError('ArduCAM: longitud de FIFO inválida')
        self._reg(0x04, 0x10)
        foto = bytearray(n)
        self.cs.value(0)
        try:
            self.spi.write(b'\x3c')
            for offset in range(0, n, 512):
                self.spi.readinto(memoryview(foto)[offset:min(offset + 512, n)])
        finally:
            self.cs.value(1)
        if foto[:2] != b'\xff\xd8' or foto[-2:] != b'\xff\xd9':
            raise ValueError('ArduCAM: JPEG incompleto')
        return foto
`;
export const arducamMain = `from machine import I2C, SPI, Pin
from arducam import ArduCAM
import hashlib
import binascii
import time

i2c = I2C(0, sda=Pin(8), scl=Pin(9), freq=100000)
spi = SPI(1, baudrate=1000000, polarity=0, phase=0, sck=Pin(12), mosi=Pin(11), miso=Pin(13))
camara = ArduCAM(i2c, spi, Pin(10, Pin.OUT, value=1))
camara.inicializar()
print('ArduCAM lista: JPEG 320 x 240')
while True:
    try:
        foto = camara.capturar()
        print('ArduCAM JPEG bytes=' + str(len(foto)) + ' sha256=' + binascii.hexlify(hashlib.sha256(foto).digest()).decode())
    except Exception as error:
        print('ArduCAM error:', error)
    time.sleep_ms(5000)
`;
