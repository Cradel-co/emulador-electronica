// BME280 en modo forzado (el recomendado para bajo consumo): x1 en los tres canales, sin
// filtro. takeForcedMeasurement() dispara la medición y espera el bit "measuring" del status.
// Imprime cuánto tardó la medición (debería ser ~8 ms: t_measure típico de la hoja).
#include <Wire.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  Wire.setClock(400000);
  if (!bme.begin(0x76)) {
    Serial.println("BME280 no encontrado");
    while (1) delay(10);
  }
  bme.setSampling(Adafruit_BME280::MODE_FORCED,
                  Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::FILTER_OFF);
  Serial.println("BME280 OK forzado");
}

void loop() {
  unsigned long t0 = micros();
  bool ok = bme.takeForcedMeasurement();
  unsigned long dt = micros() - t0;
  Serial.print("ok=");
  Serial.print(ok);
  Serial.print(" us=");
  Serial.print(dt);
  Serial.print(" T=");
  Serial.print(bme.readTemperature(), 2);
  Serial.print(" P=");
  Serial.print(bme.readPressure() / 100.0F, 2);
  Serial.print(" H=");
  Serial.println(bme.readHumidity(), 2);
  delay(100);
}
