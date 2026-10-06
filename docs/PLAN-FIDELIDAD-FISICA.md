# Plan de fidelidad física verificable

Fecha: **4 de octubre de 2026**. Documento de planificación y contrato de aceptación; **no certificación física del emulador**.

Base: [auditoría de fidelidad](../AUDITORIA-FIDELIDAD-ELECTRONICA.md), instantánea `feat/tanstack-router` / `9f5dcf2` con los cambios locales descritos allí; [convenciones](../CLAUDE.md), [motor eléctrico](motor-electrico.md), [SDK de módulos](modulos-y-su-codigo.md) y código/pruebas citados abajo. Las matrices conservan la base auditada y los requisitos completos. Los **§11 y §12 registran las correcciones posteriores y su evidencia**, sin dar por implementado un fenómeno ausente. Para el estado de la entrega actual prevalece el §12 sobre el diagnóstico histórico de las matrices. La caracterización de laboratorio sigue pendiente.

## 1. Objetivo y reglas de confianza

La meta es reproducir fenómenos identificados dentro de condiciones explícitas y comprobarlos con referencias independientes. No existe una promesa de equivalencia absoluta con cualquier circuito real ni un porcentaje global de fidelidad. Cada ampliación debe decir qué magnitudes y condiciones valida y qué fenómenos siguen fuera de alcance.

Reglas obligatorias de producto:

1. Una tensión o corriente numéricamente calculada no se publica como válida si faltan vectores, hay valores no finitos, el modelo relevante está ausente, el análisis no representa el fenómeno solicitado o la solución no cumple sus controles de consistencia.
2. `0`, `false`, `ok` y `sin problemas` son resultados, no reemplazos de datos ausentes. La referencia deliberada de 0 V se identifica; un nodo desconocido conserva ese estado.
3. El modo funcional puede entregar registros o tramas para probar firmware, pero no presentar esas respuestas como validación eléctrica. Una inyección de GPIO es un estímulo externo explícito, no una tensión medida.
4. Un resultado DC no valida flancos, PWM, carga/descarga, energía transitoria, ruido, propagación ni daño acumulado. El motor debe rechazar una solicitud física no soportada o publicarla como no válida para esa solicitud.
5. Un máximo absoluto violado se informa como violación de especificación. No demuestra destrucción instantánea ni predice el modo de avería.
6. UI, API, MCP y firmware consumen el mismo estado autoritativo y sus etiquetas de validez. No fabricar una medida viva a partir de escenarios hipotéticos.
7. La comparación entre dos solvers es evidencia de consistencia de ecuaciones; no sustituye curvas del componente ni medición de hardware.
8. Las tolerancias se justifican por caso y por fuente. Si no existe presupuesto de error o especificación aplicable, se declara **criterio cuantitativo pendiente** y no se acredita fidelidad física.

La falta de un modelo puede invalidar una isla afectada sin invalidar otra eléctricamente independiente, **solo si la independencia y el ámbito del diagnóstico están demostrados**. Hasta contar con ese análisis de impacto, degradar la solicitud completa y evitar veredictos globales favorables.

## 2. Estados, evidencia y aceptación

### 2.1 Dos ejes independientes

| Estado del fenómeno en la base | Significado |
|---|---|
| Implementado | Existe representación en el camino activo examinado. No acredita parámetros ni todas las condiciones. |
| Aproximado | Existe un equivalente o simplificación con dominio limitado. |
| Ausente | El camino activo no representa el fenómeno. |
| No acreditado | Puede haber mecanismos parciales; falta verificar la ruta completa que se pretende afirmar. |

| Estado de trabajo | Condición para usarlo |
|---|---|
| Pendiente | No hay entrega verificada. Un diseño o test propuesto permanece pendiente. |
| En progreso | Hay trabajo explícitamente abierto; sin declaración de cierre. |
| Implementado, pendiente de ejecución | Cambio presente, sin evidencia de pruebas registrada. |
| Verificado por software | Reproducción, regresiones y controles pasaron con versiones/condiciones registradas. |
| Caracterizado en laboratorio | Medición física con hardware identificado e incertidumbre documentada, dentro del dominio declarado. |
| Fuera de alcance | No se pretende simularlo en la versión/perfil publicado. No significa que sea físicamente irrelevante. |

El estado de trabajo no mejora automáticamente el estado de evidencia. `Verificado por software` no se renombra `Caracterizado en laboratorio` porque pasen más tests.

### 2.2 Criterios existentes, sin ampliar su significado

En las matrices, los códigos siguientes son una abreviatura. No son especificaciones de hardware:

- **C-DC**: el helper actual de `sim/motor.test.ts` exige, por nodo, `abs(ΣI) < 10⁻³·Σabs(I) + 10⁻⁶ A`; y en DC `abs(ΣP) < 10⁻³·Σabs(P) + 10⁻⁹ W`. Es presupuesto de regresión vigente, no precisión de un multímetro ni tolerancia de un resistor. Al llevarlo a producción se deben contabilizar fuentes internas, ramas de medida y regularización, o justificar el residuo excluido.
- **C-MNA**: `sim/comparacion.test.ts` compara redes resistivas con diferencia menor que `max(1 µA, 0,5 %·abs(I_ngspice))`. El 10 % allí aplicado a LEDs compara dos aproximaciones diferentes; **no es un criterio de exactitud del LED físico**.
- **C-EXACTO**: igualdad de identidades, estados discretos o información estructural, cuando el contrato es exacto: alias del mismo pad, ningún vector faltante admitido como cero, orden de eventos y valores de registros especificados. Los números continuos usan su presupuesto aparte.
- **C-HOJA**: comprobar el requisito mínimo/máximo y sus condiciones de tensión, temperatura, revisión, carga y frecuencia de la fuente primaria concreta. No sustituir un valor típico por un límite garantizado.
- **C-CONVERGENCIA**: establecer error absoluto/relativo y paso mediante fórmula independiente y refinamiento de resolución; registrar parámetros. Los umbrales nuevos están **pendientes de aprobación técnica basada en resultados**, no inventados en este plan.
- **C-LAB**: presupuesto separado de incertidumbre de instrumentos, montaje, componentes y modelo; decidir aceptación antes de contrastar la muestra reservada de validación. La guía [JCGM 100:2008 / GUM](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf) es la referencia para evaluar incertidumbre; no proporciona un porcentaje universal de aceptación.

### 2.3 Evidencia heredada y evidencia de esta entrega

La auditoría registra 90 pruebas eléctricas y 214 de firmware/buses, **304 en total**, además de reproducciones adversariales. Son resultados de aquella ejecución y no prueba de que F01–F06 ya estén corregidos. Los totales históricos de `motor-electrico.md` no son el baseline actual.

El plan inicial se elaboró por lectura y contraste documental. La ejecución de las correcciones se registra por separado en §11, sin sustituir ese historial. **No se ejecutaron mediciones de laboratorio**; ningún resultado automatizado acredita por sí solo la correspondencia con una placa física.

## 3. Matriz de leyes, fenómenos y contratos

Los IDs V01–V54 referencian los casos del §9 de la auditoría. Los tests propuestos son entregables pendientes; no se afirma que existan salvo que se indique un archivo actual. Las ecuaciones son el modelo de referencia bajo las condiciones de la fila, no permiso para aplicarlas fuera de ellas. Todas las filas requieren también validación de datos, unidades, polaridad y condiciones iniciales.

### 3.1 DC, topología y conservación

| Ley / ecuación | Condiciones | Evidencia actual | Oráculo y criterio | Test existente o propuesto; pendiente |
|---|---|---|---|---|
| Ohm: `V=RI` | R lineal, valor conocido, DC, sin calentamiento significativo | Implementado: primitivas R del netlist | Fórmula independiente, C-DC, C-MNA; C-LAB pendiente | Actual `sim/motor.test.ts`, `sim/comparacion.test.ts`; V01, V06, barrido de alta impedancia pendiente |
| Serie/paralelo: `Rserie=ΣR`; `1/Rpar=Σ1/R` | Conectividad real y terminales normalizados; no derivaciones ocultas | Implementado para redes resistivas | Reducción analítica y sistema nodal separado; C-DC | Actual motor/comparación; V01–V03, permutaciones V51/V52 pendientes como contrato general |
| Kirchhoff de corrientes: `ΣI_nodo=0` | Contabilizar todas las ramas, incluido suministro y fugas numéricas | Comprobado en tests; control obligatorio en resultado pendiente | C-DC con residuo y escala publicados; ningún resultado parcial admitido | Actual helper de motor; V49 y control runtime F03 en progreso |
| Kirchhoff de tensiones: `ΣV_malla=0` | Circuitos concentrados; sin flujo externo no representado | Implementado por potencial nodal | Mallas independientes y diferencias de terminales; C-CONVERGENCIA específico pendiente | Actual casos de fuentes/puentes; V04/V07; invariantes de malla sistemáticos pendientes |
| Potencia/Joule: `P=VI=I²R=V²/R` | Convención pasiva y R lineal; es potencia, no temperatura | Implementado DC | C-DC; inversión de fuente/terminales conserva física y cambia signo coherentemente | Actual motor/regulador; V04/V18; disipación por elemento y referencia de isla pendientes |
| Balance DC: `ΣP=0` | Todos los elementos de la red contabilizados; no confundir DC con energía acumulada | Comprobado en pruebas | C-DC; detectar omisión de carga/modelo antes de aceptar balance | Actual motor/regulador; V48/V49 pendientes como rechazo de resultado |
| Thévenin/Norton: `V=Vth−Rth·I`; `In=Vth/Rth` | Red lineal y fuentes dentro de su dominio; puerto identificado | Parcial: fuentes más R y MNA | Resolver `Voc`, corriente de corto admisible y varias cargas con cálculo independiente | V02/V05/V17; suite explícita de equivalencias pendiente |
| Superposición / Millman | Solo red lineal; no LED, CC ni dropout | Implementado en subconjunto resistivo | Solver Gauss independiente; C-MNA para casos cubiertos | Actual motor; V03–V05, contraste con fuente absorbente pendiente |
| Referencia/alias: `V(alias_a)=V(alias_b)` | Mismo pad físico; GND solo común si está unido | Alias GPIO defectuoso en base; referencias locales parciales | C-EXACTO para mismo nodo; diferencias internas invariantes al cambiar referencia | Actual `sim/multiplaca.test.ts`; V07/V08/V51/V52; F04 en progreso |
| Flotación: ausencia de referencia DC física | C abierta en `.op`; R hacia nodo suelto no fija entrada | F02 reproducido; regularización puede fijar un número artificial | Clasificación `unknown/flotante`, no 0 válido; demostrar camino e impedancia que fija nodo | V09/V10; F02 en progreso. Fuga de modelo y regularización requieren metadatos distintos |

