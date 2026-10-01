# Circuito continuo: el LED lo prende el pulsador, no el código.
#
# La corriente va de la Fuente regulable (5 V) por el pulsador, el LED y la
# resistencia hasta GND. Apretar el pulsador cierra ese camino: pasan ~18 mA y el
# LED prende. Ningún pin del ESP32 participa; el código solo está para que la placa
# arranque (y la fuente también la alimenta a ella, por su pin 5V).
import time

print("Circuito continuo listo: apretá el pulsador y mirá el LED.")
print("El consumo de la fuente se ve en la ventana Debug > Alimentación.")

while True:
    time.sleep(1)
