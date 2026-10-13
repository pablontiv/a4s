export interface OrcaCommand {
  operation: string
  segment: string
}

const ORCA_WRAPPERS = new Set([
  '!',
  '(',
  '{',
  'command',
  'doas',
  'elif',
  'env',
  'exec',
  'if',
  'nohup',
  'sudo',
  'then',
  'timeout',
  'until',
  'while',
  'xargs',
])


export function findOrcaCommands(command: string, operation: string): OrcaCommand[] {
  return findOrcaCommandsAtDepth(command, operation, 0)
}

export function hasShellFlag(command: string, flag: string): boolean {
  return shellWords(command).some(word => word === flag || word.startsWith(`${flag}=`))
}

export function readShellFlag(command: string, flag: string): string | undefined {
  const words = shellWords(command)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === flag) {
      const value = words[index + 1]
      return value && !value.startsWith('--') ? value : undefined
    }
    if (word?.startsWith(`${flag}=`)) return word.slice(flag.length + 1) || undefined
  }
  return undefined
}

function findOrcaCommandsAtDepth(
  command: string,
  operation: string,
  depth: number,
): OrcaCommand[] {
  return splitShellSegments(command).flatMap((segment): OrcaCommand[] => {
    const words = shellWords(segment)
    const directIndex = words.findIndex((word, index) => {
      if (!isOrcaExecutable(word) || !isAllowedExecutablePosition(words, index)) return false
      const orchestrationIndex = findCommandPathWord(words, index + 1, 'orchestration')
      if (orchestrationIndex < 0) return false
      return findCommandPathWord(words, orchestrationIndex + 1, operation) >= 0
    })
    const direct = directIndex >= 0 ? [{ operation, segment }] : []
    if (depth >= 2) return direct

    const nested = findNestedShellCommands(words, operation, depth)
    return [...direct, ...nested]
  })
}

function findNestedShellCommands(
  words: string[],
  operation: string,
  depth: number,
): OrcaCommand[] {
  const shellIndex = words.findIndex(isShellExecutable)
  if (shellIndex < 0) return []

  for (let index = shellIndex + 1; index < words.length - 1; index += 1) {
    const option = words[index]
    if (!option?.startsWith('-') || !option.includes('c')) continue
    return findOrcaCommandsAtDepth(words[index + 1] ?? '', operation, depth + 1)
  }
  return []
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote: 'single' | 'double' | undefined
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single'
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double'
      continue
    }
    if (!quote && character && ';&|\n'.includes(character)) {
      const segment = command.slice(start, index).trim()
      if (segment) segments.push(segment)
      start = index + 1
    }
  }

  const finalSegment = command.slice(start).trim()
  if (finalSegment) segments.push(finalSegment)
  return segments
}

function shellWords(segment: string): string[] {
  const normalized = segment.replace(/\\\r?\n/g, '')
  const words: string[] = []
  let word = ''
  let quote: 'single' | 'double' | undefined
  let escaped = false
  const pushWord = () => {
    if (!word) return
    words.push(word)
    word = ''
  }

  for (const character of normalized) {
    if (escaped) {
      word += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single'
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double'
      continue
    }
    if (!quote && /\s/.test(character)) {
      pushWord()
      continue
    }
    word += character
  }

  pushWord()
  return words
}

function findCommandPathWord(words: string[], start: number, expected: string): number {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index]
    if (word === expected) return index
    if (!word?.startsWith('-')) return -1
    if (word.includes('=')) continue

    const possibleValue = words[index + 1]
    if (possibleValue !== expected && !possibleValue?.startsWith('-')) index += 1
  }
  return -1
}

function isAllowedExecutablePosition(words: string[], executableIndex: number): boolean {
  let first = 0
  while (first < executableIndex && isAssignment(words[first])) first += 1
  if (first === executableIndex) return true
  const prefix = words[first]
  return Boolean(prefix && ORCA_WRAPPERS.has(prefix))
}

function isShellExecutable(word: string): boolean {
  const basename = word.split('/').at(-1)
  return basename === 'bash' || basename === 'dash' || basename === 'sh' || basename === 'zsh'
}

function isAssignment(word: string | undefined): boolean {
  return Boolean(word && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
}

function isOrcaExecutable(word: string): boolean {
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(word)) return true
  const basename = word.split('/').at(-1)
  return basename === 'orca' || basename === 'orca-dev' || basename === 'orca-ide'
}

