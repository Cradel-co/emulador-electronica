// AT24C32 por Wire a mano: graba una página de 8 bytes y espera el fin del ciclo de grabado
// preguntando la dirección hasta que contesta (acknowledge polling). Imprime cuánto tardó y lo leído.
#include <Wire.h>

const uint8_t EE = 0x57;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);
  Wire.beginTransmission(EE);
  Wire.write(0x01); Wire.write(0x00);
  for (uint8_t i = 0; i < 8; i++) Wire.write(0xA0 + i);
  uint8_t r = Wire.endTransmission();
  unsigned long t0 = micros();
  uint16_t intentos = 0;
  do {
    intentos++;
    Wire.beginTransmission(EE);
  } while (Wire.endTransmission() != 0 && intentos < 2000);
  unsigned long dt = micros() - t0;
  Serial.print("escritura=");
  Serial.print(r);
  Serial.print(" polling_us=");
  Serial.print(dt);
  Serial.print(" intentos=");
  Serial.println(intentos);
  Wire.beginTransmission(EE);
  Wire.write(0x01); Wire.write(0x00);
  Wire.endTransmission(false);
  Wire.requestFrom(EE, (uint8_t)9);
  Serial.print("leido:");
  while (Wire.available()) { Serial.print(' '); Serial.print(Wire.read(), HEX); }
  Serial.println();
}

void loop() {}
