// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Validación de entrada de la API. Las reglas salen de `src/shared` (las mismas
 * que usa el IDE) y de las migraciones SQL (handles reservados, límites de
 * presencia, archivos compartidos). Todo lo que falla lanza `ApiError` 400/422.
 */

import { ACCOUNT_RULES } from '../../src/shared/account.ts'
import { SOCIAL_RULES } from '../../src/shared/social.ts'
import { badRequest, unprocessable } from './http.ts'
import type { CodeFileUpload, PresenceActivity, PresenceStatus, ProfilePatch } from './store/types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const PRESENCE_STATUSES: readonly PresenceStatus[] = ['online', 'away', 'busy', 'offline']

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest('missing_field', `"${field}" is required.`, { field })
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw badRequest('invalid_field', `"${field}" must be a string or null.`, { field })
  }
  return value
}

export function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) {
    throw unprocessable('invalid_id', `"${field}" must be a UUID.`, { field })
  }
  return value.toLowerCase()
}

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!ACCOUNT_RULES.email.test(email)) {
    throw unprocessable('invalid_email', 'Email address is not valid.', { field: 'email' })
  }
  return email
}

export function normalizeOtp(raw: string): string {
  const code = raw.trim()
  if (!ACCOUNT_RULES.code.test(code)) {
    throw unprocessable('invalid_code_format', 'The code must be 6 digits.', { field: 'code' })
  }
  return code
}

/** Espejo de `public.handle_is_reserved` (migración 0008). */
export function isReservedHandle(handle: string): boolean {
  const h = handle.toLowerCase()
  if (h.includes('scrakk')) return true
  if ((ACCOUNT_RULES.handleReserved as readonly string[]).includes(h)) return true
  return /^(admin|root|support|system|official|mod|moderator|staff|help)([._-].*)?$/.test(h)
}

