# Señales digitales, alimentación y reset en componentes jerárquicos

Este avance de P2 conecta la agenda común con señales eléctricas y ciclo de vida. Es plataforma
interna: todavía no hay integración con el editor ni ejecución de firmware ESP32. Las pruebas usan
un modelo TypeScript resistivo declarado, sin atribuirle fidelidad de un chip comercial.

## Un propietario por efecto

Una hoja legada puede declarar `perfilDigital`, además del paquete completo por hash. El perfil
no añade fuentes ni transistores al circuito. Cada salida referencia un parámetro del modelo:
`escribirDigital` cambia ese parámetro; **el modelo eléctrico del paquete** conecta el pin a sus
rieles o lo libera. Así no se ejecutan dos circuitos para el mismo driver.

```ts
perfilDigital: {
  alimentacion: { positivo: 'VCC', negativo: 'GND', minVoltios: 2, maxVoltios: 5.5 },
  entradas: { I: { vil: 0.3, vih: 0.7 }, RST: { vil: 0.3, vih: 0.7 } },
  salidas: { Q: { parametro: 'nivel' } },
  reset: { puerto: 'RST', activo: 0 },
  retardoPs: '1',
}
```

Estos números son **datos declarados del perfil de prueba**, no especificaciones de un ESP32.
El retardo de transporte se declara como cadena decimal entre 1 y 999 999 999 999 ps. Es explícito
porque una reacción no puede retroceder a una fase ya cerrada. No es una estimación automática del
retardo físico de silicio.

El contrato exige pines eléctricos existentes, roles disjuntos y un parámetro de texto por salida,
con valores exactamente `0`, `1`, `Z` y default `Z`. Reset debe apuntar a una entrada con umbrales;
puede ser activo en bajo o alto. Los umbrales son proporciones de VCC, entre cero y uno, con
VIL < VIH. La alimentación debe tener rieles distintos y un intervalo positivo válido.

El paquete debe tener modelo explícito. La verificación comprueba compatibilidad de datos y hash,
no demuestra que cualquier código implemente correctamente `Z`: cada modelo necesita su propia
evidencia física. En el fixture, `Z` no agrega elementos de salida; `0` y `1` conectan Q a GND o
VCC mediante una resistencia declarada de 50 Ω. No crea energía dentro del componente.

Las hojas sin perfil conservan su comportamiento y hash. Una representación solo ejecuta sus
hojas activas; no se infiere automáticamente un perfil agregado para la frontera de un compuesto.
La equivalencia funcional de cada representación sigue requiriendo evidencia.

## API del adaptador temporal

```ts
crearModelo(instancia) {
  return {
    iniciar(ctx) { ctx.escribirDigital('Q', 1); },
    entradaDigital(ctx, cambio) {
      // Incluye puerto, anterior, actual e instanteMuestraPs.
      if (cambio.puerto === 'I') registrar(cambio.actual);
    },
    evento(ctx, evento) { /* timers propios */ },
  };
}
```

- `leerDigital(puerto)` devuelve `0`, `1` o `X` de una entrada propia declarada.
- `escribirDigital(puerto, 0 | 1 | 'Z')` modifica la salida propia; solo se admite en fases de
  entrada/modelo, con el componente operativo. No publica directamente una tensión lógica.
- No se permite cambiar un parámetro de drive mediante `ponerParametro`: debe pasar por la API
  digital. Los demás parámetros conservan la validación de tipo, rango y unidad declarada.
- `entradaDigital` es opcional. Recibe cambios muestreados tras una barrera, con su instante de
  origen y el retardo declarado. Se conserva el orden de transporte; no se modela filtrado inercial.
- Leer después de una escritura dentro del mismo callback exige otra barrera: no se entrega una
  medida anterior como si ya reflejara el cambio. Puede programarse una observación posterior.
- Los eventos `$digital:*` son internos y no se pueden inyectar mediante la API pública.

Los adaptadores siguen siendo TypeScript de confianza del servidor, con fábrica propia por hoja.
El comportamiento eléctrico sí se ejecuta en el sandbox del paquete. No se carga código temporal
arbitrario desde los manifiestos de componentes.

## Lecturas y referencia física

El coordinador toma VCC como `V(positivo) − V(negativo)` y lee cada entrada respecto de ese GND
local. Por debajo de VIL devuelve cero; por encima de VIH, uno; entre ambos, `X`. Sin alimentación
válida, medida o referencia física verificable devuelve `X`.

