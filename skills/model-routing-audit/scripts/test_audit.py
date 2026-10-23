"""Deterministic snapshot, comparison and generation-evidence boundaries."""

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest

import audit


def snapshot():
    return {
        'schemaVersion': 1, 'complete': True, 'capturedAt': '2026-10-19T00:00:00Z',
        'catalog': [
            {'provider': 'alpha', 'id': 'fast', 'selector': 'alpha/fast', 'kind': 'chat',
             'contextWindow': 32000, 'input': ['text', 'image'], 'cost': {'input': 1}},
            {'provider': 'beta', 'id': 'deep', 'selector': 'beta/deep', 'kind': 'chat'},
        ],
        'usage': {'generatedAt': 100, 'reports': [
            {'provider': 'alpha', 'fetchedAt': 90, 'plan': {'planType': 'pro'}, 'limits': [
                {'id': 'alpha:weekly', 'amount': {'usedFraction': 0.2, 'unit': 'percent'},
                 'window': {'resetsAt': 1000}, 'scope': {'shared': True}},
                {'id': 'alpha:daily', 'amount': {'usedFraction': 0.1}},
            ]},
        ]},
        'routing': {
            'modelRoles': {'task': 'alpha/fast'},
            'task.agentModelOverrides': {'reviewer': ['@slow', 'beta/deep', 'alpha/fast']},
            'retry.fallbackChains': {'alpha/fast': ['beta/deep', '@slow']},
        },
    }


def bench(ok=True, error=None):
    run = {'ok': ok, 'outputTokens': 3 if ok else 0}
    if error:
        run['error'] = error
    return {'runs': 1, 'failures': 0 if ok else 1,
            'models': [{'selector': 'alpha/fast', 'model': 'alpha/fast', 'results': [run]}]}


