# Interrupciones funcionales por instancia

`ControladorInterrupciones`, exportado desde `@emu/shared`, es un bloque puro de plataforma.
Recibe niveles ya decodificados; no agrega fuentes eléctricas ni interpreta tensiones. Su estado
pertenece a una instancia del adaptador temporal, creada por `crearModelo`.

## Contrato y reglas

- Entre 1 y 64 fuentes con identificadores únicos, sin máscaras de bits de JavaScript que trunquen a 32.
- `ascendente`, `descendente` o `ambos`: un flanco entre dos muestras conocidas enclava un pendiente.
  Varias ocurrencias antes del reconocimiento se agrupan en un solo pendiente; no hay contador.
- `alto` o `bajo`: el pendiente sigue el nivel actual. Reconocer no retira un nivel activo.
- La primera muestra y las transiciones desde/hacia `X` no generan flancos. `X` desactiva un pendiente
  de nivel, pero conserva un flanco previamente enclavado. No se adivina qué ocurrió durante `X`.
- Las fuentes empiezan enmascaradas salvo `habilitada: true`. La máscara afecta `irq`, no la captura.
- `irq` es la disyunción de pendientes habilitados. No implementa prioridad, vector ni arbitraje de CPU.
- `reconocer(id)` limpia solo el flanco de esa fuente. `reiniciar()` restaura configuración inicial,
  muestras `X` y pendientes vacíos. `estado` devuelve copias en orden de declaración.
- Identificadores desconocidos, niveles/máscaras inválidos y configuraciones duplicadas se rechazan.

## Conexión a la agenda y al circuito

La fábrica crea un controlador nuevo por hoja; no debe compartirlo entre copias ni generaciones.
El adaptador alimenta `muestrear` desde `entradaDigital`. Los servicios se programan mediante el
contexto, por lo que los eventos llevan la ruta y generación de la hoja:

```ts
const irq = new ControladorInterrupciones([
  { id: 'I', modo: 'ascendente', habilitada: true },
]);
// Dentro del objeto devuelto por crearModelo para esa hoja:
const adaptador: ModeloTemporalComponente = {
  entradaDigital(ctx, cambio) {
    if (cambio.puerto !== 'I') return;
    const antes = irq.irq;
    irq.muestrear('I', cambio.actual);
    if (!antes && irq.irq) ctx.programarEn(ctx.ahoraPs + 10n, 'servir');
  },
  evento(_ctx, evento) {
    if (evento.tipo === 'servir') irq.reconocer('I');
  },
};
```

Ese ejemplo atiende una sola fuente por flanco. Un adaptador con varias fuentes debe decidir cómo
atender las que queden pendientes; uno de nivel debe volver a evaluar `irq` tras atender, reconocer
o cambiar máscaras. El controlador no programa por sí mismo ni impone una latencia de servicio.
El retardo del perfil digital sigue gobernando la llegada de muestras.

Al perder alimentación o entrar en reset, el coordinador retira el adaptador y cancela sus eventos.
La recuperación fabrica otro controlador, sin heredar pendientes. Arrancar con una entrada alta
no crea un flanco; un modo de nivel alto sí queda pendiente al recibir esa primera muestra.

## Puertos IRQ del grafo

Las definiciones pueden declarar puertos funcionales junto a sus pines eléctricos:

```json
{ "id": "IRQ_OUT", "dominio": "interrupcion", "direccion": "salida", "ancho": 1 }
```

El receptor declara `direccion: "entrada"`. Cada interfaz de compuesto conecta su puerto externo
con el del hijo mediante las conexiones habituales. El elaborador conserva la red a través de
todas las capas; `EnrutadorIrq` usa únicamente hojas de la representación activa como emisores
y receptores. Las interfaces compuestas no agregan efectos ni callbacks. Un emisor puede alcanzar
varias entradas; múltiples emisores, IRQ vectoriales y puertos bidireccionales se rechazan.

Los puertos funcionales no se agregan al paquete físico: el verificador sigue exigiendo la
coincidencia exacta de todos sus pines eléctricos. El adaptador DC omite redes IRQ, sin fabricar
cables, tensiones ni primitivas para ellas. Otros dominios todavía no tienen ejecución.

### API temporal

- `ctx.escribirIrq(puerto, nivel)`: emite `0`, `1` o `X` exclusivamente por una salida IRQ propia.
  Solo se admite en fases de entrada/modelo y mientras la hoja esté operativa.
- `ctx.leerIrq(puerto)`: lee el último nivel entregado a una entrada IRQ propia; empieza en `X`.
- `entradaIrq(ctx, cambio)`: recibe puerto, nivel anterior/actual, instante de emisión y origen
  `{ ruta, puerto }`. El instante de recepción es `ctx.ahoraPs`. Solo se notifica un cambio de nivel.
- `retardoIrqPs` en las opciones de simulación fija el transporte funcional: entero bigint positivo,
  por defecto `1n`. No representa por sí solo la latencia física de un chip comercial.

Las entregas usan la fase `modelo` de la agenda común y su orden FIFO. Un pulso `0 → 1 → 0`
emitido en un mismo callback conserva ambas transiciones; repetir el mismo nivel no agrega eventos.
El retardo positivo evita reabrir una fase ya cerrada. Los presupuestos existentes de pendientes y
eventos por avance también limitan IRQ; una realimentación que los excede falla y retira las medidas.
El espacio de eventos `$irq:` está reservado al coordinador.

