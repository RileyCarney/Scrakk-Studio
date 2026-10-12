// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * T7: propiedades que deben valer para cualquier entrada, no solo para los casos
 * escritos a mano. Cubren los parsers y filtros de seguridad.
 */

import { describe, it, expect, vi } from 'vitest'
import * as path from 'node:path'
import * as fc from 'fast-check'

vi.mock('electron', () => ({ ipcMain: { handle() {}, on() {} }, app: { getPath: () => '/tmp' } }))

import { createSseParser } from '../src/shared/sse'
import { isDangerousCommand } from '../src/renderer/src/services/ai/policy/shell-safety'
import { heuristicBashVerdict } from '../src/renderer/src/services/ai/policy/autoMode'
import { resolveInRepo } from '../src/main/ipc/git'

/** Parte un buffer en trozos de tamaño arbitrario. */
function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b)
  const out: Uint8Array[] = []
  let last = 0
  for (const p of points) {
    out.push(bytes.slice(last, p))
    last = p
  }
  out.push(bytes.slice(last))
  return out
}

describe('SSE: el resultado no depende de cómo se parte el stream', () => {
  it('cualquier partición da los mismos payloads', () => {
    const payloadArb = fc.array(fc.jsonValue().map((v) => JSON.stringify(v)), { minLength: 1, maxLength: 6 })
    fc.assert(
      fc.property(payloadArb, fc.array(fc.nat(), { maxLength: 12 }), (payloads, cuts) => {
        const text = payloads.map((p) => `data: ${p}\n\n`).join('')
        const bytes = new TextEncoder().encode(text)

        const whole = createSseParser()
        const expected = [...whole.push(bytes), ...whole.flush()]

        const parts = createSseParser()
        const got: string[] = []
        for (const piece of splitAt(bytes, cuts)) got.push(...parts.push(piece))
        got.push(...parts.flush())

        expect(got).toEqual(expected)
        expect(expected).toEqual(payloads)
      }),
      { numRuns: 300 }
    )
  })
})

describe('resolveInRepo: nunca devuelve una ruta que escape del repo', () => {
  it('si acepta una ruta, la resuelta queda dentro del cwd', () => {
    const cwd = path.resolve('/srv/repo')
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (rel) => {
        const out = resolveInRepo(cwd, rel)
        if (out === null) return
        const abs = path.resolve(cwd, out)
        expect(abs === cwd || abs.startsWith(cwd + path.sep)).toBe(true)
      }),
      { numRuns: 1000 }
    )
  })
})

describe('clasificador de shell y modo auto', () => {
  it('nunca lanza y siempre devuelve un nivel conocido', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (cmd) => {
        const level = isDangerousCommand(cmd).riskLevel
        expect(['low', 'medium', 'high', 'critical']).toContain(level)
        expect(['allow', 'ask']).toContain(heuristicBashVerdict(cmd))
      }),
      { numRuns: 500 }
    )
  })

  it('un comando con sustitución de shell nunca se auto-aprueba', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (inner) => {
        expect(heuristicBashVerdict(`echo $(${inner.replace(/[`$]/g, '')})`)).toBe('ask')
      }),
      { numRuns: 300 }
    )
  })
})
