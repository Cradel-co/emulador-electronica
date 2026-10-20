# Paquetes verificados y análisis DC del grafo jerárquico

Primera conexión del elaborador con el motor eléctrico existente. La API es interna del servidor:
todavía no hay editor de subhojas, endpoint público, persistencia jerárquica ni ejecución de firmware.

## Verificar un paquete

`PaquetesComponentes` en `app/server/src/componentes/paquetes.ts` recibe las raíces del catálogo
configuradas por el servidor; por defecto usa `PATHS.modules` y `PATHS.chips`.

```ts
const paquetes = new PaquetesComponentes();
const paquete = await paquetes.inspeccionar('resistor');
// El autor fija paquete.sha256 en definicion.modulo.sha256 antes de publicar la definición.
const modelo = await paquetes.verificar(definicionHoja);
```

`inspeccionar` lee y valida el descriptor, captura los archivos y calcula un manifiesto. No compila
ni ejecuta modelos. `verificar` captura de nuevo, compara el hash fijado, valida pines/propiedades
y compila los bytes TypeScript capturados, sin ejecutarlos en el host. Cambiar el paquete después
de fijar su referencia falla; no se acepta automáticamente la revisión nueva del catálogo.

### Contenido del hash

El manifiesto `paquete-componente-v1` contiene nombres y hashes ordenados:

- `module.json`: hash del JSON canónico original, con claves ordenadas. Cambios de formato no lo
  alteran; cambios de valores o campos desconocidos sí. No se aplica aquí el hash normalizado de
  una definición jerárquica: ambos formatos tienen contratos distintos.
- SVG declarado, fuente del modelo y `tests.json` si existe: hashes de sus bytes exactos.
- Para cada chip declarado: `chip.json` canónico y bytes exactos de su comportamiento.

Descriptor y archivos se validan antes de producir el snapshot. Referencias ausentes, IDs que no
coinciden, rutas fuera del paquete, archivos no regulares, UTF-8 inválido y límites excedidos son
errores. Límites por archivo: descriptor/SVG/pruebas 256 KiB, fuentes 128 KiB. Los enlaces que salen
de la carpeta de su paquete se rechazan. Las lecturas están acotadas aunque el archivo crezca.

La verificación fija identidad de contenido, no certifica su comportamiento físico ni instala
el paquete. Los chips quedan incluidos como dependencias de integridad; esta API DC todavía no
ejecuta sus protocolos. Los paquetes históricos deben conservarse por el llamador: no se implementa
un almacén persistente de versiones ni se descarga un paquete antiguo por su hash.

### Correspondencia con la hoja

- Mismo conjunto exacto de pines, sin duplicados; el piloto requiere puertos eléctricos escalares.
- Cada parámetro expuesto corresponde a una propiedad del módulo con el mismo tipo.
- Defaults válidos y rangos/listas que no amplían los del módulo. Propiedades no expuestas usan
  defaults válidos del descriptor; una propiedad obligatoria sin valor se rechaza.
- Las unidades del contrato jerárquico se validan entre sus bindings; el SDK legado no declara
  unidades de propiedades y esta correspondencia no inventa metadatos físicos.
- Si existe `model`, su fuente es obligatoria. Un error de compilación no selecciona el equivalente
  por flags. Un error durante la ejecución tampoco permite acreditar el modelo de respaldo.

## Resolver el grafo

`analizarGrafoDc` en `app/server/src/componentes/electrico.ts` elabora la raíz y verifica sus hojas.
Construye un `Project` plano **temporal**, con alias sin colisiones y conexiones derivadas solo de
las redes; luego llama a `analizarCircuito`. Reutiliza su sandbox, primitivas, ngspice, reglas,
conservación y diagnósticos. No crea un segundo solver ni persiste ese aplanado.

```ts
const resultado = await analizarGrafoDc(catalogo, referenciaRaiz, paquetes, {
  parametros: {},
  fuentesApagadas: false,
});
if (!resultado.resuelto) {
  // tensiones === null, elementos === []; diagnosticos conserva el motivo.
} else {
  // tensiones: ruta + puerto + voltios; elementos: ruta + local + va/vb/i/p.
}
```

Las tensiones se propagan también a los puertos públicos de cada compuesto. Un puerto sin medida
recibe `null`, nunca un cero fabricado. Los valores corresponden a una instantánea DC respecto de
la referencia numérica del motor; un potencial regularizado de una isla flotante no acredita una
conexión física a tierra. No se unen dos GND por nombre.

