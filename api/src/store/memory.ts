// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Store en memoria. Reproduce las reglas de las migraciones de `docs/backend`
 * (handles, amistades, RLS de mensajes, rate limits, presencia, archivos
 * compartidos) para poder correr la API y la suite de Postman sin Supabase.
 *
 * Nada persiste: reiniciar el proceso vacía todo.
 */

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { LEGAL_VERSION } from '../../../src/shared/legal.ts'
import { SOCIAL_RULES } from '../../../src/shared/social.ts'
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
  unprocessable
} from '../http.ts'
import { countLines, isReservedHandle } from '../validation.ts'
import type {
  AccountProfile,
  Actor,
  CodeFileContent,
  CodeFileUpload,
  DirectMessage,
  Friend,
  FriendRequest,
  FriendRequestOutcome,
  LegalState,
  Me,
  MessagePage,
  OtpRequestResult,
  PresenceActivity,
  PresenceStatus,
  ProfilePatch,
  Release,
  Session,
  SocialCodeFile,
  SocialUser,
  Store,
  UserPresence
} from './types.ts'

const ACCESS_TTL_S = 3600
const OTP_TTL_MS = 10 * 60_000
const OTP_MAX_ATTEMPTS = 5
const OTP_RESEND_MS = 30_000
/** Backstop de la DB (`messages_rate_limit`): 7 mensajes cada 5 s. */
const MESSAGE_RATE = { windowMs: 5000, max: 7 }
/** `send_friend_request`: tope de solicitudes pendientes salientes. */
const MAX_PENDING_REQUESTS = 25

interface UserRow {
  id: string
  email: string
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
  bio: string | null
  gender: string | null
  customStatus: string | null
  customStatusEmoji: string | null
  customStatusExpiresAt: string | null
  createdAt: string
  legalVersion: string | null
  legalAcceptedAt: string | null
  legalLocale: string | null
}

interface OtpRow {
  code: string
  expiresAt: number
  attempts: number
  sentAt: number
}

interface TokenRow {
  userId: string
  expiresAt: number
}

interface RequestRow {
  id: string
  requesterId: string
  addresseeId: string
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled'
  createdAt: string
  respondedAt: string | null
}

interface MessageRow {
  id: string
  senderId: string
  recipientId: string
  kind: 'normal' | 'codefile'
  body: string
  createdAt: string
  /** Desempate estable cuando dos mensajes caen en el mismo milisegundo. */
  seq: number
  readAt: string | null
  replyTo: string | null
  editedAt: string | null
}

export interface MemoryStoreOptions {
  /** Releases iniciales (si no, se siembra una con `version`). */
  releases?: Release[]
  /** Versión del IDE para la release semilla. */
  version?: string
  /** Reloj inyectable (tests). */
  now?: () => number
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

export class MemoryStore implements Store {
  readonly kind = 'memory' as const

  private readonly now: () => number
  private readonly users = new Map<string, UserRow>()
  private readonly usersByEmail = new Map<string, string>()
  private readonly otps = new Map<string, OtpRow>()
  private readonly accessTokens = new Map<string, TokenRow>()
  private readonly refreshTokens = new Map<string, string>()
  private readonly friendships = new Map<string, string>()
  private readonly requests = new Map<string, RequestRow>()
  private readonly messages = new Map<string, MessageRow>()
  private readonly files = new Map<string, string>()
  private readonly presence = new Map<string, UserPresence>()
  private readonly releases: Release[]
  private seq = 0

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now
    const version = options.version ?? '0.0.0'
    this.releases = options.releases ?? [
      {
        tag: `v${version}`,
        version,
        name: `Scrakk Studio ${version}`,
        body: 'Seed release served by the in-memory store.',
        htmlUrl: `https://github.com/Scrakk/Scrakk-Studio/releases/tag/v${version}`,
        prerelease: false,
        publishedAt: new Date(this.now()).toISOString()
      }
    ]
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  async requestOtp(email: string): Promise<OtpRequestResult> {
    const previous = this.otps.get(email)
    if (previous && this.now() - previous.sentAt < OTP_RESEND_MS) {
      throw tooManyRequests('rate_limited', 'A code was sent recently. Wait before requesting another.')
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.otps.set(email, { code, expiresAt: this.now() + OTP_TTL_MS, attempts: 0, sentAt: this.now() })
    return { devCode: code }
  }

  async verifyOtp(email: string, code: string): Promise<Session> {
    const otp = this.otps.get(email)
    if (!otp || otp.expiresAt < this.now()) {
      this.otps.delete(email)
      throw unauthorized('Invalid or expired code.')
    }
    otp.attempts += 1
    if (otp.code !== code) {
      if (otp.attempts >= OTP_MAX_ATTEMPTS) this.otps.delete(email)
      throw unauthorized('Invalid or expired code.')
    }
    this.otps.delete(email)

    // Mismo patrón que `ensure_profile`: el perfil nace con el usuario.
    let userId = this.usersByEmail.get(email)
    if (!userId) {
      userId = randomUUID()
      this.users.set(userId, {
        id: userId,
        email,
        handle: null,
        displayName: null,
        avatarUrl: null,
        bio: null,
        gender: null,
        customStatus: null,
        customStatusEmoji: null,
        customStatusExpiresAt: null,
        createdAt: this.iso(),
        legalVersion: null,
        legalAcceptedAt: null,
        legalLocale: null
      })
      this.usersByEmail.set(email, userId)
    }
    return this.issueSession(userId)
  }

  private issueSession(userId: string): Session {
    const accessToken = `sk_at_${randomBytes(24).toString('base64url')}`
    const refreshToken = `sk_rt_${randomBytes(24).toString('base64url')}`
    this.accessTokens.set(accessToken, { userId, expiresAt: this.now() + ACCESS_TTL_S * 1000 })
    this.refreshTokens.set(refreshToken, userId)
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TTL_S,
      user: this.toMe(this.user(userId))
    }
  }

