#include <Arduino.h>
void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
  Serial.println("Hola desde el Uno");
}
void loop() {
  int p = digitalRead(2) == LOW;
  digitalWrite(13, p);
  static int u = -1;
  if (p != u) { Serial.print("Boton "); Serial.println(p ? "PRESIONADO" : "suelto"); u = p; }
  delay(20);
}
