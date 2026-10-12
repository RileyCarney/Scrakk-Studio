// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Regresiones de M1 del plan: B10 (exitCode de execCommand), B13 (regex de
 * autenticación de git), B14 (`..nombre` válido dentro del repo), B15 (git
 * instalado después de arrancar).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn)
  },
  dialog: {},
  shell: {},
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }
}))

import { FS_IPC } from '../src/shared/fs'
import { GIT_IPC } from '../src/shared/git'

describe('B10: execCommand devuelve exitCode numérico', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scrakk-exec-'))
    const { registerFsIpc } = await import('../src/main/ipc/fs')
    registerFsIpc()
  })
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))

  const exec = (request: Record<string, unknown>) => h.handlers.get(FS_IPC.execCommand)!({}, request)

  it('un exit code real se devuelve tal cual', async () => {
    const res = await exec({ command: 'exit 3', cwd })
    expect(res.success).toBe(false)
    expect(res.exitCode).toBe(3)
  })

  it('un cwd inexistente da exitCode 1 y el motivo en stderr (no "ENOENT")', async () => {
    const res = await exec({ command: 'echo hola', cwd: path.join(cwd, 'no-existe') })
    expect(res.success).toBe(false)
    expect(res.exitCode).toBe(1)
    expect(typeof res.exitCode).toBe('number')
    expect(res.stderr.length).toBeGreaterThan(0)
  })

  it('un timeout marca timedOut y mantiene exitCode numérico', async () => {
    const res = await exec({ command: 'sleep 5', cwd, timeoutMs: 100 })
    expect(res.timedOut).toBe(true)
    expect(typeof res.exitCode).toBe('number')
  })
})

describe('B13: la regex de autenticación no matchea dígitos sueltos', () => {
  it('reconoce los 401/403 reales de git y HTTP', async () => {
    const { mapFailure } = await import('../src/main/ipc/git')
    const base = { ok: false as const, code: 128, stdout: '', timedOut: false }
    const auth = (stderr: string) => mapFailure({ ...base, stderr }, 'push').error?.code
    expect(auth("fatal: unable to access 'https://x.test/r/': The requested URL returned error: 403")).toBe('auth')
    expect(auth('remote: HTTP/1.1 401 Unauthorized')).toBe('auth')
  })

  it('un número que contiene 403/401 NO es un error de autenticación', async () => {
    const { mapFailure } = await import('../src/main/ipc/git')
    const base = { ok: false as const, code: 128, stdout: '', timedOut: false }
    const code = (stderr: string) => mapFailure({ ...base, stderr }, 'log').error?.code
    expect(code('fatal: pack exceeds limit of 1403 objects')).toBe('failed')
    expect(code('error: object 4031abc is corrupt')).toBe('failed')
  })
})

describe('B14: resolveInRepo acepta nombres que empiezan con ..', () => {
  it('`..env.local` es un archivo válido del repo', async () => {
    const { resolveInRepo } = await import('../src/main/ipc/git')
    expect(resolveInRepo('/repo', '..env.local')).toBe('..env.local')
  })

  it('los escapes siguen bloqueados', async () => {
    const { resolveInRepo } = await import('../src/main/ipc/git')
    expect(resolveInRepo('/repo', '..')).toBeNull()
    expect(resolveInRepo('/repo', '../secreto')).toBeNull()
    expect(resolveInRepo('/repo', 'a/../../secreto')).toBeNull()
    // Una ruta absoluta se une al repo (no escapa): queda dentro.
    expect(resolveInRepo('/repo', '/etc/passwd')).toBe('etc/passwd')
  })
})

describe('B15: git instalado después de arrancar se detecta', () => {
  it('un fallo de "no hay git" no queda cacheado', async () => {
    vi.resetModules()
    h.handlers.clear()
    const git = await import('../src/main/ipc/git')
    git.registerGitIpc()
    const version = h.handlers.get(GIT_IPC.version)!

    const original = process.env.PATH
    try {
      process.env.PATH = ''
      const missing = await version({}, undefined)
      expect(missing.ok).toBe(false)

      process.env.PATH = original
      const later = await version({}, undefined)
      expect(later.ok).toBe(true)
    } finally {
      process.env.PATH = original
    }
  })
})
