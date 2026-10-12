// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * API REST (api/) contra el store en memoria: levanta el servidor real en un
 * puerto efímero y recorre los flujos de punta a punta (auth, perfil, amigos,
 * mensajes, archivos, presencia, releases).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../api/src/app'
import { MemoryStore } from '../api/src/store/memory'
import { isReservedHandle } from '../api/src/validation'
import { LEGAL_VERSION } from '../src/shared/legal'

let server: Server
let base = ''

interface Reply<T = any> {
  status: number
  body: T
  headers: Headers
}

async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<Reply<T>> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}

/** Alta completa de un usuario (OTP → sesión → handle). */
async function signUp(email: string, handle: string): Promise<{ token: string; id: string; refresh: string }> {
  const otp = await call('POST', '/v1/auth/otp', { body: { email } })
  expect(otp.status).toBe(202)
  const session = await call('POST', '/v1/auth/verify', { body: { email, code: otp.body.devCode } })
  expect(session.status).toBe(200)
  const token = session.body.accessToken as string
  const patch = await call('PATCH', '/v1/me', { token, body: { handle, displayName: handle } })
  expect(patch.status).toBe(200)
  return { token, id: session.body.user.id, refresh: session.body.refreshToken }
}

async function befriend(a: { token: string; id: string }, b: { token: string; id: string }): Promise<void> {
  const sent = await call('POST', '/v1/friend-requests', { token: a.token, body: { userId: b.id } })
  expect(sent.body.status).toBe('pending')
  const back = await call('POST', '/v1/friend-requests', { token: b.token, body: { userId: a.id } })
  expect(back.body.status).toBe('accepted')
}

beforeAll(async () => {
  const store = new MemoryStore({ version: '9.9.9' })
  const app = createApp({
    store,
    config: { exposeOtp: true, corsOrigins: ['*'], logRequests: false },
    version: '9.9.9'
  })
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('api: meta', () => {
  it('reports health and legal info', async () => {
    const health = await call('GET', '/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ status: 'ok', version: '9.9.9', store: 'memory' })
    expect(health.headers.get('x-request-id')).toBeTruthy()

    const legal = await call('GET', '/v1/legal')
    expect(legal.body.version).toBe(LEGAL_VERSION)
  })

  it('returns structured 404 / 405 / 401 errors', async () => {
    expect((await call('GET', '/nope')).body.error.code).toBe('route_not_found')
    const wrongMethod = await call('PUT', '/v1/me')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toContain('GET')
    const anon = await call('GET', '/v1/me')
    expect(anon.status).toBe(401)
    expect(anon.body.error.code).toBe('unauthorized')
  })

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${base}/v1/auth/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope'
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_json')
  })
})

describe('api: auth', () => {
  it('runs the OTP flow with consent, refresh rotation and logout', async () => {
    const email = 'auth-flow@scrakk.test'
    const otp = await call('POST', '/v1/auth/otp', { body: { email: ' Auth-Flow@Scrakk.test ' } })
    expect(otp.body).toMatchObject({ sent: true, email })
    expect(otp.body.devCode).toMatch(/^\d{6}$/)

    // Reenvío inmediato: rate limited.
    expect((await call('POST', '/v1/auth/otp', { body: { email } })).status).toBe(429)

    const wrong = otp.body.devCode === '000000' ? '111111' : '000000'
    expect((await call('POST', '/v1/auth/verify', { body: { email, code: wrong } })).status).toBe(401)

    const session = await call('POST', '/v1/auth/verify', {
      body: { email, code: otp.body.devCode, consent: { version: LEGAL_VERSION, locale: 'en' } }
    })
    expect(session.status).toBe(200)
    expect(session.body.tokenType).toBe('Bearer')
    expect(session.body.user.legal).toMatchObject({ version: LEGAL_VERSION, locale: 'en', current: true })

    // El código es de un solo uso.
    expect((await call('POST', '/v1/auth/verify', { body: { email, code: otp.body.devCode } })).status).toBe(401)

    const refreshed = await call('POST', '/v1/auth/refresh', { body: { refreshToken: session.body.refreshToken } })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.user.id).toBe(session.body.user.id)
    // Rotación: el refresh token viejo ya no sirve.
    expect((await call('POST', '/v1/auth/refresh', { body: { refreshToken: session.body.refreshToken } })).status).toBe(401)

    const token = refreshed.body.accessToken
    expect((await call('POST', '/v1/auth/logout', { token })).status).toBe(204)
    expect((await call('GET', '/v1/me', { token })).status).toBe(401)
  })

  it('validates email and code format', async () => {
    expect((await call('POST', '/v1/auth/otp', { body: { email: 'not-an-email' } })).body.error.code).toBe('invalid_email')
    expect((await call('POST', '/v1/auth/otp', { body: {} })).body.error.code).toBe('missing_field')
    const bad = await call('POST', '/v1/auth/verify', { body: { email: 'x@y.co', code: '12' } })
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('invalid_code_format')
  })
})

