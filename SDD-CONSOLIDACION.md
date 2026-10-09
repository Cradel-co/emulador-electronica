# SDD — Consolidación del emulador de electrónica

Fecha: 2026-10-08. Base analizada: `4744351` de `origin/main`.
Estado: etapas 1 y 2 implementadas y verificadas en ramas; etapas 3–6 pendientes.

## 1. Problema y resultado esperado

La plataforma ejecuta firmware, resuelve circuitos y expone resultados por UI, REST y MCP.
La evolución reciente agregó ADC, análisis transitorio, electrotérmica y audio, pero dejó
contratos antiguos en pruebas y documentación, además de fallas de build e importación.

El objetivo es que una instalación limpia pueda construir y verificar la aplicación,
importar módulos TypeScript y ejecutar compilaciones sin interferir con otros proyectos;
después, hacer coherentes las observaciones eléctricas y proteger los datos del usuario.
Cada etapa entrega un PR verificable; no depende de completar todo el plan para aportar valor.

## 2. Evidencia inicial y límites del diagnóstico

| Comprobación sobre la base | Resultado | Interpretación |
|---|---|---|
| `npm run build` | Falta `build` en `@emu/shared` | Defecto reproducido |
| Typecheck server/web, build web | Pasan | No implica frontend completamente estricto |
| Vitest con dos procesos | 1546 pasan, 1 omitido | Línea base reproducible; sockets locales necesarios |
| E2E Chrome | 126 pasan, 7 fallan, 13 omitidos | Se repitieron los siete fallidos |
| Repetición E2E | 1 pasa, 6 siguen fallando | Lección intermitente; seis escenarios requieren revisión |
| ZIP con `model.ts` | Se descarta el archivo | También afecta descarga de repositorios GitHub |
| Contenedores de proyectos distintos con placa `aux` | Mismo nombre | Identidad insuficiente; interrupción Docker inferida, no ejecutada |

Los fallos de Vitest bajo alta concurrencia desaparecieron con dos procesos. No se atribuyen
a física defectuosa. La campaña no validó hardware físico ni los E2E opcionales de ESP32/Docker.
Los resultados numéricos y las pruebas sintéticas no certifican fidelidad experimental.

## 3. Alcance y restricciones

- Todo código nuevo o modificado es TypeScript; conservar compatibilidad de módulos JS históricos.
- Mantener schemas y contratos propios; las bibliotecas se integran mediante adaptadores.
- No cambiar ecuaciones físicas para satisfacer expectativas antiguas de un test.
- No transformar un aviso de riesgo en una avería irreversible sin modelo temporal acreditado.
- No modificar proyectos personales; pruebas de persistencia e integración usan carpetas temporales.
- Cada refactor necesita caracterización previa y se separa de cambios de comportamiento.
- El agente abre PR; el merge corresponde al responsable del proyecto.

Fuera de esta consolidación: nuevos motores de CPU, nuevas familias de componentes,
cosimulación temporal completa, caracterización de laboratorio y despliegue multiusuario.
Se documentan como proyectos posteriores, no como requisitos ocultos de cierre.

## 4. Decisiones de diseño

### D1. Build del paquete compartido

`@emu/shared` exporta fuentes `.ts`; servidor y Vite las consumen directamente. Su build
verifica tipos con `tsc --noEmit`. No se introduce un segundo árbol de artefactos ni se
cambian exports para corregir un script ausente. La cadena existente shared → server → web
debe terminar en cero en una instalación Node 24 con `npm ci`.

### D2. Modelos TypeScript por todos los canales de importación

ZIP y GitHub admiten `.ts` con los mismos límites de archivo, suma descomprimida y cantidad
que los formatos existentes. La fuente se preserva al instalar. `compilarFuente` adapta el
TypeScript antes de validarlo en `SandboxModelo`; no se ejecuta fuera del sandbox.
Agregar `.ts` al filtro no autoriza archivos arbitrarios ni amplía los presupuestos.

### D3. Identidad de compilación Docker

