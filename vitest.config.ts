// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const r = (...parts: string[]): string => resolve(__dirname, ...parts)

export default defineConfig({
  resolve: {
    // Array ordenado: primero los prefijos largos para que '@ui/Modal' no
    // lo capture la clave exacta '@ui' (deep @ui/* fallaba con "Cannot find
    // package" en tests aunque Vite dev lo resuelve).
    alias: [
      { find: '@features/', replacement: r('src/renderer/src/features/') },
      { find: '@services/', replacement: r('src/renderer/src/services/') },
      { find: '@core/', replacement: r('src/renderer/src/core/') },
      { find: '@layout/', replacement: r('src/renderer/src/components/layout/') },
      { find: '@ui/', replacement: r('src/renderer/src/components/ui/') },
      { find: '@shared/', replacement: r('src/shared/') },
      { find: '@features', replacement: r('src/renderer/src/features') },
      { find: '@services', replacement: r('src/renderer/src/services') },
      { find: '@core', replacement: r('src/renderer/src/core') },
      { find: '@layout', replacement: r('src/renderer/src/components/layout') },
      { find: '@ui', replacement: r('src/renderer/src/components/ui/index.ts') },
      { find: '@shared', replacement: r('src/shared') }
    ]
  },
  // JSX de React 19 sin importar React en cada archivo (los tests de componentes).
  esbuild: { jsx: 'automatic' },
  // Define de build que el engine Innerta lee en import-time; sin esto
  // cualquier test que toque la cadena del editor muere con ReferenceError.
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_ID__: JSON.stringify('test')
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // T4: suelo por área, medido al introducirlo. Solo se sube, nunca se baja.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        'src/main/ipc/**': { lines: 19 },
        'src/main/web/**': { lines: 26 },
        'src/main/secrets/**': { lines: 75 },
        'src/renderer/src/services/ai/policy/**': { lines: 58 },
        'src/shared/**': { lines: 85 }
      }
    }
  }
})
