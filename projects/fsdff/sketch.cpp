// Plantilla Arduino para el Arduino Uno R3.
// D2 (botón a GND, con INPUT_PULLUP) -> D13 (LED, con su resistencia).
#include <Arduino.h>

const int PIN_BOTON = 2;
const int PIN_LED = 13;

void setup() {
  Serial.begin(9600);
  pinMode(PIN_BOTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  Serial.println("Hola desde el Arduino Uno R3");
}

void loop() {
  const int presionado = digitalRead(PIN_BOTON) == LOW;
  digitalWrite(PIN_LED, presionado ? HIGH : LOW);
  static int ultimo = -1;
  if (presionado != ultimo) {
    Serial.print("Boton ");
    Serial.print(presionado ? "PRESIONADO" : "suelto");
    Serial.print(" -> LED ");
    Serial.println(presionado);
    ultimo = presionado;
  }
  delay(20);
}
