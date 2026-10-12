// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** Parser SSE del stream de chat (B11). */

import { describe, it, expect } from 'vitest'
import { createSseParser } from '../src/shared/sse'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

function collect(chunks: string[]): string[] {
  const parser = createSseParser()
  const out: string[] = []
  for (const chunk of chunks) out.push(...parser.push(bytes(chunk)))
  out.push(...parser.flush())
  return out
}

describe('createSseParser', () => {
  it('emite cada payload data: de un solo tramo', () => {
    expect(collect(['data: {"a":1}\n\ndata: {"a":2}\n\n'])).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('una línea cortada entre dos chunks se reconstruye', () => {
    expect(collect(['data: {"con', 'tent":"hola"}\n\n'])).toEqual(['{"content":"hola"}'])
  })

  it('un carácter UTF-8 partido entre chunks no se corrompe', () => {
    const full = bytes('data: {"t":"ñandú 🙂"}\n\n')
    const parser = createSseParser()
    const out: string[] = []
    // Se corta en medio del emoji (4 bytes).
    const cut = full.indexOf(0xf0) + 2
    out.push(...parser.push(full.slice(0, cut)))
    out.push(...parser.push(full.slice(cut)))
    out.push(...parser.flush())
    expect(out).toEqual(['{"t":"ñandú 🙂"}'])
  })

  it('la última línea sin \\n final se recupera en flush()', () => {
    expect(collect(['data: {"content":"fin"}'])).toEqual(['{"content":"fin"}'])
  })

  it('ignora [DONE], líneas vacías y líneas que no son data:', () => {
    expect(collect([': keep-alive\n\ndata: [DONE]\n\n\n'])).toEqual([])
  })
})
