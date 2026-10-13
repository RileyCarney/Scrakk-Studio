// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Protección SSRF para `web_fetch` (port de `web_fetch/ssrf.rs` de scrakk-cli).
 *
 * Bloquea direcciones privadas, link-local, CGNAT, reservadas, multicast y
 * metadata de cloud antes de hacer la request. Loopback (127.x / ::1) SÍ se
 * permite para dev local.
 *
 * LIMITACIÓN conocida: la resolución se comprueba con una búsqueda DNS y el
 * fetch vuelve a resolver el host. Un DNS que cambie entre ambas (rebinding)
 * podría saltarse el chequeo. Cerrarlo requiere fijar la IP en el dispatcher
 * HTTP (undici), que hoy no es dependencia directa.
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { t } from '@shared/i18n'

/** IPv4 bloqueada (loopback se permite para dev local). */
function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = parts
  if (a === 127) return false // loopback (dev)
  if (a === 0) return true // "este" segmento / unspecified
  if (a === 10) return true // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a === 169 && b === 254) return true // link-local + metadata
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast, reservada y broadcast
  return false
}

/** Convierte dos hextetos IPv6 en un IPv4 dotted (para `::ffff:a9fe:a9fe`). */
function hextetsToV4(hi: string, lo: string): string {
  const h = parseInt(hi, 16)
  const l = parseInt(lo, 16)
  return `${h >> 8}.${h & 0xff}.${l >> 8}.${l & 0xff}`
}

/** IPv6 bloqueada (loopback permitido). */
function isBlockedV6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase()
  if (ip === '::1') return false
  if (ip === '::' || ip === '::0') return true
  // IPv4-mapeada: `::ffff:1.2.3.4` o la forma hex `::ffff:a9fe:a9fe`.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mappedDotted) return isBlockedV4(mappedDotted[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (mappedHex) return isBlockedV4(hextetsToV4(mappedHex[1], mappedHex[2]))
  // NAT64 (64:ff9b::/96) embebe un IPv4 en los últimos 32 bits.
  const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (nat64) return isBlockedV4(hextetsToV4(nat64[1], nat64[2]))
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true // fc00::/7 unique local
  if (/^fe[cdef][0-9a-f]:/.test(ip)) return true // fec0::/10 site-local (obsoleta)
  if (/^ff[0-9a-f]{2}:/.test(ip)) return true // ff00::/8 multicast
  if (/^2001:0?db8:/.test(ip)) return true // documentación
  return false
}

export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedV4(ip)
  if (version === 6) return isBlockedV6(ip)
  return true
}

/** Resuelve el host y verifica que ninguna dirección esté bloqueada. */
export async function assertPublicHost(hostRaw: string): Promise<void> {
  // `URL.hostname` deja los corchetes de IPv6 (`[::1]`): sin quitarlos, `isIP`
  // falla y una IPv6 pública nunca se podía pedir (B16).
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error(t('main.web.direccion.bloqueada', { host }))
    return
  }
  const addrs = await lookup(host, { all: true, verbatim: true }).catch(() => [])
  if (addrs.length === 0) throw new Error(t('main.web.host.sin.resolver', { host }))
  const blocked = addrs.find((entry) => isBlockedIp(entry.address))
  if (blocked) throw new Error(t('main.web.host.bloqueado', { host, address: blocked.address }))
}
