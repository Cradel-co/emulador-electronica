/** Diagnóstico previamente resuelto: null indica que esta placa puede seguir ejecutándose. */
export interface DiagnosticoEnergiaPlaca {
  id: string;
  motivo: string | null;
}

export interface MotorDetenible {
  getStatus(): { running: boolean };
  stop(): Promise<void>;
}

/**
 * Aplica el diagnóstico por placa, conservando las demás corridas independientes.
 * Espera cada parada y propaga su error: el host conserva y publica el diagnóstico original.
 */
export async function pararPlacasSinEnergia(
  placas: readonly DiagnosticoEnergiaPlaca[],
  motores: ReadonlyMap<string, MotorDetenible>,
  vigente: () => boolean = () => true,
): Promise<string[]> {
  const paradas: string[] = [];
  const vistos = new Set<string>();
  for (const placa of placas) {
    if (!vigente()) break;
    if (placa.motivo === null || vistos.has(placa.id)) continue;
    const motor = motores.get(placa.id);
    if (!motor?.getStatus().running) continue;
    vistos.add(placa.id);
    await motor.stop();
    paradas.push(placa.id);
  }
  return paradas;
}
