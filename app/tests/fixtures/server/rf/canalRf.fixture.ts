/** Caso sintético: estos valores no caracterizan ningún módulo comercial del catálogo. */
export function enlaceRfDePrueba() {
  return {
    frecuenciaHz: 299792458,
    distanciaM: 100,
    dominio: { espacioLibre: true, lineaDeVista: true, campoLejano: true, sinMultitrayecto: true, sinInterferencias: true },
    transmisor: { id: 'control', modelo: 'TX sintético', fuente: 'oráculo analítico', condiciones: 'potencia en el puerto TX antes de las pérdidas declaradas',
      potencia: { valor: 0, unidad: 'dBm' as const }, gananciaDbi: 0, perdidasDb: 0, dimensionAntenaM: 0.1 },
    receptor: { id: 'rx', modelo: 'RX sintético', fuente: 'umbral sintético, sin atribución comercial', condiciones: 'criterio determinista del test',
      gananciaDbi: 0, perdidasDb: 0, dimensionAntenaM: 0.1, sensibilidadDbm: -70 },
    polarizacion: { tipo: 'lineal' as const, anguloGrados: 0 },
    configuracion: { modulacion: 'OOK', tasaBitsPorS: 2000, anchoBandaHz: 10000 },
  };
}
