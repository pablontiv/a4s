#!/usr/bin/env node
// Script que sincroniza protocol.ts en adapter.ts con un banner.
// Uso: node adapters/claude/scripts/sync-protocol.mjs (desde packages/synagent)

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const BANNER = `// GENERADO — copia de packages/synagent/protocol.ts. NO editar a mano.
// Regenerar: node adapters/claude/scripts/sync-protocol.mjs (desde packages/synagent).
// El plugin se instala copiándose solo; por eso lleva su propia copia del contrato.`

// Resolver rutas
const protocolPath = join(__dirname, '../../../protocol.ts')
const adapterPath = join(__dirname, '../hooks/adapter.ts')

// Leer protocol.ts
const protocolSrc = readFileSync(protocolPath, 'utf-8')

// Escribir adapter.ts = banner + '\n\n' + contenido
const output = BANNER + '\n\n' + protocolSrc
writeFileSync(adapterPath, output, 'utf-8')

console.log(`✓ ${adapterPath}`)
