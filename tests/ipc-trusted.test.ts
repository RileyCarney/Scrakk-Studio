// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** A3: canales sensibles solo para la UI de la app. A7: log en memoria. */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, fn: any) => h.handlers.set(c, fn), on() {} },
  app: { getPath: () => '/tmp', isPackaged: false, on() {} },
  BrowserWindow: class {},
  shell: { openExternal() {} },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }
}))

import { isTrustedSender, handleTrusted } from '../src/main/ipc/trusted'
import { logError, recentErrors, clearLog } from '../src/main/log'

const appPage = pathToFileURL(path.resolve('src/main/renderer/index.html')).toString()
const sender = (url: string) => ({ senderFrame: { url } })

describe('A3: remitente confiable', () => {
  it('la propia página de la app es confiable', () => {
    expect(isTrustedSender(sender(appPage) as any)).toBe(true)
  })

  it('webviews de extensiones, web externa y frames sin URL no lo son', () => {
    for (const url of ['scrakk-ext://acme.panel/index.html', 'https://evil.test/', '']) {
      expect(isTrustedSender(sender(url) as any), url).toBe(false)
    }
    expect(isTrustedSender({ senderFrame: null } as any)).toBe(false)
  })

  it('handleTrusted responde con el valor de rechazo a remitentes ajenos', async () => {
    handleTrusted('test:secret', 'DENEGADO', () => 'valor-real')
    const fn = h.handlers.get('test:secret')!
    expect(await fn(sender('scrakk-ext://acme/x') as any)).toBe('DENEGADO')
    expect(await fn(sender(appPage) as any)).toBe('valor-real')
  })
})

describe('A7: log de errores del main', () => {
  beforeEach(() => {
    clearLog()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('guarda el alcance y el mensaje', () => {
    logError('window', new Error('boom'))
    const [entry] = recentErrors()
    expect(entry.scope).toBe('window')
    expect(entry.message).toContain('boom')
  })

  it('conserva solo los últimos 200 errores', () => {
    for (let i = 0; i < 250; i++) logError('loop', `error ${i}`)
    const all = recentErrors()
    expect(all).toHaveLength(200)
    expect(all[0].message).toBe('error 50')
    expect(all.at(-1)!.message).toBe('error 249')
  })
})