class SnapshotTests(unittest.TestCase):
    def test_catalog_and_quota_order_and_fetch_times_are_not_changes(self):
        before = snapshot()
        after = deepcopy(before)
        after['catalog'].reverse()
        after['catalog'][1]['input'].reverse()
        after['usage']['reports'][0]['limits'].reverse()
        after['usage']['reports'][0]['fetchedAt'] = 999
        after['usage']['generatedAt'] = 1000
        after['capturedAt'] = '2026-10-20T00:00:00Z'
        self.assertTrue(audit.compare(before, after)['unchanged'])

    def test_catalog_add_remove_and_metadata_change(self):
        before, after = snapshot(), snapshot()
        after['catalog'].pop()
        after['catalog'][0]['contextWindow'] = 64000
        after['catalog'].append({'provider': 'gamma', 'id': 'new', 'selector': 'gamma/new', 'kind': 'chat'})
        delta = audit.compare(before, after)
        self.assertEqual(delta['catalog'], {'added': ['gamma/new'], 'removed': ['beta/deep'], 'changed': ['alpha/fast']})
        self.assertFalse(delta['unchanged'])

    def test_agent_order_and_aliases_are_preserved(self):
        before, after = snapshot(), snapshot()
        after['routing']['task.agentModelOverrides']['reviewer'].reverse()
        change = audit.compare(before, after)['routing']['task.agentModelOverrides']['reviewer']
        self.assertEqual(change['before'], ['@slow', 'beta/deep', 'alpha/fast'])
        self.assertEqual(change['after'], ['alpha/fast', 'beta/deep', '@slow'])

    def test_retry_order_and_role_removal_are_changes(self):
        before, after = snapshot(), snapshot()
        after['routing']['retry.fallbackChains']['alpha/fast'].reverse()
        del after['routing']['modelRoles']['task']
        delta = audit.compare(before, after)
        self.assertEqual(delta['routing']['modelRoles']['task']['after'], None)
        self.assertEqual(delta['routing']['retry.fallbackChains']['alpha/fast']['after'], ['@slow', 'beta/deep'])

    def test_quota_reset_usage_and_plan_are_changes(self):
        for edit in ('reset', 'usage', 'plan'):
            with self.subTest(edit=edit):
                after = snapshot()
                report = after['usage']['reports'][0]
                if edit == 'reset':
                    report['limits'][0]['window']['resetsAt'] += 1
                elif edit == 'usage':
                    report['limits'][0]['amount']['usedFraction'] += 0.1
                else:
                    report['plan']['planType'] = 'max'
                self.assertTrue(audit.compare(snapshot(), after)['usageChanged'])

    def test_usage_projection_keeps_quota_but_only_safe_metadata(self):
        raw = {'generatedAt': 100, 'reports': [{
            'provider': 'alpha', 'fetchedAt': 90,
            'metadata': {'planType': 'pro', 'email': 'private@example.com', 'apiKey': 'secret'},
            'limits': [{'id': 'alpha:weekly', 'label': '/Users/private',
                        'amount': {'usedFraction': 0.2, 'unit': 'percent'},
                        'scope': {'shared': True, 'accountId': 'secret', 'projectId': 'private'}}],
        }], 'disabledCredentials': [{'token': 'secret'}]}
        self.assertEqual(audit.project('usage', raw), {
            'generatedAt': 100, 'reports': [{'provider': 'alpha', 'fetchedAt': 90,
                'plan': {'planType': 'pro'}, 'limits': [{'id': 'alpha:weekly',
                    'amount': {'usedFraction': 0.2, 'unit': 'percent'}, 'scope': {'shared': True}}]}]})

    def test_invalid_snapshot_versions_shapes_and_identifiers(self):
        variants = []
        for version in (0, 2, True, '1'):
            item = snapshot()
            item['schemaVersion'] = version
            variants.append(item)
        item = snapshot()
        item['complete'] = False
        variants.append(item)
        item = snapshot()
        item['catalog'][0]['contextWindow'] = 'large'
        variants.append(item)
        item = snapshot()
        item['catalog'][0]['input'] = 'text'
        variants.append(item)
        item = snapshot()
        item['routing']['task.agentModelOverrides']['reviewer'] = '/Users/private/model'
        variants.append(item)
        for item in variants:
            with self.subTest(item=item), self.assertRaises((ValueError, KeyError, TypeError)):
                audit.validate(item)

    def test_duplicate_catalog_selector_fails(self):
        data = snapshot()
        data['catalog'].append(deepcopy(data['catalog'][0]))
        with self.assertRaises(ValueError):
            audit.validate(data)

    def test_offline_round_trip_and_bad_baseline_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            source, out = Path(directory) / 'snapshot.json', Path(directory) / 'comparison.json'
            source.write_text(json.dumps(snapshot()))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(audit.main(['--snapshot', str(source), '--previous', str(source), '--out', str(out)]), 0)
            self.assertTrue(json.loads(out.read_text())['comparison']['unchanged'])
            for invalid in ('{malformed', 'null', '{\"schemaVersion\": 2}'):
                source.write_text(invalid)
                with redirect_stderr(io.StringIO()):
                    self.assertEqual(audit.main(['--snapshot', str(source), '--previous', str(source), '--out', str(out)]), 1)

    def test_probe_limit_requires_explicit_bounded_selectors(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            audit.main(['--out', '/unused', '--probe', 'a/1', '--probe', 'a/2', '--probe', 'a/3', '--probe', 'a/4'])
        self.assertEqual(raised.exception.code, 2)


class ProbeTests(unittest.TestCase):
    def classify(self, raw, status='ok', diagnostics=''):
        return audit.probe_result('alpha/fast', raw, {'status': status, 'returncode': 0 if status == 'ok' else 1}, diagnostics)

    def test_matching_generated_run_is_success(self):
        self.assertEqual(self.classify(bench())['classification'], 'success')

    def test_successful_numeric_metrics_are_generation_evidence(self):
        raw = bench()
        raw['models'][0]['results'][0].update({'durationMs': 403.5, 'inputTokens': 401})
        self.assertEqual(self.classify(raw, diagnostics=json.dumps(raw))['classification'], 'success')

    def test_access_failures_are_distinct_and_diagnostics_are_sanitized(self):
        for error, code in (
            ('USAGE_PRICING_REQUIRED secret@example.com /Users/private', 'USAGE_PRICING_REQUIRED'),
            ('HTTP 403 Forbidden', 'HTTP_403'),
            ('HTTP 401', 'HTTP_401'),
            ('quota exceeded', 'QUOTA_EXCEEDED'),
        ):
            raw = bench(False, error)
            result = self.classify(raw, 'cli-error')
            self.assertEqual(result['classification'], 'access-error')
            self.assertEqual(result['reason'], 'provider-access-rejected')
            self.assertEqual(result['accessCode'], code)
            self.assertEqual(set(result), {'selector', 'classification', 'command', 'reason', 'accessCode'})

    def test_network_or_malformed_failure_is_other_error(self):
        for raw in (None, [], {}, {'models': []}, bench(False, 'connection reset')):
            self.assertEqual(self.classify(raw, 'cli-error')['classification'], 'other-error')

    def test_failed_cli_numeric_metrics_are_other_error(self):
        diagnostics = '{"durationMs": 403.5, "inputTokens": 401}'
        self.assertEqual(self.classify(None, 'cli-error', diagnostics)['classification'], 'other-error')

    def test_failed_cli_contextual_http_error_is_access_evidence(self):
        result = self.classify(None, 'cli-error', 'HTTP/1.1 403')
        self.assertEqual(result['classification'], 'access-error')
        self.assertEqual(result['accessCode'], 'HTTP_403')

    def test_ambiguous_evidence_is_other_error(self):
        zero, mismatch, failed = bench(), bench(), bench()
        zero['models'][0]['results'][0]['outputTokens'] = 0
        mismatch['models'][0]['model'] = 'beta/deep'
        failed['failures'] = 1
        for raw in (zero, mismatch, failed):
            self.assertEqual(self.classify(raw)['classification'], 'other-error')
        self.assertEqual(self.classify(bench(), 'cli-error')['classification'], 'other-error')


if __name__ == '__main__':
    unittest.main()
