// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Regresiones de M2 del plan: B6 (terminal sin shell válido), B8 (escaneo de
 * repos asíncrono), B21 (tope de lectura), B23 (guardado atómico).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  spawnError: null as Error | null
}))

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

vi.mock('node-pty', () => ({
  spawn: () => {
    if (h.spawnError) throw h.spawnError
    return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }
  }
}))

import { FS_IPC } from '../src/shared/fs'
import { GIT_IPC } from '../src/shared/git'
import { TERMINAL_IPC } from '../src/shared/terminal'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrakk-m2-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  h.spawnError = null
})

describe('B21: readFile respeta el tope de tamaño', () => {
  it('un archivo mayor que maxBytes devuelve too-large sin leerlo', async () => {
    const { registerFsIpc } = await import('../src/main/ipc/fs')
    registerFsIpc()
    const file = path.join(dir, 'grande.log')
    fs.writeFileSync(file, 'x'.repeat(2000))

    const res = await h.handlers.get(FS_IPC.readFile)!({}, { path: file, maxBytes: 100 })
    expect(res.success).toBe(false)
    expect(res.code).toBe('too-large')
    expect(res.size).toBe(2000)
    expect(res.content).toBeUndefined()
  })

  it('un archivo dentro del tope se lee completo', async () => {
    const { registerFsIpc } = await import('../src/main/ipc/fs')
    registerFsIpc()
    const file = path.join(dir, 'chico.txt')
    fs.writeFileSync(file, 'hola')
    const res = await h.handlers.get(FS_IPC.readFile)!({}, { path: file })
    expect(res).toEqual({ success: true, content: 'hola' })
  })
})

describe('B23: el guardado es atómico y conserva modo y symlinks', () => {
  beforeEach(async () => {
    const { registerFsIpc } = await import('../src/main/ipc/fs')
    registerFsIpc()
  })

  it('reemplaza el contenido y no deja temporales', async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'viejo')
    const res = await h.handlers.get(FS_IPC.writeFile)!({}, { path: file, content: 'nuevo' })
    expect(res.success).toBe(true)
    expect(fs.readFileSync(file, 'utf-8')).toBe('nuevo')
    expect(fs.readdirSync(dir)).toEqual(['a.ts'])
  })

  it('conserva el modo del archivo (p. ej. scripts ejecutables)', async () => {
    if (process.platform === 'win32') return
    const file = path.join(dir, 'run.sh')
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o755)
    await h.handlers.get(FS_IPC.writeFile)!({}, { path: file, content: '#!/bin/sh\necho 2\n' })
    expect(fs.statSync(file).mode & 0o777).toBe(0o755)
  })

  it('escribe a través de un symlink en vez de reemplazar el enlace', async () => {
    if (process.platform === 'win32') return
    const real = path.join(dir, 'real.txt')
    const link = path.join(dir, 'link.txt')
    fs.writeFileSync(real, 'a')
    fs.symlinkSync(real, link)
    await h.handlers.get(FS_IPC.writeFile)!({}, { path: link, content: 'b' })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toBe('b')
  })
})

describe('B8: detectRepos encuentra los repos sin bloquear', () => {
  it('encuentra repos anidados y devuelve su toplevel', async () => {
    const { registerGitIpc } = await import('../src/main/ipc/git')
    registerGitIpc()
    const one = path.join(dir, 'uno')
    const two = path.join(dir, 'grupo', 'dos')
    for (const repo of [one, two]) {
      fs.mkdirSync(repo, { recursive: true })
      execFileSync('git', ['init', '-q', repo])
    }
    const res = await h.handlers.get(GIT_IPC.detectRepos)!({}, { root: dir })
    expect(res.ok).toBe(true)
    const tops = res.data.map((r: { toplevel: string }) => fs.realpathSync(r.toplevel)).sort()
    expect(tops).toEqual([fs.realpathSync(one), fs.realpathSync(two)].sort())
  })
})

describe('B6: la terminal informa un fallo de spawn sin lanzar', () => {
  it('un shell que no arranca devuelve success false', async () => {
    const { registerTerminalIpc } = await import('../src/main/ipc/terminal')
    registerTerminalIpc()
    h.spawnError = new Error('shell no encontrado')
    const sender = { id: 1, isDestroyed: () => false, send() {}, once() {} }
    const res = await h.handlers.get(TERMINAL_IPC.create)!({ sender }, { id: 't1', shell: 'bash', cwd: dir, cols: 80, rows: 24 })
    expect(res.success).toBe(false)
    expect(res.error).toContain('shell no encontrado')
  })

  it('un cwd inexistente cae al home y la terminal arranca', async () => {
    const { registerTerminalIpc } = await import('../src/main/ipc/terminal')
    registerTerminalIpc()
    const sender = { id: 2, isDestroyed: () => false, send() {}, once() {} }
    const res = await h.handlers.get(TERMINAL_IPC.create)!(
      { sender },
      { id: 't2', shell: '/bin/sh', cwd: path.join(dir, 'no-existe'), cols: 80, rows: 24 }
    )
    expect(res.success).toBe(true)
  })
})
