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

## Evidencia y límites

Las pruebas puras cubren los cinco modos, `X`, máscaras, reconocimiento, reinicio, copias y 64 fuentes.
La integración usa el solver real y dos hojas dentro de compuestos: la salida resistiva de A produce
el flanco en B. Un reset o corte de alimentación de B cancela el servicio pendiente sin reiniciar A;
la recuperación con entrada alta no inventa flancos, y el siguiente flanco ejecuta un único servicio.

Es una capacidad interna de P2. No enruta todavía puertos del dominio `interrupcion`, no agrega
registros de periféricos, trampas, vectores, prioridades ni instrucciones de ESP32. Tampoco ejecuta
firmware ni cuenta pulsos entre muestras. El editor y la persistencia continúan pendientes.

## Verificación de esta iteración

Se añadieron diez pruebas puras y dos integraciones con el solver real (reset y alimentación).
La suite completa pasó con `vitest run --maxWorkers 1`: **1881 correctas y 1 omitida**, en
176 archivos correctos y uno omitido; 507,23 s. Build de shared/server/web y tipos del servidor
correctos. No se ejecutaron E2E ni hardware; el recorrido probado es la API interna.
