// DS3231 con RTClib (Adafruit) 2.1.4: si perdió la hora (OSF), la pone en 01/10/2026 12:00:00.
// Imprime la hora y la temperatura una vez por segundo (cuando cambia el segundo).
#include <RTClib.h>

RTC_DS3231 rtc;
uint8_t ultimo = 255;

void setup() {
  Serial.begin(115200);
  if (!rtc.begin()) {
    Serial.println("RTC no encontrado");
    while (1) delay(10);
  }
  if (rtc.lostPower()) {
    Serial.println("perdio la hora: ajustando");
    rtc.adjust(DateTime(2026, 10, 1, 12, 0, 0));
  }
  Serial.print("lostPower=");
  Serial.println(rtc.lostPower());
}

void loop() {
  DateTime t = rtc.now();
  if (t.second() != ultimo) {
    ultimo = t.second();
    char buf[24];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d", t.year(), t.month(), t.day(), t.hour(), t.minute(), t.second());
    Serial.print(buf);
    Serial.print(" ms=");
    Serial.print(millis());
    Serial.print(" T=");
    Serial.println(rtc.getTemperature(), 2);
  }
  delay(20);
}
