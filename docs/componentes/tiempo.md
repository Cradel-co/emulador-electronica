# Agenda temporal compartida de componentes

La agenda está en `app/shared/src/componentes/tiempo.ts`: no importa servidor, DOM, solver ni
relojes del host. El coordinador `app/server/src/componentes/temporal.ts` la conecta al grafo
jerárquico activo y al adaptador eléctrico existente. Es trabajo de plataforma P2, no un módulo
nuevo del catálogo ni una integración de firmware.

## Tiempo y orden

El tiempo se expresa en **picosegundos enteros `bigint`**, entre 0 y `2^127−1`. No se convierte
una fecha del host en tiempo simulado. Para un futuro transporte JSON deberá codificarse como
cadena decimal; este piloto no cambia el protocolo ni ProjectSchema.

La clave de orden es `(instantePs, fase, secuencia de inserción)`. Las fases son:

1. `entrada`: estímulos externos.
2. `modelo`: evolución funcional y cambios de parámetros eléctricos.
3. `electrico`: barrera reservada al coordinador, que espera al solver.
4. `observacion`: lecturas y consecuencias que necesitan el circuito actualizado.

A igual instante/fase se conserva FIFO, incluidos eventos programados por otro callback. Se
rechazan eventos en el pasado y en una fase ya cerrada del mismo instante. Se permiten eventos
de duración cero dentro de la fase actual, sujetos al presupuesto. Al avanzar a un instante nuevo
se abre de nuevo la primera fase. No se procesan dos avances concurrentes o reentrantes.

`RelojComponente` convierte ticks enteros de 1 Hz a 1 THz. Conserva una fracción racional de
picosegundo, también al cambiar frecuencia; no redondea cada tick ni acumula error de coma flotante.
Cada fábrica crea sus relojes junto con el estado de su modelo. No se reinterpretan eventos ya
programados al cambiar frecuencia: cancelar/reprogramar esos timers corresponde al adaptador.

## Integración jerárquica

```ts
const simulacion = new SimulacionTemporalComponentes(catalogo, referencia, paquetes, {
  representaciones: [{ ruta: ['izquierda', 'r2'], seleccion: 'equivalente' }],
  crearModelo(instancia) {
    if (instancia.definicion.id !== 'resistor') return undefined;
    return {
      iniciar(ctx) { ctx.programarEn(10_000n, 'ajustar'); },
      evento(ctx) { ctx.ponerParametro('ohms', 3000); },
    };
  },
});
await simulacion.avanzarHasta(20_000n);
const medida = simulacion.resultado; // instante de resolución y resultado DC válido, o null
```

La elaboración y selección ocurren una vez al crear la simulación. Solo las **hojas activas**
reciben una fábrica temporal; ni los compuestos que las contienen ni el árbol alternativo inactivo
se ejecutan además. Las rutas de ámbito son arrays, no nombres de pines concatenados. La fábrica
recibe una copia de la instancia y debe producir estado propio por hoja y reinicio.

Los adaptadores temporales son TypeScript de confianza inyectado por el servidor. Todavía no se
carga código temporal de `module.json` ni se amplía el sandbox de paquetes. `iniciar` es síncrono;
`evento` puede ser asíncrono. No se debe compartir estado externo entre fábricas.

El contexto permite programar en la ruta propia, cancelar tokens de esa ruta, modificar sus
parámetros validados y leer tensiones de terminales identificados por ruta/puerto. Los parámetros
expuestos en el contexto son una copia del inicio del callback; el estado eléctrico efectivo vive
en el grafo privado. Los bindings del padre se resuelven al elaborar; este piloto no propaga
cambios dinámicos de parámetros del compuesto hacia sus hijos. Un contexto retenido caduca al terminar el callback o cancelar su generación.
No puede utilizarse después para modificar otra corrida.

## Barreras y validez eléctrica

Hay una barrera inicial en `t=0`. Cambiar un parámetro valida tipo/rango/unidad mediante el mismo
contrato del elaborador y solicita una barrera en el instante actual. Los cambios simultáneos de
varias hojas comparten **una sola** resolución. Se reserva espacio en la cola antes de aplicar el
cambio; una cola llena no deja una modificación sin barrera.

La barrera toma una copia del grafo y llama a `analizarGrafoElaboradoDc`, que conserva paquetes,
hashes, sandbox, ngspice, reglas y conservación del adaptador DC. El avance espera su promesa:
no ejecuta observaciones ni eventos futuros con tensiones antiguas mientras está resolviendo.
Una observación no puede cambiar parámetros en el mismo instante; debe programar una fase de
modelo futura. Leer tras un cambio y antes de la barrera falla explícitamente.

Cada medida conserva `instantePs`, el instante del último punto de operación. Puede seguir siendo
válida cuando avanza el tiempo sin cambios eléctricos; no se presenta como una nueva resolución.
Los getters devuelven copias. Cambiar parámetros, detenerse o fallar retira las medidas. Un fallo,
resultado vacío o no finito deja la agenda fallida, conserva diagnóstico y cancela el resto de la cola.

