// Como bme280-forzado, pero configurando bien según la hoja (3.3.1): begin() deja el sensor en
// modo normal con x16 (98 ms por medición). Pasar a dormido se demora hasta que termina la
// medición en curso, y mientras tanto ctrl_hum se ignora. Por eso se pide dormir, se espera
// más que una medición, y recién ahí se configura el modo forzado.
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
  bme.setSampling(Adafruit_BME280::MODE_SLEEP);
  delay(110);
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
  Serial.println(bme.readTemperature(), 2);
  delay(100);
}
