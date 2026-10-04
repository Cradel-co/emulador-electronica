import { z } from 'zod';

export const CameraDescriptorSchema = z.object({
  maxWidth: z.number().int().positive().max(640).default(640),
  maxHeight: z.number().int().positive().max(480).default(480),
  maxBytes: z.number().int().positive().max(1048576).default(1048576),
  hardware: z.literal('arducam-mini-2mp-plus').optional(),
  quality: z.number().positive().max(1).default(0.8),
}).strict();
export type CameraDescriptor = z.infer<typeof CameraDescriptorSchema>;
export interface CameraSession { id: string; expiresAt: number }
export const CameraCaptureSchema = z.object({
  requestId: z.string().optional(), sha256: z.string().optional(),
  id: z.string(), project: z.string(), instance: z.string(), number: z.number().int(),
  width: z.number().int(), height: z.number().int(), size: z.number().int(), receivedAt: z.number(),
});
export type CameraCapture = z.infer<typeof CameraCaptureSchema>;
export const CameraStatusSchema = z.object({ active: z.boolean(), expiresAt: z.number().nullable(), capture: CameraCaptureSchema.nullable() });
export type CameraStatus = z.infer<typeof CameraStatusSchema>;
export interface CameraErrorResponse { code: string; message: string }
