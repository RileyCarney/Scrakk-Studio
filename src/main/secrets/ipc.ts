// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import { ipcMain } from 'electron'
import { SECRETS_IPC, type SecretWriteResult } from '@shared/secrets'
import { deleteProviderKey, listProviderKeyIds, setProviderKey } from './providerKeys'

/** Registra los canales de API keys. Nunca devuelven el valor de una key. */
export function registerSecretsIpc(): void {
  ipcMain.handle(
    SECRETS_IPC.setProviderKey,
    (_event, providerId: unknown, apiKey: unknown): SecretWriteResult => {
      if (typeof providerId !== 'string' || !providerId || typeof apiKey !== 'string') {
        return { ok: false, reason: 'io' }
      }
      return setProviderKey(providerId, apiKey.trim())
    }
  )
  ipcMain.handle(SECRETS_IPC.deleteProviderKey, (_event, providerId: unknown): SecretWriteResult => {
    if (typeof providerId !== 'string' || !providerId) return { ok: false, reason: 'io' }
    return deleteProviderKey(providerId)
  })
  ipcMain.handle(SECRETS_IPC.listProviderKeys, (): string[] => listProviderKeyIds())
}
