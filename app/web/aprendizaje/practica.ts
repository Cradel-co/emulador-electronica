/** Reintenta una consulta de recuperación solo ante un error de transporte del POST. */
export async function crearConRecuperacion<T>(crear: () => Promise<T>, recuperar: () => Promise<T | null>): Promise<T> {
  try {
    return await crear();
  } catch (error) {
    // Los errores HTTP son Error; fetch usa TypeError cuando la respuesta no llegó al cliente.
    if (!(error instanceof TypeError)) throw error;
    try {
      const resultado = await recuperar();
      if (resultado !== null) return resultado;
    } catch {
      // Si también falló el GET, conservamos el error original del POST para permitir reintentar.
    }
    throw error;
  }
}
