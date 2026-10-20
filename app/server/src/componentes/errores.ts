export type CodigoErrorComponente = 'FORMATO' | 'LIMITE' | 'VERSION_CONFLICTIVA' | 'CICLO'
  | 'DEFINICION_AUSENTE' | 'HASH_DISTINTO' | 'PARAMETRO' | 'PUERTO_AUSENTE'
  | 'DOMINIO_INCOMPATIBLE' | 'ANCHO_INCOMPATIBLE' | 'MULTIPLES_SALIDAS'
  | 'PAQUETE_INVALIDO' | 'PUERTO_INCOMPATIBLE' | 'MODELO_INVALIDO' | 'SIN_MODELO';

/** Diagnóstico de dominio: la ruta identifica la instancia sin confundir nombres de hojas. */
export class ErrorComponente extends Error {
  override readonly name = 'ErrorComponente';
  readonly ruta: string[];
  constructor(readonly codigo: CodigoErrorComponente, readonly detalle: string, ruta: readonly string[] = []) {
    super(`${detalle} (ruta: ${JSON.stringify(ruta)})`);
    this.ruta = [...ruta];
  }
}
