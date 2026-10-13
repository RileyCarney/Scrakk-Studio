// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Primitivas HTTP de la API (sin dependencias): errores tipados, lectura de
 * JSON con tope de tamaño, respuestas y un router mínimo con parámetros.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Error de negocio: viaja hasta el handler y se responde con su status. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(400, code, message, details)
export const unprocessable = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(422, code, message, details)
export const unauthorized = (message = 'Missing or invalid access token.'): ApiError =>
  new ApiError(401, 'unauthorized', message)
export const forbidden = (code: string, message: string): ApiError =>
  new ApiError(403, code, message)
export const notFound = (code: string, message: string): ApiError => new ApiError(404, code, message)
export const conflict = (code: string, message: string): ApiError => new ApiError(409, code, message)
export const tooManyRequests = (code: string, message: string): ApiError =>
  new ApiError(429, code, message)

/** Tope del body: el archivo compartido más grande (512 KiB de texto) + margen. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'payload_too_large', 'Request body is too large.')
    }
    chunks.push(buf)
  }
  if (size === 0) return {}
  const type = (req.headers['content-type'] ?? '').toLowerCase()
  if (!type.includes('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('invalid_json', 'Request body is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('invalid_json', 'Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export function sendEmpty(res: ServerResponse, status = 204): void {
  res.writeHead(status)
  res.end()
}

export function sendError(res: ServerResponse, error: ApiError): void {
  const payload: Record<string, unknown> = { code: error.code, message: error.message }
  if (error.details !== undefined) payload.details = error.details
  sendJson(res, error.status, { error: payload })
}

// ── Router ─────────────────────────────────────────────────────────────────

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: RouteHandler
}

export type RouteMatch =
  | { kind: 'found'; handler: RouteHandler; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' }

export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: RouteHandler): this {
    const keys: string[] = []
    const source = path
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        keys.push(segment.slice(1))
        return '([^/]+)'
      })
      .join('/')
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler })
    return this
  }

  match(method: string, pathname: string): RouteMatch {
    const allow: string[] = []
    for (const route of this.routes) {
      const m = route.pattern.exec(pathname)
      if (!m) continue
      if (route.method !== method) {
        allow.push(route.method)
        continue
      }
      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1])
        } catch {
          throw badRequest('invalid_path', 'Malformed path parameter.')
        }
      })
      return { kind: 'found', handler: route.handler, params }
    }
    return allow.length > 0 ? { kind: 'method_not_allowed', allow } : { kind: 'not_found' }
  }
}
