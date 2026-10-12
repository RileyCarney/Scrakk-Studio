// @vitest-environment happy-dom
// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/** T3: si un componente revienta, la app muestra el fallback y no queda en negro. */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

import { AppErrorBoundary } from '../../src/renderer/src/components/layout/AppErrorBoundary/AppErrorBoundary'

function Boom(): JSX.Element {
  throw new Error('explotó')
}

describe('AppErrorBoundary', () => {
  it('muestra el fallback cuando un hijo lanza, en vez de dejar la pantalla vacía', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    )
    // Pantalla de error con rol de alerta, el mensaje real y los botones de acción.
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain('explotó')
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2)
  })

  it('renderiza a sus hijos cuando no hay error', () => {
    const { container } = render(
      <AppErrorBoundary>
        <p>todo bien</p>
      </AppErrorBoundary>
    )
    expect(container.textContent).toContain('todo bien')
  })
})
