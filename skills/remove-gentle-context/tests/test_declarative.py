from __future__ import annotations

import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from typing import Any

from helper.adapter import AdapterRegistry
from helper.declarative import load_declarative_adapter
from helper.engine import build_inventory, build_plan
from helper.models import OperationKind, Ownership, PlatformProfile, ReceiptStatus, RuntimeContext
from helper.ownership import canonical_tree_sha256
from helper.transaction import execute_plan
from helper.verifier import verify_receipt


SKILL_ROOT = Path(__file__).resolve().parents[1]
TEST_SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567"
WRONG_SOURCE_COMMIT = "fedcba9876543210fedcba9876543210fedcba98"
SOURCE_REPOSITORY = "https://github.com/pablontiv/skills"
UPSTREAM = {
    "upstream-author": "Alan-TheGentleman",
    "upstream-repository": "https://github.com/Gentleman-Programming/gentle-ai",
    "upstream-commit": "d1e1777faafc91a34656ba94bd712972dbe427a1",
}



class DeclarativeAdapterTests(unittest.TestCase):
    def test_adapter_registry_rejects_duplicate_and_unknown_clients(self):
        class StubAdapter:
            client = "gemini"

            def inventory(self, context):
                return ()

            def compile(self, candidate, context):
                return ()

            def verify(self, receipt, context):
                return ()

        registry = AdapterRegistry()
        adapter = StubAdapter()
        registry.register(adapter)
        self.assertIs(registry.for_client("gemini"), adapter)
        with self.assertRaisesRegex(ValueError, "adapter_duplicate_client"):
            registry.register(StubAdapter())
        with self.assertRaisesRegex(ValueError, "adapter_unknown_client"):
            registry.for_client("unknown")

    def _context(self, home: Path, **env: str) -> RuntimeContext:
        return RuntimeContext(PlatformProfile("linux", home, dict(env)))






    def test_fixture_files_cover_valid_and_forbidden_declarative_examples(self):
        fixture_root = SKILL_ROOT / "tests" / "fixtures" / "declarative"
        self.assertEqual(load_declarative_adapter(fixture_root / "valid.json").client, "gemini")
        with self.assertRaisesRegex(ValueError, "adapter_forbidden_capability"):
            load_declarative_adapter(fixture_root / "forbidden-toml.json")

    def test_rejects_toml_sqlite_runtime_and_arbitrary_text_rules(self):
        forbidden = ["toml_edit", "sqlite_update", "runtime_state", "regex_replace"]
        for kind in forbidden:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as td:
                path = Path(td) / "adapter.json"
                path.write_text(json.dumps({
                    "schema": "remove-gentle-context.adapter/v1",
                    "client": "bad",
                    "roots": {"config": {"kind": "home_relative", "path": ".bad"}},
                    "rules": [{"id": "bad", "kind": kind, "root": "config", "path": "state"}],
                }))
                with self.assertRaisesRegex(ValueError, "adapter_forbidden_capability"):
                    load_declarative_adapter(path)











class NoopLifecycle:
    def preflight(self, actions, context):
        return ()


