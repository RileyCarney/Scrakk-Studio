// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** B17: el filtro de extensiones mira el nombre del archivo, no toda la ruta. */

import { describe, it, expect } from 'vitest'
import { PolicyEngine } from '../src/renderer/src/services/ai/policy/policy-engine'
import { PolicyDecision } from '../src/renderer/src/services/ai/policy/types'

const rule = { id: 'ts-only', extensions: ['.ts', '.tsx'] } as any

function check(path: string) {
  const engine = new PolicyEngine() as any
  return engine.evaluateExtensionFilter(rule, { path }).decision as PolicyDecision
}

describe('B17: evaluateExtensionFilter', () => {
  it('una extensión permitida en una carpeta con punto sigue permitida', () => {
    expect(check('proj.v2/src/a.ts')).toBe(PolicyDecision.ALLOW)
  })

  it('una carpeta con punto NO convierte un archivo sin extensión en denegado', () => {
    expect(check('proj.v2/Makefile')).toBe(PolicyDecision.ALLOW)
  })

  it('una extensión no permitida se deniega, sin importar mayúsculas', () => {
    expect(check('src/logo.PNG')).toBe(PolicyDecision.DENY)
    expect(check('build/x.v2/readme.md')).toBe(PolicyDecision.DENY)
  })

  it('una extensión permitida en mayúsculas se acepta', () => {
    expect(check('src/A.TS')).toBe(PolicyDecision.ALLOW)
  })
})