  async refresh(refreshToken: string): Promise<Session> {
    const userId = this.refreshTokens.get(refreshToken)
    if (!userId || !this.users.has(userId)) throw unauthorized('Invalid refresh token.')
    // Rotación: cada refresh token sirve una sola vez.
    this.refreshTokens.delete(refreshToken)
    return this.issueSession(userId)
  }

  async authenticate(token: string): Promise<Actor | null> {
    const row = this.accessTokens.get(token)
    if (!row) return null
    if (row.expiresAt < this.now()) {
      this.accessTokens.delete(token)
      return null
    }
    return { userId: row.userId, token }
  }

  async logout(actor: Actor): Promise<void> {
    this.accessTokens.delete(actor.token)
  }

  // ── Cuenta ──────────────────────────────────────────────────────────────

  private user(id: string): UserRow {
    const row = this.users.get(id)
    if (!row) throw unauthorized('Account no longer exists.')
    return row
  }

  private toProfile(row: UserRow): AccountProfile {
    return {
      id: row.id,
      email: row.email,
      handle: row.handle,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      bio: row.bio,
      gender: row.gender,
      customStatus: row.customStatus,
      customStatusEmoji: row.customStatusEmoji,
      customStatusExpiresAt: row.customStatusExpiresAt,
      createdAt: row.createdAt
    }
  }

  private toLegal(row: UserRow): LegalState {
    return {
      version: row.legalVersion,
      acceptedAt: row.legalAcceptedAt,
      locale: row.legalLocale,
      current: row.legalVersion === LEGAL_VERSION
    }
  }

  private toMe(row: UserRow): Me {
    return { ...this.toProfile(row), legal: this.toLegal(row) }
  }

  private toSocialUser(row: UserRow): SocialUser {
    return {
      id: row.id,
      handle: row.handle,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      bio: row.bio,
      gender: row.gender,
      customStatus: row.customStatus,
      customStatusExpiresAt: row.customStatusExpiresAt,
      createdAt: row.createdAt
    }
  }

  async getMe(actor: Actor): Promise<Me> {
    return this.toMe(this.user(actor.userId))
  }

  async updateMe(actor: Actor, patch: ProfilePatch): Promise<Me> {
    const row = this.user(actor.userId)
    if (patch.handle) {
      if (isReservedHandle(patch.handle)) {
        throw unprocessable('handle_reserved', 'That handle is reserved.', { field: 'handle' })
      }
      for (const other of this.users.values()) {
        if (other.id !== row.id && other.handle?.toLowerCase() === patch.handle) {
          throw conflict('handle_taken', 'That handle is already taken.')
        }
      }
    }
    if (patch.displayName !== undefined) row.displayName = patch.displayName
    if (patch.handle !== undefined) row.handle = patch.handle
    if (patch.avatarUrl !== undefined) row.avatarUrl = patch.avatarUrl
    if (patch.bio !== undefined) row.bio = patch.bio
    if (patch.gender !== undefined) row.gender = patch.gender
    if (patch.customStatus !== undefined) row.customStatus = patch.customStatus
    if (patch.customStatusEmoji !== undefined) row.customStatusEmoji = patch.customStatusEmoji
    if (patch.customStatusExpiresAt !== undefined) row.customStatusExpiresAt = patch.customStatusExpiresAt
    return this.toMe(row)
  }