**Es una coordinación cuasiestática:** calcula puntos DC sucesivos. No conserva carga de C/L,
integra transitorios ni garantiza captura de pulsos de firmware. El tiempo entre puntos no implica
una simulación transitoria de ngspice. La validez de ese perfil para cada componente requiere su
propia evidencia.

## Cancelación y ciclo de vida

- Un token identifica su entrada por identidad de objeto, no solo por número; no cancela otra agenda.
- `cancelarSubarbol(ruta)` retira eventos pendientes de ese ámbito e incrementa sus generaciones.
  Un callback en vuelo pierde permiso para escribir mediante su contexto. Las otras copias siguen.
  Cancelar eventos no quita físicamente piezas ni simula pérdida de alimentación.
- `pausar` congela tiempo simulado. Una barrera ya en vuelo puede terminar en ese mismo instante.
- `detener` cancela toda la cola, invalida respuestas en vuelo y retira medidas inmediatamente.
  No fuerza la terminación del worker ngspice que ya estaba calculando; se descarta su respuesta.
- `reiniciar` exige que el avance anterior haya terminado. Restaura tiempo cero, parámetros iniciales,
  grafo elegido y fábricas nuevas; no migra estado entre representaciones ni reutiliza timers.

## Presupuestos

Máximos reducibles: 2000 propietarios, 10 000 eventos pendientes y 100 000 despachos por avance.
El coordinador permite 100 barreras por avance por defecto (configurable entre 1 y 1000), además
del límite DC existente de 100 hojas. La conversión racional limita su denominador a 4096 bits.
Los payloads contienen hasta 16 valores escalares, con claves y cadenas acotadas.

La cola usa búsqueda binaria e inserción en array; inserción y cancelación tienen coste lineal
acotado por el presupuesto. Las cancelaciones retiran físicamente las entradas. No se promete
velocidad 1× ni cancelación forzada de un adaptador de confianza que nunca devuelve el control.
El presupuesto de eventos detecta bucles de duración cero que sí devuelven el control.

## Evidencia

- Agenda pura: enteros mayores a `Number.MAX_SAFE_INTEGER`, empates/fases, cancelación por token
  y subárbol, generaciones, pausa/stop/reset, barreras asíncronas, concurrencia y saturación.
- Relojes: cambios de 3 a 6 Hz conservando residuos y equivalencia de 240 ticks individuales frente
  a un lote de 240 a 240 MHz.
- Dos divisores anidados comparten fuente y agenda. En `t=10 ps`, sus resistencias inferiores pasan
  a 3 kΩ y 4 kΩ: el solver real da `3·VIN/4` y `4·VIN/5`, con cuatro resistores, y una sola barrera
  para ambos cambios. Hay otra resolución inicial en `t=0`.
- Se cubren respuesta tardía tras stop, callback cancelado tras await, reinicio sin estado compartido,
  copias defensivas, barrera fallida/vacía/no finita, presupuesto de barreras y fase de observación.
- Una hoja equivalente activa recibe eventos; su interior inactivo no. Cancelar la rama derecha
  deja actuar a la izquierda sin duplicar primitivas eléctricas.

Siguen pendientes adaptadores de pads/IRQ/protocolos/CPU, reloj de firmware, transitorios,
persistencia/replay serializado, interfaz de usuario y certificación completa de P2/H0–H3.

## Verificación de esta iteración

Las regresiones iniciales se ejecutaron antes de crear los módulos temporal y de agenda y fallaron
por esas importaciones ausentes. La suite final incluye 97 pruebas de componentes: 23 corresponden
a tiempo y coordinación temporal, además de las 74 de contratos, elaboración, paquetes y DC.
Build de shared/server/web y comprobación final de tipos del servidor correctos.

La primera suite completa (dos workers) terminó con 1836 correctas, tres fallos ST7735 y una
omitida (366,03 s). Las tres fallas fueron lecturas de `rgb565` sobre una salida inexistente.
ST7735 pasó aislado en la rama (13/13; 28,45 s). En una copia del commit anterior `c49151d`,
sin agenda, fallaron ocho de esas 13 pruebas (36,33 s), incluidas lecturas de salida inexistente.
Los tests, el modelo y el límite de 250 ms del sandbox de pantalla coinciden con main y no se
modificaron. La intermitencia también existe antes de este cambio; estos resultados por sí solos
no prueban que toda falla de pantalla tenga la misma causa.

La repetición completa con `vitest run --maxWorkers 1` pasó: **1839 correctas, 1 omitida**,
172 archivos correctos y uno omitido, en 596,06 s. Se redujo la contención conservando todas las
pruebas y sus límites; no se modificaron ST7735 ni su sandbox. `git diff --check` correcto.
No se ejecutaron E2E ni hardware; las barreras jerárquicas sí usaron el solver eléctrico real.
