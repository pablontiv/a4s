from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METHOD_ROOT = ROOT / "methods" / "continuous-diagnostics"
LENS_ROOT = METHOD_ROOT / "lenses"


def normalized(path: Path) -> str:
    """Texto con espacios colapsados, para buscar frases que cruzan saltos de línea."""
    return re.sub(r"\s+", " ", path.read_text(encoding="utf-8"))


class ContinuousDiagnosticsMethodTests(unittest.TestCase):
    """Fija las reglas del contrato para que una reescritura no las pierda en silencio."""

    def test_contract_keeps_non_negotiable_rules(self) -> None:
        contract = normalized(METHOD_ROOT / "CONTRACT.md")
        required = (
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
        )
        for phrase in required:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, contract)

    def test_contract_defines_severity_scale_and_finding_schema(self) -> None:
        contract = normalized(METHOD_ROOT / "CONTRACT.md")
        for field in ("crítica:", "alta:", "media:", "baja:", "id: huella estable",
                      "estado: verificado / sospechado",
                      "estado temporal: nuevo / persistente / resuelto / regresión",
                      "verificación propuesta:"):
            with self.subTest(field=field):
                self.assertIn(field, contract)

    def test_functional_coverage_lens_keeps_original_audit_rules(self) -> None:
        lens = normalized(LENS_ROOT / "0-cobertura-funcional.md")
        required = (
            "evalúa todas las trayectorias del inventario",
            "Divide el trabajo por módulo o punto de entrada",
            "tiene pruebas unitarias",
            "no sustituyen a las unitarias",
            "repetida/duplicada",
            "divergente",
            "la lista de trayectorias repetidas, duplicadas y divergentes, y la lista de funciones con problemas",
        )
        for phrase in required:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, lens)

    def test_every_lens_declares_objective_unit_and_criteria(self) -> None:
        lenses = sorted(LENS_ROOT.glob("*.md"))
        self.assertGreaterEqual(len(lenses), 5)
        for path in lenses:
            text = normalized(path)
            with self.subTest(lens=path.name):
                self.assertRegex(text, r"^# Lente \d+: ")
                for field in ("- Objetivo:", "- Unidad de análisis:", "Criterios:"):
                    self.assertIn(field, text)

    def test_method_index_links_every_lens(self) -> None:
        method = (METHOD_ROOT / "METHOD.md").read_text(encoding="utf-8")
        self.assertIn("(CONTRACT.md)", method)
        linked = set(re.findall(r"\(lenses/([^)]+\.md)\)", method))
        present = {path.name for path in LENS_ROOT.glob("*.md")}
        self.assertEqual(linked, present)


if __name__ == "__main__":
    unittest.main()
