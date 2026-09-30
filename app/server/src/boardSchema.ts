import { zodToJsonSchema } from 'zod-to-json-schema';
import { BoardDescriptorSchema, ModuleDefSchema } from '@emu/shared';

/**
 * JSON Schema del descriptor de placa (el bloque `board` del module.json) y del
 * module.json completo, generados desde los esquemas Zod de shared/ (la fuente de verdad).
 * Pensado para que un agente de IA o un dev arme una placa nueva y la valide antes de
 * importarla (POST /api/boards/validate).
 */
export function esquemaJsonPlaca(): { board: unknown; module: unknown } {
  return {
    board: zodToJsonSchema(BoardDescriptorSchema, { name: 'BoardDescriptor', $refStrategy: 'none' }),
    module: zodToJsonSchema(ModuleDefSchema, { name: 'ModuleDef', $refStrategy: 'none' }),
  };
}
