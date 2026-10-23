# Banco visual de componentes propios

Con el servidor y la web actualizados (`cd app && npm run build && npm run dev`), abrí el menú
**Archivo → Banco de componentes propios…**. Funciona desde el inicio o con un proyecto abierto.
El banco tiene su propio circuito fijo; no modifica ni ejecuta el proyecto seleccionado.

1. **Iniciar / reiniciar** vuelve a 0 ms con alimentación activa y reset liberado.
2. **Avanzar 250 ms** alterna el driver entre alto y alta impedancia. El LED se pinta a partir
   de la corriente resuelta por ngspice, con el umbral de 0,5 mA usado por el modelo LED del catálogo.
3. **Mantener reset** abre el driver; **Liberar reset** continúa en la fase del reloj global.
4. **Cortar alimentación** lleva el ajuste de la fuente a 0 V y abre el driver. Restaurarla permite
   continuar el parpadeo. La fuente CV/CC solo entrega: a 0 V puede conservar milivoltios numéricos;
   la vista muestra la lectura real y no la reemplaza por cero.
5. Cambiá entre **eléctrica equivalente + lógica interna** e **interior completo**. La selección
   reinicia la historia y permite ver los propietarios activos de cada hoja.

## Modelo y alcance

El circuito es fuente de 3,3 V → driver resistivo → 330 Ω → LED rojo → retorno explícito.
El driver didáctico usa 10 Ω cerrado y 10 MΩ abierto (fuga finita): son valores declarados para
esta demostración, sin caracterización de un GPIO ni un transistor real. El reset es una entrada
lógica del modelo de demostración; no representa un pin físico RST ni el perfil digital del SoC.

La lógica TypeScript alterna cada 250 ms mediante `SimulacionTemporalComponentes`; los cambios de
resistencia cruzan el acoplamiento explícito cuando la propiedad está separada. El solver calcula
las tensiones y la corriente del diodo. No se usa una animación ni una corriente prefijada como
sustituto de la simulación. Las muestras son puntos DC: no integran tiempos de subida ni transitorios.

Cada consulta reproduce una historia determinista y acotada: hasta 5 s, 32 cambios y una consulta
simultánea por servidor. El banco no deja una simulación o temporizador corriendo al cerrar el panel.
Se pueden cancelar consultas entre puntos DC; un cálculo de ngspice en curso termina normalmente.
Una solicitud inválida o un fallo del solver devuelve un error y la UI retira las medidas anteriores.

La ruta única es `POST /api/componentes/banco-led`. El registrador recibe el servicio por dependencia;
no depende del gestor de emuladores, del constructor de firmware ni de las corridas de proyectos.
La API compartida valida solicitudes y respuestas. Los paquetes se inspeccionan y fijan por SHA-256
en cada reproducción, con los mismos controles de la plataforma. No se agregan módulos al catálogo.

No inicia `esp-emu`, ejecuta firmware ni sustituye todavía el backend ESP32 de los proyectos.
El siguiente paso será llevar las declaraciones de composición/acoplamiento a manifiestos de
proyecto y construir los GPIO del SoC con sus contratos físicos y funcionales.

## Evidencia de esta iteración

Los PR #93, #94 y #95 se integraron por merge commit en main, conservando su ascendencia;
el árbol de main coincidía con la cabeza probada del #95 antes de crear la rama del banco.

La suite completa pasó con `vitest run --maxWorkers 1`: **1944 correctas y 1 omitida**, 182 archivos
correctos y uno omitido, en 221,83 s. Incluye 17 casos nuevos de banco, API y cliente. Build de
shared/servidor/web y tipos de servidor/web correctos; `git diff --check` correcto.

Los **3 E2E** pasaron en Chromium con servidor real en 11,7 s, con `ESP_EMU_BIN` apuntando a un
archivo inexistente: parpadeo, controles, representaciones, emulador detenido sin PID, proyecto
intacto y retirada de medidas ante un error. Capturas de escritorio y ancho de 700 px inspeccionadas.
No había Chrome instalado; se utilizó el Chromium disponible. El servidor temporal quedó cerrado.
Estas pruebas no acreditan firmware ESP32, GPIO físico ni una placa completa.
