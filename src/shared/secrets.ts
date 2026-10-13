// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Contrato de las API keys de proveedores (B4). Las keys viven SOLO en el proceso
 * main, cifradas con `safeStorage`. El renderer nunca las recibe de vuelta: solo
 * sabe si existen.
 */

export const SECRETS_IPC = {
  setProviderKey: 'secrets:set-provider-key',
  deleteProviderKey: 'secrets:delete-provider-key',
  listProviderKeys: 'secrets:list-provider-keys'
} as const

export type SecretWriteError = 'no-encryption' | 'unreadable' | 'io'

export type SecretWriteResult = { ok: true } | { ok: false; reason: SecretWriteError }

export interface SecretsApi {
  /** Guarda la key cifrada. Falla (no guarda en claro) si el cifrado no está disponible. */
  setProviderKey: (providerId: string, apiKey: string) => Promise<SecretWriteResult>
  deleteProviderKey: (providerId: string) => Promise<SecretWriteResult>
  /** ids de proveedores con key guardada (sin valores). */
  listProviderKeys: () => Promise<string[]>
}
