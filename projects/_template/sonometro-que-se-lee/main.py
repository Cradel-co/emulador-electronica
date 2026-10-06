# Sonómetro SEN0232 leído por el ADC1 del ESP32-S3.
#
# El sensor entrega 0,6 V con 30 dBA y 2,6 V con 130 dBA, lineal: 20 mV por decibel.
# El ADC convierte esa tensión en cuentas de 0 a 4095 según el perfil declarado en el
# project.json (atenuación de 11 dB, de 0 a 3,1 V de fondo de escala). Este programa
# deshace las dos conversiones para volver a los decibeles.
from machine import ADC, Pin
import time

GPIO_SONOMETRO = 4

# Del perfil de ADC del proyecto: qué tensión lee como 0 y qué tensión como fondo de escala.
CERO_V = 0.0
FONDO_V = 3.1
CUENTAS = 4096

# De la hoja de datos del sensor.
DBA_MIN = 30
V_MIN = 0.6
V_POR_DB = 0.02

canal = ADC(Pin(GPIO_SONOMETRO), atten=ADC.ATTN_11DB)


def voltios(cuentas):
    return CERO_V + cuentas / CUENTAS * (FONDO_V - CERO_V)


def decibeles(cuentas):
    return DBA_MIN + (voltios(cuentas) - V_MIN) / V_POR_DB


while True:
    try:
        crudo = canal.read()
    except OSError as error:
        # El emulador no inventa lecturas: fuera del dominio declarado avisa en vez de mentir.
        print('el ADC no pudo leer:', error)
    else:
        print('%4d cuentas   %.2f V   %.1f dBA' % (crudo, voltios(crudo), decibeles(crudo)))
    time.sleep(1)