  async acceptLegal(actor: Actor, version: string, locale: string | null): Promise<LegalState> {
    const row = this.user(actor.userId)
    row.legalVersion = version
    row.legalLocale = locale
    // La marca de tiempo la pone el servidor (igual que `now()` en Postgres).
    row.legalAcceptedAt = this.iso()
    return this.toLegal(row)
  }

  // ── Amigos ──────────────────────────────────────────────────────────────

  private areFriends(a: string, b: string): boolean {
    return this.friendships.has(pairKey(a, b))
  }

  private befriend(a: string, b: string): void {
    const key = pairKey(a, b)
    if (!this.friendships.has(key)) this.friendships.set(key, this.iso())
  }

  async searchUsers(actor: Actor, query: string): Promise<SocialUser[]> {
    const needle = query.trim().replace(/^@+/, '').trim().toLowerCase()
    if (needle.length < SOCIAL_RULES.searchMin) return []
    return [...this.users.values()]
      .filter(
        (u) =>
          u.id !== actor.userId &&
          u.handle !== null &&
          (u.handle.includes(needle) || (u.displayName ?? '').toLowerCase().includes(needle))
      )
      .sort((a, b) => (a.handle ?? '').localeCompare(b.handle ?? ''))
      .slice(0, 10)
      .map((u) => this.toSocialUser(u))
  }

  async listFriends(actor: Actor): Promise<Friend[]> {
    const me = actor.userId
    const out: Friend[] = []
    for (const [key, since] of this.friendships) {
      const [a, b] = key.split(':')
      if (a !== me && b !== me) continue
      const other = this.users.get(a === me ? b : a)
      if (other) out.push({ ...this.toSocialUser(other), since })
    }
    return out.sort((x, y) => (x.handle ?? '￿').localeCompare(y.handle ?? '￿'))
  }

  async removeFriend(actor: Actor, otherId: string): Promise<boolean> {
    return this.friendships.delete(pairKey(actor.userId, otherId))
  }