El controlador puede publicar su estado desde `entradaDigital` y después de reconocer o cambiar
máscaras, sin que el router tenga que interpretar registros del componente:

```ts
irq.muestrear('I', cambio.actual);
ctx.escribirIrq('IRQ_OUT', irq.irq ? 1 : 0);
// En el callback de reconocimiento:
irq.reconocer('I');
ctx.escribirIrq('IRQ_OUT', irq.irq ? 1 : 0);
```

### Cancelación y recuperación

Cada entrega pertenece a la generación del receptor y lleva además la generación de su emisor.
Las entregas canceladas se retiran físicamente de la cola, incluso si sus receptores están fuera
del subárbol del emisor. El índice de tokens conserva solo mensajes pendientes y se limpia al
despachar, cancelar, detener, fallar o reiniciar; no acumula mensajes invalidados ni tombstones.
El reset/corte de un emisor invalida mensajes en tránsito y publica `X` con el retardo de transporte;
no inventa un flanco de desactivación `0`. El reset/corte del receptor cancela sus entregas, retira su
adaptador y vuelve sus entradas a `X`. Tras crear el adaptador nuevo, se sincronizan las entradas
con el nivel actual del emisor, respetando el mismo retardo. Una entrada sin emisor queda en `X`.

Una barrera adelantada verifica alimentación/reset antes de entregar una IRQ si cambió el circuito,
incluso cuando el receptor no tiene perfil digital. Una cancelación mientras un receptor asíncrono
espera vence su contexto si cambió la generación del emisor o receptor. Cancelar manualmente un
subárbol también invalida sus emisiones y publica `X`; no fabrica otro adaptador. Stop vacía la
agenda y reiniciar reconstruye todo el estado del router. Pausa conserva los mensajes sin entregarlos.

La desaparición de un emisor no borra un flanco ya reconocido como pendiente por otro controlador:
esa decisión pertenece al modelo receptor. No hay estímulo externo de puertos raíz mediante una API
del host; las interfaces raíz son límites de conectividad y las emisiones parten de hojas activas.

## Evidencia y límites

Las pruebas puras cubren los cinco modos, `X`, máscaras, reconocimiento, reinicio, copias y 64 fuentes.
La integración usa el solver real y dos hojas dentro de compuestos: la salida resistiva de A produce
el flanco en B. Un reset o corte de alimentación de B cancela el servicio pendiente sin reiniciar A;
la recuperación con entrada alta no inventa flancos, y el siguiente flanco ejecuta un único servicio.

Es una capacidad interna de P2. Ya enruta puertos escalares del dominio `interrupcion`; no agrega
registros de periféricos, trampas, vectores, prioridades ni instrucciones de ESP32. Tampoco ejecuta
firmware ni cuenta pulsos entre muestras. El editor y la persistencia continúan pendientes.

## Verificación del controlador local

Se añadieron diez pruebas puras y dos integraciones con el solver real (reset y alimentación).
La suite completa pasó con `vitest run --maxWorkers 1`: **1881 correctas y 1 omitida**, en
176 archivos correctos y uno omitido; 507,23 s. Build de shared/server/web y tipos del servidor
correctos. No se ejecutaron E2E ni hardware; el recorrido probado es la API interna.

## Evidencia del enrutamiento

`app/tests/unit/server/componentes/irq.test.ts` ejecuta el solver real con dos capas de compuestos,
fan-out, pulsos, origen de emisión, fuentes/receptores independientes y selección exclusiva de
representaciones. Cubre reset y alimentación en ambos extremos con mensajes en tránsito, corte y
entrega en el mismo instante hacia un receptor sin perfil, entrada sin emisor, pausa/stop/reinicio,
contextos asíncronos, rechazos de puertos/fases/topologías y realimentación acotada por presupuesto.
La cadena física integra `ControladorInterrupciones`: el flanco eléctrico enclava un pendiente,
su salida viaja por IRQ a la otra hoja y el reconocimiento publica la desactivación.

La primera regresión falló porque el verificador de paquetes rechazaba los puertos IRQ adicionales.
La verificación ahora compara solo pines eléctricos, conservando el rechazo si falta uno aunque se
agregue un puerto funcional. No hay E2E ni firmware: la evidencia sigue siendo sobre la API interna.
La revisión de la cola agregó otra regresión: cancelar el emisor dejaba cinco eventos pendientes
en vez de las dos publicaciones `X` vigentes. Ahora las entregas antiguas liberan su presupuesto
inmediatamente; la comprobación incluye receptores fuera del subárbol cancelado.
La misma regresión repite cien cancelaciones y comprueba que la cola no crece.

Verificación final del enrutamiento: **160 pruebas de componentes correctas en doce archivos**,
incluidas las 21 nuevas de IRQ; las 13 pruebas del changelog también pasaron. Build de shared,
servidor y web, con sus tipos, correcto. La suite completa final pasó con
`vitest run --maxWorkers 1`: **1902 correctas y 1 omitida**, 177 archivos correctos y uno omitido,
en 773,14 s. Una ejecución general anterior se interrumpió para corregir la retención de mensajes
invalidados; después se repitieron las pruebas específicas, build y suite completa.
