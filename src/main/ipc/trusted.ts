// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isAllowedNavigation } from '../windows/main-window'

/**
 * A3: los canales sensibles solo responden a la propia UI de la app. Un webview
 * de extensión (`scrakk-ext:`) o cualquier frame ajeno no puede pedir API keys
 * ni otras operaciones de la app, aunque el preload esté expuesto a su origen.
 */
export function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  return url !== '' && isAllowedNavigation(url)
}

/** Registra un `handle` que rechaza a remitentes no confiables con `fallback`. */
export function handleTrusted<T>(
  channel: string,
  fallback: T,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return fallback
    return handler(event, ...args)
  })
}
