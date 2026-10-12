// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Stream de chat de punta a punta (main): fetch simulado, sender simulado.
 * Cubre el camino que antes no tenía test y que una regresión rompió sin que
 * ningún test fallara.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: any) => h.handlers.set(c, fn),
    on: (c: string, fn: any) => h.handlers.set(c, fn)
  },
  app: { getPath: () => '/tmp', isPackaged: false, on() {} }
}))

vi.mock('../src/main/secrets/providerKeys', () => ({
  getProviderKey: (id: string) => (id === 'openai' ? 'sk-stored' : null)
}))

import { LLM_IPC } from '../src/shared/llm'
import { registerLlmIpc } from '../src/main/ipc/llm'

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e))
      controller.close()
    }
  })
}

function makeSender() {
  const sent: Array<{ channel: string; payload: any }> = []
  let destroyed = false
  const destroyListeners: Array<() => void> = []
  return {
    sent,
    sender: {
      id: 1,
      isDestroyed: () => destroyed,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      once: (event: string, fn: () => void) => {
        if (event === 'destroyed') destroyListeners.push(fn)
      }
    },
    destroy: () => {
      destroyed = true
      destroyListeners.forEach((fn) => fn())
    }
  }
}

const baseRequest = {
  requestId: 'req-1',
  providerId: 'openai',
  baseUrl: 'https://api.test/v1',
  model: 'm',
  messages: [{ role: 'user', content: 'hola' }]
}

async function run(request: Record<string, unknown>, sender: any): Promise<unknown> {
  return h.handlers.get(LLM_IPC.chatStreamStart)!({ sender }, request)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('llm stream (main)', () => {
  beforeEach(() => {
    registerLlmIpc()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emite contenido y termina con chatStreamDone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sseBody([
        'data: {"choices":[{"delta":{"content":"ho"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"la"}}]}\n\n',
        'data: [DONE]\n\n'
      ]), { status: 200 }))
    )
    const s = makeSender()
    await run(baseRequest, s.sender)
    await settle()
    const chunks = s.sent.filter((e) => e.channel === LLM_IPC.chatStreamChunk).map((e) => e.payload.delta)
    const done = s.sent.find((e) => e.channel === LLM_IPC.chatStreamDone)
    expect(chunks.join('')).toBe('hola')
    expect(done?.payload.content).toBe('hola')
  })

  it('usa la key guardada en el main, aunque el renderer no la envíe', async () => {
    const fetchMock = vi.fn(async () => new Response(sseBody(['data: [DONE]\n\n']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const s = makeSender()
    await run(baseRequest, s.sender)
    await settle()
    const auth = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(auth.Authorization).toBe('Bearer sk-stored')
  })

  it('sin key guardada ni enviada, avisa el error y no llama al proveedor', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const s = makeSender()
    await run({ ...baseRequest, providerId: 'sin-key' }, s.sender)
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(s.sent.find((e) => e.channel === LLM_IPC.chatStreamError)?.payload.error).toBeTruthy()
  })

  it('un error dentro del stream (HTTP 200) se reporta y no termina como éxito', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sseBody([
        'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
        'data: {"error":{"message":"cuota agotada"}}\n\n'
      ]), { status: 200 }))
    )
    const s = makeSender()
    await run(baseRequest, s.sender)
    await settle()
    expect(s.sent.some((e) => e.channel === LLM_IPC.chatStreamDone)).toBe(false)
    const err = s.sent.find((e) => e.channel === LLM_IPC.chatStreamError)
    expect(err?.payload.error).toContain('cuota agotada')
  })

  it('el último data: sin salto de línea final no se pierde', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sseBody([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}'
      ]), { status: 200 }))
    )
    const s = makeSender()
    await run(baseRequest, s.sender)
    await settle()
    expect(s.sent.find((e) => e.channel === LLM_IPC.chatStreamDone)?.payload.content).toBe('ab')
  })

  it('cerrar la ventana corta el fetch en curso', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal
        return new Response(new ReadableStream({ start() {} }), { status: 200 })
      })
    )
    const s = makeSender()
    await run(baseRequest, s.sender)
    await settle()
    s.destroy()
    await settle()
    expect(signal?.aborted).toBe(true)
  })

  it('un requestId repetido se rechaza mientras el primero sigue activo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }))
    )
    const s = makeSender()
    const request = { ...baseRequest, requestId: 'req-duplicado' }
    expect(await run(request, s.sender)).toEqual({ ok: true })
    await settle()
    expect((await run(request, s.sender) as { ok: boolean }).ok).toBe(false)
  })
})
