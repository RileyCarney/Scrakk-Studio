// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** B4: store de API keys del main (cifrado, sin escritura en claro). */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => {
  const fsMod = require('node:fs') as typeof import('node:fs')
  const osMod = require('node:os') as typeof import('node:os')
  const pathMod = require('node:path') as typeof import('node:path')
  return {
    testDir: fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'scrakk-keys-')),
    available: true
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.testDir },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    // Transformación real (base64 con prefijo): el texto plano no aparece en el buffer.
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf-8').toString('base64'), 'utf-8'),
    decryptString: (b: Buffer) => {
      const text = b.toString('utf-8')
      if (!text.startsWith('enc:')) throw new Error('not encrypted')
      return Buffer.from(text.slice(4), 'base64').toString('utf-8')
    }
  }
}))

import { setProviderKey, getProviderKey, deleteProviderKey, listProviderKeyIds } from '../src/main/secrets/providerKeys'

const storeFile = (): string => path.join(h.testDir, 'secrets', 'provider-keys.bin')

describe('provider keys (B4)', () => {
  beforeEach(() => {
    h.available = true
    fs.rmSync(path.join(h.testDir, 'secrets'), { recursive: true, force: true })
  })

  it('guarda, lee, lista y borra una key', () => {
    expect(setProviderKey('openai', 'sk-1')).toEqual({ ok: true })
    expect(getProviderKey('openai')).toBe('sk-1')
    expect(listProviderKeyIds()).toEqual(['openai'])
    expect(deleteProviderKey('openai')).toEqual({ ok: true })
    expect(getProviderKey('openai')).toBeNull()
    expect(listProviderKeyIds()).toEqual([])
  })

  it('el archivo en disco NO contiene la key en claro', () => {
    setProviderKey('openai', 'sk-secreto-123')
    const onDisk = fs.readFileSync(storeFile(), 'utf-8')
    expect(onDisk).not.toContain('sk-secreto-123')
  })

  it('sin cifrado disponible, rechaza la escritura y no crea archivo', () => {
    h.available = false
    expect(setProviderKey('openai', 'sk-1')).toEqual({ ok: false, reason: 'no-encryption' })
    expect(fs.existsSync(storeFile())).toBe(false)
  })

  it('un archivo ilegible (keyring no listo) no se pisa', () => {
    setProviderKey('openai', 'sk-1')
    const before = fs.readFileSync(storeFile())
    h.available = false
    expect(setProviderKey('anthropic', 'sk-2')).toEqual({ ok: false, reason: 'unreadable' })
    expect(fs.readFileSync(storeFile())).toEqual(before)
    h.available = true
    expect(getProviderKey('openai')).toBe('sk-1')
  })

  it('no deja temporales tras escribir', () => {
    setProviderKey('openai', 'sk-1')
    expect(fs.readdirSync(path.dirname(storeFile()))).toEqual(['provider-keys.bin'])
  })

  it('una key vacía no cuenta como guardada', () => {
    setProviderKey('openai', '   ')
    expect(getProviderKey('openai')).toBeNull()
    expect(listProviderKeyIds()).toEqual([])
  })
})