class DeclarativeCompilerTests(unittest.TestCase):
    def _context(self, home: Path, **env: str) -> RuntimeContext:
        return RuntimeContext(PlatformProfile("linux", home, dict(env)))

    def _write_adapter(self, path: Path, *, client: str, root_path: str, rules: list[dict[str, Any]]) -> None:
        path.write_text(json.dumps({
            "schema": "remove-gentle-context.adapter/v1",
            "client": client,
            "roots": {"config": {"kind": "home_relative", "path": root_path}},
            "rules": rules,
        }))

    def _build_plan(self, adapter_path: Path, home: Path):
        adapter = load_declarative_adapter(adapter_path)
        context = self._context(home)
        inventory = build_inventory(context, (adapter,))
        plan = build_plan(inventory, context, (adapter,))
        return adapter, context, inventory, plan

    def _execute(self, adapter_path: Path, home: Path):
        adapter, context, inventory, plan = self._build_plan(adapter_path, home)
        receipt = execute_plan(plan, plan.digest or "", context, NoopLifecycle(), inventory=inventory)
        self.assertEqual(receipt.status, ReceiptStatus.COMPLETED)
        return adapter, context, inventory, plan, receipt

    def _assert_second_plan_is_empty(self, adapter, context: RuntimeContext) -> None:
        second_inventory = build_inventory(context, (adapter,))
        second_plan = build_plan(second_inventory, context, (adapter,))
        self.assertEqual(second_plan.operations, ())

    def _decoded_postimage(self, operation) -> bytes:
        self.assertIsNotNone(operation.postimage_base64)
        decoded = base64.b64decode(operation.postimage_base64 or "")
        self.assertEqual(operation.postimage_sha256, "sha256:" + hashlib.sha256(decoded).hexdigest())
        return decoded


    def _fixture_bytes(self, name: str) -> bytes:
        return (SKILL_ROOT / "tests" / "fixtures" / "declarative" / name).read_bytes()

    def _span(self, content: bytes, needle: bytes, *, occurrence: int = 1) -> tuple[int, int]:
        start = -1
        search_from = 0
        for _ in range(occurrence):
            start = content.find(needle, search_from)
            self.assertNotEqual(start, -1, f"missing span fixture needle: {needle!r}")
            search_from = start + 1
        return start, start + len(needle)

    def _without_spans(self, content: bytes, spans: list[tuple[int, int]]) -> bytes:
        ordered = sorted(spans)
        previous_end = -1
        chunks: list[bytes] = []
        cursor = 0
        for start, end in ordered:
            self.assertGreaterEqual(start, previous_end)
            chunks.append(content[cursor:start])
            cursor = end
            previous_end = end
        chunks.append(content[cursor:])
        return b"".join(chunks)

    def _assert_json_splice_postimage(self, *, original: bytes, postimage: bytes, removed_spans: list[tuple[int, int]]) -> None:
        expected = self._without_spans(original, removed_spans)
        self.assertEqual(postimage, expected)
        json.loads(postimage.decode("utf-8"))


    def test_empty_directory_plan_apply_removes_only_empty_directory(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            empty_dir = home / ".custom" / "cache" / "empty"
            nonempty_dir = home / ".custom" / "cache" / "nonempty"
            empty_dir.mkdir(parents=True)
            nonempty_dir.mkdir(parents=True)
            (nonempty_dir / "keep.txt").write_text("personal cache\n")
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "empty", "kind": "empty_directory", "root": "config", "path": "cache/empty"},
                {"id": "nonempty", "kind": "empty_directory", "root": "config", "path": "cache/nonempty"},
            ])

            adapter, context, _inventory, plan, _receipt = self._execute(adapter_path, home)

            self.assertEqual(len(plan.operations), 1)
            self.assertEqual(plan.operations[0].kind, OperationKind.REMOVE_EMPTY_DIRECTORY)
            self.assertEqual(plan.operations[0].path, str(empty_dir))
            self.assertFalse(empty_dir.exists())
            self.assertEqual((nonempty_dir / "keep.txt").read_text(), "personal cache\n")
            self._assert_second_plan_is_empty(adapter, context)













    def test_json_grouped_postimage_splices_only_configured_member_and_item_bytes(self):
        original = self._fixture_bytes("json-surgery-formatting.json")
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_bytes(original)
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "object-first", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/objects/first", "key": "remove"},
                {"id": "object-middle", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/objects/middle", "key": "remove"},
                {"id": "object-last", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/objects/last", "key": "remove"},
                {"id": "object-only", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/objects/only", "key": "remove"},
                {"id": "escaped-nested-object", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/nested/1/escaped~0key~1segment", "key": "remove/key"},
                {"id": "array-first", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/arrays/first", "value": {"owned": "gentle", "meta": [1, {"x": True}]}},
                {"id": "array-middle", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/arrays/middle", "value": "gentle-ai:sdd-init"},
                {"id": "array-last", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/arrays/last", "value": "gentle-ai:sdd-init"},
                {"id": "array-only", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/arrays/only", "value": "gentle-ai:sdd-init"},
                {"id": "array-duplicates", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/arrays/duplicates", "value": {"text": "gentle-ai:sdd-init"}},
            ])

            _adapter, _context, inventory, plan = self._build_plan(adapter_path, home)

            self.assertEqual(len(inventory.candidates), 10)
            self.assertEqual(len(plan.operations), 1)
            postimage = self._decoded_postimage(plan.operations[0])
            removed_spans = [
                self._span(original, b'"remove" : { "owned": true },\n      '),
                self._span(original, b'"remove" : { "owned": true },\n      ', occurrence=2),
                self._span(original, b',\n      "remove" : { "owned": true }', occurrence=2),
                self._span(original, b'"remove" : { "owned": true }', occurrence=4),
                self._span(original, b', "remove/key" : {"nested" : [true, false]}'),
                self._span(original, b'{"owned": "gentle", "meta": [1, {"x": true}]},\n      '),
                self._span(original, b'"gentle-ai:sdd-init",\n      '),
                self._span(original, b',\n      "gentle-ai:sdd-init"', occurrence=2),
                self._span(original, b'"gentle-ai:sdd-init"', occurrence=3),
                self._span(original, b'{"text": "gentle-ai:sdd-init"},\n      '),
                self._span(original, b',\n      {"text": "gentle-ai:sdd-init"},\n      {"text": "gentle-ai:sdd-init"}'),
            ]
            self._assert_json_splice_postimage(original=original, postimage=postimage, removed_spans=removed_spans)
            mcp_bytes = b'"mcp" : {"servers":{"personal":{"command":"keep", "args":["--flag", "value"]}}}'
            self.assertIn(mcp_bytes, postimage)
            updated = json.loads(postimage.decode("utf-8"))
            self.assertEqual(list(updated), ["zeta", "objects", "nested", "arrays", "mcp", "alpha"])
            self.assertEqual(updated["arrays"]["duplicates"], [{"text": "keep"}])

    def test_json_grouped_postimage_preserves_crlf_tabs_and_final_newline(self):
        original = self._fixture_bytes("json-surgery-crlf.json")
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_bytes(original)
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "setting", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/settings", "key": "remove"},
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ])

            _adapter, _context, _inventory, plan = self._build_plan(adapter_path, home)

            self.assertEqual(len(plan.operations), 1)
            postimage = self._decoded_postimage(plan.operations[0])
            removed_spans = [
                self._span(original, b',\r\n\t\t"remove" : "owned"'),
                self._span(original, b'"gentle-ai:sdd-init",\r\n\t\t'),
            ]
            self._assert_json_splice_postimage(original=original, postimage=postimage, removed_spans=removed_spans)
            self.assertTrue(postimage.endswith(b"\r\n"))
            self.assertNotIn(b"\n\t", postimage.replace(b"\r\n\t", b""))

    def test_json_inventory_blocks_governed_invalid_existing_json(self):
        cases = {
            "malformed": (b'{"hooks": [', [
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ], "declarative_json_malformed"),
            "duplicate_key": (b'{"parent": {"remove": 1, "remove": 2}, "keep": true}', [
                {"id": "duplicate", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/parent", "key": "remove"},
            ], "declarative_json_malformed_duplicate_key"),
            "undecodable": (b'\xff\xfe', [
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ], "declarative_json_malformed"),
            "wrong_pointer_target_type": (json.dumps({"hooks": {"0": "gentle-ai:sdd-init"}}).encode("utf-8"), [
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ], "declarative_json_invalid_layout"),
        }
        for case, (content, rules, expected_message) in cases.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory() as td:
                home = Path(td) / "home"
                target = home / ".custom" / "settings.json"
                target.parent.mkdir(parents=True)
                target.write_bytes(content)
                adapter_path = Path(td) / "adapter.json"
                self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=rules)
                adapter = load_declarative_adapter(adapter_path)
                context = self._context(home)

                inventory = build_inventory(context, (adapter,))
                plan = build_plan(inventory, context, (adapter,))

                self.assertEqual(inventory.candidates, ())
                self.assertEqual(len(inventory.findings), 1)
                self.assertEqual(inventory.findings[0].client, "custom")
                self.assertEqual(inventory.findings[0].code, "inventory_io_or_layout")
                self.assertEqual(inventory.findings[0].message, expected_message)
                self.assertNotIn(str(home), inventory.findings[0].message)
                self.assertEqual(plan.operations, ())
                self.assertEqual(plan.blocked_candidate_ids, ())

    def test_json_inventory_blocks_unreadable_governed_json(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({"hooks": ["gentle-ai:sdd-init"]}))
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ])
            adapter = load_declarative_adapter(adapter_path)
            context = self._context(home)
            original_read_bytes = Path.read_bytes

            def read_bytes_or_permission_error(path: Path) -> bytes:
                if path == target:
                    raise PermissionError("permission denied")
                return original_read_bytes(path)

            with mock.patch.object(Path, "read_bytes", read_bytes_or_permission_error):
                inventory = build_inventory(context, (adapter,))
                plan = build_plan(inventory, context, (adapter,))

            self.assertEqual(inventory.candidates, ())
            self.assertEqual(len(inventory.findings), 1)
            self.assertEqual(inventory.findings[0].message, "declarative_json_unreadable")
            self.assertNotIn(str(home), inventory.findings[0].message)
            self.assertEqual(plan.operations, ())

    def test_valid_json_with_absent_selector_remains_absent_not_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({"agents": {"personal": {}}, "hooks": ["personal"]}))
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "missing-agent", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/agents", "key": "sdd-init"},
                {"id": "missing-hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ])
            adapter = load_declarative_adapter(adapter_path)
            context = self._context(home)

            inventory = build_inventory(context, (adapter,))
            plan = build_plan(inventory, context, (adapter,))

            self.assertEqual(inventory.candidates, ())
            self.assertEqual(inventory.findings, ())
            self.assertEqual(plan.operations, ())

    def test_json_inventory_treats_missing_pointer_target_as_absent_not_invalid(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({"mcpServers": {"personal": {"command": "keep"}}, "theme": "gentleman"}))
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "missing-array", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
                {"id": "missing-object", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/agents", "key": "sdd-init"},
            ])
            adapter = load_declarative_adapter(adapter_path)
            context = self._context(home)

            inventory = build_inventory(context, (adapter,))
            plan = build_plan(inventory, context, (adapter,))

            self.assertEqual(inventory.candidates, ())
            self.assertEqual(inventory.findings, ())
            self.assertEqual(plan.operations, ())

    def test_verify_fails_when_live_reinventory_sees_governed_malformed_json(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text('{"hooks": [')
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ])
            adapter = load_declarative_adapter(adapter_path)
            context = self._context(home)
            inventory = build_inventory(context, (adapter,))
            plan = build_plan(inventory, context, (adapter,))
            receipt = execute_plan(plan, plan.digest or "", context, NoopLifecycle(), inventory=inventory)

            result = verify_receipt(receipt, context, (adapter,))

            self.assertEqual(receipt.status, ReceiptStatus.COMPLETED)
            self.assertEqual(plan.operations, ())
            self.assertEqual(result.status, "failed")
            failed = [check for check in result.checks if check.status == "failed"]
            self.assertEqual(len(failed), 1)
            self.assertEqual(failed[0].code, "verify_structured_parse")
            self.assertEqual(failed[0].evidence["error"], "declarative_json_malformed")
            self.assertNotIn(str(home), str(failed[0].evidence))

    def test_json_compile_fails_closed_on_duplicate_object_keys(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text('{"parent": {"remove": 1}, "keep": true}')
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "duplicate", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/parent", "key": "remove"},
            ])
            adapter = load_declarative_adapter(adapter_path)
            context = self._context(home)
            inventory = build_inventory(context, (adapter,))
            self.assertEqual(len(inventory.candidates), 1)
            target.write_text('{"parent": {"remove": 1, "remove": 2}, "keep": true}')

            with self.assertRaisesRegex(ValueError, "declarative_evidence_drift"):
                build_plan(inventory, context, (adapter,))

    def test_multi_rule_same_target_json_composes_one_deterministic_write(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({
                "agents": {"sdd-init": {"source": "gentle"}, "personal": {"source": "mine"}},
                "hooks": ["gentle-ai:sdd-init", "personal", "gentle-ai:sdd-init"],
                "mcp": {"servers": {"personal": {"command": "keep"}}},
            }))
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "remove-agent", "kind": "json_key", "root": "config", "path": "settings.json", "pointer": "/agents", "key": "sdd-init"},
                {"id": "remove-hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ])

            adapter, context, inventory, plan, _receipt = self._execute(adapter_path, home)

            self.assertEqual(len(inventory.candidates), 2)
            self.assertEqual(len(plan.operations), 1)
            self.assertEqual(plan.operations[0].kind, OperationKind.WRITE_FILE)
            updated = json.loads(target.read_text())
            self.assertEqual(updated["agents"], {"personal": {"source": "mine"}})
            self.assertEqual(updated["hooks"], ["personal"])
            self.assertEqual(updated["mcp"], {"servers": {"personal": {"command": "keep"}}})
            self._assert_second_plan_is_empty(adapter, context)


    def test_compile_fails_closed_when_json_evidence_becomes_malformed_after_inventory(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            target = home / ".custom" / "settings.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({"hooks": ["gentle-ai:sdd-init"], "mcp": {"servers": {}}}))
            adapter_path = Path(td) / "adapter.json"
            self._write_adapter(adapter_path, client="custom", root_path=".custom", rules=[
                {"id": "hook", "kind": "json_array_value", "root": "config", "path": "settings.json", "pointer": "/hooks", "value": "gentle-ai:sdd-init"},
            ])
            adapter = load_declarative_adapter(adapter_path)
            context = self._context(home)
            inventory = build_inventory(context, (adapter,))
            self.assertEqual(len(inventory.candidates), 1)
            target.write_text('{"hooks": [')

            with self.assertRaisesRegex(ValueError, "declarative_evidence_drift"):
                build_plan(inventory, context, (adapter,))


if __name__ == "__main__":
    unittest.main()
