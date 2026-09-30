# Template de proyecto Wokwi

Punto de partida genérico: un ESP32 DevKit solo, sin nada cableado.

## Uso

1. Copiar esta carpeta con otro nombre (no editar el template directamente):
   ```bash
   cp -r ../_template ../mi-proyecto-nuevo
   ```
2. Compilar tu firmware (PlatformIO / ESP-IDF / ESPHome) y ajustar las rutas en `wokwi.toml`.
3. Editar `diagram.json`:
   - Agregar partes con el editor visual (VS Code: abrir el archivo, usar el panel de partes) o a mano.
   - Cablear (`connections`).
   - Si usás un chip custom de `../../chips/`, symlinkearlo acá (ver README general).
4. Simular:
   - VS Code: abrir `diagram.json` → ▶
   - Terminal: `wokwi-cli .` (requiere `WOKWI_CLI_TOKEN`, ver README general)