describe('api: profile', () => {
  it('updates, clears and validates profile fields', async () => {
    const me = await signUp('profile@scrakk.test', 'profile_user')
    const got = await call('GET', '/v1/me', { token: me.token })
    expect(got.body).toMatchObject({ handle: 'profile_user', email: 'profile@scrakk.test' })

    const updated = await call('PATCH', '/v1/me', {
      token: me.token,
      body: { bio: '  hi  ', gender: 'other', customStatus: 'coding', handle: '@Profile_User' }
    })
    expect(updated.body).toMatchObject({ bio: 'hi', gender: 'other', customStatus: 'coding', handle: 'profile_user' })

    const cleared = await call('PATCH', '/v1/me', { token: me.token, body: { bio: null } })
    expect(cleared.body.bio).toBeNull()

    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{}, 400, 'empty_patch'],
      [{ handle: 'ab' }, 422, 'invalid_handle'],
      [{ handle: 'admin_bot' }, 422, 'handle_reserved'],
      [{ handle: 'iamscrakk' }, 422, 'handle_reserved'],
      [{ bio: 'x'.repeat(161) }, 422, 'field_too_long'],
      [{ gender: 'robot' }, 422, 'invalid_gender'],
      [{ avatarUrl: 'ftp://nope' }, 422, 'invalid_avatar'],
      [{ displayName: 42 }, 400, 'invalid_field']
    ]
    for (const [body, status, code] of cases) {
      const res = await call('PATCH', '/v1/me', { token: me.token, body })
      expect([res.status, res.body.error.code]).toEqual([status, code])
    }

    const other = await signUp('profile2@scrakk.test', 'profile_two')
    const taken = await call('PATCH', '/v1/me', { token: other.token, body: { handle: 'PROFILE_USER' } })
    expect(taken.status).toBe(409)
    expect(taken.body.error.code).toBe('handle_taken')
  })

  it('records legal acceptance', async () => {
    const me = await signUp('legal@scrakk.test', 'legal_user')
    expect((await call('GET', '/v1/me/legal', { token: me.token })).body.current).toBe(false)
    const accepted = await call('POST', '/v1/me/legal', { token: me.token, body: { version: LEGAL_VERSION, locale: 'es' } })
    expect(accepted.body).toMatchObject({ version: LEGAL_VERSION, locale: 'es', current: true })
    expect(accepted.body.acceptedAt).toBeTruthy()
  })
})

