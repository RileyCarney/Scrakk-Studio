// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * A8: fuses de Electron al empaquetar. Cierran vías de inyección de código que
 * el atacante usaría para ejecutar Node dentro del binario de la app:
 *  - RunAsNode / NODE_OPTIONS / CLI inspect: desactivados.
 *  - Integridad del asar y carga solo desde asar: activados.
 *  - Cifrado de cookies: activado.
 */

const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[electronPlatformName]
  if (ext === undefined) return
  const executable = path.join(appOutDir, `${packager.appInfo.productFilename}${ext}`)

  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  })
}
