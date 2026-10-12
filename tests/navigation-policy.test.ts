// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** B24 y A8: navegación de la ventana y permisos del renderer. */

import { describe, it, expect, vi } from 'vitest'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const h = vi.hoisted(() => ({
  setPermissionRequestHandler: null as null | ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void),
  setPermissionCheckHandler: null as null | ((wc: unknown, perm: string) => boolean)
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, on() {} },
  BrowserWindow: class {},
  shell: { openExternal() {} },
  session: {
    defaultSession: {
      setPermissionRequestHandler: (fn: any) => (h.setPermissionRequestHandler = fn),
      setPermissionCheckHandler: (fn: any) => (h.setPermissionCheckHandler = fn)
    }
  }
}))

import { isAllowedNavigation, installPermissionPolicy } from '../src/main/windows/main-window'

describe('B24: navegación de la ventana', () => {
  it('permite archivos dentro de la carpeta del renderer', () => {
    const inside = pathToFileURL(path.resolve('src/main/renderer/index.html')).toString()
    expect(isAllowedNavigation(inside)).toBe(true)
  })

  it('no confunde un prefijo parecido con la carpeta del renderer', () => {
    const sibling = pathToFileURL(path.resolve('src/main/renderer-evil/index.html')).toString()
    expect(isAllowedNavigation(sibling)).toBe(false)
  })

  it('bloquea web externa, scrakk-ext:, data:, javascript: y file: ajeno', () => {
    for (const url of [
      'https://evil.test/',
      'http://localhost:9999/',
      'scrakk-ext://acme.panel/index.html',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url'
    ]) {
      expect(isAllowedNavigation(url), url).toBe(false)
    }
  })
})

describe('A8: permisos denegados por defecto', () => {
  it('solo clipboard-sanitized-write queda permitido', () => {
    installPermissionPolicy()
    const granted: Record<string, boolean> = {}
    for (const perm of ['media', 'geolocation', 'notifications', 'clipboard-sanitized-write']) {
      h.setPermissionRequestHandler!({}, perm, (ok) => (granted[perm] = ok))
    }
    expect(granted).toEqual({
      media: false,
      geolocation: false,
      notifications: false,
      'clipboard-sanitized-write': true
    })
    expect(h.setPermissionCheckHandler!({}, 'media')).toBe(false)
  })
})
