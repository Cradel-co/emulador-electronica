# Motor propio en la ejecución habitual del proyecto

## Cómo usarlo

1. Abrí un proyecto con **una placa ESP32 y lenguaje MicroPython**. La plantilla botón → LED
   que ya trae la app es compatible; no hace falta crear un proyecto de banco.
2. En **Configuración → Simulación de este proyecto → Motor ESP32**, elegí
   **Propio · GPIO y temporización MicroPython**. La elección se guarda como `sim.motorEsp: "propio"`.
3. Conectá la alimentación USB de la placa o una fuente externa válida.
4. Usá **Ejecutar**. El backend valida y ejecuta el `main.py` del editor, y el circuito muestra
   las medidas y estados en el mismo lienzo. El pulsador del dibujo llega al programa a través
   del solver; las escrituras del programa vuelven al circuito por los eventos GPIO existentes.
5. **Parar** cancela la generación temporal y retira sus salidas. **Reset** reinicia el programa
   validado, con las entradas eléctricas actuales; no toma cambios de código sin ejecutar de nuevo.
6. Para aplicar código nuevo, guardá y usá **Parar → Ejecutar**. La recarga en caliente todavía no
   está implementada en este backend y devuelve esa explicación. Cambiar motor exige detenerse.

La ausencia de `motorEsp` conserva el motor del descriptor de la placa; no migra proyectos existentes
sin una selección explícita. Seleccionar el motor propio no inicia esp-emu ni lo usa como alternativa
si falla un programa. El motor anterior sigue disponible para los casos aún no implementados.

## Qué ejecuta

Es un intérprete funcional propio escrito en TypeScript. Lezer solo adapta la sintaxis Python a
expresiones e instrucciones del dominio; no se ejecuta Python, JavaScript del usuario, CPU, firmware
binario ni procesos externos. El programa del usuario decide las salidas: no se sustituye por un
parpadeo o una demostración prefijada.

Soporta, de forma deliberadamente acotada:

- `import time`, `import machine`, `import simbridge`, `from machine import Pin`,
  `from time import sleep` y `from time import sleep_ms`. Los imports van al inicio.
- Asignaciones simples, números decimales finitos de magnitud segura, cadenas cortas, booleanos,
  `None`, operadores aritméticos y comparaciones, `and`, `or`, `not`, ternario `a if c else b`.
- `if/elif/else`, `while`, `break`, `continue`, `pass` y `print` de escalares.
- Pines declarados una sola vez al nivel superior con GPIO literal o constante numérica y modo
  explícito: `Pin(n, Pin.OUT)`, `Pin(n, Pin.IN[, Pin.PULL_UP/Pin.PULL_DOWN])`.
  `simbridge.pin(n)` es una entrada con pull-up para conservar la plantilla existente; no abre UART.
- `value`, `on` y `off` para salidas binarias. Leer una entrada sin referencia eléctrica válida
  produce un error **X**, no un cero ni el último nivel conocido. Leer una salida devuelve su
  latch funcional; la tensión real bajo carga se consulta en las medidas del circuito.
- `sleep`/`sleep_ms` con esperas de 10 a 60000 ms enteros. La agenda comparte la unidad de
  picosegundos de la plataforma; un único temporizador del host lleva la ejecución a tiempo real.
  No promete precisión de reloj del chip ni sincronía de instrucciones.

Límites: main.py de hasta 64 KiB, 4096 instrucciones/expresiones, 256 variables, 1000 instrucciones
sin una espera, 16 impresiones y 64 barreras por tramo de ejecución. El código no soportado falla
con archivo/línea. Sin funciones/clases propias, listas, módulos de usuario importados, REPL,
PWM, ADC, buses I2C/SPI, Wi-Fi, radio, interrupciones de firmware, RTOS ni binarios ESPHome/C/C++.
No se acredita compatibilidad completa con MicroPython ni con un SoC ESP32.

## Integración y validez eléctrica

`BuildService` prepara un snapshot de main.py y omite el toolchain de firmware al elegir este motor.
`EmuladorPropio` implementa el contrato de los motores existentes; se selecciona en el mismo registro
y emite los mismos eventos de estado y GPIO, con `motor: "propio"`, PID y puertos nulos.

Las direcciones y pulls se obtienen del programa validado. Durante una corrida se conservan las
configuraciones activas; editar un archivo no cambia las propiedades eléctricas del programa que
sigue ejecutándose. Un cambio de motor invalida también la revisión de la observación eléctrica.

Cada escritura retira las lecturas de entrada anteriores y cede al coordinador eléctrico antes de
continuar con otra instrucción. Las llamadas anidadas que intenten escribir y luego leer dentro de
una sola expresión sin una barrera no obtienen medidas inventadas: fallan por ausencia de referencia.
La alimentación, los drivers de la placa y los componentes conservan los modelos de ngspice de la
aplicación. El LED se pinta con su corriente calculada. Se actualiza la lectura física también con
alimentación USB, aunque no haya una fuente regulable en el dibujo.

El coordinador existente evita consultas eléctricas concurrentes sin límite. Parar o resetear cambia
la generación y una barrera pendiente no puede reactivar código ni publicar salidas de la corrida
anterior. Los errores de ejecución retiran las salidas y dejan el diagnóstico en la consola.

Esta integración reutiliza la agenda común y los contratos de motor, entrada y observación. El
lienzo de proyectos conserva su esquema plano actual; cargar manifiestos jerárquicos y acoplamientos
arbitrarios en proyectos sigue pendiente. El banco jerárquico del PR #96 queda como herramienta de
verificación de esa plataforma. No se cambia ni se inventa el esquemático interno del ESP32.

## Verificación de esta iteración

El PR #96 se integró a main (`d5ef336`); esta implementación parte de ese contenido. La suite
completa pasó con `vitest run --maxWorkers 1`: **1972 correctas y 1 omitida**, 185 archivos correctos
y uno omitido, en 532,99 s. Incluye 27 pruebas nuevas de programa/backend/preparación y una regresión
adicional de revisión eléctrica. Build de shared/servidor/web y tipos de servidor/web correctos;
`git diff --check` correcto.

Pasaron **6 E2E en Chromium y servidor real**, en 34,4 s, con `ESP_EMU_BIN` apuntando a un archivo
inexistente. Verifican el main.py de la plantilla original, botón → solver → programa → GPIO → LED
sobre el lienzo existente, estado `motor: propio` sin PID/puertos, reset, stop, corte USB, código
activo inmutable al editar, cambio de motor rechazado durante la corrida y errores sin fallback.
Incluyen las tres regresiones del banco visual. No se interceptan API ni WebSocket en la ejecución
del motor propio. La captura del lienzo se inspeccionó y el servidor temporal quedó cerrado.

La prueba integrada falló inicialmente porque el backend ya publicaba GPIO7=1 pero el lienzo no
refrescaba las medidas cuando sólo había alimentación USB. Se corrigió la guarda de actualización
física; no se sustituyó la lectura por el latch ni se forzó el LED a encendido.

Esto acredita la integración funcional inicial. No acredita ejecución de firmware binario, un
ESP32 completo, RF, nuevos periféricos ni compatibilidad general con MicroPython.
