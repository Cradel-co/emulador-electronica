// BME280 con la librería de Adafruit en modo normal (lo que hace begin() por defecto:
// x16 en los tres canales, sin filtro, standby 0,5 ms). Imprime una línea por lectura.
#include <Wire.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  if (!bme.begin(0x77)) {
    Serial.print("BME280 no encontrado, id=0x");
    Serial.println(bme.sensorID(), HEX);
    while (1) delay(10);
  }
  Serial.println("BME280 OK");
}

void loop() {
  Serial.print("T=");
  Serial.print(bme.readTemperature(), 2);
  Serial.print(" P=");
  Serial.print(bme.readPressure() / 100.0F, 2);
  Serial.print(" H=");
  Serial.println(bme.readHumidity(), 2);
  delay(200);
}
