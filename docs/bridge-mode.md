# Modo bridge: que Home Assistant descubra al ESP32 simulado solo

Avanzado / opcional. Sirve para que el ESP32 corriendo en Wokwi tenga una **IP real en tu LAN**, indistinguible de hardware físico — HA lo va a mostrar como "nuevo dispositivo ESPHome" por mDNS, igual que con el módulo real.

## Opción simple primero (sin instalar nada más)

Si solo necesitás que el firmware simulado le hable a tu HA en la misma PC (sin necesitar auto-discovery), Wokwi ya resuelve `host.wokwi.internal` al `localhost` de tu máquina. Sirve para pruebas rápidas, pero en HA hay que agregar el dispositivo a mano (no aparece solo).

## Bridge real: `wokwigw`

Repo: [github.com/wokwi/wokwigw](https://github.com/wokwi/wokwigw) — "Wokwi IoT Network Gateway".

- Linux: requiere `root` (crea una interfaz TUN/TAP puenteada a tu red real).
- Windows: requiere el driver TAP-Windows y puentear la interfaz manualmente (una interfaz WiFi puede no servir para esto — usar cable si hace falta).
- Dentro de VS Code / el diagrama: `F1` → **"Enable Private Wokwi IoT Gateway"** una vez que `wokwigw` está corriendo.

Seguir la instalación exacta desde el README del repo (cambia según versión). Cuando esté andando, el flujo queda:

```
ESP32 (Wokwi) ──IP real en tu LAN── mismo WiFi/router que tu PC con HA
                                     └─► HA lo descubre por mDNS, como si fuera hardware real
```

## Cuándo usarlo

- Para probar la **integración completa** ESP32 ↔ HA (auto-discovery, entidades, automatizaciones) sin hardware.
- No hace falta para simplemente validar la lógica del firmware (arm/disarm, timings de RF) — para eso alcanza con los logs de la simulación.
