"""omp topology, accounting and explicit child attribution regressions."""
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace
from unittest.mock import patch

from dataset import load_ledger
import delivery_efficiency
from views import aggregate_harness, render_harness_overview, render_tokens_breakdown
from attribution import build_attribution_from_records


class OmpDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.parent = self.root / '2026-10-13_parent.jsonl'
        self.children = self.parent.with_suffix('')
        self.children.mkdir()
        self.write(self.parent, 'parent-id', [self.turn([
            {'type': 'toolCall', 'name': 'task', 'arguments': {}},
            {'type': 'toolCall', 'name': 'write', 'arguments': json.dumps({'path': 'agent://Worker'})},
        ]), self.turn([])])
        for name in ('Worker', 'Reviewer'):
            # Independent cwd and timestamp prove linkage is structural, not proximity.
            self.write(self.children / f'{name}.jsonl', name, [self.turn([])], cwd='/other/repo')

    def turn(self, content):
        return {'type': 'message', 'timestamp': '2026-10-13T01:00:00Z', 'message': {
            'role': 'assistant', 'provider': 'openai-codex', 'model': 'gpt-6.1-sol',
            'usage': {'input': 10, 'output': 2, 'cacheRead': 100, 'cacheWrite': 3,
                      'cost': {'total': 0.25}}, 'content': content}}

    def write(self, path, session_id, turns, cwd='/repo'):
        header = {'type': 'session', 'id': session_id, 'timestamp': '2026-10-13T00:00:00Z', 'cwd': cwd}
        non_assistant = self.turn([])
        non_assistant['message']['role'] = 'user'
        path.write_text('\n'.join(json.dumps(row) for row in [header, *turns, non_assistant]) + '\n')

    def records(self):
        return load_ledger(dt.date(2000, 1, 1), roots={'omp': self.root})

    def test_parent_and_two_children(self):
        records = self.records()
        self.assertEqual(len(records), 3)
        parent = next(r for r in records if r.id == 'parent-id')
        self.assertEqual(parent.harness, 'omp')
        self.assertEqual(parent.form, 'form-orch-hybrid')
        self.assertEqual(parent.delegation_degree, 0.5)
        self.assertTrue(parent.has_intercom)
        self.assertEqual((parent.input_tokens, parent.output_tokens, parent.cache_read_tokens, parent.cache_write_tokens), (20, 4, 200, 6))
        self.assertEqual(parent.cost_native_usd, 0.5)
        self.assertEqual((parent.provider, parent.model), ('openai-codex', 'gpt-6.1-sol'))
        children = [r for r in records if r.id != 'parent-id']
        self.assertTrue(all(r.parent_session_id == self.parent.stem for r in children))
        self.assertTrue(all(r.form == 'form-solo' and r.observed_topology == 'S1' for r in children))
        entry = build_attribution_from_records(records)[str(self.parent)]
        self.assertEqual(entry['n_spawned'], 2)
        self.assertEqual(entry['cost_s1_spawned'], 0.5)

    def test_child_directory_is_delegation_signal(self):
        self.write(self.parent, 'parent-id', [self.turn([])])
        parent = next(r for r in self.records() if r.id == 'parent-id')
        self.assertEqual(parent.form, 'form-orch-hybrid')
        self.assertEqual(parent.delegation_degree, 0)
        self.assertEqual(build_attribution_from_records(self.records())[str(self.parent)]['n_spawned'], 2)

    def test_coordination_is_orthogonal(self):
        worker = self.children / 'Worker.jsonl'
        self.write(worker, 'Worker', [self.turn([{'type': 'toolCall', 'name': 'write', 'arguments': {'path': 'agent://parent'}}])])
        record = next(r for r in self.records() if r.id == 'Worker')
        self.assertTrue(record.has_intercom)
        self.assertEqual(record.form, 'form-solo')
        # Explicitly linked solo children are S1 workers even with messaging.
        self.assertEqual(record.observed_topology, 'S1')

    def test_explicit_child_belongs_to_one_parent(self):
        other = self.root / 'other.jsonl'
        self.write(other, 'other', [self.turn([{'type': 'toolCall', 'name': 'task', 'arguments': {}}])])
        entries = build_attribution_from_records(self.records())
        self.assertEqual(entries[str(self.parent)]['n_spawned'], 2)
        self.assertEqual(entries[str(other)]['n_spawned'], 0)


    def test_delivery_includes_omp_and_preserves_maturity(self):
        record = replace(next(r for r in self.records() if r.id == 'parent-id'), commits=frozenset({'new'}))
        evidence = delivery_efficiency.CommitEvidence(
            'new', Path('/repo'), dt.datetime(2026, 10, 13, tzinfo=dt.timezone.utc),
            frozenset({'code'}), 'production-code', 'immature', 'not-applicable',
        )
        with patch.object(delivery_efficiency, '_repository_for', return_value=Path('/repo')), \
             patch.object(delivery_efficiency, 'inspect_commit', return_value=evidence):
            rows = delivery_efficiency.analyze_delivery_efficiency([record], dt.date(2026, 10, 18))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].session_cost, 0.5)
        self.assertEqual(rows[0].status, 'no-durable-changes')
        self.assertEqual(rows[0].immature_count, 1)
        self.assertEqual(rows[0].durable_shas, frozenset())

    def test_harness_rendering_includes_omp(self):
        summary = aggregate_harness(self.records())
        self.assertIn('omp', render_harness_overview(summary))
        self.assertIn('omp', render_tokens_breakdown(summary))

    def test_explicit_tree_uses_structural_children(self):
        records = self.records()
        parent = next(r for r in records if r.id == 'parent-id')
        unrelated = replace(records[1], id='unrelated', harness='claude',
                            source_path='/unrelated.jsonl', parent_session_id=None,
                            cwd=parent.cwd, observed_topology='S1')
        entry = build_attribution_from_records([*records, unrelated])[str(self.parent)]
        self.assertEqual(entry['n_spawned'], 2)

if __name__ == '__main__':
    unittest.main()
