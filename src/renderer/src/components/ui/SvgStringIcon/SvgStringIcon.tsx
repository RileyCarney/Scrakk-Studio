// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import type { CSSProperties } from 'react'

interface SvgStringIconProps {
  /** SVG de un paquete de extensión: NO se inyecta como HTML (B19). */
  svg: string
  className?: string
}

/**
 * Renderiza un SVG de texto dentro de un `<img>` con data URI. Un `<img>` no
 * ejecuta scripts ni hereda CSS/eventos del documento, a diferencia de
 * `dangerouslySetInnerHTML`, que dejaba a un `.sef` inyectar HTML en la UI.
 */
export function SvgStringIcon({ svg, className }: SvgStringIconProps): JSX.Element {
  const style: CSSProperties = { display: 'block', width: '100%', height: '100%' }
  return (
    <img
      className={className}
      style={style}
      alt=""
      aria-hidden="true"
      draggable={false}
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
    />
  )
}
