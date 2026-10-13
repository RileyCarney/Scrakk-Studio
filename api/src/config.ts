// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Configuración de la API, leída del entorno (ver `api/README.md`).
 */

export interface ApiConfig {
  host: string
  port: number
  store: 'memory' | 'supabase'
  /** Devuelve el código OTP en la respuesta (solo store `memory`, para dev/tests). */
  exposeOtp: boolean
  /** Orígenes permitidos para CORS (`*` = cualquiera). */
  corsOrigins: string[]
  /** Loguea cada request en stdout. */
  logRequests: boolean
  supabaseUrl: string
  supabaseKey: string
  /** API del CLI que manda/verifica el OTP por email (Resend). */
  cliApiBase: string
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const store = (env.SCRAKK_API_STORE ?? 'memory').trim().toLowerCase()
  if (store !== 'memory' && store !== 'supabase') {
    throw new Error(`SCRAKK_API_STORE must be "memory" or "supabase" (got "${store}").`)
  }
  const port = Number(env.SCRAKK_API_PORT ?? env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${env.SCRAKK_API_PORT ?? env.PORT}`)
  }
  return {
    host: env.SCRAKK_API_HOST ?? '127.0.0.1',
    port,
    store,
    // Nunca se expone el código contra Supabase: ahí el OTP llega por email.
    exposeOtp: store === 'memory' && flag(env.SCRAKK_API_EXPOSE_OTP, true),
    corsOrigins: (env.SCRAKK_API_CORS_ORIGINS ?? '*')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    logRequests: flag(env.SCRAKK_API_LOG, true),
    // Mismos defaults públicos que el IDE (src/main/account/config.ts).
    supabaseUrl: env.SCRAKK_SUPABASE_URL ?? 'https://ufcwwigmzgmyyfauymim.supabase.co',
    supabaseKey: env.SCRAKK_SUPABASE_KEY ?? 'sb_publishable_l3U5_bv_76IH3EPrffeK6g_YC9a1wzc',
    cliApiBase: env.SCRAKK_API_BASE ?? 'https://api.scrakk.art/api'
  }
}
