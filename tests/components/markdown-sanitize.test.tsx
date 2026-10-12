// @vitest-environment happy-dom
// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * T3: el markdown del chat no puede inyectar script, handlers ni URLs
 * peligrosas, aunque el modelo (o el texto que el modelo leyó) lo pida.
 */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('@features/chat/components/Markdown/CodeBlock', () => ({ CodeBlock: () => null }))

import { Markdown } from '../../src/renderer/src/features/chat/components/Markdown/Markdown'

describe('Markdown del chat: sanitizado', () => {
  it('no renderiza <script> ni handlers inline', () => {
    const { container } = render(
      <Markdown content={'Hola <script>alert(1)</script> <img src=x onerror="alert(2)">'} />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
  })

  it('no deja links javascript:', () => {
    const { container } = render(<Markdown content={'[click](javascript:alert(3))'} />)
    const href = container.querySelector('a')?.getAttribute('href') ?? ''
    expect(href.toLowerCase()).not.toContain('javascript:')
  })

  it('sí renderiza texto y negrita normales', () => {
    const { container } = render(<Markdown content={'**importante** de verdad'} />)
    expect(container.querySelector('strong')?.textContent).toBe('importante')
    expect(container.textContent).toContain('de verdad')
  })
})
