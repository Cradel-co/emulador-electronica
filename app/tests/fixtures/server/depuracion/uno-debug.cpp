#include <Arduino.h>

struct Config {
  int umbral;
  bool activo;
  float factor;
};

volatile unsigned long contador = 0;
int lecturas[5] = {10, 20, 30, 40, 50};
Config config = {42, true, 1.5f};
char nombre[12] = "uno-debug";
const int PIN_BOTON = 2;
const int PIN_LED = 13;

void incrementar() {
  contador++;
  lecturas[contador % 5] = (int)(contador * 3);
}

void setup() {
  Serial.begin(9600);
  pinMode(PIN_BOTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  Serial.println(nombre);
}

void loop() {
  incrementar();
  bool presionado = digitalRead(PIN_BOTON) == LOW;
  digitalWrite(PIN_LED, presionado ? HIGH : LOW);
  if (config.activo && contador % 50 == 0) {
    Serial.print("contador=");
    Serial.println(contador * config.factor);
  }
  delay(20);
}
