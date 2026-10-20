# Selección exclusiva de representaciones

El piloto DC admite dos alternativas completas por componente compuesto: su esquema `interno`
y una definición `equivalente` fijada por versión y SHA-256. La elegida es dueña de **todos** los
efectos del componente para esa consulta. No se combinan partes de ambas ni se ejecuta el interior
como observador. Así se evita duplicar corriente, consumo o primitivas, incluso si VOUT no cambia.

```ts
// Campo opcional de una definición tipo compuesto:
representaciones: {
  equivalente: referenciaDelModelo,
  predeterminada: 'interno', // o 'equivalente'
}
// Opciones de elaborarComponente / analizarGrafoDc:
{ representaciones: [
  { ruta: ['izquierda'], seleccion: 'equivalente' },
  { ruta: ['derecha'], seleccion: 'interno' },
] }
```

Las rutas son arrays estructurales; `[]` selecciona la raíz. La opción reemplaza el valor
predeterminado solo para esa instancia. Sin el campo opcional, las definiciones conservan su
comportamiento y hash anteriores. La selección forma parte de la entrada explícita de cada
consulta; todavía no se guarda en Project ni hay un selector en el editor.

## Validación y trazabilidad

- El catálogo comprueba todas las referencias, hashes, ciclos y presupuestos, incluidas las
  alternativas inactivas. No ejecuta sus paquetes.
- El equivalente debe tener exactamente los mismos puertos (identidad, dominio, dirección y ancho)
  y contratos de parámetros (defaults, unidades y restricciones). El orden de puertos no importa.
- Un equivalente puede ser hoja o compuesto, pero no seleccionar otra alternativa en su propia
  raíz: no hay dos decisiones para una misma ruta. Sus hijos sí pueden ofrecer alternativas.
- La elaboración sustituye la definición en la misma ruta pública **antes** de crear terminales,
  recorrer hijos o cargar modelos. Solo el árbol activo consume el presupuesto de elaboración.
- `InstanciaElaborada.representacion` registra selección y referencia del componente original;
  `definicion` registra la implementación efectiva. Los errores de paquete conservan esa ruta.
- Rutas duplicadas, inexistentes, sin alternativas o bajo un árbol inactivo fallan; no se ignoran.
  Tampoco existe la selección `ambos`. Un modelo seleccionado inválido no usa el otro como fallback.

Consultar o expandir una copia de la definición para inspeccionarla no modifica la selección.
Cada análisis DC crea un grafo y sandboxes nuevos. No hay cambio en caliente ni transferencia de
estado. El catálogo garantiza compatibilidad estructural, **no** demuestra equivalencia física
arbitraria: cada alternativa necesita evidencia para su rango de uso.

## Evidencia y alcance

`representaciones.test.ts` cubre decisiones, identidad, interfaces, hashes, dependencias y ciclos.
`electrico.test.ts` contrasta dos divisores alimentados, de 1 kΩ/1 kΩ y 1 kΩ/2 kΩ: un modelo TS
único de tres terminales puede reemplazar las dos hojas internas, en una o ambas instancias.
Con el solver real se comparan salidas, elementos, corriente de alimentación y potencia contra
la representación interna. Otro caso alterna hojas equivalentes dentro de los divisores.
Se comprueba además que un paquete seleccionado alterado falla sin volver al interior.

Esto implementa una parte de P2. La cobertura parcial por dominio, modelos complementarios,
agenda temporal, eventos/IRQ/radio y validación de energía en transiciones siguen pendientes.
La exclusión es total por componente; no se atribuye ejecución funcional a esos dominios todavía.

## Verificación de esta iteración

- Regresiones iniciales ejecutadas antes de implementar: el contrato rechazó el campo nuevo.
- 74 pruebas de componentes en la suite final (contratos, elaboración, paquetes, DC y selección).
- Suite completa: **1816 correctas, 1 omitida**, 170 archivos correctos y 1 omitido, 251,75 s.
- Build de shared/server/web y comprobación de tipos del servidor correctos.
- Sin E2E ni hardware; esta API todavía no tiene integración con el editor.
