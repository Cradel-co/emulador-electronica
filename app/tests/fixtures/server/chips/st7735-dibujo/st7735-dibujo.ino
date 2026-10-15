// TFT 1,8" ST7735 con Adafruit ST7735 and ST7789 Library 1.11.0 + Adafruit GFX 1.12.6 por SPI por
// hardware (CS D10, A0/DC D9, RESET D8): pinta el fondo, las cuatro esquinas y un rectángulo,
// después invierte, gira la pantalla y la apaga, avisando cada paso por el Serial.
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <SPI.h>

Adafruit_ST7735 tft(10, 9, 8);

void setup() {
  Serial.begin(115200);
  tft.initR(INITR_BLACKTAB);
  Serial.print("INIT ms=");
  Serial.println(millis());
  tft.fillScreen(ST77XX_BLUE);
  tft.drawPixel(0, 0, ST77XX_RED);
  tft.drawPixel(127, 0, ST77XX_GREEN);
  tft.drawPixel(0, 159, ST77XX_WHITE);
  tft.drawPixel(127, 159, ST77XX_YELLOW);
  tft.fillRect(10, 20, 30, 40, ST77XX_RED);
  Serial.print("DIBUJADO ms=");
  Serial.println(millis());
  delay(200);
  tft.invertDisplay(true);
  Serial.println("INVERTIDO");
  delay(200);
  tft.invertDisplay(false);
  tft.setRotation(1);
  tft.fillRect(0, 0, 20, 10, ST77XX_GREEN);
  Serial.println("ROTADO");
  delay(200);
  tft.enableDisplay(false);
  Serial.println("APAGADO");
}

void loop() {}
