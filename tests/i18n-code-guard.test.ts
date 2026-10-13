// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * A10: el catálogo de traducciones guarda TEXTO de UI. Un valor con pinta de
 * código (CSP, HTML, script) es un error de extracción, como el de B2, donde las
 * directivas de seguridad se traducían.
 *
 * Las etiquetas con comandos git (`Fetch --all --prune`) son texto de UI legítimo
 * y no coinciden con estos patrones.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CODE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'directiva CSP', re: /(^|;\s*)(default|script|style|img|font|connect|frame|base|form|media)-(src|uri|action)\b/ },
  { name: 'palabra clave CSP', re: /'(none|self|unsafe-inline|unsafe-eval|wasm-unsafe-eval)'/ },
  { name: 'HTML o script', re: /<\/?(script|img|svg|iframe|object|style)\b/i },
  { name: 'URL javascript:/data:', re: /\b(javascript|data):/i }
]

function catalogEntries(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = []
  for (const loc of ['en', 'es']) {
    const dir = path.join(root, 'src/shared/i18n/catalogs', loc)
    for (const file of fs.readdirSync(dir)) {
      const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as Record<string, string>
      for (const [key, value] of Object.entries(json)) out.push([loc, key, value])
    }
  }
  return out
}

describe('catálogos: sin código colado como texto de UI', () => {
  it('ningún valor tiene forma de CSP, HTML o URL peligrosa', () => {
    const bad: string[] = []
    for (const [loc, key, value] of catalogEntries()) {
      for (const { name, re } of CODE_PATTERNS) {
        if (re.test(value)) bad.push(`${loc} ${key}: ${name} → ${value}`)
      }
    }
    expect(bad).toEqual([])
  })
})
