#!/usr/bin/env node
// Genera las dos variantes autocontenidas de diagnostics.ts para Claude.

import { readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { Script } from 'node:vm'

const banner = `// GENERADO — fuente: packages/synagent/core/diagnostics.ts. NO editar a mano.
// Regenerar: node adapters/claude/scripts/sync-diagnostics.mjs (desde packages/synagent/core).
// El marketplace instala solo el directorio del plugin Claude.`
const source = readFileSync(new URL('../../../diagnostics.ts', import.meta.url), 'utf8')

// La fuente usa tipos borrables, imports default de node:* y exports de
// funciones/constantes. Solo estos bordes ESM requieren conversión a CommonJS;
// Script valida el resultado antes de escribir cualquiera de los artefactos.
const exports = []
const commonjs = stripTypeScriptTypes(source, { mode: 'strip' })
  .replace(/^import (\w+) from '(node:[^']+)'$/gm, (_match, name, specifier) =>
    `const ${name} = require(${JSON.stringify(specifier)})`)
  .replace(/^export (?=(?:const|function) (\w+))/gm, (_match, name) => {
    exports.push(name)
    return ''
  })
const cjs = `${banner}\n\n'use strict'\n\n${commonjs}\nmodule.exports = { ${exports.join(', ')} }\n`
new Script(cjs, { filename: 'diagnostics.cjs' })

const artifacts = [
  ['../diagnostics.ts', `${banner}\n\n${source}`],
  ['../bridge/diagnostics.cjs', cjs],
]
const check = process.argv.includes('--check')
for (const [relative, expected] of artifacts) {
  const target = new URL(relative, import.meta.url)
  if (check) {
    let actual
    try {
      actual = readFileSync(target, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (actual !== expected) {
      console.error(`Desincronizado: ${target.pathname}; ejecutar sync-diagnostics.mjs`)
      process.exitCode = 1
    }
  } else {
    writeFileSync(target, expected, 'utf8')
  }
}
