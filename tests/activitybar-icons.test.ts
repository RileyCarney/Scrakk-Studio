// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** B19: un ícono de extensión nunca llega al DOM como HTML crudo. */

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildActivityBarButton } from '../src/renderer/src/services/extensions/types/activitybar/logic'
import { SvgStringIcon } from '../src/renderer/src/components/ui/SvgStringIcon/SvgStringIcon'

const contribution = {
  id: 'acme.bar',
  label: 'Acme',
  icon: '<img src=x onerror="alert(1)">',
  side: 'left',
  target: 'panel',
  panelId: 'acme',
  order: 1
} as any

describe('B19: íconos de extensiones', () => {
  it('si el módulo no resuelve, el ícono de reemplazo NO es el string del manifest', () => {
    const button = buildActivityBarButton(contribution, { resolveIcon: () => undefined } as any)
    expect(typeof button.icon).not.toBe('string')
    const html = renderToStaticMarkup(createElement(button.icon as any, { size: 20 }))
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
  })

  it('un SVG de texto se renderiza como img con data URI (sin script)', () => {
    const html = renderToStaticMarkup(
      createElement(SvgStringIcon, { svg: '<svg onload="alert(1)"><script>alert(2)</script></svg>' })
    )
    expect(html.startsWith('<img')).toBe(true)
    expect(html).toContain('src="data:image/svg+xml;charset=utf-8,')
    expect(html).not.toContain('onload="alert')
    expect(html).not.toContain('<script')
  })
})
