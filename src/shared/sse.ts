// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Parser SSE mínimo para streams de chat (`data: {json}` por línea).
 *
 * Es puro (sin red ni Electron) para poder testearlo. Maneja lo que el parser
 * ingenuo rompía (B11):
 *  - un chunk que corta una línea a la mitad (se acumula hasta el `\n`);
 *  - caracteres UTF-8 partidos entre dos chunks (decoder en modo stream);
 *  - la última línea sin `\n` final (se recupera en `flush()`).
 */

export interface SseParser {
  /** Recibe bytes; devuelve los payloads `data:` completos de este tramo. */
  push(chunk: Uint8Array): string[]
  /** Fin del stream: devuelve lo que quedó pendiente, incluido el último `data:` sin `\n`. */
  flush(): string[]
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder()
  let pending = ''

  const takeData = (line: string): string | null => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return null
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return null
    return payload
  }

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      return lines.map(takeData).filter((p): p is string => p !== null)
    },
    flush() {
      pending += decoder.decode()
      const rest = pending
      pending = ''
      const payload = takeData(rest)
      return payload === null ? [] : [payload]
    }
  }
}
