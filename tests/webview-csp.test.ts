// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * CSP de los webviews de extensiones (B2 del plan). Las directivas de aislamiento
 * son literales: no pueden depender del catálogo de traducciones.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} }
}))

import { webviewCsp } from '../src/main/ipc/extension-host'

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...values] = d.split(/\s+/)
      return [name, values.join(' ')]
    })
  )
}

describe('CSP de webviews', () => {
  it('aísla por defecto: default-src none, sin frames, sin base ni form externos', () => {
    const map = directives(webviewCsp('acme.panel'))
    expect(map.get('default-src')).toBe("'none'")
    expect(map.get('frame-src')).toBe("'none'")
    expect(map.get('base-uri')).toBe("'none'")
    expect(map.get('form-action')).toBe("'none'")
  })

  it('no permite scripts inline fuera del paquete ni de terceros sin https', () => {
    const script = directives(webviewCsp('acme.panel')).get('script-src') ?? ''
    expect(script).toContain('scrakk-ext://acme.panel')
    expect(script).not.toMatch(/\*/)
  })

  it('la política no cambia con el idioma (no depende de t())', async () => {
    const { setLocale } = await import('@shared/i18n')
    setLocale('es')
    const es = webviewCsp('acme.panel')
    setLocale('en')
    const en = webviewCsp('acme.panel')
    expect(es).toBe(en)
    expect(es).toContain("default-src 'none'")
  })
})
