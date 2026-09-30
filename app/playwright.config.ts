import { defineConfig } from '@playwright/test';
import { cpSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Server propio para los e2e: otro puerto y una carpeta de proyectos temporal,
// así los tests no tocan los proyectos reales ni el server de desarrollo (5180).
const PORT = 5191;
const proyectos = (process.env.EMU_E2E_PROJECTS ??= mkdtempSync(path.join(os.tmpdir(), 'emu-e2e-')));
// Copia del catálogo de fábrica: los tests importan y quitan módulos sin tocar el real.
if (!process.env.EMU_E2E_MODULES) {
  process.env.EMU_E2E_MODULES = mkdtempSync(path.join(os.tmpdir(), 'emu-e2e-mod-'));
  cpSync(path.resolve(import.meta.dirname, '../modules'), process.env.EMU_E2E_MODULES, { recursive: true });
}
const modulos = process.env.EMU_E2E_MODULES;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: {
    // El Google Chrome instalado en la PC: no hace falta `npx playwright install`.
    channel: 'chrome',
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 950 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx server/src/index.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), EMU_PROJECTS_DIR: proyectos, EMU_MODULES_DIR: modulos },
    timeout: 30_000,
  },
});
