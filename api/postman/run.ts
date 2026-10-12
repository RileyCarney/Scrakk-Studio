// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Corre la suite de Postman de punta a punta sin pasos manuales:
 * levanta la API (store en memoria) en un puerto libre, ejecuta la colección
 * con Newman y devuelve su código de salida.
 *
 *   npm run api:postman                      # API efímera en memoria
 *   npm run api:postman -- --base-url URL    # contra una API ya levantada
 *
 * Los argumentos extra se pasan a Newman (p. ej. `-n 3`, `--reporters cli,junit`).
 */

import { spawn } from 'node:child_process'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.ts'
import { startServer } from '../server.ts'

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url))
const COLLECTION = here('./scrakk-studio-api.postman_collection.json')
const ENVIRONMENT = here('./scrakk-studio-api.local.postman_environment.json')

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flagAt = args.indexOf('--base-url')
  let baseUrl = flagAt >= 0 ? args[flagAt + 1] : undefined
  if (flagAt >= 0) args.splice(flagAt, 2)

  let server: Server | null = null
  if (!baseUrl) {
    const config = { ...loadConfig(), store: 'memory' as const, exposeOtp: true, port: 0, logRequests: false }
    server = await startServer(config)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    console.log(`API (memory store) listening on ${baseUrl}`)
  }

  const newmanArgs = ['--yes', 'newman@6', 'run', COLLECTION, '-e', ENVIRONMENT, '--env-var', `baseUrl=${baseUrl}`, ...args]
  const code = await new Promise<number>((resolve) => {
    const child = spawn('npx', newmanArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (exitCode) => resolve(exitCode ?? 1))
    child.on('error', (error) => {
      console.error('Could not run newman:', error.message)
      resolve(1)
    })
  })
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  return code
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
