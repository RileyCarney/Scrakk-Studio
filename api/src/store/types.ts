// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Contrato de almacenamiento de la API.
 *
 * Hay dos implementaciones con la MISMA semántica:
 *   - `memory`   → todo en RAM; reproduce las reglas de las migraciones SQL
 *                  (docs/backend). Es la que usan los tests y la suite de Postman.
 *   - `supabase` → habla con el proyecto real usando la publishable key + el JWT
 *                  del usuario (la RLS y las RPCs deciden, igual que el IDE).
 *
 * Los modelos de salida reutilizan los contratos de `src/shared` para que la API
 * hable el mismo idioma que el editor.
 */

import type { AccountProfile } from '../../../src/shared/account.ts'
import type {
  DirectMessage,
  Friend,
  FriendRequest,
  PresenceActivity,
  PresenceStatus,
  SocialUser,
  UserPresence
} from '../../../src/shared/social.ts'
import type { SocialCodeFile } from '../../../src/shared/socialCodeFile.ts'

export type {
  AccountProfile,
  DirectMessage,
  Friend,
  FriendRequest,
  PresenceActivity,
  PresenceStatus,
  SocialCodeFile,
  SocialUser,
  UserPresence
}

/** Quién hace la llamada: el id del usuario + el token con el que entró. */
export interface Actor {
  userId: string
  token: string
}

export interface LegalState {
  version: string | null
  acceptedAt: string | null
  locale: string | null
  /** ¿La versión aceptada es la vigente (`LEGAL_VERSION`)? */
  current: boolean
}

export interface Me extends AccountProfile {
  legal: LegalState
}

export interface Session {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  /** Segundos hasta que vence el access token. */
  expiresIn: number
  user: Me
}

export interface OtpRequestResult {
  /** Solo en desarrollo (store `memory` con `SCRAKK_API_EXPOSE_OTP`): el código. */
  devCode?: string
}

/** Cambios de perfil ya validados: `undefined` = no tocar, `null` = borrar. */
export interface ProfilePatch {
  displayName?: string | null
  handle?: string | null
  avatarUrl?: string | null
  bio?: string | null
  gender?: string | null
  customStatus?: string | null
  customStatusEmoji?: string | null
  customStatusExpiresAt?: string | null
}

export type FriendRequestOutcome = 'pending' | 'accepted' | 'already_friends'

export interface MessagePage {
  items: DirectMessage[]
  /** Hay mensajes más viejos: pedir con `before = items[0].id`. */
  hasMore: boolean
}

export interface CodeFileUpload {
  name: string
  lang: string
  content: string
  replyTo: string | null
}

export interface CodeFileContent {
  meta: SocialCodeFile
  content: string
}

export interface Release {
  tag: string
  version: string
  name: string | null
  body: string | null
  htmlUrl: string | null
  prerelease: boolean
  publishedAt: string
}

export interface Store {
  readonly kind: 'memory' | 'supabase'

  // Auth
  requestOtp(email: string): Promise<OtpRequestResult>
  verifyOtp(email: string, code: string): Promise<Session>
  refresh(refreshToken: string): Promise<Session>
  /** Resuelve un access token a su usuario (null si no es válido). */
  authenticate(token: string): Promise<Actor | null>
  logout(actor: Actor): Promise<void>

  // Cuenta
  getMe(actor: Actor): Promise<Me>
  updateMe(actor: Actor, patch: ProfilePatch): Promise<Me>
  acceptLegal(actor: Actor, version: string, locale: string | null): Promise<LegalState>

  // Amigos
  searchUsers(actor: Actor, query: string): Promise<SocialUser[]>
  listFriends(actor: Actor): Promise<Friend[]>
  removeFriend(actor: Actor, otherId: string): Promise<boolean>
  listRequests(actor: Actor): Promise<FriendRequest[]>
  sendRequest(actor: Actor, targetId: string): Promise<FriendRequestOutcome>
  respondRequest(actor: Actor, requestId: string, accept: boolean): Promise<'accepted' | 'rejected'>

  // Mensajes
  listMessages(
    actor: Actor,
    peerId: string,
    opts: { before: string | null; limit: number }
  ): Promise<MessagePage>
  sendMessage(
    actor: Actor,
    peerId: string,
    body: string,
    replyTo: string | null
  ): Promise<DirectMessage>
  editMessage(actor: Actor, messageId: string, body: string): Promise<DirectMessage>
  deleteMessage(actor: Actor, messageId: string): Promise<void>
  markRead(actor: Actor, peerId: string): Promise<number>

  // Archivos compartidos (`kind = 'codefile'`)
  sendCodeFile(actor: Actor, peerId: string, file: CodeFileUpload): Promise<DirectMessage>
  getCodeFile(actor: Actor, messageId: string): Promise<CodeFileContent>
  deleteCodeFile(actor: Actor, messageId: string): Promise<void>

  // Presencia
  getPresence(actor: Actor): Promise<UserPresence[]>
  setPresence(
    actor: Actor,
    status: PresenceStatus,
    activity: PresenceActivity
  ): Promise<UserPresence>

  // Releases (público)
  listReleases(opts: { limit: number; includePrerelease: boolean }): Promise<Release[]>
  getRelease(tag: string): Promise<Release | null>
}
