// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { I18N_IPC } from '@shared/window-controls'
import { setLocale } from '@shared/i18n'
import { registerLlmIpc } from './ipc/llm'
import { registerFsIpc } from './ipc/fs'
import { registerWindowControlsIpc } from './ipc/window-controls'
import { registerScreenshotIpc } from './ipc/screenshot'
import { registerExtensionsIpc } from './ipc/extensions'
import { registerLspIpc } from './lsp'
import { registerUpdatesIpc } from './app-updates'
import { registerExtensionFsIpc } from './extensions/permissions'
import { registerEncodingsIpc } from './encodings'
import { registerTerminalIpc } from './ipc/terminal'
import { registerGitIpc } from './ipc/git'
import { registerAccountIpc } from './account'
import { registerSocialIpc } from './social'
import { registerScrakkIpc } from './scrakk'
import { registerModelsDevIpc } from './models-dev'
import { registerWebIpc } from './web'
import {
  registerExtensionHostIpc,
  registerExtensionScheme,
  shutdownExtensionHosts
} from './ipc/extension-host'
import { flushAllTokens } from './supabaseClient'
import { loadLocalEnv } from './env'
import { createMainWindow, installPermissionPolicy, isAllowedNavigation, isAppLocalUrl } from './windows/main-window'
import { stopKolargrepServers } from './search/kolargrepServer'
import { applyPathAugmentation } from './binaries'
import { applyChromiumSwitches, registerGpuFallback } from './perf/startup'

// PATH ANTES QUE NADA: lanzada desde el menú, la app hereda el PATH pelado de la
// sesión (sin nvm/fnm/volta/~/.local/bin), y entonces `npm`, `node` y `git` no
// existen para el LSP, la terminal ni el panel de Git — sin ningún error visible.
// Se aumenta una sola vez aquí y todo hijo lo hereda. Ver `binaries.ts`.
applyPathAugmentation()

// Switches de Chromium/Electron (GPU, memoria) ANTES de ready.
applyChromiumSwitches()

// Si la GPU muere en Linux, relanzar UNA vez con software rendering.
registerGpuFallback()

// Nombre de app ANTES de ready: en Linux define el WM_CLASS/app_id.
// Sin esto, en dev la ventana se agrupa como "electron" y el dock ignora
// el logo (en Windows basta setIcon; en Linux/Wayland manda el .desktop
// + StartupWMClass, ver assets/scrakk-studio.desktop y desktop:install).
// Esquema de las extensiones (`scrakk-ext://`): sirve los documentos de
// webview y los assets de los paquetes. DEBE registrarse antes de `ready`.
registerExtensionScheme()

// B7: un error no capturado en el proceso principal no debe ser silencioso ni
// tirar la app entera sin rastro. Se registra y la app sigue viva.
process.on('uncaughtException', (error) => {
  console.error('[main] excepción no capturada:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] promesa rechazada sin manejar:', reason)
})

app.setName('scrakk-studio')
if (process.platform === 'linux') {
  app.setDesktopName('scrakk-studio.desktop')
}

// Instancia única: si ya hay una app corriendo, se enfoca su ventana.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const main = BrowserWindow.getAllWindows()[0]
    if (main) {
      if (main.isMinimized()) main.restore()
      main.focus()
    }
  })

  app.whenReady().then(() => {
    // .env local (R2 y dev): el entorno real siempre gana.
    loadLocalEnv()
    // Idioma activo: lo persiste el renderer y lo aplica el main, para que
    // los mensajes/errores del proceso principal salgan en el idioma elegido.
    ipcMain.on(I18N_IPC.setLocale, (_event, locale: unknown) => {
      if (locale === 'es' || locale === 'en') setLocale(locale)
    })
    registerWindowControlsIpc()
    registerScreenshotIpc()
    registerLlmIpc()
    registerFsIpc()
    registerExtensionsIpc()
    registerLspIpc()
    registerUpdatesIpc()
    registerExtensionFsIpc()
    registerEncodingsIpc()
    registerTerminalIpc()
    registerGitIpc()
    registerAccountIpc()
    registerSocialIpc()
    registerScrakkIpc()
    registerModelsDevIpc()
    registerWebIpc()
    registerExtensionHostIpc()

    // Links externos (target=_blank) se abren en el navegador del sistema,
    // nunca en una ventana nueva de Electron.
    app.on('web-contents-created', (_event, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        // El dev server (HMR) jamás se abre afuera.
        if (!isAppLocalUrl(url) && (url.startsWith('http://') || url.startsWith('https://'))) {
          void shell.openExternal(url)
        }
        return { action: 'deny' }
      })
      // La ventana de la app jamás navega a una web externa (defensa extra
      // para links sin target=_blank o redirects): se abre afuera. Las
      // navegaciones al propio dev server (reload de Vite HMR) se dejan pasar
      // EN la ventana; si no, el reload se cancela, la app queda congelada y
      // la URL local termina abierta en el navegador del sistema.
      // B24: fuera de nuestro origen no se navega dentro de la app (ni file:,
      // ni scrakk-ext:, ni data:, ni javascript:).
      contents.on('will-navigate', (event, url) => {
        if (isAllowedNavigation(url)) return
        event.preventDefault()
        if (url.startsWith('http://') || url.startsWith('https://')) {
          void shell.openExternal(url)
        }
      })
    })

    installPermissionPolicy()
    createMainWindow()

    // macOS: re-crear la ventana al activar el dock si no hay ninguna.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  // Flush de sesiones al cerrar: garantiza que los últimos tokens queden
  // guardados aunque el refresh haya ocurrido justo antes de salir.
  // Al salir se ESPERAN las tareas de cierre (B9): antes eran fire-and-forget y
  // el proceso moría antes de guardar los tokens refrescados. Hay un tope de
  // 3 s para que un proceso colgado no impida cerrar la app.
  let shuttingDown = false
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    const tasks = Promise.allSettled([flushAllTokens(), shutdownExtensionHosts()])
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    void Promise.race([tasks, deadline]).finally(() => {
      // Los servidores de búsqueda (kolargrep serve) tienen un lock exclusivo
      // por directorio: uno colgado bloquea al siguiente, así que van al final.
      stopKolargrepServers()
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
