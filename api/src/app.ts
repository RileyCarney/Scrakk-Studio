// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Rutas de la API REST de Scrakk Studio (v1). El contrato completo está en
 * `api/README.md` y la suite de Postman en `api/postman/`.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LEGAL_LINKS, LEGAL_VERSION } from '../../src/shared/legal.ts'
import type { ApiConfig } from './config.ts'
import {
  ApiError,
  Router,
  badRequest,
  notFound,
  readJson,
  sendEmpty,
  sendError,
  sendJson,
  unauthorized,
  type RouteContext
} from './http.ts'
import type { Actor, Store } from './store/types.ts'
import {
  intParam,
  normalizeEmail,
  normalizeOtp,
  parseCodeFile,
  parseMessageBody,
  parsePresence,
  parseProfilePatch,
  parseReplyTo,
  requireString,
  requireUuid
} from './validation.ts'

export interface AppOptions {
  store: Store
  config: Pick<ApiConfig, 'exposeOtp' | 'corsOrigins' | 'logRequests'>
  version: string
}

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void

export function createApp({ store, config, version }: AppOptions): RequestListener {
  const router = new Router()
  const startedAt = Date.now()

  async function requireActor(ctx: RouteContext): Promise<Actor> {
    const header = ctx.req.headers.authorization ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match) throw unauthorized()
    const actor = await store.authenticate(match[1])
    if (!actor) throw unauthorized()
    return actor
  }

  /** Atajo: handler autenticado. */
  const authed =
    (fn: (ctx: RouteContext, actor: Actor) => Promise<void>) =>
    async (ctx: RouteContext): Promise<void> =>
      fn(ctx, await requireActor(ctx))

  // ── Meta ────────────────────────────────────────────────────────────────

  router.add('GET', '/health', (ctx) =>
    sendJson(ctx.res, 200, {
      status: 'ok',
      version,
      store: store.kind,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    })
  )

  router.add('GET', '/v1/legal', (ctx) =>
    sendJson(ctx.res, 200, { version: LEGAL_VERSION, links: LEGAL_LINKS })
  )

  // ── Auth ────────────────────────────────────────────────────────────────

  router.add('POST', '/v1/auth/otp', async (ctx) => {
    const body = await readJson(ctx.req)
    const email = normalizeEmail(requireString(body, 'email'))
    const result = await store.requestOtp(email)
    const payload: Record<string, unknown> = { sent: true, email }
    if (config.exposeOtp && result.devCode) payload.devCode = result.devCode
    sendJson(ctx.res, 202, payload)
  })

  router.add('POST', '/v1/auth/verify', async (ctx) => {
    const body = await readJson(ctx.req)
    const email = normalizeEmail(requireString(body, 'email'))
    const code = normalizeOtp(requireString(body, 'code'))
    // Aceptación de términos capturada en el signup (igual que el IDE). Se
    // valida ANTES de consumir el código, para no quemarlo con un body malo.
    let consent: { version: string; locale: string | null } | null = null
    if (body.consent !== undefined && body.consent !== null) {
      if (typeof body.consent !== 'object' || Array.isArray(body.consent)) {
        throw badRequest('invalid_field', '"consent" must be an object.')
      }
      const raw = body.consent as Record<string, unknown>
      consent = {
        version: requireString(raw, 'version').trim(),
        locale: typeof raw.locale === 'string' ? raw.locale.trim() || null : null
      }
    }
    const session = await store.verifyOtp(email, code)
    if (consent) {
      const actor = { userId: session.user.id, token: session.accessToken }
      session.user.legal = await store.acceptLegal(actor, consent.version, consent.locale)
    }
    sendJson(ctx.res, 200, session)
  })

  router.add('POST', '/v1/auth/refresh', async (ctx) => {
    const body = await readJson(ctx.req)
    sendJson(ctx.res, 200, await store.refresh(requireString(body, 'refreshToken')))
  })

  router.add(
    'POST',
    '/v1/auth/logout',
    authed(async (ctx, actor) => {
      await store.logout(actor)
      sendEmpty(ctx.res)
    })
  )

  // ── Cuenta ──────────────────────────────────────────────────────────────

  router.add(
    'GET',
    '/v1/me',
    authed(async (ctx, actor) => sendJson(ctx.res, 200, await store.getMe(actor)))
  )

  router.add(
    'PATCH',
    '/v1/me',
    authed(async (ctx, actor) => {
      const patch = parseProfilePatch(await readJson(ctx.req))
      sendJson(ctx.res, 200, await store.updateMe(actor, patch))
    })
  )

  router.add(
    'GET',
    '/v1/me/legal',
    authed(async (ctx, actor) => sendJson(ctx.res, 200, (await store.getMe(actor)).legal))
  )

  router.add(
    'POST',
    '/v1/me/legal',
    authed(async (ctx, actor) => {
      const body = await readJson(ctx.req)
      const versionField = requireString(body, 'version').trim()
      const locale = typeof body.locale === 'string' ? body.locale.trim() || null : null
      sendJson(ctx.res, 200, await store.acceptLegal(actor, versionField, locale))
    })
  )

  // ── Usuarios y amigos ───────────────────────────────────────────────────

  router.add(
    'GET',
    '/v1/users/search',
    authed(async (ctx, actor) => {
      const q = ctx.query.get('q') ?? ''
      sendJson(ctx.res, 200, { items: await store.searchUsers(actor, q) })
    })
  )

  router.add(
    'GET',
    '/v1/friends',
    authed(async (ctx, actor) => sendJson(ctx.res, 200, { items: await store.listFriends(actor) }))
  )

  router.add(
    'DELETE',
    '/v1/friends/:userId',
    authed(async (ctx, actor) => {
      const userId = requireUuid(ctx.params.userId, 'userId')
      if (!(await store.removeFriend(actor, userId))) {
        throw notFound('friend_not_found', 'That user is not your friend.')
      }
      sendEmpty(ctx.res)
    })
  )

  router.add(
    'GET',
    '/v1/friend-requests',
    authed(async (ctx, actor) => sendJson(ctx.res, 200, { items: await store.listRequests(actor) }))
  )

  router.add(
    'POST',
    '/v1/friend-requests',
    authed(async (ctx, actor) => {
      const body = await readJson(ctx.req)
      const userId = requireUuid(requireString(body, 'userId'), 'userId')
      const status = await store.sendRequest(actor, userId)
      sendJson(ctx.res, status === 'pending' ? 201 : 200, { status })
    })
  )

  for (const [action, accept] of [
    ['accept', true],
    ['reject', false]
  ] as const) {
    router.add(
      'POST',
      `/v1/friend-requests/:requestId/${action}`,
      authed(async (ctx, actor) => {
        const requestId = requireUuid(ctx.params.requestId, 'requestId')
        sendJson(ctx.res, 200, { status: await store.respondRequest(actor, requestId, accept) })
      })
    )
  }

  // ── Mensajes ────────────────────────────────────────────────────────────

  router.add(
    'GET',
    '/v1/conversations/:peerId/messages',
    authed(async (ctx, actor) => {
      const peerId = requireUuid(ctx.params.peerId, 'peerId')
      const before = ctx.query.get('before')
      const page = await store.listMessages(actor, peerId, {
        before: before ? requireUuid(before, 'before') : null,
        limit: intParam(ctx.query, 'limit', 50, 1, 100)
      })
      sendJson(ctx.res, 200, page)
    })
  )

  router.add(
    'POST',
    '/v1/conversations/:peerId/messages',
    authed(async (ctx, actor) => {
      const peerId = requireUuid(ctx.params.peerId, 'peerId')
      const body = await readJson(ctx.req)
      const message = await store.sendMessage(actor, peerId, parseMessageBody(body), parseReplyTo(body))
      sendJson(ctx.res, 201, message)
    })
  )

  router.add(
    'POST',
    '/v1/conversations/:peerId/read',
    authed(async (ctx, actor) => {
      const peerId = requireUuid(ctx.params.peerId, 'peerId')
      sendJson(ctx.res, 200, { updated: await store.markRead(actor, peerId) })
    })
  )

  router.add(
    'POST',
    '/v1/conversations/:peerId/files',
    authed(async (ctx, actor) => {
      const peerId = requireUuid(ctx.params.peerId, 'peerId')
      const { lines: _lines, ...file } = parseCodeFile(await readJson(ctx.req))
      sendJson(ctx.res, 201, await store.sendCodeFile(actor, peerId, file))
    })
  )

  router.add(
    'PATCH',
    '/v1/messages/:messageId',
    authed(async (ctx, actor) => {
      const messageId = requireUuid(ctx.params.messageId, 'messageId')
      const body = parseMessageBody(await readJson(ctx.req))
      sendJson(ctx.res, 200, await store.editMessage(actor, messageId, body))
    })
  )

  router.add(
    'DELETE',
    '/v1/messages/:messageId',
    authed(async (ctx, actor) => {
      await store.deleteMessage(actor, requireUuid(ctx.params.messageId, 'messageId'))
      sendEmpty(ctx.res)
    })
  )

  router.add(
    'GET',
    '/v1/messages/:messageId/file',
    authed(async (ctx, actor) => {
      const messageId = requireUuid(ctx.params.messageId, 'messageId')
      sendJson(ctx.res, 200, await store.getCodeFile(actor, messageId))
    })
  )

  router.add(
    'DELETE',
    '/v1/messages/:messageId/file',
    authed(async (ctx, actor) => {
      await store.deleteCodeFile(actor, requireUuid(ctx.params.messageId, 'messageId'))
      sendEmpty(ctx.res)
    })
  )

  // ── Presencia ───────────────────────────────────────────────────────────

  router.add(
    'GET',
    '/v1/presence',
    authed(async (ctx, actor) => sendJson(ctx.res, 200, { items: await store.getPresence(actor) }))
  )

  router.add(
    'PUT',
    '/v1/presence',
    authed(async (ctx, actor) => {
      const { status, activity } = parsePresence(await readJson(ctx.req))
      sendJson(ctx.res, 200, await store.setPresence(actor, status, activity))
    })
  )

  // ── Releases (públicas) ─────────────────────────────────────────────────

  router.add('GET', '/v1/releases', async (ctx) => {
    const items = await store.listReleases({
      limit: intParam(ctx.query, 'limit', 20, 1, 100),
      includePrerelease: ctx.query.get('prerelease') === 'true'
    })
    sendJson(ctx.res, 200, { items })
  })

  router.add('GET', '/v1/releases/latest', async (ctx) => {
    const [latest] = await store.listReleases({
      limit: 1,
      includePrerelease: ctx.query.get('prerelease') === 'true'
    })
    if (!latest) throw notFound('release_not_found', 'No releases published yet.')
    sendJson(ctx.res, 200, latest)
  })

  router.add('GET', '/v1/releases/:tag', async (ctx) => {
    const release = await store.getRelease(ctx.params.tag)
    if (!release) throw notFound('release_not_found', `Release "${ctx.params.tag}" not found.`)
    sendJson(ctx.res, 200, release)
  })

  // ── Dispatcher ──────────────────────────────────────────────────────────

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    const allowAll = config.corsOrigins.includes('*')
    if (allowAll) res.setHeader('Access-Control-Allow-Origin', '*')
    else if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id')
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id')
  }

  return (req, res) => {
    const started = process.hrtime.bigint()
    const incomingId = req.headers['x-request-id']
    const requestId =
      typeof incomingId === 'string' && /^[\w.-]{1,64}$/.test(incomingId) ? incomingId : randomUUID()
    res.setHeader('X-Request-Id', requestId)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    applyCors(req, res)

    if (config.logRequests) {
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms.toFixed(1)} ms) [${requestId}]`)
      })
    }

    const run = async (): Promise<void> => {
      const method = (req.method ?? 'GET').toUpperCase()
      if (method === 'OPTIONS') return sendEmpty(res)
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = router.match(method, url.pathname)
      if (match.kind === 'not_found') {
        throw notFound('route_not_found', `No route for ${method} ${url.pathname}.`)
      }
      if (match.kind === 'method_not_allowed') {
        res.setHeader('Allow', [...new Set(match.allow)].join(', '))
        throw new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${url.pathname}.`)
      }
      await match.handler({ req, res, params: match.params, query: url.searchParams })
    }

    run().catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof ApiError) return sendError(res, error)
      console.error(`[api] unhandled error [${requestId}]`, error)
      sendError(res, new ApiError(500, 'internal_error', 'Unexpected server error.'))
    })
  }
}
