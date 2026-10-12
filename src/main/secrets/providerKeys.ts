// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Store de API keys de proveedores (B4).
 *
 * A diferencia del store de cuentas, NUNCA escribe en claro: si `safeStorage` no
 * está disponible, la escritura se rechaza y el renderer lo muestra. Antes las
 * keys quedaban en `localStorage`, legibles por cualquier script del renderer y
 * por quien tuviera acceso al perfil de Chromium.
 *
 * Escritura atómica (temporal + fsync + rename). Un archivo que existe pero no
 * se puede descifrar NO se pisa: las keys guardadas no se pierden por un keyring
 * que todavía no está listo.
 */

import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SecretWriteResult } from '@shared/secrets'

type Keys = Record<string, string>

type ReadResult = { status: 'ok'; keys: Keys } | { status: 'missing' } | { status: 'unreadable' }

function filePath(): string {
  return path.join(app.getPath('userData'), 'secrets', 'provider-keys.bin')
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function readKeys(): ReadResult {
  let raw: Buffer
  try {
    raw = fs.readFileSync(filePath())
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable' }
  }
  if (!canEncrypt()) return { status: 'unreadable' }
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(raw))
    if (!parsed || typeof parsed !== 'object') return { status: 'unreadable' }
    const keys: Keys = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') keys[id] = value
    }
    return { status: 'ok', keys }
  } catch {
    return { status: 'unreadable' }
  }
}

function writeKeys(keys: Keys): SecretWriteResult {
  if (!canEncrypt()) return { ok: false, reason: 'no-encryption' }
  const target = filePath()
  const tmp = `${target}.tmp`
  try {
    const buf = safeStorage.encryptString(JSON.stringify(keys))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, buf)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
    return { ok: true }
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* noop */
    }
    return { ok: false, reason: 'io' }
  }
}

/** Aplica un cambio sobre las keys; si el archivo es ilegible, no escribe. */
function mutate(apply: (keys: Keys) => void): SecretWriteResult {
  const current = readKeys()
  if (current.status === 'unreadable') return { ok: false, reason: 'unreadable' }
  const keys = current.status === 'ok' ? current.keys : {}
  apply(keys)
  return writeKeys(keys)
}

export function setProviderKey(providerId: string, apiKey: string): SecretWriteResult {
  return mutate((keys) => {
    keys[providerId] = apiKey
  })
}

export function deleteProviderKey(providerId: string): SecretWriteResult {
  return mutate((keys) => {
    delete keys[providerId]
  })
}

/** Key en claro para el proceso main (solo la usa `ipc/llm.ts` al armar el request). */
export function getProviderKey(providerId: string): string | null {
  const current = readKeys()
  if (current.status !== 'ok') return null
  const key = current.keys[providerId]
  return key && key.trim() ? key.trim() : null
}

/** ids con key guardada, sin valores. */
export function listProviderKeyIds(): string[] {
  const current = readKeys()
  if (current.status !== 'ok') return []
  return Object.keys(current.keys).filter((id) => current.keys[id].trim())
}
