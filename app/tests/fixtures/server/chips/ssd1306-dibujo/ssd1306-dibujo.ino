// SSD1306 128x64 con Adafruit_SSD1306 2.5.17 + Adafruit GFX 1.12.6: dibuja, y manda por el Serial
// su propio búfer (getBuffer) para compararlo píxel por píxel con lo que muestra el emulador.
// Después invierte, baja el brillo y apaga la pantalla, avisando cada paso.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 oled(128, 64, &Wire, -1);

void volcar() {
  uint8_t *b = oled.getBuffer();
  for (uint8_t pag = 0; pag < 8; pag++) {
    Serial.print("P");
    Serial.print(pag);
    Serial.print("=");
    for (uint8_t x = 0; x < 128; x++) {
      uint8_t v = b[pag * 128 + x];
      if (v < 16) Serial.print('0');
      Serial.print(v, HEX);
    }
    Serial.println();
  }
}

void setup() {
  Serial.begin(115200);
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 no encontrado");
    while (1) delay(10);
  }
  oled.clearDisplay();
  oled.drawPixel(0, 0, SSD1306_WHITE);
  oled.drawPixel(127, 63, SSD1306_WHITE);
  oled.drawRect(10, 10, 30, 12, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 40);
  oled.print("Hola SSD1306");
  oled.display();
  Serial.println("DIBUJADO");
  volcar();
  delay(200);
  oled.invertDisplay(true);
  Serial.println("INVERTIDO");
  delay(200);
  oled.invertDisplay(false);
  oled.dim(true);
  Serial.println("TENUE");
  delay(200);
  oled.ssd1306_command(SSD1306_DISPLAYOFF);
  Serial.println("APAGADO");
}

void loop() {}