La identidad depende del directorio de salida completo normalizado, no solamente de su
basename. El nombre lleva una etiqueta legible acotada y un digest SHA-256 truncado a 96 bits.
Es estable para reintentos/limpieza y distinto entre proyectos, placas y checkouts.
No es un mecanismo de autenticación ni una garantía matemática de ausencia de colisiones.
La limpieza sólo opera sobre el nombre de esa identidad. No se hace una limpieza global de
contenedores antiguos al migrar: podrían pertenecer a otro checkout aún activo.

### D4. Concurrencia de pruebas

Vitest limita por defecto a dos procesos y mantiene los plazos existentes. Un archivo puede
crear su worker ngspice/WASM; el número de CPUs disponibles no expresa presupuesto de memoria.
No se ocultan fallos con retries ni se aumentan timeouts. En una máquina con otro presupuesto,
los flags de Vitest permiten ajustar la concurrencia explícitamente.

### D5. Una observación eléctrica para cada consumidor

En la etapa 3, UI y MCP deben derivar conducción, alimentación y mediciones del mismo contrato
de análisis resuelto. Un GPIO alto no acredita corriente ni alimentación. Las lecturas incluirán
contexto de proyecto/placa y distinguirán válido, desconocido y no resuelto. No representar
una observación vieja como nueva después de cambiar corrida o topología.

### D6. Persistencia y confianza

En la etapa 4, los archivos se escriben en temporal del mismo directorio y se reemplazan por
rename tras éxito; se limpia el temporal ante fallo. La atomicidad se distinguirá de durabilidad
ante pérdida de energía. Las mutaciones de proyecto se serializan por proyecto, incluida su
lectura inicial. El control de versiones entre clientes y la migración de API deben diseñarse
explícitamente: serializar únicamente `save` no evita sobrescribir snapshots obsoletos.

El firmware existente se compara con una huella de referencia: una huella creada a partir del
primer download detecta corrupción posterior, pero no autentica el origen de ese primer archivo.
Una caché histórica sin huella requiere una política explícita, sin atribuirle verificación previa.
Las descargas se cortan durante lectura al superar el presupuesto, aunque no haya Content-Length.

## 5. Plan por etapas y condiciones de salida

| Etapa | Trabajo | Condición de salida | Dependencias |
|---|---|---|---|
| 1. Instalación e aislamiento | Build shared, ZIP TS, identidad Docker, concurrencia Vitest | Build/typechecks y suite general pasan; regresiones ZIP/GitHub y contenedores pasan | Base main; revisar PR #69 |
| 2. Pruebas de recorrido | Reconciliar seis E2E, aislar intermitencia de recarga | E2E estándar completos en verde sin omitir escenarios ni relajar assertions | Coordinar con PR #55 |
| 3. Observación eléctrica | Unificar `leer_pines`, ampliar `ver_proyecto`, contexto multiplaca | REST/UI/MCP coinciden en fixtures activos bajo, entre GPIO, sin energía y solver fallido | Contrato compartido y etapa 2 |
| 4. Datos y descargas | Escritura atómica, mutaciones serializadas, conflicto entre clientes, integridad firmware, descarga acotada | Pruebas de interrupción/concurrencia y límites pasan; política de caché documentada | Revisar cambios de ProjectStore en #55 |
| 5. Arquitectura y documentación | Extraer coordinación, migrar tipos por responsabilidad, reconciliar alcance | Caracterización sin cambios funcionales; módulos extraídos estrictos; docs trazables al código | Etapas 2–4 y SDD existentes |
| 6. Resultado del prototipado | Exportar circuito y medidas; UI para análisis físicos | Exportación completa legible, dominio/unidades/validez explícitos y pruebas visuales | Observación etapa 3; SDD específico de exportación |

No se prometen fechas sin medir las primeras entregas. El tamaño de un PR se decide por
responsabilidad y evidencia, no por agrupar todas las etapas en una rama larga.

## 6. Primera entrega: pruebas antes del arreglo

