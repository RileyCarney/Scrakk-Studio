// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * A2: capas de docs/dev/architecture.md, verificadas por imports.
 *
 * - Reglas DURAS (cero violaciones, sin excepciones):
 *     shared no importa main, renderer ni electron; main no importa renderer.
 * - Reglas con DEUDA conocida (ratchet en tests/fixtures/layer-baseline.json):
 *     services no importa features, y components/ui no importa services/features.
 *     Se puede bajar el número por archivo, nunca subirlo ni agregar archivos.
 *
 * Es sin dependencias: ESLint con el parser de TypeScript no soporta todavía
 * el compilador 7 que usa el repo.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline: Record<string, number> = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/layer-baseline.json'), 'utf-8')
)

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiers(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8')
  const out: string[] = []
  for (const match of text.matchAll(IMPORT_RE)) out.push(match[1] ?? match[2])
  return out
}

const rel = (file: string): string => path.relative(root, file).split(path.sep).join('/')

describe('capas: reglas duras', () => {
  it('shared no importa main, renderer ni electron', () => {
    const bad: string[] = []
    for (const file of walk(path.join(root, 'src/shared'))) {
      for (const spec of specifiers(file)) {
        if (spec === 'electron' || spec.startsWith('electron/') || /(^|\/)main\//.test(spec) || /renderer/.test(spec)) {
          bad.push(`${rel(file)} → ${spec}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('main no importa el renderer', () => {
    const bad: string[] = []
    for (const file of walk(path.join(root, 'src/main'))) {
      for (const spec of specifiers(file)) {
        if (/renderer/.test(spec)) bad.push(`${rel(file)} → ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('capas: deuda con ratchet', () => {
  it('services no importa features, y no crece por archivo', () => {
    const current: Record<string, number> = {}
    for (const file of walk(path.join(root, 'src/renderer/src/services'))) {
      const n = specifiers(file).filter((s) => /^@features/.test(s)).length
      if (n) current[rel(file)] = n
    }
    const grew = Object.entries(current).filter(([file, n]) => n > (baseline[file] ?? 0))
    expect(grew, 'nuevas violaciones services→features').toEqual([])
  })

  it('components/ui no importa services, features ni layout', () => {
    const current: Record<string, number> = {}
    for (const file of walk(path.join(root, 'src/renderer/src/components/ui'))) {
      const n = specifiers(file).filter((s) => /^@(services|features|layout)/.test(s)).length
      if (n) current[rel(file)] = n
    }
    const grew = Object.entries(current).filter(([file, n]) => n > (baseline[file] ?? 0))
    expect(grew, 'nuevas violaciones ui→services/features/layout').toEqual([])
  })

  it('la deuda registrada no tiene archivos que ya no existen', () => {
    const missing = Object.keys(baseline).filter((file) => !fs.existsSync(path.join(root, file)))
    expect(missing, 'quitar del baseline los archivos eliminados').toEqual([])
  })
})
