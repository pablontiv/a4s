from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from helper.models import Ownership, PlatformProfile, RuntimeContext
from helper.ownership import classify_exact_file_ownership, recognized_managed_marker_evidence


class OwnershipTests(unittest.TestCase):
    def _context(self, home: Path) -> RuntimeContext:
        return RuntimeContext(PlatformProfile("linux", home, {}))

    def test_managed_marker_requires_complete_trimmed_html_comment_with_identifier(self):
        text = "\n".join((
            "A prose note mentions gentle-ai:sdd-init.",
            "https://example.invalid/?q=gentle-ai:sdd-init",
            "`gentle-ai:sdd-init`",
            "<!-- docs mention gentle-ai:sdd-init, not a managed marker -->",
            "<!-- gentle-ai: -->",
            "  <!-- gentle-ai:sdd-init -->  ",
        ))
        self.assertEqual(
            recognized_managed_marker_evidence(text, "gentle-ai:"),
            [{"kind": "marker", "value": "<!-- gentle-ai:sdd-init -->", "identifier": "sdd-init"}],
        )




if __name__ == "__main__":
    unittest.main()
