// Alarma 1 del DS3231 con RTClib: INT/SQW (colector abierto, con pull-up en la placa) a D2 con
// interrupción por flanco de bajada. Programa la alarma 3 s después y avisa cuando INT baja.
#include <RTClib.h>

RTC_DS3231 rtc;
volatile bool disparo = false;
volatile unsigned long cuando = 0;

void alBajar() {
  disparo = true;
  cuando = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT); // sin pull-up interno: alcanza el de la placa
  if (!rtc.begin()) {
    Serial.println("RTC no encontrado");
    while (1) delay(10);
  }
  rtc.disable32K();
  rtc.clearAlarm(1);
  rtc.clearAlarm(2);
  rtc.writeSqwPinMode(DS3231_OFF); // INT/SQW como interrupción (INTCN = 1)
  DateTime ahora = rtc.now();
  bool ok = rtc.setAlarm1(ahora + TimeSpan(3), DS3231_A1_Second);
  Serial.print("alarma programada ok=");
  Serial.print(ok);
  Serial.print(" a las ");
  Serial.print(ahora.second());
  Serial.print("+3 ms=");
  Serial.println(millis());
  attachInterrupt(digitalPinToInterrupt(2), alBajar, FALLING);
}

void loop() {
  if (disparo) {
    disparo = false;
    Serial.print("ALARMA ms=");
    Serial.print(cuando);
    Serial.print(" fired=");
    Serial.print(rtc.alarmFired(1));
    Serial.print(" D2=");
    Serial.print(digitalRead(2));
    rtc.clearAlarm(1);
    delay(1);
    Serial.print(" despues D2=");
    Serial.println(digitalRead(2));
  }
}