  async listRequests(actor: Actor): Promise<FriendRequest[]> {
    const me = actor.userId
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending' && (r.requesterId === me || r.addresseeId === me))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        const outgoing = r.requesterId === me
        const otherId = outgoing ? r.addresseeId : r.requesterId
        const other = this.users.get(otherId)
        return {
          id: r.id,
          direction: outgoing ? 'outgoing' : 'incoming',
          otherId,
          handle: other?.handle ?? null,
          displayName: other?.displayName ?? null,
          avatarUrl: other?.avatarUrl ?? null,
          createdAt: r.createdAt
        }
      })
  }

  /** Espejo de `send_friend_request` (0011 + tope de 0017). */
  async sendRequest(actor: Actor, targetId: string): Promise<FriendRequestOutcome> {
    const me = actor.userId
    if (targetId === me) throw unprocessable('invalid_target', 'You cannot befriend yourself.')
    if (!this.users.has(targetId)) throw notFound('user_not_found', 'User not found.')
    if (this.areFriends(me, targetId)) return 'already_friends'

    const pending = [...this.requests.values()]
    const reverse = pending.find(
      (r) => r.status === 'pending' && r.requesterId === targetId && r.addresseeId === me
    )
    if (reverse) {
      reverse.status = 'accepted'
      reverse.respondedAt = this.iso()
      this.befriend(me, targetId)
      return 'accepted'
    }
    const existing = pending.find(
      (r) => r.status === 'pending' && r.requesterId === me && r.addresseeId === targetId
    )
    if (existing) return 'pending'
    if (pending.filter((r) => r.status === 'pending' && r.requesterId === me).length >= MAX_PENDING_REQUESTS) {
      throw tooManyRequests('rate_limited', 'Too many pending friend requests.')
    }
    const id = randomUUID()
    this.requests.set(id, {
      id,
      requesterId: me,
      addresseeId: targetId,
      status: 'pending',
      createdAt: this.iso(),
      respondedAt: null
    })
    return 'pending'
  }

  async respondRequest(actor: Actor, requestId: string, accept: boolean): Promise<'accepted' | 'rejected'> {
    const r = this.requests.get(requestId)
    if (!r || r.status !== 'pending' || r.addresseeId !== actor.userId) {
      throw notFound('request_not_found', 'Friend request not found.')
    }
    r.respondedAt = this.iso()
    if (accept) {
      r.status = 'accepted'
      this.befriend(r.requesterId, r.addresseeId)
      return 'accepted'
    }
    r.status = 'rejected'
    return 'rejected'
  }

  // ── Mensajes ────────────────────────────────────────────────────────────

  private inDm(m: MessageRow, a: string, b: string): boolean {
    return (m.senderId === a && m.recipientId === b) || (m.senderId === b && m.recipientId === a)
  }

  private toMessage(m: MessageRow): DirectMessage {
    const parent = m.replyTo ? this.messages.get(m.replyTo) : undefined
    return {
      id: m.id,
      senderId: m.senderId,
      recipientId: m.recipientId,
      kind: m.kind,
      body: m.body,
      createdAt: m.createdAt,
      readAt: m.readAt,
      replyTo: m.replyTo,
      editedAt: m.editedAt,
      replyPreview: parent ? { id: parent.id, body: parent.body, senderId: parent.senderId } : null,
      attachments: []
    }
  }

  /** Mensaje visible para el actor (RLS: solo participantes; si no, 404). */
  private visibleMessage(actor: Actor, messageId: string): MessageRow {
    const m = this.messages.get(messageId)
    if (!m || (m.senderId !== actor.userId && m.recipientId !== actor.userId)) {
      throw notFound('message_not_found', 'Message not found.')
    }
    return m
  }

  /** Validaciones del INSERT: amistad (RLS), reply en el mismo DM, rate limit. */
  private insertMessage(
    actor: Actor,
    peerId: string,
    kind: MessageRow['kind'],
    body: string,
    replyTo: string | null
  ): MessageRow {
    const me = actor.userId
    if (peerId === me) throw unprocessable('invalid_target', 'You cannot message yourself.')
    if (!this.areFriends(me, peerId)) {
      throw forbidden('not_friends', 'You can only message your friends.')
    }
    if (replyTo) {
      const parent = this.messages.get(replyTo)
      if (!parent || !this.inDm(parent, me, peerId)) {
        throw unprocessable('reply_not_in_dm', 'The quoted message is not part of this conversation.')
      }
    }
    const since = this.now() - MESSAGE_RATE.windowMs
    let recent = 0
    for (const m of this.messages.values()) {
      if (m.senderId === me && Date.parse(m.createdAt) > since) recent += 1
    }
    if (recent >= MESSAGE_RATE.max) {
      throw tooManyRequests('rate_limited', 'You are sending messages too fast.')
    }
    const row: MessageRow = {
      id: randomUUID(),
      senderId: me,
      recipientId: peerId,
      kind,
      body,
      createdAt: this.iso(),
      seq: ++this.seq,
      readAt: null,
      replyTo,
      editedAt: null
    }
    this.messages.set(row.id, row)
    return row
  }

  async listMessages(
    actor: Actor,
    peerId: string,
    opts: { before: string | null; limit: number }
  ): Promise<MessagePage> {
    const me = actor.userId
    let rows = [...this.messages.values()]
      .filter((m) => this.inDm(m, me, peerId))
      .sort((a, b) => a.seq - b.seq)
    if (opts.before) {
      const cursor = this.messages.get(opts.before)
      if (cursor && this.inDm(cursor, me, peerId)) rows = rows.filter((m) => m.seq < cursor.seq)
    }
    const page = rows.slice(-opts.limit)
    return { items: page.map((m) => this.toMessage(m)), hasMore: rows.length > page.length }
  }

  async sendMessage(actor: Actor, peerId: string, body: string, replyTo: string | null): Promise<DirectMessage> {
    return this.toMessage(this.insertMessage(actor, peerId, 'normal', body, replyTo))
  }

  async editMessage(actor: Actor, messageId: string, body: string): Promise<DirectMessage> {
    const m = this.visibleMessage(actor, messageId)
    if (m.senderId !== actor.userId) throw forbidden('not_sender', 'Only the sender can edit a message.')
    // Un `codefile` no se edita: su body es el sobre JSON.
    if (m.kind !== 'normal') throw unprocessable('not_editable', 'Shared files cannot be edited.')
    m.body = body
    m.editedAt = this.iso()
    return this.toMessage(m)
  }

  async deleteMessage(actor: Actor, messageId: string): Promise<void> {
    const m = this.visibleMessage(actor, messageId)
    if (m.senderId !== actor.userId) throw forbidden('not_sender', 'Only the sender can delete a message.')
    this.messages.delete(m.id)
    // `reply_to ... on delete set null`.
    for (const other of this.messages.values()) {
      if (other.replyTo === m.id) other.replyTo = null
    }
    const meta = m.kind === 'codefile' ? parseEnvelope(m.body) : null
    if (meta) this.files.delete(meta.key)
  }

  async markRead(actor: Actor, peerId: string): Promise<number> {
    let count = 0
    const now = this.iso()
    for (const m of this.messages.values()) {
      if (m.recipientId === actor.userId && m.senderId === peerId && m.readAt === null) {
        m.readAt = now
        count += 1
      }
    }
    return count
  }

  // ── Archivos compartidos ────────────────────────────────────────────────

  /** Espejo de la Edge Function `social-file` (action: upload). */
  async sendCodeFile(actor: Actor, peerId: string, file: CodeFileUpload): Promise<DirectMessage> {
    const me = actor.userId
    if (!this.areFriends(me, peerId)) throw forbidden('not_friends', 'You can only share files with friends.')
    const ttlMs = SOCIAL_RULES.codeFileTtlDays * 86_400_000
    const since = this.now() - ttlMs
    let live = 0
    for (const m of this.messages.values()) {
      if (m.kind === 'codefile' && m.senderId === me && m.recipientId === peerId && Date.parse(m.createdAt) >= since) {
        live += 1
      }
    }
    if (live >= SOCIAL_RULES.codeFileQuotaPerConversation) {
      throw conflict('file_quota_full', 'File quota for this conversation is full: delete a file first.')
    }
    const key = `code/${randomUUID()}`
    const meta: SocialCodeFile = {
      v: 1,
      kind: 'codefile',
      name: file.name,
      lang: file.lang,
      lines: countLines(file.content),
      size: file.content.length,
      sha: createHash('sha256').update(file.content, 'utf8').digest('hex'),
      key,
      expiresAt: new Date(this.now() + ttlMs).toISOString()
    }
    const row = this.insertMessage(actor, peerId, 'codefile', JSON.stringify(meta), file.replyTo)
    this.files.set(key, file.content)
    return this.toMessage(row)
  }

  async getCodeFile(actor: Actor, messageId: string): Promise<CodeFileContent> {
    const m = this.visibleMessage(actor, messageId)
    const meta = m.kind === 'codefile' ? parseEnvelope(m.body) : null
    if (!meta) throw unprocessable('not_a_file', 'That message is not a shared file.')
    const content = this.files.get(meta.key)
    if (content === undefined || Date.parse(meta.expiresAt) < this.now()) {
      throw new ApiError(410, 'file_expired', 'The shared file has expired.')
    }
    return { meta, content }
  }

  async deleteCodeFile(actor: Actor, messageId: string): Promise<void> {
    const m = this.visibleMessage(actor, messageId)
    if (m.kind !== 'codefile') throw unprocessable('not_a_file', 'That message is not a shared file.')
    await this.deleteMessage(actor, messageId)
  }

  // ── Presencia ───────────────────────────────────────────────────────────

  async getPresence(actor: Actor): Promise<UserPresence[]> {
    const out: UserPresence[] = []
    for (const p of this.presence.values()) {
      if (p.userId === actor.userId || this.areFriends(actor.userId, p.userId)) out.push(p)
    }
    return out
  }

  async setPresence(actor: Actor, status: PresenceStatus, activity: PresenceActivity): Promise<UserPresence> {
    const row: UserPresence = { userId: actor.userId, status, activity, updatedAt: this.iso() }
    this.presence.set(actor.userId, row)
    return row
  }

  // ── Releases ────────────────────────────────────────────────────────────

  async listReleases(opts: { limit: number; includePrerelease: boolean }): Promise<Release[]> {
    return this.releases
      .filter((r) => opts.includePrerelease || !r.prerelease)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, opts.limit)
  }

  async getRelease(tag: string): Promise<Release | null> {
    const wanted = tag.startsWith('v') ? tag : `v${tag}`
    return this.releases.find((r) => r.tag === wanted) ?? null
  }
}

function parseEnvelope(body: string): SocialCodeFile | null {
  try {
    const meta = JSON.parse(body) as SocialCodeFile
    return meta && meta.kind === 'codefile' && typeof meta.key === 'string' ? meta : null
  } catch {
    return null
  }
}
