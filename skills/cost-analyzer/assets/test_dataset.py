#!/usr/bin/env python3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from dataset import TopologyEvidence, classify_topology, parse_claude_session, parse_codex_session, parse_pi_session


class PiDatasetTests(unittest.TestCase):
    def test_direct_delegation_without_coordination_is_s2(self):
        self.assertEqual(
            classify_topology(TopologyEvidence(delegation=True), parseable=True),
            ('S2', 'direct'),
        )

    def test_unparseable_source_is_unknown(self):
        self.assertEqual(
            classify_topology(TopologyEvidence(), parseable=False),
            ('unknown', 'unknown'),
        )

    def test_pi_parser_keeps_native_cost_and_legacy_s2(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'plain.jsonl'
            path.write_text(
                '{"type":"session","timestamp":"2026-08-01T00:00:00Z","cwd":"/repo"}\n'
                '{"type":"message","timestamp":"2026-08-01T00:01:00Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"subagent_run"}],"usage":{"cost":{"total":2.5},"input":10,"output":4}}}\n'
            )
            record = parse_pi_session(path)

        self.assertEqual(record.harness, 'pi')
        self.assertEqual(record.cost_native_usd, 2.5)
        self.assertEqual(record.topology, 'S2')
        self.assertEqual(record.input_tokens, 10)
        self.assertEqual(record.output_tokens, 4)
        self.assertEqual(record.observed_topology, 'S2')
        self.assertEqual(record.topology_confidence, 'direct')

    def test_malformed_pi_source_is_unknown(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.jsonl'
            path.write_text('not-json\n')
            record = parse_pi_session(path)
        self.assertEqual((record.observed_topology, record.topology_confidence), ('unknown', 'unknown'))

    def test_claude_parser_has_no_native_cost(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'claude.jsonl'
            path.write_text(
                '{"type":"assistant","timestamp":"2026-09-01T00:00:00Z","cwd":"/repo",'
                '"message":{"model":"claude-sonnet","role":"assistant",'
                '"usage":{"input_tokens":11,"output_tokens":3}}}\n'
            )
            record = parse_claude_session(path)

        self.assertEqual(record.harness, 'claude')
        self.assertIsNone(record.cost_native_usd)
        self.assertIsNone(record.topology)
        self.assertEqual(record.input_tokens, 11)
        self.assertEqual(record.cwd, '/repo')

    def test_claude_agent_tool_is_s2_direct(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'claude-agent.jsonl'
            path.write_text('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent"}]}}\n')
            record = parse_claude_session(path)
        self.assertEqual((record.observed_topology, record.topology_confidence), ('S2', 'direct'))

    def test_codex_parser_uses_source_not_originator(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'codex.jsonl'
            path.write_text(
                '{"timestamp":"2026-09-01T00:00:00Z","type":"session_meta",'
                '"payload":{"originator":"Claude Code","cwd":"/repo"}}\n'
                '{"timestamp":"2026-09-01T00:01:00Z","type":"event_msg",'
                '"payload":{"type":"token_count","info":{"total_token_usage":'
                '{"input_tokens":20,"cached_input_tokens":5,"output_tokens":4}}}}\n'
            )
            record = parse_codex_session(path)

        self.assertEqual(record.harness, 'codex')
        self.assertEqual(record.input_tokens, 20)
        self.assertEqual(record.cache_read_tokens, 5)
        self.assertIsNone(record.cost_native_usd)

    def test_codex_spawn_agent_is_s2_direct(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'codex-agent.jsonl'
            path.write_text('{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent"}}\n')
            record = parse_codex_session(path)
        self.assertEqual((record.observed_topology, record.topology_confidence), ('S2', 'direct'))

    def test_d5_cross_session_with_parent_session_id_and_intercom(self):
        """D5 FIX: Detect cross_session_heuristic via parent_session_id + intercom."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'cross-session.jsonl'
            path.write_text(
                '{"type":"session","timestamp":"2026-08-01T00:00:00Z","cwd":"/repo","id":"s1","parent_session_id":"parent-s2"}\n'
                '{"type":"custom","customType":"intercom"}\n'
                '{"type":"message","timestamp":"2026-08-01T00:01:00Z","message":{"role":"assistant","content":[],"usage":{"input":5,"output":2}}}\n'
            )
            record = parse_pi_session(path)
        self.assertEqual(record.form, 'form-cross-session')

    def test_d5_no_cross_session_without_signal(self):
        """D5 FIX: No cross_session_heuristic without parent_session_id."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'solo.jsonl'
            path.write_text(
                '{"type":"session","timestamp":"2026-08-01T00:00:00Z","cwd":"/repo","id":"s1"}\n'
                '{"type":"message","timestamp":"2026-08-01T00:01:00Z","message":{"role":"assistant","content":[],"usage":{"input":5,"output":2}}}\n'
            )
            record = parse_pi_session(path)
        self.assertEqual(record.form, 'form-solo')

    def test_d9_claude_with_delegation_is_form_orch_hybrid(self):
        """D9 FIX: Claude session with Agent tool is classified as form."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'claude-form.jsonl'
            path.write_text(
                '{"type":"assistant","timestamp":"2026-09-01T00:00:00Z",'
                '"message":{"model":"claude-sonnet","role":"assistant",'
                '"content":[{"type":"tool_use","name":"Agent"}],'
                '"usage":{"input_tokens":11,"output_tokens":3}}}\n'
            )
            record = parse_claude_session(path)
        self.assertEqual(record.form, 'form-orch-hybrid')
        self.assertNotEqual(record.form, 'unknown')

    def test_d9_codex_with_delegation_is_form_orch_hybrid(self):
        """D9 FIX: Codex session with spawn_agent is classified as form."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'codex-form.jsonl'
            path.write_text(
                '{"type":"session_meta","timestamp":"2026-09-01T00:00:00Z",'
                '"payload":{"session_id":"s1","cwd":"/repo","model":"gpt-4"}}\n'
                '{"type":"response_item","timestamp":"2026-09-01T00:01:00Z",'
                '"payload":{"type":"function_call","name":"spawn_agent"}}\n'
                '{"type":"event_msg","payload":{"type":"token_count",'
                '"info":{"total_token_usage":{"input_tokens":10,"output_tokens":5}}}}\n'
            )
            record = parse_codex_session(path)
        self.assertEqual(record.form, 'form-orch-hybrid')
        self.assertNotEqual(record.form, 'unknown')


if __name__ == '__main__':
    unittest.main()