1. Ejecutar build en la base y registrar el error de script compartido ausente.
2. Añadir regresiones que importen un módulo con sintaxis TypeScript desde ZIP y GitHub
   usando fetch inyectado. Deben fallar porque falta el modelo, no por red o sintaxis inválida.
3. Añadir regresiones de identidad Docker: mismo id en proyectos distintos, placa adicional
   frente a proyecto homónimo, checkouts distintos, rutas equivalentes y nombre acotado válido.
4. Ver esas regresiones en rojo; aplicar cambios mínimos; repetirlas en verde.
5. Ejecutar `npm run build`, typecheck web y `npx vitest run` sin flags adicionales.
6. Typecheck server obligatorio antes de push; revisión del diff y PR con evidencia real.

La prueba de identidad acredita separación de nombres; no se declara un ensayo de Docker real.
El build se verifica por ejecución, sin añadir un test que copie el contenido de package.json.

## 7. Diseño de las verificaciones posteriores

### Recorridos E2E

- Catálogo: comprobar los módulos ofrecidos por el catálogo aislado y categorías; evitar un
  número histórico fijo como único oráculo.
- Avisos: activar una corrida o inyectar una instantánea eléctrica completa y resuelta con una
  carga sobreexigida. Una placa encendida con GPIO sin nivel informado no inventa HIGH.
- LED: verificar conducción y aviso de riesgo; no esperar humo/daño irreversible retirado.
- Render: proporcionar estado del solver consistente con el evento; medir mutaciones y
  comprobar que el LED realmente cambia. No validar sólo costo con una salida que nunca cambia.
- Recarga: conservar ruta/progreso y diagnosticar el timeout intermitente con trace y consola.

### MCP y física

Fixtures con corriente positiva en activo bajo, carga entre dos salidas, falta de alimentación,
entrada flotante, dos placas con el mismo GPIO y fallo del solver. Comparar el significado del
resultado entre REST y MCP, con tolerancias numéricas justificadas por fixture. Conservar
compatibilidad aditiva cuando sea posible; cualquier cambio de schema requiere migración.

### Persistencia y recursos

Inyectar fallo antes del rename y comprobar que queda el archivo anterior completo. Solapar
dos mutaciones y acreditar que ambas sobreviven. Un error debe liberar la cola del proyecto.
Lecturas de otro proyecto no deben quedar bloqueadas por esa cola. Probar integridad de caché
correcta, corrupta y sin huella; descargas chunked sin tamaño declarado y cancelación del stream.

### Modularización

Extraer inicialmente coordinación de corridas, observaciones y transporte del backend; en web,
guardado y sincronización. Mantener interfaces propias, captura de contexto y cancelación.
Habilitar strictness por módulo migrado; no convertir todo `app.ts` en un único cambio.

## 8. PR concurrentes y compatibilidad

Revisados el 2026-10-08:

- #69 (`chore/changelog-por-rama`): agrega CLI y regla de fragmentos; modifica la última entrada
  de scripts en app/package.json. Etapa 1 agrega scripts en shared/package.json, por lo que no
  necesita depender de su rama. Dejar un fragmento propio compatible con su formato.
- #55 (`codex/aprender-ruta`): cambios amplios de Aprender, ProjectStore, física y varios E2E.
  No duplicar los arreglos de tests que ya propone; revisar su diff y estado antes de etapa 2.
- #70 (`chore/revision-del-sonometro`): amplía pruebas del sonómetro. Etapa 1 no modifica esos
  archivos. No absorber sus cambios ni cerrar/mergear ninguno de estos PR.

Si una etapa necesita trabajo aún abierto, se crea una rama dependiente y un PR con base explícita,
o se espera su integración. Revalidar las dependencias al comenzar cada etapa.

## 9. Riesgos y políticas de operación

La app sigue siendo local y con una corrida de proyecto compartida; varias placas no significan
sesiones multiusuario aisladas. Host/Origin no autentican a un cliente que use HTTP directo.
Exponer por LAN requiere decidir autenticación/HTTPS y autorización de operaciones en un SDD
propio. No introducir una configuración pública como efecto secundario de consolidación.

