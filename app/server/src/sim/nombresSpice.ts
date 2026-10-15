/** SPICE ignora mayúsculas: asignación por identidad original, sin sanitización con pérdidas. */
export class NombresSpice {
  private readonly nombres = new Map<string, string>();
  constructor(private readonly prefijo: string) {}
  de(identidad: string): string {
    let nombre = this.nombres.get(identidad);
    if (nombre === undefined) {
      nombre = `${this.prefijo}${this.nombres.size + 1}`;
      this.nombres.set(identidad, nombre);
    }
    return nombre;
  }
}
