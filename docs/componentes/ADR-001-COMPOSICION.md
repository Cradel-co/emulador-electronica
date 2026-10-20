# ADR-001: identidad y fuente de verdad de componentes jerárquicos

Estado: contratos P1 y primera integración DC implementados bajo pruebas; selección exclusiva implementada; editor pendiente.
Fecha: 20 de octubre de 2026. Alcance: plataforma común, independiente de ESP32.

## Decisión

La definición versionada contiene puertos y una implementación: hoja legada o compuesto. El
compuesto contiene instancias y redes con referencias estructuradas. La netlist del solver, el
grafo elaborado, el layout y los formatos de fabricación se derivan y no son esquemas eléctricos
editables en paralelo. El contrato inicial se implementa en `app/shared/src/componentes/contratos.ts`.

### Identidad, paquetes y versiones

- IDs locales estables de instancia/definición, distintos del nombre visible y del layout.
- Referencia a definición = ID + versión exacta `major.minor.patch` + SHA-256 de contenido.
  Nunca `latest` ni rangos. Renombrar una etiqueta no crea una nueva instancia.
- Identidad de terminal = ruta de IDs como array + ID de puerto. Para serializar una clave se
  usa una tupla JSON; no puntos ni barras ambiguas. No reemplazar `board.GPIO6` legado de golpe.
- Una versión publicada con un digest distinto se rechaza. El resolver verifica el digest y
  conserva paquetes necesarios para reproducir proyectos anteriores.
- Digest de paquete legado: descriptor canónico, fuente exacta del modelo y comportamiento de
  chips referidos, SVG y pruebas si existen; dependencias por hash. Definir canonicalización JSON
  con claves ordenadas y arrays en orden original en el resolver P1; las fuentes se hashean como
  bytes exactos. No usar solo `type`, mtime o el código compilado por una versión de esbuild.
- SHA-256 demuestra identidad, no confianza ni seguridad. El sandbox y los límites siguen aplicando.

### Instancias, puertos y redes

- Dos hijos pueden referir la misma definición, pero nunca comparten estado mutable.
- `parametros` de instancia son overrides de valores declarados por la hoja/definición. El contrato
  ahora declara defaults de número/texto/booleano y rangos; el elaborador valida claves y valores.
  Un hijo puede vincular un valor a un parámetro declarado por el padre sin evaluar expresiones.
  El futuro adaptador de hojas debe contrastar esas declaraciones con el descriptor legado.
- Terminal eléctrico: escalar bidireccional. Dirección de drive, pull y estado los determina el
  modelo en ejecución; no se confunden con la flecha gráfica de un conector.
- Lógico/IRQ/reloj/transacción/radio son dominios distintos. P1 valida compatibilidad completa y
  P2 define adaptadores; no convertir una transacción en cable por compartir nombre.
- Una red contiene dos o más terminales; un terminal pertenece a una única red. La UI fusiona redes
  explícitamente al unirlas. Terminal ausente de todas las redes está abierto: no es un error automático.
- El mapeo de puertos de un compuesto se expresa en esas mismas redes mediante terminales externos.
  No hay otra tabla de mapeo editable que pueda contradecirlas.
- GND no es global por nombre. Globales y adaptadores entre dominios no entran en la versión inicial;
  deben declararse como futuras capacidades, nunca inferirse.

### Adaptación de legado y persistencia

La hoja legada referencia un módulo por ID y hash de paquete, y expone sus pines. El adaptador P1
validará la correspondencia con `ModuleDef`. Conserva `modeloDe`, primitivas, observación, reglas y
datos de fabricación actuales. No trata `discreto` como una composición ejecutable automática.

Los archivos actuales del catálogo permanecen como fuente para hojas legadas. Para un nuevo
compuesto, su definición es la fuente de conexiones internas. No se ejecutan simultáneamente el
modelo eléctrico legado completo y las piezas internas que lo sustituyen; la selección de
representación inicia P2. El contrato fue ampliado con alternativas completas y exclusivas;
ver [selección de representaciones](representaciones.md).

No se añade todavía ningún campo a `ProjectSchema`: Zod puede eliminar campos desconocidos y un
cliente antiguo podría perder la composición al guardar. P3 debe definir formato nuevo/migración y
rechazo de escrituras incompatibles. La selección de variantes debe fijar versiones y guardar todo
lo necesario en una única transacción mediante cola/revisión/escritura atómica existentes.

Una edición local crea una variante; una edición compartida publica una nueva versión. Antes de
propagarla se muestra qué instancias se actualizan. Layout, código y artefactos de firmware siguen
sus identidades existentes; no se incluyen en una red eléctrica por estar en la misma hoja.

### Validación por capas

1. Contrato añadido: formato estricto, límites por definición, IDs únicos, terminales locales
   existentes y pertenencia a una sola red.
2. Resolver P1: dependencias/digests, puertos hijos, parámetros, compatibilidad, ciclos y presupuestos
   globales. Recorrido determinista con pila activa para detectar ciclos; reutilizar una definición
   en ramas distintas es válido y no debe producir un falso ciclo.
3. Elaboración P1/P2: asignación de IDs de ejecución y mapa de origen; generación de conectividad
   antes de producir primitivas. Mantener la procedencia al transformar nombres SPICE.
4. Ejecución P2: propiedad de efectos, límites temporales y resultados con validez.

El primer esquema tiene nombre `schemaVersion: 1` para definiciones, independiente de la versión
de proyecto. Cambios incompatibles en el contrato requieren su propia versión de formato; la
versión del componente identifica revisiones de contenido, no el parser.

## Consecuencias y aceptación pendiente

El contrato puede usarse en tooling sin importar servidor, archivos o ESP32. No habilita aún
simulación jerárquica, certificación de módulos ni editor. Se requieren las pruebas del corpus
J01–J08 en sus etapas correspondientes; typecheck solo valida consistencia de tipos.

La elaboración en memoria resuelve dos copias del divisor J02 con identidad independiente,
errores de referencia y mapa de origen. La [integración DC](electrico.md) verifica paquetes legados
y compara las medidas con el circuito plano usando el motor existente. No cambia proyectos guardados.
Almacén persistente de versiones, estado dinámico y cobertura parcial por dominio siguen pendientes. API,
normalización de hashes y límites se describen en [elaboracion.md](elaboracion.md) y [electrico.md](electrico.md).

## Agenda común inicial de P2

[La agenda](tiempo.md) vive en shared, sin dependencia del solver o del servidor. El coordinador
reutiliza el grafo activo y el adaptador DC: tiempo entero, fases, generaciones y barreras
asíncronas. No se promete transitorio analógico ni ejecución de CPU/IRQ todavía.

## Perfiles digitales y ciclo de vida

La hoja declara umbrales, alimentación/reset y parámetros de salida. La agenda controla esos
parámetros y consume lecturas del solver; el paquete conserva el único modelo eléctrico del driver.
Las transiciones cancelan generaciones y recrean estado por instancia. Ver [contrato y límites](digital.md).