/** Valida un PATCH de perfil. `null` o "" borran el campo; ausente = no tocar. */
export function parseProfilePatch(body: Record<string, unknown>): ProfilePatch {
  const patch: ProfilePatch = {}
  const text = (field: string): string | null | undefined => {
    const value = optionalString(body, field)
    if (value === undefined || value === null) return value
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  const tooLong = (field: string, max: number): never => {
    throw unprocessable('field_too_long', `"${field}" must be at most ${max} characters.`, {
      field,
      max
    })
  }

  const displayName = text('displayName')
  if (displayName && displayName.length > ACCOUNT_RULES.displayNameMax) {
    tooLong('displayName', ACCOUNT_RULES.displayNameMax)
  }
  if (displayName !== undefined) patch.displayName = displayName

  const handle = text('handle')
  if (handle !== undefined) {
    const h = handle === null ? null : handle.replace(/^@/, '').toLowerCase()
    if (h !== null && !ACCOUNT_RULES.handle.test(h)) {
      throw unprocessable(
        'invalid_handle',
        'Handle must be 3-24 characters: lowercase letters, digits or underscore.',
        { field: 'handle' }
      )
    }
    patch.handle = h
  }

  const bio = text('bio')
  if (bio && bio.length > ACCOUNT_RULES.bioMax) tooLong('bio', ACCOUNT_RULES.bioMax)
  if (bio !== undefined) patch.bio = bio

  const avatarUrl = text('avatarUrl')
  if (avatarUrl) {
    if (avatarUrl.length > ACCOUNT_RULES.avatarMaxBytes) tooLong('avatarUrl', ACCOUNT_RULES.avatarMaxBytes)
    const isDataUrl = /^data:image\/(png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(avatarUrl)
    let isHttp = false
    try {
      const url = new URL(avatarUrl)
      isHttp = url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      isHttp = false
    }
    if (!isDataUrl && !isHttp) {
      throw unprocessable('invalid_avatar', 'avatarUrl must be an http(s) URL or an image data URL.', {
        field: 'avatarUrl'
      })
    }
  }
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl

  const gender = text('gender')
  if (gender && !(ACCOUNT_RULES.gender as readonly string[]).includes(gender)) {
    throw unprocessable('invalid_gender', `gender must be one of: ${ACCOUNT_RULES.gender.join(', ')}.`, {
      field: 'gender'
    })
  }
  if (gender !== undefined) patch.gender = gender

  const customStatus = text('customStatus')
  if (customStatus && customStatus.length > ACCOUNT_RULES.customStatusMax) {
    tooLong('customStatus', ACCOUNT_RULES.customStatusMax)
  }
  if (customStatus !== undefined) patch.customStatus = customStatus

  const customStatusEmoji = text('customStatusEmoji')
  if (customStatusEmoji && customStatusEmoji.length > ACCOUNT_RULES.customStatusEmojiMax) {
    tooLong('customStatusEmoji', ACCOUNT_RULES.customStatusEmojiMax)
  }
  if (customStatusEmoji !== undefined) patch.customStatusEmoji = customStatusEmoji

  const expiresAt = text('customStatusExpiresAt')
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw unprocessable('invalid_date', 'customStatusExpiresAt must be an ISO-8601 date.', {
      field: 'customStatusExpiresAt'
    })
  }
  if (expiresAt !== undefined) {
    patch.customStatusExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest('empty_patch', 'Send at least one profile field to update.')
  }
  return patch
}

/** Texto de un mensaje normal: recortado, no vacío, ≤ 4000. */
export function parseMessageBody(body: Record<string, unknown>): string {
  const raw = body.body
  if (typeof raw !== 'string') throw badRequest('missing_field', '"body" is required.', { field: 'body' })
  const text = raw.trim()
  if (text.length === 0) throw unprocessable('empty_message', 'Message body is empty.')
  if (text.length > SOCIAL_RULES.messageMax) {
    throw unprocessable('message_too_long', `Message must be at most ${SOCIAL_RULES.messageMax} characters.`)
  }
  return text
}

export function parseReplyTo(body: Record<string, unknown>): string | null {
  const raw = body.replyTo
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw badRequest('invalid_field', '"replyTo" must be a string.')
  return requireUuid(raw, 'replyTo')
}

export function parsePresence(body: Record<string, unknown>): {
  status: PresenceStatus
  activity: PresenceActivity
} {
  const status = body.status
  if (typeof status !== 'string' || !(PRESENCE_STATUSES as readonly string[]).includes(status)) {
    throw unprocessable('invalid_status', `status must be one of: ${PRESENCE_STATUSES.join(', ')}.`, {
      field: 'status'
    })
  }
  const activity: PresenceActivity = {}
  const raw = body.activity
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest('invalid_field', '"activity" must be an object.')
    }
    const { project, file } = raw as Record<string, unknown>
    // Igual que el IDE: solo nombres (nunca rutas) y recortados.
    if (typeof project === 'string' && project.trim()) activity.project = project.trim().slice(0, 80)
    if (typeof file === 'string' && file.trim()) activity.file = file.trim().slice(0, 120)
  }
  return { status: status as PresenceStatus, activity }
}

/** Cuenta líneas igual que el codec del cliente (una cadena vacía tiene 0). */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1
  }
  return lines
}

/** Valida un archivo a compartir (mismos límites que la Edge Function). */
export function parseCodeFile(body: Record<string, unknown>): CodeFileUpload & { lines: number } {
  const name = requireString(body, 'name').trim().replace(/[\\/]/g, '').slice(0, 255)
  if (!name) throw unprocessable('invalid_name', 'File name is empty.')
  const lang = typeof body.lang === 'string' ? body.lang.slice(0, 64) : ''
  const content = body.content
  if (typeof content !== 'string') throw badRequest('missing_field', '"content" is required.', { field: 'content' })
  if (content.length === 0) throw unprocessable('empty_file', 'The file is empty.')
  if (content.length > SOCIAL_RULES.codeFileMaxChars) {
    throw unprocessable('file_too_large', `The file exceeds ${SOCIAL_RULES.codeFileMaxChars} characters.`)
  }
  const lines = countLines(content)
  if (lines > SOCIAL_RULES.codeFileMaxLines) {
    throw unprocessable('file_too_many_lines', `The file exceeds ${SOCIAL_RULES.codeFileMaxLines} lines.`)
  }
  return { name, lang, content, replyTo: parseReplyTo(body), lines }
}

/** Entero acotado desde la query (`fallback` si falta). */
export function intParam(
  query: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = query.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw badRequest('invalid_query', `"${name}" must be an integer.`, { field: name })
  }
  return Math.min(Math.max(value, min), max)
}
