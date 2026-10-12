// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Arranque de la API REST de Scrakk Studio.
 *
 *   npm run api                          # store en memoria (dev / Postman)
 *   SCRAKK_API_STORE=supabase npm run api  # contra el proyecto Supabase real
 *
 * Ver `api/README.md` para las variables de entorno y el contrato.
 */

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createApp } from './src/app.ts'
import { loadConfig, type ApiConfig } from './src/config.ts'
import { MemoryStore } from './src/store/memory.ts'
import { SupabaseStore } from './src/store/supabase.ts'
import type { Store } from './src/store/types.ts'

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function buildStore(config: ApiConfig, version: string): Store {
  return config.store === 'supabase' ? new SupabaseStore(config) : new MemoryStore({ version })
}

/** Levanta el servidor (exportado para tests y para embeber la API). */
export function startServer(config: ApiConfig = loadConfig()): Promise<Server> {
  const version = appVersion()
  const server = createServer(createApp({ store: buildStore(config, version), config, version }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => resolve(server))
  })
}

const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  const config = loadConfig()
  startServer(config)
    .then((server) => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : config.port
      console.log(`Scrakk Studio API listening on http://${config.host}:${port} (store: ${config.store})`)
      if (config.exposeOtp) console.log('OTP codes are returned as "devCode" (development mode).')
      const shutdown = (): void => {
        server.close(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((error: unknown) => {
      console.error('Could not start the API:', error)
      process.exit(1)
    })
}