Los modelos `vm` y límites de V8 no ofrecen aislamiento de sistema operativo ni una cuota total
de memoria externa WASM. Mantener presupuestos y distinguir bloqueo del hilo, CPU y memoria.
Una mejora de fidelidad debe declarar dominio y procedencia de parámetros, además de pruebas.

## 10. Seguimiento

| Entrega | Estado | Evidencia |
|---|---|---|
| SDD y revisión de dependencias | Redactado | Diagnóstico y PR #55/#69/#70 |
| Regresiones iniciales | En rojo antes del arreglo | 6 fallan y 66 pasan en pruebas focalizadas |
| Etapa 1 | Implementada; pendiente de revisión/merge | 72 pruebas focalizadas; 1552 pasan y 1 omitida en `npx vitest run`; build general y typechecks server/web pasan |
| Etapa 2 | Implementada; pendiente de revisión/merge | E2E: 133 pasan, 13 omisiones existentes; recarga Aprender 3/3; Vitest: 1552 pasan, 1 omitida; build/typechecks pasan |
| Etapas 3–6 | Pendientes | No declarar realizadas por completar este documento |

La suite final se ejecutó sin flags de concurrencia, con la configuración nueva de dos procesos.
Las seis regresiones nuevas pasaron después de fallar en la base. Las pruebas TCP se ejecutaron
con sockets locales habilitados. En la etapa 1 no se repitió E2E porque no cambiaba UI; la etapa 2 ejecutó la suite completa.

### Segunda entrega: contratos E2E y refresco físico

Se revisó el diff de PR #55 antes de modificar los E2E compartidos. Sus cambios de selectores
no resuelven las expectativas eléctricas antiguas; esta entrega conserva los selectores de
la base y modifica esas expectativas. La rama parte de la etapa 1 y su PR usa esa rama como base.

El catálogo se contrasta por cantidad e identidad con la API. Conectar USB sin ejecutar
firmware no debe inventar HIGH. La fixture declara dirección y nivel de GPIO7, calcula las
corrientes/tensiones con `analizarCircuito` y adapta esa observación a `/pins`; no compila ni
sustituye los ensayos de firmware real. Ohm y Problemas conservan sus escenarios activos.
El riesgo de sobrecorriente se prueba con conducción, apagado y encendido posterior, sin
atribuir daño permanente a una instantánea DC.

La nueva regresión de render falló correctamente antes del arreglo: encendía el LED pero
creaba 724 nodos. `refrescarAvisos` y la rama de eventos eléctricos reconstruían el dibujo.
Ahora el lienzo aplica estados visibles, clases y títulos de pines en los nodos existentes.
Si cambia la estructura visual de un corto o de una quemadura heredada, conserva el render
completo. La prueba grande usa 100 LEDs, un GPIO conectado y 40 cambios de nivel calculados,
verificando que realmente prende/apaga y que no crea ni quita nodos. En verde conservó
5251 nodos durante los 40 pulsos. La suite estándar terminó con 133 aprobadas y las mismas
13 omisiones condicionales preexistentes (firmware/Docker); no se añadieron skips ni retries.
Aprender pasó en la suite general y en tres repeticiones de recarga. La intermitencia anterior
no se reprodujo; esas ejecuciones no prueban ausencia de intermitencias bajo toda carga.
Vitest volvió a dar 1552 aprobadas y 1 omitida; build y typechecks server/web pasan.

Referencias: [CLAUDE.md](CLAUDE.md), [arquitectura web](docs/arquitectura-web.md),
[perfiles físicos](docs/PERFILES-FISICOS.md), [análisis temporal](docs/ANALISIS-TEMPORAL-Y-EVIDENCIA.md),
[plan de fidelidad](docs/PLAN-FIDELIDAD-FISICA.md), [módulos](SDD-MODULOS.md).