describe('api: friends, messages, files and presence', () => {
  it('walks the full social flow between two users', async () => {
    const ana = await signUp('ana@scrakk.test', 'ana_dev')
    const bob = await signUp('bob@scrakk.test', 'bob_dev')
    const eve = await signUp('eve@scrakk.test', 'eve_dev')

    const search = await call('GET', '/v1/users/search?q=@bob', { token: ana.token })
    expect(search.body.items.map((u: { id: string }) => u.id)).toEqual([bob.id])
    expect((await call('GET', '/v1/users/search?q=b', { token: ana.token })).body.items).toEqual([])

    // Sin amistad no hay DM.
    const blocked = await call('POST', `/v1/conversations/${bob.id}/messages`, { token: ana.token, body: { body: 'hi' } })
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('not_friends')

    expect((await call('POST', '/v1/friend-requests', { token: ana.token, body: { userId: ana.id } })).status).toBe(422)
    const sent = await call('POST', '/v1/friend-requests', { token: ana.token, body: { userId: bob.id } })
    expect([sent.status, sent.body.status]).toEqual([201, 'pending'])

    const incoming = await call('GET', '/v1/friend-requests', { token: bob.token })
    expect(incoming.body.items).toHaveLength(1)
    expect(incoming.body.items[0]).toMatchObject({ direction: 'incoming', otherId: ana.id, handle: 'ana_dev' })

    // Solo el destinatario responde.
    const reqId = incoming.body.items[0].id
    expect((await call('POST', `/v1/friend-requests/${reqId}/accept`, { token: ana.token })).status).toBe(404)
    const accepted = await call('POST', `/v1/friend-requests/${reqId}/accept`, { token: bob.token })
    expect(accepted.body.status).toBe('accepted')
    expect((await call('POST', '/v1/friend-requests', { token: ana.token, body: { userId: bob.id } })).body.status).toBe(
      'already_friends'
    )
    expect((await call('GET', '/v1/friends', { token: ana.token })).body.items[0]).toMatchObject({ id: bob.id })

    // Mensajes: enviar, responder, editar, leer, paginar.
    const first = await call('POST', `/v1/conversations/${bob.id}/messages`, { token: ana.token, body: { body: ' hello bob ' } })
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ body: 'hello bob', kind: 'normal', senderId: ana.id, readAt: null })

    const reply = await call('POST', `/v1/conversations/${ana.id}/messages`, {
      token: bob.token,
      body: { body: 'hey ana', replyTo: first.body.id }
    })
    expect(reply.body.replyPreview).toMatchObject({ id: first.body.id, body: 'hello bob' })

    expect((await call('PATCH', `/v1/messages/${first.body.id}`, { token: bob.token, body: { body: 'hijack' } })).status).toBe(403)
    expect((await call('PATCH', `/v1/messages/${first.body.id}`, { token: eve.token, body: { body: 'x' } })).status).toBe(404)
    const edited = await call('PATCH', `/v1/messages/${first.body.id}`, { token: ana.token, body: { body: 'hello Bob!' } })
    expect(edited.body.editedAt).toBeTruthy()

    const read = await call('POST', `/v1/conversations/${ana.id}/read`, { token: bob.token })
    expect(read.body.updated).toBe(1)

    const page = await call('GET', `/v1/conversations/${bob.id}/messages?limit=1`, { token: ana.token })
    expect(page.body.items.map((m: { id: string }) => m.id)).toEqual([reply.body.id])
    expect(page.body.hasMore).toBe(true)
    const older = await call('GET', `/v1/conversations/${bob.id}/messages?limit=1&before=${reply.body.id}`, { token: ana.token })
    expect(older.body.items[0]).toMatchObject({ id: first.body.id, body: 'hello Bob!' })
    expect(older.body.hasMore).toBe(false)

    // Eve no ve la conversación.
    expect((await call('GET', `/v1/conversations/${ana.id}/messages`, { token: eve.token })).body.items).toEqual([])

    // Archivos compartidos.
    const content = 'export const answer = 42\nconsole.log(answer)\n'
    const file = await call('POST', `/v1/conversations/${bob.id}/files`, {
      token: ana.token,
      body: { name: 'src/answer.ts', lang: 'typescript', content }
    })
    expect(file.status).toBe(201)
    expect(file.body.kind).toBe('codefile')
    const meta = JSON.parse(file.body.body)
    expect(meta).toMatchObject({ v: 1, kind: 'codefile', name: 'srcanswer.ts', lines: 3, size: content.length })

    const download = await call('GET', `/v1/messages/${file.body.id}/file`, { token: bob.token })
    expect(download.body.content).toBe(content)
    expect(download.body.meta.sha).toBe(meta.sha)
    expect((await call('GET', `/v1/messages/${file.body.id}/file`, { token: eve.token })).status).toBe(404)
    expect((await call('GET', `/v1/messages/${first.body.id}/file`, { token: ana.token })).body.error.code).toBe('not_a_file')
    expect((await call('PATCH', `/v1/messages/${file.body.id}`, { token: ana.token, body: { body: 'x' } })).status).toBe(422)
    expect((await call('DELETE', `/v1/messages/${file.body.id}/file`, { token: bob.token })).status).toBe(403)
    expect((await call('DELETE', `/v1/messages/${file.body.id}/file`, { token: ana.token })).status).toBe(204)
    expect((await call('GET', `/v1/messages/${file.body.id}/file`, { token: bob.token })).status).toBe(404)

    // Borrar el mensaje citado deja el reply sin padre (on delete set null).
    expect((await call('DELETE', `/v1/messages/${first.body.id}`, { token: ana.token })).status).toBe(204)
    const after = await call('GET', `/v1/conversations/${bob.id}/messages`, { token: ana.token })
    expect(after.body.items).toHaveLength(1)
    expect(after.body.items[0]).toMatchObject({ replyTo: null, replyPreview: null })

    // Presencia: yo + amigos, nunca extraños.
    await call('PUT', '/v1/presence', { token: bob.token, body: { status: 'busy', activity: { project: 'scrakk', file: 'a.ts' } } })
    await call('PUT', '/v1/presence', { token: eve.token, body: { status: 'online' } })
    const presence = await call('GET', '/v1/presence', { token: ana.token })
    expect(presence.body.items).toEqual([expect.objectContaining({ userId: bob.id, status: 'busy' })])
    expect((await call('PUT', '/v1/presence', { token: ana.token, body: { status: 'sleeping' } })).status).toBe(422)

    // Quitar amigo corta el DM.
    expect((await call('DELETE', `/v1/friends/${bob.id}`, { token: ana.token })).status).toBe(204)
    expect((await call('DELETE', `/v1/friends/${bob.id}`, { token: ana.token })).status).toBe(404)
    expect((await call('POST', `/v1/conversations/${bob.id}/messages`, { token: ana.token, body: { body: 'still?' } })).status).toBe(403)
  })

  it('rate limits messages (7 per 5 s) and validates ids and bodies', async () => {
    const a = await signUp('rate-a@scrakk.test', 'rate_a')
    const b = await signUp('rate-b@scrakk.test', 'rate_b')
    await befriend(a, b)
    const statuses: number[] = []
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await call('POST', `/v1/conversations/${b.id}/messages`, { token: a.token, body: { body: `m${i}` } })).status)
    }
    expect(statuses.slice(0, 7).every((s) => s === 201)).toBe(true)
    expect(statuses[7]).toBe(429)

    expect((await call('GET', '/v1/conversations/not-a-uuid/messages', { token: a.token })).body.error.code).toBe('invalid_id')
    expect((await call('POST', `/v1/conversations/${a.id}/messages`, { token: b.token, body: { body: '   ' } })).body.error.code).toBe(
      'empty_message'
    )
    expect(
      (await call('POST', `/v1/conversations/${a.id}/messages`, { token: b.token, body: { body: 'x'.repeat(4001) } })).body.error.code
    ).toBe('message_too_long')
  })

  it('rejects a reply that quotes another conversation', async () => {
    const a = await signUp('reply-a@scrakk.test', 'reply_a')
    const b = await signUp('reply-b@scrakk.test', 'reply_b')
    const c = await signUp('reply-c@scrakk.test', 'reply_c')
    await befriend(a, b)
    await befriend(a, c)
    const toB = await call('POST', `/v1/conversations/${b.id}/messages`, { token: a.token, body: { body: 'for b' } })
    const res = await call('POST', `/v1/conversations/${c.id}/messages`, {
      token: a.token,
      body: { body: 'for c', replyTo: toB.body.id }
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('reply_not_in_dm')
  })
})

describe('api: releases', () => {
  it('lists the seed release and finds it by tag', async () => {
    const list = await call('GET', '/v1/releases')
    expect(list.body.items[0]).toMatchObject({ tag: 'v9.9.9', version: '9.9.9' })
    expect((await call('GET', '/v1/releases/latest')).body.tag).toBe('v9.9.9')
    expect((await call('GET', '/v1/releases/9.9.9')).body.tag).toBe('v9.9.9')
    expect((await call('GET', '/v1/releases/v0.0.1')).status).toBe(404)
  })
})

describe('api: reserved handles', () => {
  it('mirrors public.handle_is_reserved', () => {
    for (const h of ['scrakk', 'scrakkteam', 'iamscrakk', 'admin', 'admin_oficial', 'support-bot', 'mod.x', 'help']) {
      expect(isReservedHandle(h)).toBe(true)
    }
    for (const h of ['ana_dev', 'administrator', 'helpful', 'rooted']) {
      expect(isReservedHandle(h)).toBe(false)
    }
  })
})
