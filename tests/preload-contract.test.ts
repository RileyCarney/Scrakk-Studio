// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * T2: contrato preload ↔ main. Cada canal que el preload usa (`X_IPC.clave`)
 * tiene que estar también en el lado main, ya sea como handler (`handle`/`on`)
 * o como evento que el main envía (`send`). Así un canal renombrado o
 * olvidado falla en CI, en vez de como un `invoke` sin respuesta en la app.
 *
 * El chequeo es por nombre de constante: el valor de cada canal vive en
 * `src/shared` y ambos lados lo importan.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHANNEL_REF = /\b([A-Z_]+_IPC)\.([A-Za-z0-9_]+)/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

function channelRefs(text: string): Set<string> {
  return new Set([...text.matchAll(CHANNEL_REF)].map((m) => `${m[1]}.${m[2]}`))
}

describe('contrato preload ↔ main', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf-8')
  const mainText = walk(path.join(root, 'src/main')).map((f) => fs.readFileSync(f, 'utf-8')).join('\n')

  it('el preload usa canales conocidos', () => {
    expect(channelRefs(preload).size).toBeGreaterThan(100)
  })

  it('cada canal del preload lo maneja o emite el main', () => {
    const missing = [...channelRefs(preload)].filter((ref) => !channelRefs(mainText).has(ref))
    expect(missing, 'canales sin contraparte en main').toEqual([])
  })
})
