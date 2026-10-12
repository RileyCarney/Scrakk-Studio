// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

/**
 * Shell safety analyzer — detects dangerous commands.
 *
 * Analiza por TOKENS, no con regex sobre el string completo: las flags se leen
 * en cualquier posición (`rm -fr /`, `rm / -rf`), las combinadas se expanden
 * (`-rf`) y los argumentos se comparan exactos (`--force` ≠ `--follow-tags`).
 * Cada segmento (separado por `;`, `&&`, `||`, `|`, `&`, saltos de línea) se
 * analiza por separado, y un comando envuelto (`sudo`, `bash -c "…"`) se
 * revisa en cada palabra que pueda ser un programa.
 */

import type { ShellSafetyResult } from './types'

type RiskLevel = ShellSafetyResult['riskLevel']

interface Finding {
  level: RiskLevel
  reason: string
}

type Add = (level: RiskLevel, reason: string) => void

/** Objetivos que borran el sistema o el home entero. */
const ROOT_TARGETS = new Set([
  '/', '/*', '~', '~/', '~/*', '$home', '$home/', '$home/*', '${home}', '${home}/', '${home}/*'
])

const SPLIT_SEGMENTS = /&&|\|\||;|\||&|\n/

function splitSegments(command: string): string[] {
  return command.split(SPLIT_SEGMENTS).map((s) => s.trim()).filter(Boolean)
}

function tokenize(segment: string): string[] {
  return segment.replace(/["']/g, '').split(/\s+/).filter(Boolean)
}

function basename(word: string): string {
  return word.split('/').pop() ?? word
}

/** Flags cortas de una lista de args, como letras (`-rf` → "rf"). */
function shortLetters(args: string[]): string {
  return args
    .filter((a) => /^-[a-z]+$/.test(a))
    .map((a) => a.slice(1))
    .join('')
}

function analyzeRm(args: string[], elevated: boolean, add: Add): void {
  const longFlags = args.filter((a) => a.startsWith('--'))
  const letters = shortLetters(args)
  const recursive = letters.includes('r') || longFlags.includes('--recursive')
  const force = letters.includes('f') || longFlags.includes('--force')
  const noPreserveRoot = longFlags.includes('--no-preserve-root')
  const rootTarget = args.some((a) => ROOT_TARGETS.has(a))

  if (elevated) add('critical', 'Sudo rm (elevated delete)')
  if (noPreserveRoot || (recursive && rootTarget)) {
    add('critical', 'Recursive delete from root or home')
  } else if (recursive && force) {
    add('high', 'Recursive force delete')
  } else if (recursive) {
    add('high', 'Recursive delete')
  } else if (force) {
    add('high', 'Force delete')
  }
  add('medium', 'Delete operation')
}

function analyzeGit(args: string[], add: Add): void {
  const [sub, ...rest] = args
  if (sub === 'push') {
    // `-f` y clusters de flags cortas que lo contienen (`-uf`). `--force` exacto:
    // `--force-with-lease` y `--follow-tags` no fuerzan nada.
    const forced = rest.some((a) => a === '--force' || (/^-[a-z]+$/.test(a) && a.includes('f')))
    if (forced) add('critical', 'Force push to git')
    else add('medium', 'Git push')
  }
  if (sub === 'reset' && rest.includes('--hard')) add('medium', 'Hard git reset')
  if (sub === 'checkout' && rest.includes('--')) add('medium', 'Force git checkout')
}

function analyzeSegment(tokens: string[], add: Add): void {
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]
    const head = basename(word)
    const args = tokens.slice(i + 1)
    const elevated = i > 0 && tokens[i - 1] === 'sudo'

    if (word === 'sudo') add('high', 'Superuser execution')

    if (head === 'rm') analyzeRm(args, elevated, add)
    else if (head === 'git' && args.length > 0) analyzeGit(args, add)
    else if (head.startsWith('mkfs')) add('critical', 'Filesystem formatting')
    else if (head === 'dd' && args.some((a) => a.startsWith('if='))) {
      add('critical', 'Direct disk write')
    } else if (head === 'chown' && shortLetters(args).includes('r')) {
      add('critical', 'Recursive ownership change')
    } else if (head === 'chmod') {
      if (args.includes('777')) add('critical', 'World-writable permissions')
      else if (shortLetters(args).includes('r')) add('high', 'Recursive permission change')
    } else if (head === 'kill' && args.includes('-9')) add('high', 'Force kill process')
    else if (head === 'killall') add('high', 'Kill all processes')
    else if (head === 'pkill') add('high', 'Kill processes by name')
    else if (head === 'shutdown') add('high', 'System shutdown')
    else if (head === 'reboot') add('high', 'System reboot')
    else if (head === 'mv') add('medium', 'Move/rename operation')
    else if (head === 'cp' && shortLetters(args).includes('r')) add('medium', 'Recursive copy')
    else if (head === 'npm' && ['publish', 'unpublish'].includes(args[0])) {
      add('medium', 'NPM publish operation')
    } else if (head === 'yarn' && args[0] === 'publish') add('medium', 'Yarn publish')
    else if (head === 'pip' && args[0] === 'install') add('medium', 'Package installation')
  }
}

/** Patrones que no dependen de la segmentación (fork bomb, escrituras a disco, SQL). */
function analyzeWhole(command: string, add: Add): void {
  const lower = command.toLowerCase()
  const squashed = lower.replace(/\s+/g, '')
  // `:(){ :|:& };:` y la forma con nombre `bomb(){ bomb|bomb& };bomb`.
  if (/:\(\)\{.*\|.*&\};:/.test(squashed) || /(\w+)\(\)\{.*\1\|\1&\};\1/.test(squashed)) {
    add('critical', 'Fork bomb')
  }
  if (/(^|[^0-9])>{1,2}\s*\/dev\/(sd|hd|xvd|nvme|disk)/.test(lower) || /\bof=\/dev\//.test(lower)) {
    add('critical', 'Direct disk device write')
  }
  if (/\bdrop\s+database\b/.test(lower)) add('critical', 'Database drop')
  if (/\btruncate\s+table\b/.test(lower)) add('critical', 'Table truncation')
  if (/\bcurl\b.*\|\s*(sh|bash)\b/.test(lower)) add('medium', 'Pipe curl to shell')
  if (/\bwget\b.*\|\s*(sh|bash)\b/.test(lower)) add('medium', 'Pipe wget to shell')
}

function analyze(command: string): Finding[] {
  const findings: Finding[] = []
  const add: Add = (level, reason) => findings.push({ level, reason })
  analyzeWhole(command, add)
  for (const segment of splitSegments(command.toLowerCase())) {
    analyzeSegment(tokenize(segment), add)
  }
  return findings
}

/**
 * Analyze a shell command for safety risks. Devuelve el nivel más alto que se
 * encontró y los motivos de ese nivel.
 */
export function isDangerousCommand(command: string): ShellSafetyResult {
  const trimmed = command.trim()
  const findings = analyze(trimmed)
  for (const level of ['critical', 'high', 'medium'] as const) {
    const reasons = [...new Set(findings.filter((f) => f.level === level).map((f) => f.reason))]
    if (reasons.length > 0) return { riskLevel: level, reasons, command: trimmed }
  }
  return { riskLevel: 'low', reasons: [], command: trimmed }
}
