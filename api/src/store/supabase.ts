// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Store Supabase: la API como fachada REST del backend real.
 *
 * Igual que el IDE, NUNCA usa la service_role: cada request arma un cliente con
 * la publishable key + el JWT del usuario, así la RLS y las RPCs `security
 * definer` de `docs/backend` deciden qué se puede. El login es el mismo flujo
 * OTP del CLI (`/auth/register` + `/auth/login`) y los archivos compartidos van
 * por la Edge Function `social-file` (la única con acceso a R2).
 */

import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { LEGAL_VERSION } from '../../../src/shared/legal.ts'
import { SOCIAL_RULES } from '../../../src/shared/social.ts'
import type { ApiConfig } from '../config.ts'
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
  unprocessable
} from '../http.ts'
import type {
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

const PROFILE_COLUMNS =
  'id,email,handle,display_name,avatar_url,bio,gender,custom_status,custom_status_emoji,custom_status_expires_at,created_at,legal_version,legal_accepted_at,legal_locale'
const MESSAGE_COLUMNS = 'id,sender_id,recipient_id,kind,body,created_at,read_at,reply_to,edited_at'
const ATTACH_COLUMNS = 'id,message_id,path,url,mime,size_bytes,width,height'
const UPSTREAM_TIMEOUT_MS = 20_000

type Row = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Traduce errores de Postgres/PostgREST a errores HTTP estables. */
function mapDbError(error: { message?: string; code?: string } | null): ApiError {
  const message = error?.message ?? 'Upstream error.'
  const code = error?.code ?? ''
  if (message.includes('handle_reservado')) return unprocessable('handle_reserved', 'That handle is reserved.')
  if (message.includes('handle_invalido')) return unprocessable('invalid_handle', 'Handle format is invalid.')
  if (code === '23505') return conflict('handle_taken', 'That handle is already taken.')
  if (message.includes('msg_ratelimited') || message.includes('rate_limited')) {
    return tooManyRequests('rate_limited', 'Rate limit exceeded.')
  }
  if (message.includes('user_not_found')) return notFound('user_not_found', 'User not found.')
  if (message.includes('request_not_found')) return notFound('request_not_found', 'Friend request not found.')
  if (message.includes('invalid_target')) return unprocessable('invalid_target', 'Invalid target user.')
  if (message.includes('reply_not_in_dm')) {
    return unprocessable('reply_not_in_dm', 'The quoted message is not part of this conversation.')
  }
  if (message.includes('not_sender')) return forbidden('not_sender', 'Only the sender can change a message.')
  if (code === '42501') return forbidden('forbidden', 'Not allowed.')
  if (code === '23514') return unprocessable('constraint_violation', message)
  if (code === 'PGRST301' || /jwt/i.test(message)) return unauthorized()
  return new ApiError(502, 'upstream_error', message)
}

function mapUser(row: Row): SocialUser {
  return {
    id: String(row.id),
    handle: str(row.handle),
    displayName: str(row.display_name),
    avatarUrl: str(row.avatar_url),
    bio: str(row.bio),
    gender: str(row.gender),
    customStatus: str(row.custom_status),
    customStatusExpiresAt: str(row.custom_status_expires_at),
    createdAt: str(row.created_at)
  }
}

function mapMe(row: Row): Me {
  const version = str(row.legal_version)
  return {
    id: String(row.id),
    email: str(row.email) ?? '',
    handle: str(row.handle),
    displayName: str(row.display_name),
    avatarUrl: str(row.avatar_url),
    bio: str(row.bio),
    gender: str(row.gender),
    customStatus: str(row.custom_status),
    customStatusEmoji: str(row.custom_status_emoji),
    customStatusExpiresAt: str(row.custom_status_expires_at),
    createdAt: str(row.created_at),
    legal: {
      version,
      acceptedAt: str(row.legal_accepted_at),
      locale: str(row.legal_locale),
      current: version === LEGAL_VERSION
    }
  }
}

function mapMessage(row: Row): DirectMessage {
  return {
    id: String(row.id),
    senderId: String(row.sender_id),
    recipientId: String(row.recipient_id),
    kind: row.kind === 'codefile' ? 'codefile' : 'normal',
    body: String(row.body ?? ''),
    createdAt: String(row.created_at),
    readAt: str(row.read_at),
    replyTo: str(row.reply_to),
    editedAt: str(row.edited_at)
  }
}

function mapRelease(row: Row): Release {
  return {
    tag: String(row.tag),
    version: String(row.version),
    name: str(row.name),
    body: str(row.body),
    htmlUrl: str(row.html_url),
    prerelease: Boolean(row.prerelease),
    publishedAt: String(row.published_at)
  }
}

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const
  private readonly config: ApiConfig
  private readonly anon: SupabaseClient

  constructor(config: ApiConfig) {
    this.config = config
    this.anon = this.client()
  }

  /** Cliente sin sesión persistida; con `token`, cada request lleva ese JWT. */
  private client(token?: string): SupabaseClient {
    return createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    })
  }

  private async callCliApi(path: string, body: unknown): Promise<{ status: number; data: Row | null }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.config.cliApiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scrakk-Client': 'api' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const data = (await response.json().catch(() => null)) as Row | null
      return { status: response.status, data }
    } catch {
      throw new ApiError(502, 'upstream_unreachable', 'Could not reach the Scrakk auth API.')
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  async requestOtp(email: string): Promise<OtpRequestResult> {
    const { status, data } = await this.callCliApi('/auth/register', { email })
    if (status === 429) throw tooManyRequests('rate_limited', 'Too many code requests.')
    if (status < 200 || status >= 300 || data?.ok === false) {
      throw new ApiError(502, 'upstream_error', str(data?.error) ?? 'Could not send the code.')
    }
    return {}
  }

  private async sessionFrom(accessToken: string, refreshToken: string, expiresIn: number): Promise<Session> {
    const actor = await this.authenticate(accessToken)
    if (!actor) throw unauthorized('The auth API returned an unusable session.')
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn,
      user: await this.getMe(actor)
    }
  }

  async verifyOtp(email: string, code: string): Promise<Session> {
    const { status, data } = await this.callCliApi('/auth/login', { email, code })
    if (status === 429) throw tooManyRequests('rate_limited', 'Too many attempts.')
    const access = str(data?.access_token)
    const refresh = str(data?.refresh_token)
    if (status < 200 || status >= 300 || !access || !refresh) {
      throw unauthorized(str(data?.error) ?? 'Invalid or expired code.')
    }
    return this.sessionFrom(access, refresh, Number(data?.expires_in ?? 3600))
  }

  async refresh(refreshToken: string): Promise<Session> {
    const { data, error } = await this.client().auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) throw unauthorized('Invalid refresh token.')
    return this.sessionFrom(data.session.access_token, data.session.refresh_token, data.session.expires_in)
  }

  async authenticate(token: string): Promise<Actor | null> {
    const { data, error } = await this.anon.auth.getUser(token)
    if (error || !data.user) return null
    return { userId: data.user.id, token }
  }

  async logout(actor: Actor): Promise<void> {
    // GoTrue revoca la sesión del JWT (y sus refresh tokens).
    await fetch(`${this.config.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: this.config.supabaseKey, Authorization: `Bearer ${actor.token}` }
    }).catch(() => undefined)
  }

  // ── Cuenta ──────────────────────────────────────────────────────────────

  async getMe(actor: Actor): Promise<Me> {
    const db = this.client(actor.token)
    const { data, error } = await db.from('profiles').select(PROFILE_COLUMNS).eq('id', actor.userId).maybeSingle()
    if (error) throw mapDbError(error)
    if (!data) throw notFound('profile_not_found', 'Profile not found.')
    return mapMe(data as Row)
  }

  async updateMe(actor: Actor, patch: ProfilePatch): Promise<Me> {
    const columns: Row = {}
    if (patch.displayName !== undefined) columns.display_name = patch.displayName
    if (patch.handle !== undefined) columns.handle = patch.handle
    if (patch.avatarUrl !== undefined) columns.avatar_url = patch.avatarUrl
    if (patch.bio !== undefined) columns.bio = patch.bio
    if (patch.gender !== undefined) columns.gender = patch.gender
    if (patch.customStatus !== undefined) columns.custom_status = patch.customStatus
    if (patch.customStatusEmoji !== undefined) columns.custom_status_emoji = patch.customStatusEmoji
    if (patch.customStatusExpiresAt !== undefined) columns.custom_status_expires_at = patch.customStatusExpiresAt
    const { error } = await this.client(actor.token).from('profiles').update(columns).eq('id', actor.userId)
    if (error) throw mapDbError(error)
    return this.getMe(actor)
  }

  async acceptLegal(actor: Actor, version: string, locale: string | null): Promise<LegalState> {
    const { error } = await this.client(actor.token).rpc('accept_legal', { p_version: version, p_locale: locale })
    if (error) throw mapDbError(error)
    return (await this.getMe(actor)).legal
  }

  // ── Amigos ──────────────────────────────────────────────────────────────

  async searchUsers(actor: Actor, query: string): Promise<SocialUser[]> {
    const q = query.trim().replace(/^@+/, '')
    if (q.length < SOCIAL_RULES.searchMin) return []
    const { data, error } = await this.client(actor.token).rpc('search_users', { q })
    if (error) throw mapDbError(error)
    return ((data ?? []) as Row[]).map(mapUser)
  }

  async listFriends(actor: Actor): Promise<Friend[]> {
    const { data, error } = await this.client(actor.token).rpc('list_friends')
    if (error) throw mapDbError(error)
    return ((data ?? []) as Row[]).map((row) => ({ ...mapUser(row), since: String(row.since) }))
  }

  async removeFriend(actor: Actor, otherId: string): Promise<boolean> {
    const { data, error } = await this.client(actor.token).rpc('remove_friend', { other: otherId })
    if (error) throw mapDbError(error)
    return Boolean(data)
  }

  async listRequests(actor: Actor): Promise<FriendRequest[]> {
    const { data, error } = await this.client(actor.token).rpc('list_requests')
    if (error) throw mapDbError(error)
    return ((data ?? []) as Row[]).map((row) => ({
      id: String(row.id),
      direction: row.direction === 'outgoing' ? 'outgoing' : 'incoming',
      otherId: String(row.other_id),
      handle: str(row.handle),
      displayName: str(row.display_name),
      avatarUrl: str(row.avatar_url),
      createdAt: String(row.created_at)
    }))
  }

  async sendRequest(actor: Actor, targetId: string): Promise<FriendRequestOutcome> {
    const { data, error } = await this.client(actor.token).rpc('send_friend_request', { target: targetId })
    if (error) throw mapDbError(error)
    const outcome = String(data ?? 'pending')
    return outcome === 'accepted' || outcome === 'already_friends' ? outcome : 'pending'
  }

  async respondRequest(actor: Actor, requestId: string, accept: boolean): Promise<'accepted' | 'rejected'> {
    const { data, error } = await this.client(actor.token).rpc('respond_friend_request', { req: requestId, accept })
    if (error) throw mapDbError(error)
    return data === 'accepted' ? 'accepted' : 'rejected'
  }

  // ── Mensajes ────────────────────────────────────────────────────────────

  /** Previews de respuesta + adjuntos (dos queries por lote). */
  private async hydrate(db: SupabaseClient, rows: Row[]): Promise<DirectMessage[]> {
    const messages = rows.map(mapMessage)
    const replyIds = [...new Set(messages.map((m) => m.replyTo).filter((id): id is string => !!id))]
    const parents = new Map<string, Row>()
    if (replyIds.length > 0) {
      const { data } = await db.from('messages').select('id,body,sender_id').in('id', replyIds)
      for (const row of (data ?? []) as Row[]) parents.set(String(row.id), row)
    }
    const attachments = new Map<string, NonNullable<DirectMessage['attachments']>>()
    if (messages.length > 0) {
      const { data } = await db.from('message_attachments').select(ATTACH_COLUMNS).in('message_id', messages.map((m) => m.id))
      for (const row of (data ?? []) as Row[]) {
        const list = attachments.get(String(row.message_id)) ?? []
        list.push({
          id: String(row.id),
          messageId: String(row.message_id),
          path: String(row.path),
          url: String(row.url),
          mime: String(row.mime),
          sizeBytes: Number(row.size_bytes),
          width: typeof row.width === 'number' ? row.width : null,
          height: typeof row.height === 'number' ? row.height : null
        })
        attachments.set(String(row.message_id), list)
      }
    }
    return messages.map((m) => {
      const parent = m.replyTo ? parents.get(m.replyTo) : undefined
      return {
        ...m,
        replyPreview: parent ? { id: String(parent.id), body: String(parent.body), senderId: String(parent.sender_id) } : null,
        attachments: attachments.get(m.id) ?? []
      }
    })
  }

  async listMessages(actor: Actor, peerId: string, opts: { before: string | null; limit: number }): Promise<MessagePage> {
    const db = this.client(actor.token)
    const me = actor.userId
    let query = db
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .or(`and(sender_id.eq.${me},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${me})`)
    if (opts.before) {
      const { data: cursor } = await db.from('messages').select('created_at').eq('id', opts.before).maybeSingle()
      if (cursor) query = query.lt('created_at', String((cursor as Row).created_at))
    }
    // Se pide uno de más para saber si hay página anterior.
    const { data, error } = await query.order('created_at', { ascending: false }).limit(opts.limit + 1)
    if (error) throw mapDbError(error)
    const rows = (data ?? []) as Row[]
    const hasMore = rows.length > opts.limit
    return { items: await this.hydrate(db, rows.slice(0, opts.limit).reverse()), hasMore }
  }

  async sendMessage(actor: Actor, peerId: string, body: string, replyTo: string | null): Promise<DirectMessage> {
    const db = this.client(actor.token)
    const { data, error } = await db
      .from('messages')
      .insert({ sender_id: actor.userId, recipient_id: peerId, body, reply_to: replyTo })
      .select(MESSAGE_COLUMNS)
      .single()
    if (error) {
      // La política de INSERT exige amistad: sin ella PostgREST responde 42501.
      if (error.code === '42501') throw forbidden('not_friends', 'You can only message your friends.')
      throw mapDbError(error)
    }
    return (await this.hydrate(db, [data as Row]))[0]
  }

  async editMessage(actor: Actor, messageId: string, body: string): Promise<DirectMessage> {
    const db = this.client(actor.token)
    const { data, error } = await db
      .from('messages')
      .update({ body, edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .eq('sender_id', actor.userId)
      .eq('kind', 'normal')
      .select(MESSAGE_COLUMNS)
      .maybeSingle()
    if (error) throw mapDbError(error)
    if (!data) throw notFound('message_not_found', 'Message not found (or not editable by you).')
    return (await this.hydrate(db, [data as Row]))[0]
  }

  async deleteMessage(actor: Actor, messageId: string): Promise<void> {
    const { data, error } = await this.client(actor.token)
      .from('messages')
      .delete()
      .eq('id', messageId)
      .eq('sender_id', actor.userId)
      .select('id')
    if (error) throw mapDbError(error)
    if (!data || data.length === 0) throw notFound('message_not_found', 'Message not found (or not yours).')
  }

  async markRead(actor: Actor, peerId: string): Promise<number> {
    const { data, error } = await this.client(actor.token)
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', actor.userId)
      .eq('sender_id', peerId)
      .is('read_at', null)
      .select('id')
    if (error) throw mapDbError(error)
    return data?.length ?? 0
  }

  // ── Archivos compartidos (Edge Function `social-file`) ──────────────────

  private async invokeSocialFile(actor: Actor, payload: Row): Promise<Row> {
    const response = await fetch(`${this.config.supabaseUrl}/functions/v1/social-file`, {
      method: 'POST',
      headers: {
        apikey: this.config.supabaseKey,
        Authorization: `Bearer ${actor.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }).catch(() => null)
    if (!response) throw new ApiError(502, 'upstream_unreachable', 'Could not reach the file service.')
    const data = (await response.json().catch(() => ({}))) as Row
    if (!response.ok) {
      const message = str(data.error) ?? `File service error (${response.status}).`
      if (response.status === 429) throw tooManyRequests('rate_limited', message)
      if (response.status === 409) throw conflict('file_quota_full', message)
      if (response.status === 403) throw forbidden('forbidden', message)
      if (response.status === 404) throw notFound('message_not_found', message)
      if (response.status === 401) throw unauthorized(message)
      if (response.status === 400) throw unprocessable('invalid_file', message)
      throw new ApiError(502, 'upstream_error', message)
    }
    return data
  }

  async sendCodeFile(actor: Actor, peerId: string, file: CodeFileUpload): Promise<DirectMessage> {
    const data = await this.invokeSocialFile(actor, { action: 'upload', peerId, ...file })
    const row = data.message as Row | undefined
    if (!row) throw new ApiError(502, 'upstream_error', 'The file service did not return a message.')
    return (await this.hydrate(this.client(actor.token), [row]))[0]
  }

  async getCodeFile(actor: Actor, messageId: string): Promise<CodeFileContent> {
    const db = this.client(actor.token)
    const { data } = await db.from('messages').select('body,kind').eq('id', messageId).maybeSingle()
    if (!data) throw notFound('message_not_found', 'Message not found.')
    let meta: SocialCodeFile | null = null
    try {
      meta = (data as Row).kind === 'codefile' ? (JSON.parse(String((data as Row).body)) as SocialCodeFile) : null
    } catch {
      meta = null
    }
    if (!meta) throw unprocessable('not_a_file', 'That message is not a shared file.')
    const signed = await this.invokeSocialFile(actor, { action: 'url', messageId })
    const url = str(signed.url)
    if (!url) throw new ApiError(502, 'upstream_error', 'The file service did not return a URL.')
    const response = await fetch(url).catch(() => null)
    if (!response) throw new ApiError(502, 'upstream_unreachable', 'Could not download the file.')
    if (response.status === 404) throw new ApiError(410, 'file_expired', 'The shared file has expired.')
    if (!response.ok) throw new ApiError(502, 'upstream_error', `Download failed (${response.status}).`)
    const content = await response.text()
    const sha = createHash('sha256').update(content, 'utf8').digest('hex')
    if (sha !== meta.sha) throw new ApiError(502, 'integrity_error', 'Downloaded file does not match its checksum.')
    return { meta, content }
  }

  async deleteCodeFile(actor: Actor, messageId: string): Promise<void> {
    // Si el objeto ya expiró en R2, igual se borra el mensaje (como el IDE).
    await this.invokeSocialFile(actor, { action: 'delete', messageId }).catch((error: unknown) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) throw error
    })
    await this.deleteMessage(actor, messageId)
  }

  // ── Presencia ───────────────────────────────────────────────────────────

  async getPresence(actor: Actor): Promise<UserPresence[]> {
    const { data, error } = await this.client(actor.token).from('presence').select('user_id,status,activity,updated_at')
    if (error) throw mapDbError(error)
    return ((data ?? []) as Row[]).map((row) => {
      const activity = (row.activity ?? {}) as Row
      const status = String(row.status)
      return {
        userId: String(row.user_id),
        status: (['online', 'away', 'busy', 'offline'].includes(status) ? status : 'offline') as PresenceStatus,
        activity: {
          ...(typeof activity.project === 'string' ? { project: activity.project } : {}),
          ...(typeof activity.file === 'string' ? { file: activity.file } : {})
        },
        updatedAt: String(row.updated_at)
      }
    })
  }

  async setPresence(actor: Actor, status: PresenceStatus, activity: PresenceActivity): Promise<UserPresence> {
    const db = this.client(actor.token)
    const updatedAt = new Date().toISOString()
    const row = { user_id: actor.userId, status, activity, updated_at: updatedAt }
    // Grants por columna: primero garantizar la fila, después actualizar.
    const { error: ensureError } = await db.from('presence').upsert(row, { onConflict: 'user_id', ignoreDuplicates: true })
    if (ensureError && ensureError.code !== '23505') throw mapDbError(ensureError)
    const { error } = await db.from('presence').update({ status, activity, updated_at: updatedAt }).eq('user_id', actor.userId)
    if (error) throw mapDbError(error)
    return { userId: actor.userId, status, activity, updatedAt }
  }

  // ── Releases ────────────────────────────────────────────────────────────

  async listReleases(opts: { limit: number; includePrerelease: boolean }): Promise<Release[]> {
    let query = this.anon.from('releases').select('*').order('published_at', { ascending: false }).limit(opts.limit)
    if (!opts.includePrerelease) query = query.eq('prerelease', false)
    const { data, error } = await query
    if (error) throw mapDbError(error)
    return ((data ?? []) as Row[]).map(mapRelease)
  }

  async getRelease(tag: string): Promise<Release | null> {
    const wanted = tag.startsWith('v') ? tag : `v${tag}`
    const { data, error } = await this.anon.from('releases').select('*').eq('tag', wanted).maybeSingle()
    if (error) throw mapDbError(error)
    return data ? mapRelease(data as Row) : null
  }
}