### 3.2 AC, transitorios, almacenamiento y ruido

El adaptador activo genera `.op`. ngspice dispone de otros análisis, pero su disponibilidad en el motor upstream no acredita integración en esta aplicación. Los modos se definen en [manual oficial ngspice](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf); registrar la versión WASM efectiva antes de usar opciones de un manual de desarrollo.

| Ley / ecuación | Condiciones | Evidencia actual | Oráculo y criterio | Test existente o propuesto; pendiente |
|---|---|---|---|---|
| Capacitor: `i=C·dv/dt`; `Ec=Cv²/2` | C lineal, condición inicial y tiempo físico | Ausente temporalmente; C aparece abierta en DC | Derivación/integración independiente, conservación de energía y C-CONVERGENCIA | V29; `transitorio-rc` propuesto, pendiente |
| Inductor: `v=L·di/dt`; `El=Li²/2` | L lineal; continuidad de corriente salvo impulso ideal identificado | Ausente temporalmente; relé no representa bobina dinámica | RL analítico, balance energía almacenada/disipada, C-CONVERGENCIA | V30; `transitorio-rl` propuesto, pendiente |
| RC escalón: `v(t)=vf+(v0−vf)e^(−t/RC)` | Fuente/R/C lineales y carga definida | Ausente | Fórmula analítica en varios tiempos; refinamiento de paso, C-CONVERGENCIA | V29; carga/descarga y condición inicial distinta de cero pendientes |
| RL/RLC: `τ=L/R`; `ω0=1/√(LC)` | Topología correspondiente; pérdidas y régimen sub/sobre/crítico explicitados | Ausente | Solución diferencial independiente; fase, amplitud y amortiguamiento, no solo valor final | V30/V31; oscilación, estabilidad y paso máximo pendientes |
| AC: `Zr=R`; `Zc=1/(jωC)`; `Zl=jωL` | Régimen senoidal; pequeños incrementos en punto de operación para no lineales | Ausente en camino activo | Fasores analíticos y barrido externo; C-CONVERGENCIA | Filtros RC/RLC en `ac` propuesto, pendiente; no reutilizar transitorio como evidencia sin comparación |
| PWM: `Vmedio=D·V`; `Vrms=V·√D` | Pulso ideal 0/V, periodo y carga especificados; RMS para potencia resistiva | F08: flancos pueden perderse; integración de energía no acreditada | Traza de eventos independiente; área y RMS por ciclo; tiempos exactos en reloj simulado | V32/V33; evento corto interplaca y distintas fases pendientes |
| Rebote | Secuencia temporal de contacto, Ron/Roff y semilla/perfil identificados | Ausente; switch ideal en estado estático | Traza prescrita y respuesta del debounce; C-EXACTO temporal más error de integración | V34; perfil determinista y caída de contacto pendientes |
| Flyback: `v=L·di/dt`; energía inicial `Li²/2` | L, diodo/clamp y parasitismos de circuito concreto | Ausente: relé tiene equivalente resistivo | Solución RL/clamp y netlist externo; no imponer una tensión máxima sin parasitismos. [TI cargas inductivas](https://www.ti.com/document-viewer/lit/html/SNVAA45) | V30; corte con/sin diodo y corriente sostenida pendientes |
| Johnson: `Sv=4kTR`; shot ideal: `Si=2qI` | Densidad espectral unilateral; temperatura/banda/modelo aplicables | Ausente en red; ruido de chips es otra capa | PSD/banda independientes, estadística con semilla y presupuesto; no comparar una muestra aislada | V54; análisis `.noise` e integración en banda pendientes. [Vishay resistencias](https://www.vishay.com/docs/28771/basics.pdf) respalda ruido y límites del resistor, no un modelo universal de todo semiconductor |

### 3.3 Semiconductores, pads y conversión analógica

| Ley / ecuación | Condiciones | Evidencia actual | Oráculo y criterio | Test existente o propuesto; pendiente |
|---|---|---|---|---|
| Diodo Shockley: `I=Is·(e^(V/(n·Vt))−1)` | Región y temperatura válidas; R serie y ruptura se modelan aparte | LED aproximado IS/N/RS/BV, ajuste a Vf nominal | Curva I/V del número de parte y modelo externo; C-HOJA, C-LAB pendiente; 10 % de C-MNA no certifica curva | Actual motor/comparación; V26. [Vishay VLWR9632](https://www.vishay.com/docs/81818/vlwr9632.pdf) ejemplifica límites particulares, no identifica el LED del catálogo |
| BJT: `Ic≈βIb` en región activa | β dependiente de I/T; saturación, corte y carga almacenada aparte | Ausente como primitiva pública directa | Curvas y modelo de parte concreto; C-HOJA/C-CONVERGENCIA | Modelo `bjt` propuesto; pendientes SDK, regiones, conmutación y validación |
| MOSFET: relación `Id=f(Vgs,Vds,T)` | Región, cuerpo, capacitancias, SOA y modelo concreto | Ausente como primitiva pública directa | Modelo fabricante frente curvas de parte; no validar usando solo ley cuadrática ideal | Modelo `mosfet` propuesto; pendiente selección de familia y soporte de subcircuitos |
| GPIO push-pull: `I≈(Vrail−Vpad)/Rout` o `Vpad/Rout` | Equivalente DC; dirección/source/sink/drive identificados | Aproximado R simétrica; contención DC parcial | Curvas por pad y drive, C-HOJA; no interpretar corriente típica como rotura | Actual motor/multiplaca; V11–V13. [ESP32-S3 §5.4](https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf) distingue condiciones source/sink |
| Open-drain: alto libera; bajo conduce | Pull y clamps separados; alto no es fuente al riel | F06 confirmado; scanner actual pierde modo | C-EXACTO de topología/modo; con pull cálculo Ohm; sin pull unknown | V14; F06 en progreso; prueba runtime adicional F07 pendiente |
| VIL/VIH y Schmitt | VDD, pin, temperatura, pad y umbrales garantizados concretos | Parcial; último bit retenido no acredita histéresis física | C-HOJA; franja no garantizada→unknown; Schmitt solo si hay umbrales de transición caracterizados | V10/V16. [TI Schmitt](https://www.ti.com/lit/an/scea046/scea046.pdf); pruebas de flancos lentos/metastabilidad pendientes |
| Clamps / inyección / back-power | Riel y chip apagado; diodo real y límites de inyección | Parcial DC; latch-up y daño ausentes | Curvas y máximos concretos; balance de corriente por riel | Actual motor; V15; validación por MCU y secuencias de encendido pendiente |
| ADC ideal: cuenta≈cuantización de `Vin/Vref` | Transferencia/rango/resolución del chip; extremos y saturación según hoja | AVRADC instanciado; nodo eléctrico→ADC no integrado | Divisor conocido→tensión→cuenta, Vref elegida; C-HOJA y cuantización correspondiente | V35; puente ADC propuesto y pendiente. No declarar ADC válido por existir clase AVRADC |
| ADC adquisición: `vsettle=vf+(v0−vf)e^(−t/(Rsource·Csample))` | Equivalente sample-and-hold aplicable; multiplexado y carga inicial | Ausente | Modelo particular más experimento; C-HOJA/C-LAB, parámetros pendientes | V36. [TI ADC Source Impedance](https://www.ti.com/lit/an/spna061/spna061.pdf) ilustra adquisición, no identifica el ADC ESP/AVR |
| DAC/salida analógica | Transferencia cuantizada, impedancia y settling concretos | Ausente en SDK eléctrico actual | Curva estática/dinámica de parte; errores offset/gain/INL según hoja | Puente DAC propuesto, pendiente; no confundir PWM sin filtro con tensión analógica continua |

### 3.4 Alimentación, protecciones y térmica

| Ley / ecuación | Condiciones | Evidencia actual | Oráculo y criterio | Test existente o propuesto; pendiente |
|---|---|---|---|---|
| Fuente CV/CC | Característica estática y capacidad source/sink concretas | Aproximado; pruebas de límite | C-MNA/C-DC para equivalente; barrido contra curva externa/lab para hardware | Actual motor; V17–V19; respuesta de lazo y overshoot pendientes |
| LDO: `P≈(Vin−Vout)Iout+Vin·Iq` | Corrientes internas correctamente contabilizadas; dropout variable | Aproximado caída/límite fijo | C-DC + curvas dropout/carga/T de parte real; C-HOJA | Actual `sim/regulador.test.ts`; V20/V22. [TI TPS715](https://www.ti.com/lit/ds/symlink/tps715.pdf) referencia fenómeno, no regulador identificado de los DevKit |
| Uno 3V3: límite publicado 50 mA | Uno R3/revisión y alimentación válidas | F05: base aplica límite genérico 600 mA | C-HOJA para requisito de riel; no afirmar curva de foldback real a partir de límite | `sim/placa-descriptor.test.ts` en preparación; V21; F05 en progreso. [Pinout Arduino](https://content.arduino.cc/assets/Pinout-UNOrev3_latest.pdf) |
| Corriente por pad/puerto/chip | Agrupaciones y condiciones source/sink de MCU concreto | Control agregado incompleto | Sumas firmadas de corrientes físicas y límites de hoja; no sumas de bits | V12; tablas por chip y casos con varios puertos pendientes. [ATmega328/P](https://docs.arduino.cc/resources/datasheets/Atmel-42735-8-bit-AVR-Microcontroller-ATmega328-328P_Datasheet.pdf) |
| Brownout/reset | Umbrales, histéresis, retardo y consumo definidos | F01 reproducido: estado y rail inconsistentes | Primero consistencia discreta + causa conservada; transitorio real exige curvas/timing adicionales | Actual motor; V24/V45; F01 en progreso. Una oscilación del equivalente DC no es una frecuencia física validada |
| Selección USB/VIN | Esquemático, blocking, cable/fuente identificados | Aproximado genérico | Esquemático oficial + netlist de referencia y corriente inversa por cada fuente | V23; revisión por placa y backfeed pendiente |
| PPTC | R(T), condiciones ambientales y curvas tiempo/corriente | Sustituto DC de límite; disparo/recuperación ausentes | Curvas del componente concreto, C-HOJA/C-LAB | Modelo térmico PPTC propuesto, pendiente. [Littelfuse PPTC](https://www.littelfuse.com/products/fuses-overcurrent-protection/polyswitch-resettable-pptc-devices) como familia, no parámetro único |
| Balance térmico: `Cth·dT/dt=P−(T−Ta)/Rth` | Red térmica y condiciones de montaje; coeficientes identificados | Ausente general; potencia/avisos no simulan temperatura | Modelo térmico y transitorio de referencia; C-CONVERGENCIA/C-LAB | V22/V28/V54; `termica` propuesto, pendiente. [TI métricas térmicas](https://www.ti.com/lit/an/spra953d/spra953d.pdf): θJA depende del montaje y no sustituye todas las métricas |
| Derating / avería | Límites, pulsos, SOA y mecanismo definidos | Umbrales pedagógicos, estado no unificado; F13 | C-HOJA para violación; daño solo con modelo/calibración explícitos | V28; pendiente estado autoritativo y topología abierto/corto/degradado; C-LAB de avería no disponible |
| Batería: `dQ/dt=−I`; `V=OCV(SOC,T)−I·Rint−Vpolarización` | Química, capacidad, envejecimiento y convenio de signo conocidos | Fuente equivalente; SOC y electroquímica ausentes | Modelo específico y curvas carga/descarga reservadas para validar; C-LAB | Modelo batería propuesto, pendiente; no anunciar autonomía/recarga válida con fuente ideal |

### 3.5 Electromagnetismo, cableado y RF

Las ecuaciones de campos y transmisión requieren geometría, materiales y condiciones de contorno. Se usan como referencia de alcance, **no describen una implementación actual**. Véanse [notas oficiales MIT de electromagnetismo y líneas](https://ocw.mit.edu/courses/6-013-electromagnetics-and-applications-spring-2009/d3be4ea78b036a6362230fb41780cf54_MIT6_013S09_notes.pdf).

| Ley / ecuación | Condiciones | Evidencia actual | Oráculo y criterio | Test existente o propuesto; pendiente |
|---|---|---|---|---|
| Maxwell: `∇·D=ρ`, `∇·B=0`, `∇×E=−∂B/∂t`, `∇×H=J+∂D/∂t` | Campo/material/geometría y fronteras conocidos | Ausente; posiciones gráficas no son dimensiones físicas | Soluciones analíticas simples y solver EM independiente; criterio por caso pendiente | Capacitor/inductor geométrico o campo externo propuesto; fuera del primer roadmap |
| Cable DC: `R=ρ·l/A` | Material, sección, temperatura, contacto y longitud físicas declaradas | Wires ideales; no geometría eléctrica | Medición Kelvin/hoja y cálculo; C-LAB para contactos | Casos largo/retorno/carga propuestos; parámetros de wire pendientes |
| Línea: `∂v/∂x=−Ri−L∂i/∂t`; `∂i/∂x=−Gv−C∂v/∂t` | Modelo distribuido RLCG, terminaciones y frecuencia | Ausente | Pulsos, retardo/reflexión y línea de referencia; C-CONVERGENCIA | Línea de transmisión propuesta, pendiente; no límite de longitud inventado |
| Acoplamiento: `Vind=M·di/dt`; desplazamiento `i=Cpar·dv/dt` | Acoplamiento y geometría identificados | Ground bounce/EMI ausentes | Netlist acoplado o solver EM + medida; signo/magnitud/fase | Retorno compartido, diafonía y EMC pendientes; no afirmar compatibilidad electromagnética |
| RF espacio libre: `Pr=Pt·Gt·Gr·(λ/(4πr))²` | Campo lejano, línea de vista, adaptación/polarización; ganancia lineal | RF funcional parcial, sin canal físico | Presupuesto de enlace y medidas de radio identificada, C-HOJA/C-LAB | V47; fuente [Microchip AN9144](https://www.microchip.com/en-us/application-notes/an9144). No aplicar Friis a cualquier montaje/interior |
| Canal RF real / PER | Frecuencia, modulación, ancho de banda, antena, interferencia y propagación | Ausente; trama recibida no acredita alcance | PER/RSSI frente potencia/condiciones, semilla y curva calibrada | V47; RXB6/STX882 sin procedencia suficiente: pendiente identificar fabricante/variante. [TI CC1101](https://www.ti.com/lit/ds/symlink/cc1101.pdf) ejemplifica sensibilidad condicionada, no es su modelo |
| Aislamiento/arcos | Material, contaminación, distancias y normas de montaje concretas | Ausente | Requiere modelos/especificaciones y ensayos propios; criterios no definidos | Fuera de alcance actual; ninguna etiqueta de seguridad de aislamiento derivada de DC ideal |

### 3.6 Buses, firmware, sensores y tiempo

| Ley / contrato | Condiciones | Evidencia actual | Oráculo y criterio | Test existente o propuesto; pendiente |
|---|---|---|---|---|
| I2C lógico: START/STOP, ACK, bytes, addressing | Perfil/velocidad/chip y backend declarados | Parcial implementado | Especificación de protocolo; C-EXACTO para bytes/eventos; tiempos según modo | Actual `bus/busChips.test.ts`, `bus/firmwareReal.test.ts`; V38/V39 pendientes en cobertura completa |
| I2C eléctrico: `tr=0,8473·Rp·Cb` | Pull resistivo y carga capacitiva en condiciones especificadas | Ausente/desconectado de ruta de bytes | Flancos + límites eléctricos/temporales del modo. [NXP UM10204 §7.1](https://cache.nxp.com/docs/en/user-guide/UM10204.pdf); C-HOJA, sin tolerancia universal | V37–V39; pull ausente, corto, stretching/arbitraje eléctrico pendientes |
| SPI: modo, CS, setup/hold, MISO | Parte y host concretos; push-pull no wired-AND | Lógico parcial; contención física no validada | Registros y timing de hoja; tensión/corriente ante dos drivers | Actual `bus/spi.test.ts`, firmware SPI; V40 pendiente como conformidad eléctrica |
| UART: bit/baud, muestreo, framing | Baud real, reloj, tensión y cableado entre placas | Consola/periférico no demuestra interplaca arbitraria | Patrón independiente y tolerancia de baud del receptor concreto | Actual `avrSim.test.ts` funcional; V46 pendiente ruta física TX→red→RX |
| Runtime pad: mode/drive/pull/level | Estado efectivamente ejecutado y orden de instrucciones | F07: scanner heurístico no acredita runtime | DDR/PORT o APIs/periféricos instrumentados; C-EXACTO eventos | Actual `pinScan.test.ts` caracteriza scanner; V25 pendiente en AVR/ESP/MP, scanner queda diagnóstico |
| CPU/reloj: `t=ciclos/frecuencia` | Frecuencia por backend, periféricos y cambios de reloj declarados | AVR temporal interno; no reloj eléctrico compartido | Traza de instrucción/periférico y lazo co-simulado; C-EXACTO de ciclos/eventos | Actual `avrSim.test.ts`; V32/V33/V45; barreras interplaca pendientes |
| Alimentación de chip: power-on/brownout/reset | VCC, masa propia, tiempos y memoria según parte | Flag inicial de BusChips; transición viva incompleta F10 | Hoja + secuencia de voltajes; respuestas sin energía no válidas físicamente | V41/V45 pendiente cortar solo VCC de sensor mientras MCU sigue activo |
| BME280: compensación y conversión | Calibración, oversampling, IIR, modo y tiempo según parte | Modelo funcional con ruido/filtro/timing | Vectores independientes de fórmulas y registros, luego entorno físico C-LAB | Actual `bus/bme280.test.ts`, `bus/firmwareReal.test.ts`; V42. [Bosch BME280](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf); validación de incertidumbre física pendiente |
| MPU6050: escala, saturación, filtro, INT | Rango/ODR/DLPF y variante concreta | Aproximado con ruido/errores y tests | Registros y escalas de hoja; respuesta temporal independiente y semilla | Actual `bus/mpu6050.test.ts`, firmware; V43. [TDK MPU6000/6050](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet.pdf); filtros aproximados requieren caracterización |
| RTC: `Δt≈ppm·10⁻⁶·t` | Frecuencia, aging, pila y temperatura; tiempo simulado definido | DS3231 funcional con tiempo/alarmas/ppm | Registros/timing de hoja y referencia temporal externa | Actual `bus/ds3231.test.ts`, `bus/firmwareRtc.test.ts`; V44. [ADI DS3231](https://www.analog.com/media/en/technical-documentation/data-sheets/ds3231.pdf); pila/cortes y curva térmica C-LAB pendientes |
| EEPROM/estado persistente | Página, busy/write time y suministro de chip identificado | Implementado funcionalmente en ciertos chips | Patrón de escritura, ACK polling y reset de energía de hoja | Actual `bus/memoria.test.ts`/RTC; transitorios de escritura interrumpida pendientes |
| Tolerancias/corners/Monte Carlo | Distribuciones/correlaciones identificadas; semilla no prueba distribución real | Ausente general; sensores tienen mecanismos parciales | Límites min/typ/max y datos de lotes; C-HOJA/C-LAB | V54; muestras, correlaciones y conjuntos reservados pendientes |

## 4. Primer lote: F01–F06 y aceptación concreta

No extender las afirmaciones más allá de estos objetivos. Cada corrección necesita test rojo previo, cambio mínimo y evidencia de que el nuevo caso pasa junto a los válidos existentes.

| ID / estado | Entrega y dependencia | Regresión mínima | Criterio de cierre de software |
|---|---|---|---|
| **F03 — En progreso** | Contrato de resultados de netlist; distinguir referencia, vector ausente, error fatal, NaN/Infinity y resultado parcial. Base para todas las medidas | V49: mapa vacío/parcial, tensión/corriente ausente, errores con vectores presentes, finitud y cero físico auténtico | Ninguna lectura inventada; error/validez propagados; caso nominal y nodo de referencia mantienen valores. `sim/netlist-resultados.test.ts` requiere informe final |
| **F04 — En progreso** | Normalización pad→nodo antes union-find; alias no dependen del orden. Preservar terminales visibles y rails | V08: Uno A4/SDA a dos R y GND, GPIO18 high; repetir con orden invertido y corto entre alias | Igual nodo/tensión y corriente total correcta; permutaciones invariantes; entradas/salidas/clamps no duplicados |
| **F02 — En progreso** | Referencia DC física y clasificación unknown; requiere topología canónica F04 y resultados F03 | V09: pad solo, C a GND, R a extremo abierto; contraste con pull, R a GND y switch abierto/cerrado | Casos sin referencia no entregan nivel digital válido. Regularización no prueba conexión; región/impedancia de clamps documentadas |
| **F01 — En progreso** | Alimentación discreta coherente y causa de brownout/corto preservada; límites de iteración/ciclo explícitos | V24: S3 3V3 a 130 mA, USB off, GPIO7 high cortado a GND; fuente insuficiente y arranque válido | No `chipEncendido=false` con resumen favorable incongruente; causa visible en snapshot. Ciclo sin punto fijo se declara; no inventar frecuencia/retardo de reinicio |
| **F05 — En progreso** | Descriptor de riel por placa; Uno R3 3V3 no hereda 600 mA | V21: cargas por debajo/alrededor/sobre límite declarado, controles ESP no regresan | Límite publicado 50 mA identificado como requisito Uno R3; aviso/resultados consistentes con equivalente. No acreditar curva física exacta ni protección sin modelo |
| **F06 — En progreso** | Modo open-drain separado de nivel; preservar información scanner y no conectar high al riel | V14: low/high con pull, sin pull, dos emisores, pull externo a otra tensión | Low conduce y high libera; corriente y clasificación correspondientes; puentes/backends que no informan mode quedan limitados explícitamente. Runtime completo F07 pendiente |

**No se cierran F07–F15 por cerrar F01–F06.** La integración de open-drain por scanner, por ejemplo, no acredita cambios runtime ni flancos I2C. Agregar los IDs concretos de tests al informe final, no solamente un total de pruebas.

## 5. Arquitectura modular, propia y escalable

### 5.1 Capas y responsabilidades propuestas

Mantener el solver global. Separar estas responsabilidades por contratos TypeScript propios y módulos probados; las bibliotecas no se convierten en el estado de dominio:

| Capa | Contrato / responsabilidad | Ubicación actual y evolución |
|---|---|---|
| Catálogo y modelos | Identidad de parte/revisión, terminales→pads, primitivas, capacidades, parámetros, dominio, procedencia | `shared/src/modelo.ts`, descriptores y SDK; evolucionar esquema versionado sin mezclar geometría visual con física |
| Topología | Pad canónico, union-find, islas, referencias, caminos conductivos y diagnósticos | `sim/analisis.ts`; extraer lógica pura de topología y validación con invariantes |
| Estado de dispositivos | Suministro, modo del pad, almacenamiento, reset y memoria persistente | `sim/placa.ts`, chips; estado físico propio separado de estado UI y del sandbox |
| Coordinador físico | Selección de análisis, eventos, estabilidad, reloj, dependencias entre islas y placas | Nuevo servicio de dominio; `.op` inicial no finge estado transitorio |
| Adaptador solver | Traducir netlist, correr análisis, validar vectores/diagnósticos, cancelar y medir coste | `sim/netlist.ts`, `sim/spice.ts`; aislar worker/proceso supervisado detrás del contrato |
| Adaptadores firmware | Eventos runtime de pad/periférico y consumo; entradas digitales/analógicas y cambios de suministro | AVR/ESP/MP por adaptador; capacidades declaradas por versión/backend |
| Adaptadores de buses | Perfil funcional rápido o eléctrico/temporal, explícito en resultado | `bus/`; modelo de byte no certifica pad, carga o flancos |
| Observación/API/UI/MCP | Snapshot inmutable, unidades, validez y escenarios separados | `index.ts` y UI; componentes React reutilizables para representar límites/estado, no calcular física |
| Evidencia | Fixtures, fuentes, versiones, oráculos, resultados y laboratorio | Catálogo de conformidad versionado; CI y release lo consultan |

Nuevas fuentes, configuraciones y tests se escriben en `.ts`/`.tsx`, conforme a `AGENTS.md`. Si se necesita modificar código JavaScript existente del modelo, convertirlo a TypeScript y definir su salida compilada; no editar manualmente archivos generados ni introducir nuevos `.js` fuente para el SDK.

### 5.2 Manifiesto de cada modelo

Campos conceptuales del contrato (propuesto; no afirmación de implementación):

- `modelId`, versión de esquema/modelo, hash de contenido y de parámetros; fabricante/parte/revisión de placa o etiqueta `generic-equivalent`.
- Terminales visibles, pad físico, rails, referencia de medida y relación de alias.
- Perfiles soportados: funcional, DC, transitorio, AC, ruido; fenómenos omitidos y dependencia de otros modelos.
- Cada parámetro con unidad, fuente/documento/revisión/página, condición, clase (`min`, `typ`, `max`, recomendado, máximo absoluto, ajuste, numérico/pedagógico) y evidencia.
- Dominio V/I/T/frecuencia/tiempo de pulso; los campos no conocidos son desconocidos, no ilimitados por defecto.
- Condiciones iniciales, persistencia, fuente de semilla, callbacks/eventos y política de fuera de dominio.
- Tests de conformidad y estado de validación por combinación de perfil/backend/parte.

No ocultar fallback de modelo. Un equivalente alternativo tiene su propia identidad y evidencia; si no cubre la solicitud, esa solicitud permanece no válida. El sandbox valida ejecución y primitivas, no exactitud física.

### 5.3 Snapshot y escenarios

Proponer un snapshot con `snapshotId`, revisión del proyecto, tiempos simulados por dominio, perfil, versiones de motor/modelos/firmware, mapa de medidas con unidades/referencia y diagnóstico por isla/dispositivo.

Cada medida incluye estado `valid`, `unknown`, `out-of-domain`, `unsupported`, `non-convergent` o `degraded`; valor solo cuando corresponde, causa y ámbito afectado. El snapshot global resume el estado más restrictivo de la solicitud. Los consumidores no eliminan la etiqueta al copiar el valor.

Separar tres productos:

1. **Live**: condiciones actuales y medidas autorizadas por el perfil.
2. **Design checks**: escenarios hipotéticos, con sus condiciones y IDs; all-high/all-low no se denominan peor caso universal.
3. **Fault state**: violación de especificación o avería modelada. Si una avería cambia la red, la topología resultante se recalcula en servidor y persiste con versión; una animación del cliente no cambia la física.

Prueba contractual: LED activo en bajo, diferencial entre GPIO y pestañas distintas deben mostrar la misma medida live y el mismo estado de fallo. La UI puede interpolar brillo para renderizar; no puede alterar la corriente autoritativa.

### 5.4 Relojes y co-simulación

- El reloj físico es simulado, monótono y versionado; el reloj de pared solo limita ejecución/renderizado. Pausar, acelerar o atrasarse no elimina eventos del dominio.
- Evento de pad: boardId, padId, mode, drive, pull, level, timestamp simulado y secuencia. Capture runtime antes de resumir; al renderizar se permite reducir frames, no descartar flancos que cambian el circuito.
- El coordinador avanza hasta el siguiente evento/barrera; respeta causa antes de efecto y devuelve entradas/ADC/transiciones de energía al backend apropiado.
- Placas conectadas comparten coordinación temporal; placas demostrablemente independientes pueden avanzar por separado. Un fallo de una placa no apaga otra por física implícita: política de parada del entorno se publica por separado.
- Transitorio: paso máximo, tolerancias, condiciones iniciales, método de integración y discontinuidades registrados. Usar interpolación solo con error acotado conforme al perfil.
- Buses eléctricos dependen del estado de pads/red y tiempo; el modo funcional mantiene velocidad de ejecución y su etiqueta de alcance.
- Backends incapaces de emitir ciertos eventos declaran la limitación; no se inventa una frecuencia máxima fiable universal basada solo en periodo de polling.

### 5.5 Recursos y cancelación real

Antes de agregar resolución temporal, verificar F15. Solver en worker/proceso, una cola acotada, límites de nodos/elementos, memoria y pasos. Un watchdog que termina el worker debe recuperar la cola y publicar error. `Promise.race` sin interrupción real no es evidencia de plazo duro.

Pruebas adversariales en proceso supervisado independiente y con límite externo; no provocar un bloqueo deliberado del PC de desarrollo. Mantener un solo worker pesado durante validación local. Registrar versión embebida de ngspice/WASM, dependencia y hash; la versión del manual no establece la del binario instalado.

## 6. Roadmap por dependencias y entregas

El orden siguiente es técnico, sin fechas inventadas ni compromiso de implementar fenómenos fuera del perfil acordado.

| Etapa / estado | Depende de | Entregas verificables | Puerta de salida |
|---|---|---|---|
| **E0 Baseline — documentado, laboratorio pendiente** | Auditoría actual | Fixtures V01–V54 inventariados, etiquetas de alcance, registro de versiones/logs y criterios | Reproducciones preservadas en repo; no usar `/tmp` como única evidencia |
| **E1 DC confiable — correcciones iniciales verificadas por software** | E0 | Resultados estrictos, alias, flotación, brownout consistente, Uno 3V3, open-drain | Casos y límites registrados en §11; no acreditar transitorio/runtime completo ni laboratorio |
| **E2 Resultado autoritativo — parcial, ver §11** | E1/F03, F04 | Validez de snapshot, modelos ausentes/fallback F14, live/design/fault F09/F13, energía de chips F10 | Quedan identidad temporal entre clientes, estado por die y validación visual |
| **E3 Parámetros/hardware — parcial** | E1/E2 | Procedencia F12, rieles/USB/VIN, drive source/sink, límites de puerto, esquemático/revisión por placa | Riel Uno y distinción typical/absolute incorporados; campaña completa V11–V12/V15/V20–V23/V54 pendiente |
| **E4 Runtime y aislamiento — aislamiento verificado, tiempo pendiente** | E1/E2, contrato pad | F07: mode/pulls/drive realmente ejecutados; F15: worker/cancelación; reloj/eventos F08 | Worker y parada por placa probados; faltan reloj compartido y observación completa del runtime |
| **E5 Analógico/tiempo — parcial, §12** | E3/E4 | ADC ideal Uno nodo→cuenta y `.tran` RC/RL/RLC de diseño; faltan eventos PWM/rebote y suministro co-simulados | V29–V36 parciales; no cerrar adquisición ADC, reloj común ni tiempo real por pruebas de diseño |
| **E6 Buses eléctricos — pendiente** | E4/E5, power chips E2 | I2C abierto/pull/Cbus, SPI contención, UART interplaca cuando se elija | V37–V41/V46; perfil funcional separado del validado eléctrico |
| **E7 Térmica/protecciones/variabilidad — equivalente RC parcial, §12** | E3/E5 + laboratorio | Térmica RC de una dirección con parámetros declarados; faltan modelos por parte, PPTC y corners | V22/V28/V54 no cerrados; temperatura de equivalente no acredita daño o pieza real |
| **E8 Cable/EM/RF — pendiente o fuera de perfil inicial** | E4/E5 + geometría/hardware | Cable RLC, retornos/acoplamiento, canal RF identificado; solver EM como adaptador si se necesita | V47 y fixtures nuevos por fenómeno; no declarar EMC/aislamiento por resolver netlist |
| **E-LAB Caracterización — pendiente, transversal** | Hardware/fixture identificados y E1 | Banco DC primero; luego captura temporal, sensores/buses y RF por etapas | Datos físicos reservados, incertidumbre y dominio publicado por modelo/release |

E-LAB empieza con DC en paralelo al avance posterior; no se deja toda la comparación física para el final. No hace falta implementar EM, RF o térmica completa para publicar un perfil DC honesto. Ninguna etapa hereda automáticamente evidencia de otra.

### 6.1 Backlog de la auditoría fuera del primer lote

| Hallazgo | Estado en este plan | Siguiente paso medible |
|---|---|---|
| F07 scanner/runtime | Pendiente | Instrumentar cambios reales de DDR/Pin.init y probar ruta a modelo de pad |
| F08 polling pierde flancos | Pendiente | Traza mínima con pulso entre muestras y receptor conectado; conservar timestamp |
| F09 LED mezcla escenarios | Corrección verificada por software | Validación visual e identidad temporal entre consultas independientes |
| F10 energía de sensores | Acoplamiento funcional probado | Refinar tensión por chip interno, alimentación de respaldo, transiciones y corrupción de memoria por parte |
| F11 buses responden con línea inválida | Pendiente | Selector de perfil funcional/eléctrico; línea sin pull/corto con validez explícita |
| F12 parámetros genéricos | Correcciones parciales | Completar inventario parameter→fuente/clase/dominio; elegir hardware y revisión |
| F13 daño sin modelo | Inferencia de avería retirada | Elegir modelo térmico/de fallo, calibrarlo y validar topología/persistencia antes de simular daño |
| F14 fallback benigno | Rechazo verificado | Ampliar validación de propiedades de modelos propios y análisis de impacto por isla |
| F15 timeout real | Interrupción/recuperación verificadas | Cuotas de recursos externas si se admiten cargas no acotadas; no confundir heap V8 con memoria total |

## 7. Catálogo de casos y evidencia por versión

### 7.1 Cobertura de V01–V54

| Grupo de casos de auditoría | Entrega principal |
|---|---|
| V01–V07, V17–V19 | E1/E3: leyes DC, referencias y fuentes; laboratorio DC |
| V08–V10, V14, V21, V24, V49 | E1: regresiones F01–F06 y validación de resultados |
| V11–V13, V15–V16, V20, V22–V23, V54 | E3/E7: curvas de pad, supply, incertidumbre/corners |
| V25, V32–V33, V45, V50 | E4/E5: runtime, eventos, placas y cancelación |
| V26–V28, V41, V48, V53 | E2/E7: live, energía, validez, daño y UI compartida |
| V29–V31, V34–V36 | E5: transitorios, rebote, conversión analógica |
| V37–V40, V46 | E6: buses eléctricos y UART con backend verificado |
| V42–V44 | Modelos de sensores/chips actuales + E2/E4/E-LAB |
| V47 | E8: RF funcional vs canal físico identificado |
| V51–V52 | Transversal: invariancia de orden e identidad de la topología |

La agrupación no cierra el caso: cada V mantiene su archivo, criterio y estado individual. Las leyes/modelos adicionales de esta matriz (AC, BJT/MOSFET, batería, cable/EM) requieren IDs nuevos cuando su implementación se acuerde; no forzar correspondencia falsa con un test DC existente.

### 7.2 Registro mínimo por caso y ejecución

Un registro reproducible debe contener:

- ID de caso y requisito/hallazgo; perfil y estado del trabajo; commit y árbol limpio/sucio con hash del diff cuando corresponda.
- Proyecto/fixture, esquema, netlist generado, valores medidos de componentes o modelo genérico, identidad de placa/chip y condiciones de montaje.
- Versiones/hashes del solver/WASM, modelos/parámetros, firmware/HEX, librería de aplicación y adaptador backend.
- Fuente primaria con revisión/página, URL y fecha de consulta; no asumir que un enlace `latest` conserva contenido.
- Oráculo independiente y procedimiento para obtenerlo; presupuesto de error definido antes de aceptar el resultado.
- Resultado esperado/obtenido, unidades, referencias, residuos, tiempo simulado, semilla, método/paso y diagnósticos completos.
- Comando, entorno, log, estado pasó/falló/omitido y motivo de omisión. Un test optativo omitido nunca cuenta como aprobado.
- Si hay laboratorio: instrumento/serial/configuración/calibración/incertidumbre, temperatura, fecha, crudos y procedimiento de medición; muestra de ajuste separada de validación.

En futuras releases, el catálogo genera un resumen **por modelo + revisión + perfil + rango + backend**, con enlaces a evidencia. Un número total de tests no sustituye esa matriz. Cambios de parámetros, alias, solver, clocks o backend invalidan solo las acreditaciones afectadas tras análisis de impacto; si no se puede demostrar impacto acotado, volver a validar la categoría.

## 8. Baseline de laboratorio pendiente

**No hay baseline de laboratorio acreditado por esta entrega.** No declarar exactitud física hasta tenerlo. El primer banco requiere fuente limitada, multímetro y resistencias medidas; los casos temporales añaden osciloscopio/analizador lógico y fixture repetible. Instrumentos y selección de partes concretas están pendientes, no presupuestados aquí.

Secuencia propuesta:

1. Identificar revisión de Uno/ESP y número de parte de resistor/LED/regulador usado; fotografiar/conservar esquema del fixture y conexiones de retorno.
2. Medir valores reales, fuente y condiciones; crear oráculo del equivalente antes de ver el resultado de emulación. No usar lectura del emulador como valor esperado.
3. Hacer DC: divisores, LED con resistencia y pad source/sink dentro de condiciones recomendadas. Medir ambos terminales y corrientes/caídas del suministro.
4. Separar error numérico, discrepancia del modelo e incertidumbre de medición. Cuando una hoja solo da típico, el test nominal verifica ese equivalente, no un límite garantizado del hardware.
5. Reservar datos/condiciones que no se usaron para ajustar parámetros. Aceptar o rechazar con el criterio previamente registrado; registrar también discrepancias.
6. Añadir escalón RC/RL, flancos I2C, cambios de suministro y sensores una vez existan perfiles temporales. Sin modelo temporal, esa comparación solo identifica brecha pendiente.
7. Las pruebas de sobrecarga física/destrucción no son requisito para cerrar E1. Contrastar límites publicados y equivalentes sin exceder condiciones de operación del hardware de referencia; cualquier campaña de avería requiere un diseño experimental propio.

## 9. Flujo de implementación y revisión

Seguir `CLAUDE.md`: rama y PR, commits temáticos en español, TypeScript obligatorio; leyes/física con TDD. Por cambio: test que reproduce el defecto, modificación por responsabilidad, caso nominal, borde, inválido/desconocido y regresión pertinente. Ampliar pruebas cuando cambian hipótesis o aparecen fallos; no repetir suites sin motivo.

Antes de publicar código, ejecutar las verificaciones exigidas del proyecto y registrar comando/resultado/omitidos. La interfaz se comprueba con Playwright en proyectos temporales y un solo worker; el comportamiento físico requiere fixtures de motor/integración, no una captura bonita. Mantener el dev con pnpm y cuidar los recursos del equipo.

Criterio común de cierre de una tarea: requisito concreto satisface su oráculo, regresión falla antes/pasa después, fuentes/condiciones registradas, caminos de error probados, límites actualizados, consumidores preservan validez y queda claro qué evidencia todavía es laboratorio pendiente.

## 10. Referencias primarias y límites de su uso

Consultadas el 4 de octubre de 2026. Las URLs móviles no fijan una revisión; el registro de cada modelo deberá identificar el documento exacto utilizado.

| Referencia | Uso autorizado en el plan |
|---|---|
| [ngspice manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf) | Modos de análisis y dispositivos; comprobar versión realmente embebida, no asumir equivalencia con manual 47+ de desarrollo |
| [NXP UM10204](https://cache.nxp.com/docs/en/user-guide/UM10204.pdf) | Perfil I2C, tiempos y condiciones eléctricas; no garantiza que el bus del emulador ya las represente |
| [Arduino Uno R3 pinout](https://content.arduino.cc/assets/Pinout-UNOrev3_latest.pdf) | Pad/alias y límite publicado del riel 3V3; no curva temporal del regulador |
| [ATmega328/P](https://docs.arduino.cc/resources/datasheets/Atmel-42735-8-bit-AVR-Microcontroller-ATmega328-328P_Datasheet.pdf) | Límites, grupos GPIO y periféricos del chip/revisión correspondiente |
| [ESP32-S3](https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf), [C3](https://documentation.espressif.com/esp32-c3_datasheet_en.html), [C6](https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf) | Elegir parámetros por familia y condiciones; la placa DevKit necesita su esquemático/revisión adicional |
| [TI Schmitt](https://www.ti.com/lit/an/scea046/scea046.pdf), [ADC](https://www.ti.com/lit/an/spna061/spna061.pdf) | Fenómenos de histéresis/adquisición; no identificación automática del pad o ADC del catálogo |
| [TI cargas inductivas](https://www.ti.com/document-viewer/lit/html/SNVAA45), [TPS715](https://www.ti.com/lit/ds/symlink/tps715.pdf), [métricas térmicas](https://www.ti.com/lit/an/spra953d/spra953d.pdf) | Energía de bobina, regulación y condiciones térmicas; partes citadas como ejemplos, no componentes acreditados de las placas |
| [Vishay resistores](https://www.vishay.com/docs/28771/basics.pdf), [VLWR9632](https://www.vishay.com/docs/81818/vlwr9632.pdf) | Disipación, ruido y límites particulares de LED; no valores universales para cualquier componente |
| [Bosch BME280](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf), [TDK MPU6000/6050](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet.pdf), [ADI DS3231](https://www.analog.com/media/en/technical-documentation/data-sheets/ds3231.pdf) | Registros, modos, conversión y tiempos; separar implementación funcional de caracterización del sensor físico |
| [MIT electromagnetismo](https://ocw.mit.edu/courses/6-013-electromagnetics-and-applications-spring-2009/d3be4ea78b036a6362230fb41780cf54_MIT6_013S09_notes.pdf) | Marco académico de campos/líneas; no evidencia de un solver EM integrado |
| [Microchip AN9144](https://www.microchip.com/en-us/application-notes/an9144), [TI CC1101](https://www.ti.com/lit/ds/symlink/cc1101.pdf) | Presupuesto RF y sensibilidad condicionada; no caracterizan RXB6/STX882 sin identificación adicional |
| [BIPM/JCGM publicaciones](https://www.bipm.org/en/committees/jc/jcgm/publications), [GUM JCGM 100:2008](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf) | Evaluación de incertidumbre experimental; aceptación sigue siendo requisito por caso, no una tolerancia fija |

Documentos del repo: [auditoría](../AUDITORIA-FIDELIDAD-ELECTRONICA.md), [circuito libre](../SDD-CIRCUITO-LIBRE.md), [módulos](../SDD-MODULOS.md), [chips](../chips/README.md), [motor eléctrico](motor-electrico.md), [convenciones](../CLAUDE.md). Ante contradicción entre una afirmación histórica de fidelidad y un resultado defectuoso reproducido, publicar el límite y actualizar la afirmación, sin borrar la evidencia.

## 11. Implementación y evidencia posterior a la auditoría

### 11.1 Qué cambia en esta ronda

Trabajo iniciado el 4 de octubre de 2026 desde la base local auditada, en `fix/fidelidad-electrica`, conservando cambios anteriores del editor/rutas/visor. Durante la ejecución otro trabajo cambió la rama del checkout compartido y agregó commits de Aprender. La implementación eléctrica se identifica por los archivos y resultados siguientes; no se atribuyen aquellos commits a esta auditoría. No se reinició el proceso `pnpm run dev`.

Las pruebas se ejecutan con un solo worker y prioridad reducida. Los ciclos parten de reproducciones que fallan y terminan con regresiones concretas. Hay dos clases distintas de entrega: correcciones de ecuaciones/topología y políticas explícitas para evitar afirmaciones que el modelo no puede sostener.

| Hallazgo | Corrección incorporada | Verificación nueva | Límite que permanece |
|---|---|---|---|
| F01 | Brownout retira salidas de cada placa afectada, conserva la causa inicial y evita reactivar esas salidas por el rebote DC posterior | `sim/fidelidad.test.ts`, `sim/instantanea-real.test.ts` | Es una política de reset DC conservadora; no simula oscilación de arranque, tiempos de reset ni consumo transitorio |
| F02 | Referencia de entrada obtenida por conectividad DC: C abierta y R a extremo suelto no fijan un bit; REG solo aporta referencia si está activo y con entrada/tierra referenciadas | `sim/fidelidad.test.ts`, `sim/referencias-regulador.test.ts` | Grafo aproximado: corte resistivo de 100 MΩ y conducción D/SV de 10 nA; no sustituye impedancia incremental, fugas caracterizadas ni ruido |
| F03 | Vectores ausentes, no finitos, complejos y fallos finales de convergencia se rechazan; primitivas inválidas no llegan al solver; pines sin ecuación se enumeran sin publicar 0 V | `sim/netlist-resultados.test.ts`, `sim/validacionSpice.test.ts` | `resuelto` acredita consistencia del equivalente calculado, no exactitud física del descriptor |
| F03 / V49 | Se aplica conservación de corriente y potencia antes de publicar un resultado | `sim/conservacion.test.ts`, regresiones del motor | Presupuestos numéricos C-DC, no tolerancias de componentes reales; no balance temporal de energía almacenada |
| F04 | A4/SDA y A5/SCL se unen por identidad de GPIO; nodos internos usan nombres inyectivos | `sim/fidelidad.test.ts`, `sim/nombresSpice.test.ts` | Otros alias dependen de que el descriptor de cada placa declare correctamente su pad |
| F05 | USB, reguladores, dropout, corriente y brownout son parámetros del descriptor. Uno 3V3 usa 50 mA | `sim/placa-descriptor.test.ts`, `sim/instantanea-real.test.ts` | 50 mA es el límite publicado por Arduino; el limitador ideal del equivalente **no es** una protección real acreditada ni la curva de un regulador específico |
| F06 | Open-drain HIGH libera, LOW hunde corriente; se conserva el modo reconocido en MicroPython, Arduino, ESP-IDF y ESPHome | `pinScan-open-drain.test.ts`, `sim/placa-descriptor.test.ts`, `sim/instantanea-real.test.ts` | F07 sigue abierto: reconocer texto no observa todos los cambios reales de modo/pull del MCU |
| F07 | Un nivel de salida no comunicado por el runtime ya no se inventa como HIGH en la API viva (`nivelesReales:true`) | `sim/instantanea-real.test.ts` | La configuración sigue siendo parcialmente estática. El modo de análisis de diseño conserva valores supuestos por compatibilidad; no usarlo como instantánea viva |
| F08 | Actualizador con un cálculo activo y una solicitud pendiente coalescida, sin acumular una cola de cálculos por cada GPIO | `actualizadorElectrico.test.ts` | Protege recursos; **no corrige** pérdida de pulsos ni conserva la forma de onda. Agrupar a 50 ms no es un reloj físico |
| F09 | LED, tensiones y medidas de `/pins` corresponden a un mismo cálculo con los niveles vivos; `mAFijo` queda como alias de `mA` | `sim/instantanea-real.test.ts`, `tests/unit/estado-electrico.test.ts` | Editor y visor hacen solicitudes independientes; falta un identificador común de instante/tiempo. Brillo es una representación funcional, no fotometría |
| F09 / V53 | UI y visor exigen `resuelto === true`; respuesta inválida o cambio de proyecto limpian medidas anteriores e invalidan respuestas pendientes | Pruebas del helper de estado eléctrico y TypeScript web | Validación visual de integración pendiente por rechazo de acceso al navegador en esta sesión |
| F10 | Cortar alimentación del módulo retira ACK/MISO, libera salidas y cancela temporizadores; el reinicio usa el contrato guardar/encender del chip | `bus/alimentacionChips.test.ts`, suites de bus/memoria | Se usa `ui.on` del modelo del módulo como proxy de alimentación; no hay tensión por cada die interno, brownout analógico de sensor ni corrupción realista de EEPROM |
| F12 | Los 40 mA source / 28 mA sink típicos de ESP se distinguen de máximos absolutos y se conservan condiciones/referencias | Descriptores S3/C3/C6, pruebas del motor | Faltan curvas I/V por drive/temperatura y límites acumulados por grupo/encapsulado. El equivalente Rout sigue aproximado |
| F13 | Sobrepasar un umbral informa riesgo. Ya no se apaga un LED por una marca visual ni se memoriza una placa destruida para siempre por una sola sobretensión | `estadoAlimentacion.test.ts`, `tests/unit/estado-electrico.test.ts` | No se simula daño térmico, latch-up ni degradación. `quema`/`se-quema` son códigos legacy de riesgo; `quemada:false` es compatibilidad, **no afirmación de que el hardware sobreviviría** |
| F14 | Error al cargar/calcular/observar un modelo o módulo desconocido invalida el análisis; no desaparece silenciosamente la carga. Caché identificada por descriptor completo | `sim/sandbox.test.ts`, `sim/fidelidad.test.ts`, `sim/modelos-fidelidad.test.ts` | Sin análisis formal de independencia de islas, se invalida la consulta completa |
| F15 | ngspice se ejecuta en worker terminable, con cola acotada y reinicio tras error/timeout | `sim/colaWorker.test.ts` con bucle CPU, salida inesperada, cola llena, cierre activo y arranque lento | V8 limita heap, no toda memoria externa WASM ni CPU a nivel SO. El presupuesto no certifica disponibilidad bajo agotamiento global del host |
| V45 | Se detiene solo la placa con diagnóstico inválido/falta de energía; una corrida nueva invalida diagnósticos anteriores | `pararPlacasSinEnergia.test.ts` | No implementa un reloj compartido de todas las placas ni reconstruye la dinámica de la fuente común |
| V51 / V52 | Se elimina una colisión válida entre nombres internos de chip y corriente quiescente del regulador | `sim/placa-nombres.test.ts` (IDs `a-ldo-q` y `chip-a`) | El espacio de IDs aceptado por el esquema sigue siendo parte del contrato |
| V53 | Las opciones del runtime se copian al entrar al análisis; niveles, direcciones, controles y estado conservan el mismo valor durante todas las pasadas | `sim/instantanea-analisis.test.ts` | No se sincronizan automáticamente consultas independientes del editor y el visor |
| F14 / V48 | En modelos legacy por flags se rechazan resistencias o parámetros de fuente inválidos; no se convierten en una carga abierta, 0 V o una fuente ilimitada | `sim/modelos-validacion.test.ts` | Se conserva fuente ideal únicamente cuando el descriptor no declara límite; los modelos propios del catálogo requieren también revisión de cómo validan/transforman sus propiedades |

F11 permanece abierto: el intercambio digital I2C/SPI no está condicionado por todos los requisitos eléctricos de sus líneas. Tampoco se da por cerrado un caso completo V01–V54 solo porque una parte de él tenga una regresión nueva.

### 11.2 Responsabilidades y contratos del código

Rutas relativas a `app/server/src/` salvo indicación:

- `sim/validacionSpice.ts`: frontera de valores y primitivas; una excepción nunca se convierte en vector cero.
- `sim/conservacion.ts`: controles de KCL y potencia DC, separados del ensamblador y la UI.
- `sim/conectividadDc.ts`: referencias eléctricas físicas; la regularización numérica no se presenta como pull real.
- `sim/nombresSpice.ts`: asignación de identidades sin colisiones por sanitización de nombres.
- `sim/colaWorker.ts` / `sim/spiceWorker.ts`: ejecución aislada y cancelación real. Hasta 32 trabajos admitidos, uno activo; 20 s para arranque confirmado y 5 s para cálculo. La cola avanza después de terminar el worker fallido.
- `sim/placa.ts` + `shared/src/board.ts`: topología y parámetros de la placa descritos como datos. Agregar un descriptor no acredita automáticamente sus valores.
- `actualizadorElectrico.ts`: limita solicitudes repetidas sin hacer concurrir soluciones del mismo actualizador. No convierte el muestreo de la interfaz en tiempo de simulación.
- `estadoAlimentacion.ts` / `pararPlacasSinEnergia.ts`: separan diagnóstico, política de ejecución y parada por placa; no inventan un historial de daño.
- `bus/busChips.ts` / `bus/puenteChips.ts`: estado de energía y ciclo de vida de chips. Los adaptadores AVR/MicroPython consumen el mismo contrato.
- `web/estado-electrico.ts`: representación a partir de una observación válida, separada del riesgo y de escenarios hipotéticos.

La API conserva `mAFijo`, `quema`, `se-quema` y `quemada` para compatibilidad. Sus nombres históricos no tienen autoridad física: leer sus contratos actualizados. `resuelto:false` impide publicar un conjunto parcial de medidas como exitoso. Un circuito resuelto puede seguir fuera de un dominio físico acreditado; no se debe mostrar “certificado” a partir de este booleano.

### 11.3 Registro de validación

Primer cierre de integración: **19 suites, 211 pruebas aprobadas**, incluidas las 56 del motor, comparación MNA, modelos, reguladores, entradas, open-drain, worker y estado visible. Luego **9 pruebas aprobadas** de política de alimentación y parada por placa. Los totales no se suman con la suite final porque se solapan.

Evidencia TDD específica: seis fallos de alias/flotación/brownout antes del cambio; cinco de scanner open-drain; nueve del estado visual; rechazo de vectores/primitivas inválidas; modelo cacheado con descriptor viejo; colisiones de nombres; cancelación por generación (el diagnóstico viejo detenía también una corrida nueva). Los logs de trabajo se guardaron en `/tmp/*red.log` / `/tmp/*green.log`; son evidencia local de la sesión, **no archivos duraderos del repositorio**. Los tests versionables citados son el mecanismo de reproducción mantenible.

Los antiguos tests del sandbox que aceptaban un modelo roto con carga omitida fueron cambiados expresamente: ahora exigen `resuelto:false` y el diagnóstico de origen. Se trata de un contrato de rechazo más estricto, no de conservar la apariencia de circuito sano.

Resultado final con **Node 24.14.0**, Vitest **2.1.9**, `eecircuit-engine` **1.8.0** y Vite **8.3.2**:

Identidad del bundle del motor ensayado: SHA-256 de `app/node_modules/eecircuit-engine/dist/eecircuit-engine.mjs` = `a4a4776888e6fbbd1c1be755adba8bc48c0921a26649e86c7539c40433cfe66e`. Es el hash del bundle instalado, no un número de versión upstream de ngspice deducido del manual.

| Verificación | Comando desde `app/` (Node 24 en PATH) | Resultado |
|---|---|---|
| Suite completa | `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1` | **83 suites aprobadas, 1 omitida; 1.008 pruebas aprobadas, 1 omitida**, 127,81 s |
| Servidor | `node node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit` | Sin errores |
| Navegación web | `node node_modules/typescript/bin/tsc -b web/tsconfig.navigation.json` | Sin errores |
| Frontend | `node node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit` | Sin errores |
| Build web | `node node_modules/vite/bin/vite.js build` desde `app/web/` | Correcto, 175 módulos, 1,20 s |
| Regresión web después de restaurar dependencias locales | `node node_modules/vitest/vitest.mjs run tests/unit --maxWorkers=1 --minWorkers=1` | **18 suites, 233 pruebas aprobadas**; subconjunto, no se suma a 1.008 |
| Formato del diff | `git diff --check` | Sin errores |

La omisión es `micropythonImports.integration.test.ts`: requiere activación explícita `EMU_TEST_MICROPYTHON_IMPORTS=1`, binario esp-emu y firmware instalado; no formó parte de esta corrida. Las pruebas de firmware AVR y buses habilitadas sí forman parte de la suite completa. No se afirma cobertura de compilación/ejecución física completa de todos los lenguajes.

El primer pase completo bajo Node 22.22.1 dio 1.006 aprobadas y dos fallos por textos antiguos de advertencias. Se actualizaron esas expectativas sin cambiar los umbrales ni las comprobaciones numéricas; el pase final usa la versión 24 requerida por el proyecto. El comando de chequeo con pnpm inició una instalación automática local: se apartó esa instalación, se recuperaron Vite/plugin-react originales y se repitieron typecheck, build y pruebas web. No se cambió ningún manifest ni lockfile del proyecto.

Logs locales del cierre: `/tmp/fidelidad-suite-node24.log`, `/tmp/fidelidad-tsc-final.log`, `/tmp/fidelidad-web-tsc-restaurado.log`, `/tmp/fidelidad-web-build.log`, `/tmp/fidelidad-web-unit-restaurado.log`. El acceso al navegador fue rechazado durante la sesión; no se intentó sortearlo mediante Playwright u otra vía. **Prueba visual pendiente**. Ninguna de estas verificaciones constituye una medición de laboratorio.

### 11.4 Qué falta para extender la confianza

1. Instrumentar modo, pulls, drive, ADC y eventos reales del MCU. Sustituir gradualmente el scanner como autoridad de runtime; mantenerlo solo como ayuda de análisis estático.
2. Establecer reloj/eventos deterministas compartidos y resolver flancos sin depender del repintado. Verificar PWM/pulsos antes de afirmar soporte temporal.
3. Incorporar `.tran` con estado energético, condiciones iniciales, control de error y refinamiento: primero RC, después RL/flyback y RLC. La disponibilidad de ngspice no equivale a haber integrado ese estado.
4. Acoplar I2C/SPI/UART a tensión, impedancia, tiempos, capacitancia y contención según cada bus; mantener un modo funcional identificado para el firmware que lo necesite.
5. Identificar revisión de placa, esquemático y número de parte de cada componente. Separar datos mínimos/típicos/máximos, temperatura, corners y tolerancias. Corregir un número genérico no acredita toda una familia.
6. Incorporar modelos térmicos y de avería únicamente con ecuaciones, parámetros y evidencia suficientes. Hasta entonces reportar riesgo sin fabricar destrucción o supervivencia.
7. Ejecutar la campaña de laboratorio del §8 y publicar presupuesto de incertidumbre, condiciones y discrepancias. Para RF, EMC, cableado distribuido y sensores físicos se requieren modelos/campañas adicionales específicos.

La confianza procede de cerrar cada contrato acotado con evidencia. Las pruebas de software ejecutadas en esta ronda no cierran esos siete frentes ni permiten afirmar que el simulador reproduzca toda la vida real.

Referencia adicional consultada para F13: [Analog Devices, Absolute Maximum Ratings](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-50.html). Describe límites de estrés y posible daño; no proporciona un tiempo universal hasta la avería. El cambio de política evita inferir ese tiempo a partir de una única comparación de tensión.

### 11.5 Entrega aislada sobre main

La entrega para revisión se preparó en **`fix/fidelidad-fisica`**, sobre `origin/main` **`bb2b21a`**, en un worktree separado. Se trasladaron únicamente las correcciones eléctricas, de runtime y representación relacionadas con este informe. Se conservaron las funciones de cámara de main; no se incluyeron el trabajo paralelo de Aprender, la limpieza de paneles ni la nueva vista compartida. Las menciones al visor del §11.1/§11.3 registran el trabajo local previo; ese feature no forma parte de este PR.

La integración con main requirió conciliar `alimentar` con el nuevo ciclo de vida del bus. Se comprobó pérdida de VCC, cancelación de captura y recuperación de cámara con CS sostenido bajo. El PR abierto #53 añade otras pruebas en ese archivo y fue revisado: sus cambios de plantilla/captura no se incorporaron ni se reemplazaron.

Validación **del árbol que se entrega a PR**, nuevamente con Node 24.14.0 y un worker:

- Suite completa: **93 suites aprobadas, una omitida; 1.039 pruebas aprobadas, una omitida**, 129,72 s. Log `/tmp/fidelidad-pr-suite.log`.
- TypeScript servidor y web: sin errores. Las declaraciones de navegación se generaron antes de comprobar web.
- Build web: **175 módulos, 1,16 s**, correcto. Log `/tmp/fidelidad-pr-build.log`.
- `git diff --check`, índice sin conflictos y preservación de cambios de main: correctos.

La prueba optativa omitida y la limitación de validación visual son las mismas del §11.3. Estos totales reemplazan a los del workspace inicial para evaluar este PR; no deben sumarse entre sí. Las dependencias se reutilizaron fuera del índice y no se modificaron manifests ni lockfiles. El proceso dev del workspace original permanece activo.

## 12. Continuación: transitorios, ADC, térmica y evidencia

Este apartado registra el cierre anterior. Los avances posteriores y sus límites están en §13.

El documento [Análisis temporal y evidencia](ANALISIS-TEMPORAL-Y-EVIDENCIA.md) registra contratos, ecuaciones, API, parámetros, fuentes y límites de esta tanda en `fix/fidelidad-fisica` / PR #54. Se conservó el workspace principal de trabajo paralelo y se continuó en el worktree aislado. Tras la interrupción de sesión se volvió a levantar el dev principal con `pnpm run dev`; esto no traslada automáticamente el código del worktree a ese proceso.

| Fenómeno / caso | Avance de software | Lo que no cierra |
|---|---|---|
| V29–V31, RC/RL/RLC | `.tran`, condiciones iniciales, PWL, trazas completas y presupuestos de recursos; oráculos analíticos y balance energético | Firmware, PWM/rebote, cambios de topología y reloj común siguen separados |
| V35–V36, ADC | Uno: voltaje/referencia DC→cuenta ideal→registros leídos por firmware; pruebas local/worker, alias y reset | ADC ESP32, adquisición, ruido, INL/DNL, error de referencia, auto-trigger y timing físico |
| V40, SPI | Rechazo de MISO opuestos; ausencia de conducción separada de `0xFF`; error recuperable MicroPython y parada AVR | Contención analógica, impedancia, frecuencia/forma de flanco y buses eléctricos completos |
| V28, térmica | Cuerpo RC con parámetros explícitos, potencia de R/S, temperatura y energía; calentamiento/enfriamiento/rampa | Caracterización por pieza, red térmica de montaje, feedback eléctrico, PPTC, envejecimiento y averías |
| E-LAB | Registro tipado de identidad/dominio, incertidumbre, correlación y decisión con zona indeterminada; CLI y fixture sintético | No hay mediciones físicas, instrumentos verificados ni certificación automática |
| V47, RF | Criterios/fuentes para el siguiente contrato documentados | Ningún canal RF nuevo queda acreditado ni implementado por esta tanda |

Reproducciones que fallaron antes del arreglo: ADC con MUX reservado devolvía cero, alias A4/SDA sobrescribía una lectura conocida, riel sin cable quedaba desconocido, snapshot de reset podía mutarse desde el llamador; respuestas SPI incompatibles producían un AND; sandbox rellenaba ausencia MISO como conducción de unos; resistor afirmaba avería sin modelo y no respetaba una potencia nominal distinta de 1/4 W; transitorios no acotaban el total de valores y admitían arrays dispersos. Los fixtures de TDD permanecen en el repositorio.

La revisión final añadió dos regresiones: una fuente con masa en otra isla habilitaba tensiones absolutas de un RC flotante; una lectura iniciada antes de un relanzamiento podía actualizar la nueva CPU o detenerla con un brownout antiguo. Se comprueba ahora referencia por conectividad y vigencia de la solución eléctrica durante todo el ciclo asíncrono. `vigenciaElectrica.test.ts` reproduce cinco fallos previos y verifica seis escenarios, incluida la parada por placa, cambios superpuestos y recuperación después de un fallo de arranque.

El nuevo catálogo incluye capacitor e inductor ideales en TypeScript. La potencia nominal del resistor es declarativa y configurable, sin inferir temperatura ni daño. La API permite aplicar por separado el modelo térmico con procedencia y dominio explícitos. Los modelos no incorporan características físicas de una parte comercial que no se hayan parametrizado.

### 12.1 Registro de cierre

Verificación final del árbol entregado, Node 24.14.0, Vitest 2.1.9 y un solo worker con prioridad reducida:

| Comprobación | Resultado |
|---|---|
| Suite completa | **110 suites aprobadas y una omitida; 1.192 pruebas aprobadas y una omitida**, 168,21 s |
| TypeScript servidor | Sin errores, `tsc -p server/tsconfig.json --noEmit` |
| TypeScript frontend | Sin errores, generación previa de declaraciones de navegación y `tsc -p web/tsconfig.json --noEmit` |
| Build frontend | Vite 8.3.2, **175 módulos**, 1,00 s |
| CLI de evidencia | Fixture sintético aceptado por su regla; conserva `clasificacion:sintetico` y `certificacion:false` |
| Diff | `git diff --check` sin errores |

Los totales incluyen las regresiones previas; no deben sumarse a los de §11. La prueba omitida sigue siendo la integración optativa `micropythonImports.integration.test.ts`, que requiere activar `EMU_TEST_MICROPYTHON_IMPORTS=1` y disponer de binario/firmware externo. No se realizó verificación visual en navegador ni medición de laboratorio. El dev del checkout principal permanece en 5180 con pnpm; la nueva implementación queda en la rama aislada hasta integrar el PR.

Logs locales: `/tmp/fidelidad-temporal-final-suite.log`, `/tmp/fidelidad-temporal-final-tsc.log`, `/tmp/fidelidad-temporal-web-build.log`, `/tmp/fidelidad-evidencia-cli.json`; casos rojo/verde de recarga en `/tmp/vigencia-electrica-{rojo,verde}.log` y aislamiento transitorio en `/tmp/transitorios-islas-{rojo,verde}.log`. Son archivos temporales de la sesión; las pruebas versionadas permiten reproducir la verificación. Los resultados de software no acreditan parámetros de hardware sin la campaña física pendiente.

## 13. Perfiles configurables: adquisición, I2C, electrotérmica y RF

Implementación modular, contratos, ejemplos y fuentes en [Perfiles físicos](PERFILES-FISICOS.md).
Se continúa en `fix/fidelidad-fisica`, PR #54; el checkout principal y sus cambios de
otros trabajos permanecen separados. El dev de ese checkout sigue ejecutándose con
pnpm en 5180; estas modificaciones todavía requieren integrar la rama para verse allí.

| Área | Implementación y evidencia nueva | Límite conservado |
|---|---|---|
| ADC Uno | Equivalente de adquisición RC con memoria de canales, fuente/interruptor, offset, ganancia y ruido uniforme con semilla; registros AVR, worker/local y reset | Snapshot DC, sin carga devuelta al solver ni calibración de silicio |
| ADC1 ESP32 | Shim `machine.ADC`, GPIO/atenuación y perfil lineal explícito; `read`/`read_u16`, OSError para datos desconocidos o sin modelo; CPython para transporte y ciclo de vida mock | Sólo MicroPython, ADC1, S3/C3/C6; sin SAR nativo, ADC2, eFuse o `read_uv` |
| I2C | RC declarado por placa/GPIO, niveles/corriente, mínimos/máximos de flancos, carga y reloj; impide ACK fuera de dominio, con error al firmware | No extrae automáticamente el equivalente del esquema ni resuelve cada bit/arbitraje/stretching |
| Térmica | R(T) lineal realimentada en ngspice, RK2 adaptativo, dominios, balance y presupuestos | Cuasiestático; sin C/L eléctricos, firmware, red térmica ni averías |
| RF | Friis, pérdidas/polarización y umbral declarados; filtro MCP/WS, destino eléctrico y capacidad del transporte | Espacio libre/campo lejano; inyección al puente, no ACK ni BER/PER |

La revisión cruzada detectó y corrigió además: errores I2C de dominio que omitían
respuesta UART; flancos Fast-mode más rápidos que el mínimo; perfiles RF aplicados
sin verificar el receptor o su alimentación; entregas RF aparentes en backends sin
soporte; y el rango de la API RF que excedía los 24 bits del búfer RMT nativo. Las
guardas TypeScript limitan el transporte real a 24 bits/protocolo 1. El código C++
existente no se modificó y sigue requiriendo sus propias guardas si se accede a él
por fuera del servidor de la aplicación.

También se reprodujo un bloqueo por cabecera SPICE Unicode: el adaptador raw
interpretaba posiciones de caracteres como offsets de bytes. Se normaliza únicamente
esa cabecera, preservando el nombre del proyecto. La prueba ejecuta la red real con
un título acentuado.

No se considera cerrado el reloj común firmware/analógica, la física completa de
buses, el ADC nativo ESP32, la caracterización térmica/RF de cada parte, el
envejecimiento, las averías ni la validación de laboratorio. Los datos sintéticos
siguen identificados como tales. Ningún porcentaje de pruebas aprobadas equivale
a un porcentaje de realidad reproducida.

### 13.1 Verificación de esta continuación

Node 24.14.0, Vitest 2.1.9, un worker y prioridad reducida:

- Suite completa: **123 suites aprobadas y una omitida; 1.351 pruebas aprobadas y una omitida**, 173,02 s.
- Las pruebas incluyen AVR local/worker, ADC1 vía plantilla Python y transporte UART,
  modelos RC/Friis, API térmica con ngspice real, MCP, contratos WS y rechazo de
  entregas que exceden la capacidad del transporte. Son **159 pruebas aprobadas más**
  que en §12, incluidas regresiones de las revisiones cruzadas.
- La omisión sigue siendo `micropythonImports.integration.test.ts`, optativa y con
  dependencias externas. CPython y procesos simulados no sustituyen esa integración
  con firmware MicroPython real.
- TypeScript servidor y frontend: correctos, con declaraciones de navegación regeneradas.
- Build web: correcto, 175 módulos en 815 ms. `git diff --check`: correcto.
- No se ejecutó navegador/Playwright ni laboratorio. Dev principal confirmado en 5180.

Log local reproducible de la suite: `/tmp/perfiles-fisicos-suite.log`; typecheck del
servidor: `/tmp/perfiles-fisicos-tsc-final.log`; build: `/tmp/perfiles-fisicos-web-build.log`. Los logs temporales no se versionan;
los casos unitarios y de integración sí.