El adaptador solicita al motor `referenciasDeEntradas` para los pines del perfil. El motor reutiliza
`nodosReferenciadosDc` y agrupa la comprobación por los rieles locales. Las resistencias de fuga de
ngspice para converger no conceden referencia. El DTO de esos terminales agrega `referenciada`;
la consulta opcional no cambia los resultados ni la forma de las consultas anteriores sin perfil.

Una entrada abierta y una resistencia que termina en otra isla siguen siendo indeterminadas.
Dos salidas resistivas enfrentadas se resuelven físicamente y pueden producir un nivel intermedio,
sin elegir arbitrariamente un ganador. La decodificación por umbrales no certifica seguridad frente
a sobretensión ni modela protección ESD o daño de entradas.

## Alimentación y reset

El estado por instancia es `apagado`, `reset` o `activo`:

1. Al crear/reiniciar la simulación, las salidas se fuerzan a `Z`, incluso si había un override de drive.
2. Tras resolver el circuito, una alimentación fuera del intervalo deja la hoja apagada. Un reset
   activo o indeterminado mantiene reset. No se ejecuta su inicialización hasta comprobar esos datos.
3. Perder operación cancela eventos de esa ruta, invalida la generación, descarta el adaptador
   anterior y pone sus salidas en `Z`. No cancela otras copias del mismo esquema.
4. Si liberar salidas cambia el circuito, se resuelve de nuevo en el mismo instante hasta estabilizar,
   dentro del presupuesto de barreras por avance. No se publican estados intermedios como resultado final.
5. Al volver a estar operativo, se agenda un inicio con el retardo declarado. La fábrica crea estado
   nuevo y se entregan las entradas iniciales; los timers anteriores no reaparecen.

Antes de despachar un evento digital, si hay cambios eléctricos pendientes se adelanta una barrera.
Esto cubre el empate donde un cambio anterior de alimentación/reset y un timer comparten instante:
se verifica la energía antes del callback. Se conserva el orden instante/fase/secuencia de la agenda;
una modificación que todavía no ocurrió según ese orden no se anticipa.

El presupuesto cuenta cada resolución real, incluidas las necesarias para estabilizar y las adelantadas.
La barrera ordinaria se evita si ese instante ya tiene una medida vigente. Stop/reset de la simulación
invalidan también las respuestas asíncronas; no se adelanta el tiempo mientras se espera al solver.

`estadosDigitales` entrega una copia de los estados, entradas y alimentación por ruta solo cuando hay
una medida válida. Durante una barrera, fallo o stop devuelve `null`.

## Evidencia y límites

El fixture contiene dos copias de un esquema con un chip interno, fuentes independientes, una salida
resistiva, una carga de 10 kΩ y un pull-up de reset. Se verifica:

- `VQ = VCC · 10000/10050` y lectura de esa tensión en la otra copia.
- Corte/restauración de alimentación, aserción/liberación de reset, fábrica nueva y timers cancelados.
- Supervivencia de la copia no afectada y cancelación del timer que vence junto al corte.
- Entradas abiertas/islas resistivas como `X`, contención de salidas e intervalo indeterminado.
- Umbrales relativos a GND local, reset activo en alto y contratos inválidos.
- Rechazo de drive fuera de su API, notificaciones suplantadas y paquetes sin modelo explícito.

Se mantienen puntos de operación DC sucesivos. No se conserva energía de capacitores/inductores ni
se modelan transitorios, metastabilidad, ruido, ESD, retención de RAM, rampas de power-on o retardos
analógicos de reset. El [controlador funcional de interrupciones](interrupciones.md) consume estas
muestras y conserva pendientes por instancia. Enrutamiento de puertos IRQ, buses/protocolos, CPU, worker de firmware, persistencia y editor siguen
pendientes. La alimentación lógica del perfil no sustituye la evidencia de consumo de cada modelo.

## Verificación de la iteración

Las regresiones de integración se ejecutaron antes del contrato nuevo y fallaron por `perfilDigital`
ausente. La isla resistiva produjo 0 en lugar de `X` antes de conectar la prueba de referencia física.
El conjunto específico final pasó 127 pruebas en diez archivos (30 pruebas añadidas a las 97 previas).
Build de shared/server/web y comprobación final de tipos del servidor correctos.

La suite completa pasó con `vitest run --maxWorkers 1`: **1869 correctas, 1 omitida**,
175 archivos correctos y uno omitido; 371,59 s. Se usó un worker para reducir la contención
observada previamente con ST7735, conservando todos los tests y límites. `git diff --check` correcto.
No se ejecutaron E2E ni hardware: la integración física se probó con el solver real sobre la API
interna, y la integración de editor/firmware todavía no forma parte de este bloque.
