// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Store MULTI-CUENTA persistente (safeStorage).
 *
 * Guarda la sesión de cada cuenta (access + refresh token) + un snapshot de su
 * perfil, y cuál es la activa.
 *
 * Robustez en Linux: `safeStorage.isEncryptionAvailable()` puede dar `false`
 * (o la keyring estar lista más tarde) y hacíamos que la sesión se perdiera al
 * reiniciar. Ahora:
 *  - READ: intenta descifrar; si no puede, cae a un archivo de texto (legacy /
 *    keyring no lista) en vez de devolver "sin cuentas".
 *  - WRITE: cifra si se puede; si no, escribe igual en texto plano con 0600
 *    (userData, solo el usuario) para no perder la sesión.
 */

import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AccountProfile, AccountSummary } from '@shared/account'

export interface StoredAccount {
  profile: AccountProfile
  accessToken: string
  refreshToken: string
}

interface Store {
  activeId: string | null
  accounts: Record<string, StoredAccount>
}

function emptyStore(): Store {
  return { activeId: null, accounts: {} }
}

function filePath(): string {
  return path.join(app.getPath('userData'), 'account', 'accounts.bin')
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Lee el store. Tres resultados, y solo `missing` es "vacío de verdad":
 *  - `ok`: se pudo leer (cifrado o texto plano legado).
 *  - `missing`: no hay archivo todavía (primer uso).
 *  - `unreadable`: el archivo existe pero no se pudo descifrar ni parsear
 *    (keyring no lista, truncado, corrupto). NUNCA se trata como vacío al
 *    escribir: eso borraba todas las cuentas guardadas (B3).
 */
type ReadResult = { status: 'ok'; store: Store } | { status: 'missing' } | { status: 'unreadable' }

function readResult(): ReadResult {
  let raw: Buffer
  try {
    raw = fs.readFileSync(filePath())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' }
  }
  let json: string | null = null
  if (canEncrypt()) {
    try {
      json = safeStorage.decryptString(raw)
    } catch {
      json = null
    }
  }
  if (json === null) {
    // Keyring no lista o archivo en texto plano legado: intentar tal cual.
    json = raw.toString('utf-8')
  }
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return { status: 'unreadable' }
    const store = parsed as Store
    return {
      status: 'ok',
      store: {
        activeId: typeof store.activeId === 'string' ? store.activeId : null,
        accounts: store.accounts && typeof store.accounts === 'object' ? store.accounts : {}
      }
    }
  } catch {
    return { status: 'unreadable' }
  }
}

/** Store para LEER: un archivo ilegible se ve como vacío (sin sesión), sin borrarlo. */
function read(): Store {
  const result = readResult()
  return result.status === 'ok' ? result.store : emptyStore()
}

/**
 * Aplica un cambio sobre el store y lo escribe. Si el archivo existe pero es
 * ilegible, NO escribe: el cambio se descarta y las cuentas guardadas quedan
 * intactas hasta que el keyring vuelva o el archivo se recupere.
 */
function mutate(apply: (store: Store) => void): void {
  const result = readResult()
  if (result.status === 'unreadable') {
    console.warn('[account] store ilegible (¿keyring no listo?): cambio descartado para no borrar cuentas')
    return
  }
  const store = result.status === 'ok' ? result.store : emptyStore()
  apply(store)
  write(store)
}

/**
 * Escritura atómica: se escribe a un temporal en el mismo directorio, se fuerza
 * a disco y recién entonces se renombra encima del archivo. Un corte a mitad
 * deja el archivo anterior intacto (antes: truncado = sesión perdida).
 */
function write(store: Store): void {
  const json = JSON.stringify(store)
  let buf: Buffer
  try {
    buf = canEncrypt() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf-8')
  } catch {
    buf = Buffer.from(json, 'utf-8')
  }
  const target = filePath()
  const tmp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, buf)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
  } catch {
    // Un fallo de disco no debe romper la sesión en memoria.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* noop */
    }
  }
}

export function getActiveId(): string | null {
  return read().activeId
}

export function getActive(): StoredAccount | null {
  const store = read()
  if (!store.activeId) return null
  return store.accounts[store.activeId] ?? null
}

export function getAccount(userId: string): StoredAccount | null {
  return read().accounts[userId] ?? null
}

/** Alta/actualización de una cuenta; la deja activa. */
export function upsertAccount(
  profile: AccountProfile,
  tokens: { accessToken: string; refreshToken: string }
): void {
  mutate((store) => {
    store.accounts[profile.id] = { profile, ...tokens }
    store.activeId = profile.id
  })
}

/** Actualiza solo los tokens (refresh) de una cuenta. */
export function updateTokens(userId: string, accessToken: string, refreshToken: string): void {
  mutate((store) => {
    const account = store.accounts[userId]
    if (!account) return
    account.accessToken = accessToken
    account.refreshToken = refreshToken
  })
}

/** Actualiza solo el snapshot de perfil. */
export function updateProfileSnapshot(profile: AccountProfile): void {
  mutate((store) => {
    const account = store.accounts[profile.id]
    if (!account) return
    account.profile = profile
  })
}

export function setActive(userId: string): boolean {
  let found = false
  mutate((store) => {
    if (!store.accounts[userId]) return
    store.activeId = userId
    found = true
  })
  return found
}

/** Elimina una cuenta. Devuelve el nuevo activo (o null). */
export function removeAccount(userId: string): string | null {
  let next: string | null = null
  mutate((store) => {
    delete store.accounts[userId]
    if (store.activeId === userId) {
      store.activeId = Object.keys(store.accounts)[0] ?? null
    }
    next = store.activeId
  })
  return next ?? read().activeId
}

/** Resumen para el switcher (sin tokens). */
export function listAccountSummaries(): AccountSummary[] {
  return Object.values(read().accounts).map((account) => ({
    id: account.profile.id,
    email: account.profile.email,
    displayName: account.profile.displayName,
    handle: account.profile.handle,
    avatarUrl: account.profile.avatarUrl
  }))
}

/** Borra todo (logout total). */
export function clearAll(): void {
  write(emptyStore())
}
