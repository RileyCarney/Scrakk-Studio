// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** B16: direcciones bloqueadas por web_fetch. Sin red: solo literales. */

import { describe, it, expect, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({ lookup: async () => [] }))

import { isBlockedIp, assertPublicHost } from '../src/main/web/ssrf'

describe('isBlockedIp: IPv4', () => {
  it.each([
    '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'
  ])('%s bloqueada', (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1'])('%s pública permitida', (ip) => {
    expect(isBlockedIp(ip)).toBe(false)
  })

  it('loopback sigue permitido para dev', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(false)
  })
})

describe('isBlockedIp: IPv6', () => {
  it.each([
    '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', '2001:db8::1'
  ])('%s bloqueada', (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  it.each(['2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s pública permitida', (ip) => {
    expect(isBlockedIp(ip)).toBe(false)
  })

  it('::1 permitido (loopback)', () => {
    expect(isBlockedIp('::1')).toBe(false)
  })
})

describe('assertPublicHost', () => {
  it('acepta IPv6 pública entre corchetes (antes fallaba)', async () => {
    await expect(assertPublicHost('[2606:4700:4700::1111]')).resolves.toBeUndefined()
  })

  it('rechaza IPv6 privada entre corchetes', async () => {
    await expect(assertPublicHost('[fd00::1]')).rejects.toThrow(/SSRF/)
  })

  it('rechaza IPv4 privada literal', async () => {
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow(/SSRF/)
  })
})
