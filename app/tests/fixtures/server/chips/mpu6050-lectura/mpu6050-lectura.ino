// MPU-6050 con Adafruit_MPU6050 2.2.9: begin() (WHO_AM_I, reset, filtro 260 Hz, ±500 °/s, ±2 g,
// lo despierta) y una lectura cada 100 ms de aceleración (m/s²), giro (rad/s) y temperatura.
#include <Adafruit_MPU6050.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  if (!mpu.begin()) {
    Serial.println("MPU6050 no encontrado");
    while (1) delay(10);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  Serial.println("MPU6050 OK");
}

void loop() {
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  Serial.print("ax="); Serial.print(a.acceleration.x, 3);
  Serial.print(" ay="); Serial.print(a.acceleration.y, 3);
  Serial.print(" az="); Serial.print(a.acceleration.z, 3);
  Serial.print(" gx="); Serial.print(g.gyro.x, 4);
  Serial.print(" gy="); Serial.print(g.gyro.y, 4);
  Serial.print(" gz="); Serial.print(g.gyro.z, 4);
  Serial.print(" T="); Serial.println(t.temperature, 2);
  delay(100);
}
