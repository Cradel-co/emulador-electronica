# Crear un chip custom (Wokwi Custom Chips API)

Para simular un módulo que no existe en la librería de Wokwi (ej. RXB6, STX882).

## 1. Scaffold

Desde VS Code, con la extensión Wokwi instalada: paleta de comandos (`Ctrl+Shift+P`) → **"Wokwi: New Chip"** → nombre del chip (ej. `rxb6`) → lenguaje **C**.

Esto genera una carpeta con:
- `<nombre>.chip.c` — lógica (incluye `wokwi-api.h`)
- `<nombre>.chip.json` — pines + controles visuales del chip
- `Makefile` — compila el `.c` a `.wasm`
- `diagram.json` de ejemplo para probarlo solo

Si preferís hacerlo a mano (sin VS Code), los templates están en [wokwi/chip-ts-template](https://github.com/wokwi) y en la guía oficial: [Getting Started with the Custom Chips C API](https://docs.wokwi.com/chips-api/getting-started).

## 2. Editar

- **`.chip.json`**: pines (nombres deben coincidir con lo que espera el `.c`) y `controls` (botones/sliders que aparecen sobre el chip en el diagrama).
- **`.chip.c`**: `chip_init()` engancha los pines y callbacks (`pin_watch`, timers con `chip_timer_add`, etc.). Ver [Custom Chip JSON Format](https://docs.wokwi.com/chips-api/chip-json) y el ejemplo completo: [Tutorial: 7-segment display](https://docs.wokwi.com/chips-api/tutorial-7seg).

## 3. Compilar a WASM

Sin instalar el toolchain de compilación en la máquina (usa Docker, que ya está instalado):

```bash
cd chips/<nombre>
docker run --rm -u 1000:1000 -v "$PWD":/src wokwi/builder-clang-wasm:latest make
```

Genera el `.wasm` en `dist/` (o al lado del `.c`, según el Makefile generado).

## 4. Usar el chip en un proyecto

En el `diagram.json` del proyecto, agregar una `part` con `"type": "chip-<nombre>"` y cablearla. Wokwi busca los archivos del chip **en la misma carpeta que el `diagram.json`**, así que symlinkeá los archivos fuente (no los copies, para no desincronizar):

```bash
cd projects/mi-proyecto
ln -s ../../chips/rxb6/rxb6.chip.json .
ln -s ../../chips/rxb6/rxb6.chip.c .
ln -s ../../chips/rxb6/dist/rxb6.chip.wasm rxb6.chip.wasm   # o donde haya quedado el .wasm
```

## Referencias

- [Getting Started with the Custom Chips C API](https://docs.wokwi.com/chips-api/getting-started)
- [Custom Chip JSON Format](https://docs.wokwi.com/chips-api/chip-json)
- [Compiling custom chips to WASM](https://docs.wokwi.com/guides/custom-chips-to-wasm)
- [Tutorial: 7-segment display](https://docs.wokwi.com/chips-api/tutorial-7seg)
- Ejemplo real de un chip publicado (buena referencia de estructura): [wokwi/inverter-chip](https://github.com/wokwi/inverter-chip)
