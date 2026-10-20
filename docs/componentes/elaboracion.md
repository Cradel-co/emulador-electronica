# Elaboración de componentes: primer recorrido P1

La elaboración convierte definiciones versionadas en un grafo de instancias y redes. Es una
operación pura en memoria: no lee proyectos, carga módulos ejecutables, llama al solver ni ejecuta
firmware. No crea APIs HTTP ni modifica el esquema de persistencia actual.

## API

`app/server/src/componentes/catalogo.ts` exporta:

- `huellaDefinicion(documento)`: valida el contrato y calcula SHA-256 del JSON normalizado.
- `CatalogoComponentes(documentos)`: valida definiciones, conflictos de versión, existencia de
  dependencias, ciclos por identidad y hashes de referencias internas. El catálogo es un snapshot.
- `catalogo.resolver({id, version, sha256})`: devuelve una copia del contenido verificado.

`app/server/src/componentes/elaboracion.ts` exporta:

- `elaborarComponente(catalogo, referencia, {parametros?, limites?})`.
- `LIMITES_ELABORACION`: profundidad 16 (raíz en 0), 2.000 instancias incluida la raíz,
  20.000 terminales, 10.000 conexiones explícitas y 10.000 redes resultantes.

Los límites de una llamada solo pueden reducir los máximos. El catálogo limita además a 2.000
documentos, 20.000 puertos, 10.000 conexiones y 10.000 referencias a hijos antes de resolverlas.
Estos máximos son presupuestos de seguridad, no mediciones de velocidad ni garantías de simulación.

Ejemplo de uso, con documentos y referencia recibidos por el llamador:

```ts
const catalogo = new CatalogoComponentes(documentos);
const grafo = elaborarComponente(catalogo, referenciaRaiz, {
  parametros: { inferior: 2000 },
  limites: { instancias: 100 },
});
```

## Parámetros

Cada definición puede declarar `parametros` de número finito con min/max/unidad, texto con lista
de valores permitidos o booleano. Sus defaults deben ser válidos. Ausente equivale a `{}`.
La raíz recibe valores escalares. Una instancia hija puede fijar un valor o usar
`{parametro: "nombreDelPadre"}`. El elaborador resuelve ese vínculo y valida el valor contra el
contrato del hijo. No se evalúan expresiones, unidades implícitas ni código del proyecto.
En un vínculo numérico, las unidades declaradas deben coincidir exactamente (o estar ambas
ausentes); no se convierte entre V y mV ni se asume una unidad que solo declara uno de los extremos.

Un parámetro desconocido o fuera de rango falla con ruta de instancia. Cada resultado contiene
sus propios valores: cambiar el resultado de una elaboración no afecta al catálogo ni a otra
instancia. El estado dinámico de simulación todavía no se crea en esta etapa.

## Hashes y versiones

El hash de una definición se calcula **después de validar y aplicar defaults del contrato**,
con claves de objeto ordenadas y arrays en su orden original. Cambiar whitespace u orden de claves
de entrada no lo altera. Cambiar contenido o el orden de un array sí puede alterarlo. La versión
del formato sigue siendo inicial, no publicada; los consumidores deben obtener la huella mediante
esta API y no hashear el texto JSON original.

Dos documentos distintos con el mismo ID/versión se rechazan dentro de un catálogo. La persistencia
de un registro de versiones publicadas entre catálogos o ejecuciones todavía no está implementada.
Para diagnosticar ciclos se comprueba primero la topología por ID/versión, antes de comparar hashes;
un ciclo no necesita constituir un cierre de hashes válido para ser rechazado.

El hash de `modulo` de una hoja legada permanece como referencia opaca. **Todavía no se resuelve
ni verifica el paquete legado en disco** ni se comprueba su correspondencia con `ModuleDef`.
Los fixtures usan hashes sintéticos para esa referencia y no cargan modelos de resistores.
Ese adaptador debe verificar paquete, pines y props antes de ejecutar hojas con el solver.

## Resultado y trazabilidad

- `instancias`: ruta de IDs como array, definición exacta, tipo y parámetros efectivos.
- `redes`: ID determinista, dominio, ancho, terminales y conexiones de origen.
- Cada terminal conserva ruta, puerto y una clave de tupla JSON. Los nombres SPICE se asignarán
  después mediante el adaptador existente; no se generan concatenando barras o puntos.
- `origenes` identifica cada conexión declarada por ruta y su ID, incluso al fusionar redes de
  distintos niveles. La red puede volver a la hoja/terminal de origen sin inspeccionar ngspice.
- Los puertos abiertos conservan una red aislada de un terminal. Dos terminales llamados GND
  no se unen por nombre. Una conexión explícita sí fusiona sus redes.
- Se valida dominio y ancho en cada unión. Las redes funcionales rechazan múltiples salidas
  declaradas, contando hojas y entradas de la raíz; las fronteras de compuestos no agregan drivers.
  Alta impedancia, arbitraje o contención temporal requieren estrategias de ejecución posteriores.

Las definiciones se recorren en orden estable por IDs locales; el resultado no depende del orden
de carga del catálogo. Un lazo eléctrico es conectividad y se permite; una definición que se
contiene a sí misma, directa o indirectamente, se rechaza.

`ErrorComponente` contiene código estable, mensaje y ruta. La validación devuelve el primer error
y no entrega un grafo parcial. Los errores de catálogo identifican la definición; los de expansión
y parámetros conservan la ruta de instancia cuando corresponde.

## Evidencia y frontera de esta entrega

Pruebas en `app/tests/unit/shared/componentes/contratos.test.ts` y
`app/tests/unit/server/componentes/elaboracion.test.ts`; fixtures exclusivos bajo
`app/tests/fixtures/server/componentes/`. Cubren contrato, referencias por contenido, aislamiento,
defaults/bindings, redes de dos divisores, anidamiento, GND explícito, ciclos, dominios, anchos,
direcciones funcionales y presupuestos. Los casos base se ejecutaron antes de la implementación
y detectaron el contrato de parámetros pendiente y los módulos inexistentes.

J01–J04 se comprueban aquí en **conectividad y parámetros**, no en tensiones o corrientes. No se
ha medido VOUT ni se presenta 2,5 V como resultado del solver. J05–J08, la elección de
representaciones, su integración eléctrica, el editor y la fabricación siguen pendientes.
La primera conexión al solver deberá comparar el grafo jerárquico con un plano y conservar
`resuelto:false` como fallo, también en smoke y certificación.

Resultados estructurales comprobados para el fixture de dos divisores:

| Caso | Resultado |
|---|---|
| Dos copias sin cables entre ellas | 7 instancias y 6 redes independientes. |
| Resistor inferior izquierdo/derecho | 1.000 Ω / 2.000 Ω en parámetros efectivos; no son medidas eléctricas. |
| Conectar ambos GND explícitamente | 5 redes; se fusionan solo las tierras. |
| Añadir una envoltura | 8 instancias; se conserva la ruta `caja → derecha → r2`. |

### Verificación del 20 de octubre de 2026

- Casos específicos: 42 correctos en los dos archivos de componentes.
- Vitest completo: 1.784 correctos, 1 omitido; 167 archivos correctos y 1 omitido; 108,18 s.
- Typechecks shared/server/web y `npm run typecheck:modulos`: correctos.
- `npm run build` (shared/server/web): correcto.
- E2E y hardware no ejecutados; no hay UI nueva, arranque de firmware ni integración eléctrica.
- Los resultados validan esta etapa de conectividad; no convierten el caso omitido en evidencia
  física ni cierran los hitos posteriores del SDD.
