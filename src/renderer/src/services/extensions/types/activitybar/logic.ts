// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Tipo 'activityBar' — lógica de registro.
 * Construye el ActivityBarButton que consume la activity bar de la app.
 */

import { createElement, type ComponentType } from 'react'
import type { ActivityBarButton } from '@features/activitybar'
import type { ComponentResolver } from '../../manifest'
import type { ActivityBarContribution } from './schema'

/**
 * Ícono de reemplazo cuando el módulo no resuelve. Antes se usaba el string del
 * manifest como HTML crudo (B19): ahora nunca se renderiza texto del paquete.
 */
const MissingIcon: ComponentType<{ size?: number }> = ({ size = 20 }) =>
  createElement('span', {
    'aria-hidden': true,
    style: { display: 'inline-block', width: size, height: size }
  })

export function buildActivityBarButton(
  contribution: ActivityBarContribution,
  resolver: ComponentResolver
): ActivityBarButton {
  return {
    id: contribution.id,
    label: contribution.label,
    icon: resolver.resolveIcon(contribution.icon) ?? MissingIcon,
    side: contribution.side,
    target: contribution.target,
    panelId: contribution.panelId,
    order: contribution.order
  }
}