Las corrientes/potencias conservan el signo y la orientación del SDK. Cada elemento resuelto conserva
la ruta de su hoja y el nombre local; no expone objetos internos de ngspice. Los avisos mantienen
severidad y referencias originales, agregan rutas/puertos cuando se identifican y sustituyen alias
en el mensaje visible conservando `mensajeOriginal`.
Ese campo original es diagnóstico técnico y puede contener IDs de ejecución; las comparaciones
reproducibles usan los mensajes y orígenes normalizados, no esos IDs internos.

El modelo legado puede guardar variables globales. Se asigna un sandbox distinto por hoja y corrida
mediante su identidad interna de caché; las rutas públicas siguen deterministas. El piloto no
conserva estado dinámico entre consultas ni promete ejecución temporal de controles o firmware.

### Fallos y límites

Errores de paquete/contrato ocurren antes del solver y conservan código/ruta. Si el motor devuelve
`resuelto:false`, una simulación vacía o medidas no finitas, la respuesta no contiene medidas ni
elementos exitosos y conserva el diagnóstico. Está cubierto incluso cuando el motor devuelve datos
residuales junto al fallo. No se interpreta un smoke sin expectativas como aprobación.

El piloto admite hasta 100 hojas (máximo heredado de 200 primitivas por hoja). Rechaza placas
programables, hojas sin modelo eléctrico y dominios funcionales no eléctricos. Los límites globales
del elaborador siguen aplicando. Admite [selección exclusiva de representaciones](representaciones.md) antes de ejecutar el solver.
El [coordinador temporal](tiempo.md) reutiliza el adaptador sobre snapshots elaborados y espera
cada barrera DC. Importación/fabricación, transitorios y backend ESP32 siguen pendientes.

## Divisores medidos y comparación independiente

El fixture `divisorElectrico.ts` usa los paquetes reales de `resistor` y `fuente-regulable` del catálogo,
con hashes calculados de sus archivos. Una fuente alimenta dos divisores: 1 kΩ/1 kΩ y 1 kΩ/2 kΩ.
Se prueba también una envoltura adicional, preservando las rutas.

La referencia plana se escribe manualmente, sin derivarla del elaborador. Se comprueban:

- Salidas próximas a 2,5 V y 3,333 V (±5 mV), con coincidencia frente al plano a 8 decimales.
- Leyes independientes `VOUT = VIN/2` y `VOUT = 2·VIN/3`, y corrientes `VIN/2000` y `VIN/3000`.
- Cuatro resistores y cuatro redes, sin duplicar los compuestos como cargas.
- La fuente CV/CC existente tiene un pequeño offset por su recorte de diodos; por eso se mide
  VIN y se verifican las proporciones reales, sin modificar el solver para forzar 5 V exactos.

Las pruebas cubren además modificación de archivos/dependencias, límites, rutas, incompatibilidad de
pines/props, rechazo previo al solver, errores reales del modelo, aislamiento de variables globales
y retirada de medidas ante fallos/vacíos/no finitos. Archivo de pruebas:
`app/tests/unit/server/componentes/{paquetes,electrico}.test.ts`.

### Verificación del 20 de octubre de 2026

- Componentes: 62 tests correctos en cuatro archivos, incluidos 20 casos nuevos de paquetes/DC.
- Última suite completa, configuración normal (máximo dos workers): 1.804 correctos, 1 omitido;
  169 archivos correctos y 1 omitido; 200,46 s.
- Typechecks shared/server/web y modelos del catálogo, y build shared/server/web: correctos.
- Primera corrida con compilación concurrente: interrumpida tras fallos en ST7735/rendimiento.
  La repetición completa con un worker terminó con 1.803 correctos, 1 fallo ST7735 y 1 omitido.
  El archivo ST7735 pasó aislado tanto en la base `53e5721` como en la rama (13/13 en cada una),
  y la última corrida completa normal pasó. No se cambiaron esas pruebas, sus modelos o límites.
- E2E y hardware no ejecutados: no hay recorrido nuevo de UI ni firmware. La evidencia eléctrica
  proviene del ngspice que usa la aplicación, con paquetes reales y referencia plana independiente.

## Perfiles digitales

[El perfil digital](digital.md) solicita referencia física a los rieles de cada hoja y distingue
entradas indeterminadas de los valores numéricos que usa ngspice para converger. El modelo del
paquete sigue siendo el único propietario de los elementos de salida.
