import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const methodRoot = fileURLToPath(new URL("../skills/discovery", import.meta.url));
const lensRoot = join(methodRoot, "lenses");

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ");
}

test("el contrato conserva las reglas no negociables", () => {
  const contract = normalized(join(methodRoot, "CONTRACT.md"));
  const required = [
    "en lugar de asumir main o master",
    "# Restricciones (no negociables)",
    "El repositorio es de solo lectura",
    "sin checkout, sin cambios",
    "Declara la rama y el commit auditados",
    "van solo en la carpeta temporal del sistema o del harness",
    "solo el dump (su markdown y su JSONL) y solo si el operador lo pide",
    "En modo desatendido, ninguna",
    "las únicas excepciones son la solicitud de recursos y la confirmación de la ruta del dump",
    "presenta en una única solicitud la lista de recursos",
    "usa solo los recursos aprobados",
    "no evaluada: requiere <recurso>",
    "hasta ocho a la vez",
    "el único reintento permitido es dividirla en partes más pequeñas",
    "Prefiere la evidencia por ejecución sobre la lectura del código",
    "aunque tu contexto se compacte",
    "Lo que entregues es siempre el resultado consolidado",
    "distintas de este diagnóstico",
    "índice de funciones o componentes con hallazgos",
    "markdown legible y JSONL con un hallazgo por línea",
    "si no existe, propón una ruta y espera confirmación",
  ];

  for (const phrase of required) {
    assert.ok(contract.includes(phrase), `falta la regla: ${phrase}`);
  }
});

test("el contrato define la escala de severidad y las claves JSONL", () => {
  const contract = normalized(join(methodRoot, "CONTRACT.md"));
  for (const field of [
    "`id`: huella estable",
    "`lens`: lente",
    "`unit`: unidad de análisis",
    "`location`: archivo:línea",
    "`criterion`: criterio incumplido",
    "`severity`:",
    "`critica`:",
    "`alta`:",
    "`media`:",
    "`baja`:",
    "`evidence`: evidencia",
    "`reproduce`: pasos para reproducir",
    "`status`: `verificado` / `sospechado`",
    "`verification`: el test, benchmark o fixture determinista",
    "`temporal` es `nuevo`, `persistente`, `resuelto` o `regresion`",
  ]) {
    assert.ok(contract.includes(field), `falta el campo o valor: ${field}`);
  }
});

test("la lente de cobertura funcional conserva las reglas originales", () => {
  const lens = normalized(join(lensRoot, "0-cobertura-funcional.md"));
  for (const phrase of [
    "evalúa todas las trayectorias del inventario",
    "Divide el trabajo por módulo o punto de entrada",
    "tiene pruebas unitarias",
    "no sustituyen a las unitarias",
    "repetida/duplicada",
    "divergente",
    "la lista de trayectorias repetidas, duplicadas y divergentes, y la lista de funciones con problemas",
  ]) {
    assert.ok(lens.includes(phrase), `falta la regla de cobertura: ${phrase}`);
  }
});

test("cada lente declara objetivo, unidad y criterios", () => {
  const lenses = readdirSync(lensRoot).filter((name) => name.endsWith(".md")).sort();
  assert.ok(lenses.length >= 5);

  for (const name of lenses) {
    const text = normalized(join(lensRoot, name));
    assert.match(text, /^# Lente \d+: /, name);
    for (const field of ["- Objetivo:", "- Unidad de análisis:", "Criterios:"]) {
      assert.ok(text.includes(field), `${name} no declara ${field}`);
    }
  }
});

test("el índice enlaza todas las lentes presentes", () => {
  const method = readFileSync(join(methodRoot, "METHOD.md"), "utf8");
  assert.ok(method.includes("(CONTRACT.md)"));
  const linked = new Set([...method.matchAll(/\(lenses\/([^)]+\.md)\)/g)].map((match) => match[1]));
  const present = new Set(readdirSync(lensRoot).filter((name) => name.endsWith(".md")));
  assert.deepEqual(linked, present);
});
