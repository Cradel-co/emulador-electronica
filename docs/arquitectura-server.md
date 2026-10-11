# Arquitectura del server

El server es un **monolito modular**. Un solo proceso coordina la API HTTP, WebSocket, proyectos,
compilación, emulación y simulación eléctrica. Las carpetas de `app/server/src/` agrupan capacidades
del dominio (`bus/`, `camera/`, `debug/`, `rf/`, `sim/`, `sonido/`, `toolchains/` y `engines/`). No
se separa en servicios independientes mientras esos límites no necesiten despliegue o escalado
propio.

## Dirección de dependencias

Las dependencias avanzan desde los adaptadores hacia las capacidades del server:

```text
HTTP / WebSocket / CLI
          ↓
Rutas y adaptadores
          ↓
Casos de uso y coordinación
          ↓
Dominio y contratos de shared
```

Filesystem, Fastify, procesos externos, motores y toolchains son detalles de infraestructura. Se
conectan desde el arranque o se pasan a los casos de uso; las reglas del dominio no deben depender
de handlers HTTP ni de estado interno de una biblioteca.

## Reglas para cambios nuevos

- Agrupar archivos por capacidad del dominio cuando comparten vocabulario y cambian juntos. No crear
  carpetas por cada archivo ni mover código solo para que el árbol quede simétrico.
- Mantener las rutas en `routes/` o junto a la capacidad cuando sean específicas de ella. Un módulo
  de rutas registra endpoints y valida/transforma la entrada HTTP; delega el trabajo a servicios o
  funciones recibidos por una interfaz explícita.
- No importar `index.ts` desde otros módulos. El punto de entrada compone implementaciones y
  dependencias; no debe ser una biblioteca compartida.
- Evitar singletons mutables nuevos. Si una capacidad necesita estado de vida del server, agruparlo
  en una instancia y pasarla explícitamente a quienes la usan.
- Mantener los contratos compartidos del producto en `app/shared`; no duplicar esquemas de API en
  rutas ni filtrar tipos de infraestructura a `shared`.
- Mantener las pruebas fuera de `src`, bajo `app/tests/unit/server/`, en la subcarpeta que refleje el
  área probada. Los fixtures exclusivos de pruebas van en `app/tests/fixtures/`.

## Estado y migración

`app/server/src/index.ts` todavía conserva estado del proceso, casos de uso y parte del registro de
rutas. `bootstrap.ts` ya concentra la creación de Fastify y su ciclo de vida; la coordinación de
ejecución y emulación sigue en el punto de composición y es el siguiente límite por aclarar. Los
casos de uso de crear proyectos y agregar placas ya viven en `application/proyectos.ts`. La migración
se hace por capacidad: cada extracción preserva contratos HTTP y WebSocket y se mantiene acotada
para que el cambio sea revisable.

Hoy `routes/boards.ts`, `routes/modules.ts` y `routes/mcp.ts` registran sus rutas y reciben sus
dependencias desde el punto de composición. `camera/`, `debug/`, `bus/` y `sonido/` conservan sus
registradores al lado de cada capacidad. `application/proyectos.ts` recibe almacenamiento,
catálogo, selección de toolchain y control del circuito por dependencias. `bootstrap.ts` recibe
callbacks explícitos para inicializar, registrar rutas, adjuntar WebSocket, calentar el motor y
cerrar recursos. Esta combinación es válida durante la migración; no hace falta trasladar todo de
una vez.
