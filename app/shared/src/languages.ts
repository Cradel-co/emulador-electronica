import { z } from 'zod';

/** Lenguajes de programación de la app (separado de project.ts para que board.ts lo use sin ciclos). */
export const LANGUAGES = ['esphome', 'idf-c', 'idf-cpp', 'arduino', 'micropython'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LanguageSchema = z.enum(LANGUAGES);
