// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * A7: registro mínimo del proceso principal. Escribe a consola y guarda los
 * últimos errores en memoria, para que un fallo no quede sin rastro cuando la
 * app sigue corriendo. Un archivo rotativo queda para una fase posterior.
 */

export interface LogEntry {
  at: number
  scope: string
  message: string
}

const MAX_ENTRIES = 200
const entries: LogEntry[] = []

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export function logError(scope: string, error: unknown): void {
  const message = describe(error)
  entries.push({ at: Date.now(), scope, message })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  console.error(`[${scope}]`, message)
}

/** Errores recientes, del más viejo al más nuevo (para diagnóstico). */
export function recentErrors(): readonly LogEntry[] {
  return entries.slice()
}

/** Solo para tests. */
export function clearLog(): void {
  entries.length = 0
}
