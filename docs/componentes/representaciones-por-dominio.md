# Representaciones por dominio de ejecución

Un compuesto puede asignar sus efectos eléctricos y funcionales a implementaciones diferentes.
Estas son **dos familias de ejecución**, no seis motores nuevos para todos los dominios de puerto.
Actualmente se ejecutan puntos DC, entradas digitales, temporizadores e IRQ; CPU y protocolos siguen pendientes.

## Selección

El equivalente conserva los mismos puertos y contratos de parámetros que el compuesto. El catálogo
valida todas las dependencias, hashes, ciclos e interfaces, incluso de alternativas no ejecutadas.

```ts
representaciones: {
  equivalente: referenciaDelEquivalente,
  predeterminada: { electrico: 'equivalente', funcional: 'interno' },
}
// Override de una instancia, para elaborar, analizar DC o crear la simulación temporal:
{ representaciones: [
  { ruta: ['sensor'], seleccion: { electrico: 'equivalente', funcional: 'interno' } },
] }
```

El objeto exige ambos campos y rechaza campos extra o valores desconocidos. También admite la
combinación inversa. Los valores anteriores `'interno'` y `'equivalente'` siguen seleccionando
todos los efectos, sin alterar los hashes ni la forma de los grafos anteriores. Si ambas familias
eligen la misma implementación, se elabora una sola vez. No hay selección `ambos` ni fallback.

Los descendientes reciben la intersección de los dominios de sus ancestros. Una selección anidada
no puede reactivar efectos excluidos por el padre. Las ramas sin efectos no se recorren y un
override bajo ellas se rechaza como inexistente/inactivo. No hay cambio en caliente ni transferencia
de estado entre representaciones: se construye otra simulación o se reinicia la misma selección.

## Identidad y propietarios

La ruta pública del compuesto se conserva. Al combinar implementaciones, el interior mantiene sus
rutas y el equivalente ocupa un hijo derivado `equivalente`. Si existe un hijo real con ese ID,
se utiliza el primer `equivalente-N` libre. No se cambian IDs del usuario. Ese nivel adicional y
todos los terminales/conexiones de las dos ramas consumen los presupuestos globales existentes.

El grafo contiene:

- `InstanciaElaborada.dominiosActivos`: máscaras heredadas; ausencia significa ambas familias.
- `representacion`: decisión solicitada y referencia del compuesto original.
- `origenRepresentacion` en la raíz derivada: ruta pública que representa.
- `OrigenRed.observacion`: conexión que permite leer, sin aportar conectividad física.
- `OrigenRed.representacion`: distingue los enlaces derivados del equivalente de conexiones del usuario.

El adaptador DC verifica los paquetes activos de ambas ramas, pero estampa únicamente las hojas
con propiedad eléctrica. Las fábricas temporales y el router IRQ ejecutan únicamente propietarios
funcionales. Los compuestos siguen siendo interfaces, sin callbacks ni drivers adicionales.
La representación sin propiedad funcional no puede unir redes IRQ activas mediante su cableado.

## Lecturas sin modificar el circuito

El elaborador conserva separadamente la conectividad física y las asociaciones de observación.
Una hoja funcional puede observar una tensión cuando su red interna se asocia a un único nodo
físico del equivalente mediante las interfaces declaradas. Las entradas digitales usan esa tensión
y la prueba de referencia a sus rieles locales; cada consulta funcional tiene un ID propio para
no sobrescribir la evidencia de otra entrada que lea el mismo pin físico.

Un cable de observación **no puede unir dos nodos físicos distintos**. Esa combinación se rechaza
antes de ejecutar el solver, en vez de cortocircuitar el equivalente. Si un nodo interno no tiene
correspondencia física, su tensión queda `null` y una entrada digital es `X`. No se reconstruyen
tensiones internas de un equivalente por suposición ni se usan fugas numéricas como señales.

## Alimentación, reset y escrituras

Los perfiles digitales se evalúan con las medidas del propietario eléctrico. Se conservan los
estados apagado/reset/activo y la cancelación de eventos/IRQ por generación. La recuperación crea
un adaptador funcional nuevo; el propietario exclusivamente eléctrico no recibe otra fábrica temporal.
Un riel o reset interno no observable no autoriza operación: se aplican las mismas reglas de `X`
y ausencia de alimentación del perfil digital.

Una hoja exclusivamente funcional no puede usar `ponerParametro` o `escribirDigital` para modificar
un modelo eléctrico excluido. El intento falla y retira las medidas. Esta iteración permite observar
el circuito y producir efectos funcionales como IRQ y temporizadores. **No implementa todavía
acoplamientos declarativos de escritura entre las dos representaciones.** Para controlar hoy un
driver físico con esas APIs, su hoja debe conservar ambas familias, o usarse una representación completa.

## Evidencia

- Nueve pruebas de elaboración: propietarios, predeterminado/override, selección inversa, deduplicación,
  límites, campos inválidos, colisión de IDs, máscaras anidadas y rechazo de observaciones que cortocircuiten.
- Nueve integraciones con ngspice: las dos combinaciones eléctrica/funcional, lectura digital e IRQ,
  reset/alimentación, bloqueo de escrituras ajenas, nodos internos no observables, exclusión de cableado
  IRQ inactivo y divisores anidados con cuatro resistencias y medidas conservadas.
- Regresión inicial: el parser rechazaba el objeto de selección. Sin el control de conectividad física,
  la regresión del cable de observación no rechazaba la unión de nodos distintos.

API interna de P2. Sin cambios de Project, editor o rutas HTTP; no ejecuta firmware ESP32,
transitorios analógicos ni protocolos nuevos. No acredita P2 completo ni equivalencia física general
entre alternativas: cada par de modelos necesita evidencia para su rango de uso.

## Verificación de esta iteración

El conjunto de componentes pasó **178 pruebas en catorce archivos**, incluidas las 18 nuevas.
Build de shared/servidor/web y tipos correctos. La suite completa pasó con
`vitest run --maxWorkers 1`: **1920 correctas y 1 omitida**, 179 archivos correctos y uno omitido,
en 321,02 s. `git diff --check` correcto. Sin E2E ni hardware; las integraciones usan el solver real
sobre la API interna. El build inicial detectó un fixture sin estrechamiento de tipo, corregido
antes del build final y la suite completa.
