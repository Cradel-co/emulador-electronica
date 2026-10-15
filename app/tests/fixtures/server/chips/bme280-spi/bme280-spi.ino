// BME280 por SPI por hardware (SCK D13, MOSI D11, MISO D12, CS D10) con Adafruit_BME280 2.3.0.
// En SPI el I2C del sensor se apaga: el escáner I2C al final no lo tiene que encontrar.
#include <SPI.h>
#include <Wire.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme(10);

void setup() {
  Serial.begin(115200);
  if (!bme.begin()) {
    Serial.print("BME280 no encontrado por SPI, id=0x");
    Serial.println(bme.sensorID(), HEX);
    while (1) delay(10);
  }
  Serial.println("BME280 SPI OK");
  Wire.begin();
  Wire.beginTransmission(0x77);
  Serial.print("i2c 0x77 contesta=");
  Serial.println(Wire.endTransmission() == 0);
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
