// El escáner I2C clásico: prueba cada dirección de 1 a 126 y lista las que contestan (ACK).
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
}

void loop() {
  Serial.print("encontrados:");
  for (byte dir = 1; dir < 127; dir++) {
    Wire.beginTransmission(dir);
    if (Wire.endTransmission() == 0) {
      Serial.print(" 0x");
      if (dir < 16) Serial.print("0");
      Serial.print(dir, HEX);
    }
  }
  Serial.println();
  delay(500);
}
