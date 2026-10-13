// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import { SECRETS_IPC, type SecretWriteResult } from '@shared/secrets'
import { deleteProviderKey, listProviderKeyIds, setProviderKey } from './providerKeys'
import { handleTrusted } from '../ipc/trusted'

/** Registra los canales de API keys. Nunca devuelven el valor de una key. */
export function registerSecretsIpc(): void {
  const denied: SecretWriteResult = { ok: false, reason: 'io' }
  handleTrusted(SECRETS_IPC.setProviderKey, denied, (_event, providerId, apiKey): SecretWriteResult => {
    if (typeof providerId !== 'string' || !providerId || typeof apiKey !== 'string') return denied
    return setProviderKey(providerId, apiKey.trim())
  })
  handleTrusted(SECRETS_IPC.deleteProviderKey, denied, (_event, providerId): SecretWriteResult => {
    if (typeof providerId !== 'string' || !providerId) return denied
    return deleteProviderKey(providerId)
  })
  handleTrusted(SECRETS_IPC.listProviderKeys, [] as string[], (): string[] => listProviderKeyIds())
}
