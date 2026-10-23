#!/usr/bin/env python3
"""Collect a read-only, allowlisted OMP routing snapshot (Python 3.10+)."""

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import subprocess
import sys

VERSION = 1
ROUTING_KEYS = ('modelRoles', 'task.agentModelOverrides', 'retry.fallbackChains')
READS = (
    ('catalog', ['models', 'refresh', '--kind', 'all', '--json']),
    ('usage', ['usage', '--json', '--redact']),
    *((key, ['config', 'get', key, '--json']) for key in ROUTING_KEYS),
)
PROMPT = 'Reply with exactly OK.'
ACCESS = re.compile(
    r'\b(?P<code>USAGE_PRICING_REQUIRED|UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN|PERMISSION_DENIED|INVALID_API_KEY)\b'
    r'|(?P<authentication>authentication required)|(?P<permission>access denied)'
    r'|(?P<quota>insufficient (?:quota|credits)|quota exceeded)'
    r'|(?P<http>\bHTTP(?:/\d(?:\.\d)?)?\s+(?:status\s*[:=]?\s*)?(?:401|403)\b)', re.I)


def identifier(value):
    if (not isinstance(value, str) or not value or len(value) > 200
            or not re.fullmatch(r'[A-Za-z0-9_@.*?:/+~\-]+', value)
            or value.startswith(('/', '~')) or '..' in value
            or '://' in value or ('@' in value and not value.startswith('@'))):
        raise ValueError('invalid identifier in supported fields')
    return value


def fields(record, names):
    """Project scalar metadata only; arbitrary provider metadata is never copied."""
    if not isinstance(record, dict):
        raise ValueError('expected object in supported fields')
    result = {}
    for name in names:
        if name not in record:
            continue
        value = record[name]
        if name in ('contextWindow', 'maxTokens', 'input', 'output', 'cacheRead', 'cacheWrite',
                    'fetchedAt', 'generatedAt', 'durationMs', 'resetsAt', 'used', 'limit',
                    'remaining', 'usedFraction', 'remainingFraction', 'failures', 'outputTokens'):
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                raise ValueError('expected finite numeric metadata')
        if name in ('reasoning', 'shared', 'allowed', 'limitReached', 'ok'):
            if value is not None and type(value) is not bool:
                raise ValueError('expected boolean metadata')
        if isinstance(value, str):
            value = identifier(value)
        elif value is not None and type(value) not in (bool, int, float):
            raise ValueError('expected scalar in supported fields')
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError('non-finite number')
        result[name] = value
    return result


def ordered(records):
    return sorted(records, key=lambda item: json.dumps(item, sort_keys=True))


def array(value):
    if not isinstance(value, list):
        raise ValueError('expected array in supported fields')
    return value


def project(section, raw):
    if not isinstance(raw, dict):
        raise ValueError('expected CLI JSON object')
    if section == 'catalog':
        models = []
        for item in array(raw['models']):
            model = fields(item, ('provider', 'id', 'selector', 'kind', 'contextWindow',
                                  'maxTokens', 'reasoning', 'pricingStatus'))
            for key in ('provider', 'id', 'selector', 'kind'):
                identifier(model[key])
            for key in ('input', 'thinking'):
                if key in item:
                    model[key] = None if item[key] is None else sorted(identifier(v) for v in array(item[key]))
            if 'cost' in item:
                model['cost'] = fields(item['cost'], ('input', 'output', 'cacheRead', 'cacheWrite'))
            models.append(model)
        if len({m['selector'] for m in models}) != len(models):
            raise ValueError('duplicate catalog selector')
        return sorted(models, key=lambda model: model['selector'])
    if section == 'usage':
        reports = []
        for item in array(raw['reports']):
            report = fields(item, ('provider', 'fetchedAt'))
            identifier(report['provider'])
            report['limits'] = []
            for limit in array(item['limits']):
                row = fields(limit, ('id', 'status'))
                identifier(row['id'])
                for key, names in (
                    ('scope', ('provider', 'windowId', 'shared', 'sharedGroup', 'tier')),
                    ('window', ('id', 'durationMs', 'resetsAt')),
                    ('amount', ('used', 'limit', 'remaining', 'usedFraction', 'remainingFraction', 'unit')),
                ):
                    if key in limit:
                        row[key] = fields(limit[key], names)
                report['limits'].append(row)
            report['limits'] = ordered(report['limits'])
            report['plan'] = fields(item.get('metadata', item.get('plan', {})), ('planType', 'allowed', 'limitReached'))
            reports.append(report)
        return {**fields(raw, ('generatedAt',)), 'reports': ordered(reports)}
    if raw.get('key') != section or raw.get('type') != 'record' or not isinstance(raw.get('value'), dict):
        raise ValueError('unexpected config response')
    result = {}
    for key, value in raw['value'].items():
        identifier(key)
        if section == 'modelRoles':
            result[key] = identifier(value)
        else:
            if not isinstance(value, list):
                raise ValueError('expected ordered route array')
            result[key] = [identifier(spec) for spec in value]
    return result


def execute(args):
    """No shell, retries, raw diagnostics, credential/config dumps or user prompts."""
    evidence = {'argv': ['omp', *args], 'returncode': None}
    if '--prompt' in args:
        evidence['argv'][evidence['argv'].index('--prompt') + 1] = '<fixed synthetic prompt>'
    try:
        result = subprocess.run(['omp', *args], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        evidence['status'] = 'execution-error'
        return None, evidence, ''
    evidence['returncode'] = result.returncode
    evidence['status'] = 'ok' if result.returncode == 0 else 'cli-error'
    try:
        raw = json.loads(result.stdout)
    except (ValueError, TypeError):
        raw = None
        if result.returncode == 0:
            evidence['status'] = 'invalid-json'
    diagnostics = result.stderr if raw is not None else result.stdout + '\n' + result.stderr
    return raw, evidence, diagnostics


def probe_result(selector, raw, evidence, diagnostics):
    """Conservative generation evidence, not quality or server identity attestation."""
    result = {'selector': selector, 'classification': 'other-error', 'command': evidence}
    models = raw.get('models') if isinstance(raw, dict) else None
    model = models[0] if isinstance(models, list) and len(models) == 1 else None
    runs = model.get('results') if isinstance(model, dict) else None
    run = runs[0] if isinstance(runs, list) and len(runs) == 1 else None
    errors = [diagnostics] if evidence['status'] == 'cli-error' else []
    if isinstance(run, dict) and run.get('ok') is False and isinstance(run.get('error'), str):
        errors.append(run['error'])
    for error in errors:
        match = ACCESS.search(error)
        if match:
            result['classification'] = 'access-error'
            result['reason'] = 'provider-access-rejected'
            result['accessCode'] = (
                match['code'].upper() if match['code'] else
                'HTTP_' + re.search(r'(401|403)\b', match['http'])[1] if match['http'] else
                {'authentication': 'AUTHENTICATION_REQUIRED', 'permission': 'PERMISSION_DENIED',
                 'quota': 'QUOTA_EXCEEDED'}[match.lastgroup]
            )
            return result
    if not isinstance(run, dict):
        return result
    result['result'] = {
        **fields(raw, ('failures',)),
        **fields(model, ('selector', 'model')),
        'run': fields(run, ('ok', 'outputTokens')),
    }
    if (evidence['status'] == 'ok' and model.get('selector') == selector
            and model.get('model') == selector and raw.get('failures') == 0
            and run.get('ok') is True and type(run.get('outputTokens')) in (int, float)
            and run['outputTokens'] > 0):
        result['classification'] = 'success'
    return result


def collect(selectors):
    snapshot = {'schemaVersion': VERSION, 'capturedAt': datetime.now(timezone.utc).isoformat(),
                'complete': True, 'catalog': None, 'usage': None, 'routing': {},
                'commands': [], 'probes': []}
    for section, args in READS:
        raw, evidence, _ = execute(args)
        evidence['section'] = section
        if evidence['status'] == 'ok':
            try:
                data = project(section, raw)
                if section in ROUTING_KEYS:
                    snapshot['routing'][section] = data
                else:
                    snapshot[section] = data
            except (ValueError, KeyError, TypeError):
                evidence['status'] = 'invalid-shape'
        if evidence['status'] != 'ok':
            snapshot['complete'] = False
        snapshot['commands'].append(evidence)
    # Collection must succeed before any explicitly requested generation.
    if snapshot['complete']:
        catalog = {m['selector']: m for m in snapshot['catalog']}
        for selector in selectors:
            if selector not in catalog or catalog[selector]['kind'] != 'chat':
                snapshot['probes'].append({'selector': selector, 'classification': 'other-error',
                                           'reason': 'not-in-chat-catalog'})
                continue
            args = ['bench', selector, '--profile', 'chat', '--runs', '1', '--par', '1',
                    '--max-tokens', '128', '--prompt', PROMPT, '--service-tier', 'none', '--json']
            raw, evidence, diagnostics = execute(args)
            try:
                snapshot['probes'].append(probe_result(selector, raw, evidence, diagnostics))
            except (ValueError, TypeError):
                snapshot['probes'].append({'selector': selector, 'classification': 'other-error',
                                           'reason': 'invalid-bench-shape', 'command': evidence})
    return snapshot


def validate(snapshot):
    if (not isinstance(snapshot, dict) or type(snapshot.get('schemaVersion')) is not int
            or snapshot['schemaVersion'] != VERSION or snapshot.get('complete') is not True):
        raise ValueError('baseline requires a complete schemaVersion=1 snapshot')
    # Re-project loaded data through the same public boundary before comparing/exporting.
    catalog = project('catalog', {'models': snapshot['catalog']})
    usage = project('usage', snapshot['usage'])
    routing = {key: project(key, {'key': key, 'type': 'record', 'value': snapshot['routing'][key]})
               for key in ROUTING_KEYS}
    return {'schemaVersion': VERSION, 'complete': True, 'catalog': catalog,
            'usage': usage, 'routing': routing}


def compare(previous, current):
    before, after = validate(previous), validate(current)
    old = {model['selector']: model for model in before['catalog']}
    new = {model['selector']: model for model in after['catalog']}
    catalog = {'added': sorted(new.keys() - old.keys()), 'removed': sorted(old.keys() - new.keys()),
               'changed': sorted(key for key in old.keys() & new.keys() if old[key] != new[key])}
    routing = {}
    for key in ROUTING_KEYS:
        a, b = before['routing'][key], after['routing'][key]
        changes = {name: {'before': a.get(name), 'after': b.get(name)}
                   for name in sorted(a.keys() | b.keys()) if a.get(name) != b.get(name)}
        if changes:
            routing[key] = changes
    quotas = []
    for data in (before, after):
        quotas.append(ordered([{k: v for k, v in report.items() if k != 'fetchedAt'}
                               for report in data['usage']['reports']]))
    usage_changed = quotas[0] != quotas[1]
    return {'unchanged': not any(catalog.values()) and not routing and not usage_changed,
            'catalog': catalog, 'routing': routing, 'usageChanged': usage_changed}


def load(path):
    with path.open(encoding='utf-8') as stream:
        return json.load(stream)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Default: five allowlisted CLI reads, zero inference and zero assignments. '
        'Exit 0: complete collection/comparison and successful requested probes; '
        '1: CLI/data/baseline failure or failed probe; 2: argument error.'))
    parser.add_argument('--out', type=Path, required=True, help='JSON evidence output outside source data')
    parser.add_argument('--previous', type=Path, help='Compare complete schemaVersion=1 baseline; malformed/unsupported/incomplete baselines fail visibly')
    parser.add_argument('--snapshot', type=Path, help='Offline comparison input instead of CLI collection; requires --previous, excludes probes')
    parser.add_argument('--probe', action='append', default=[], metavar='PROVIDER/MODEL', help=(
        'Opt-in generation: exact chat selector, repeat up to 3 distinct models; '
        'fixed 1 run, parallelism 1, 128 max output tokens, 120s timeout each'))
    args = parser.parse_args(argv)
    if args.snapshot and (not args.previous or args.probe):
        parser.error('--snapshot requires --previous and excludes --probe')
    if len(args.probe) > 3 or len(set(args.probe)) != len(args.probe):
        parser.error('--probe requires at most 3 distinct exact selectors')
    try:
        for spec in args.probe:
            identifier(spec)
            if '/' not in spec or any(char in spec for char in '*?@'):
                parser.error('--probe requires an exact provider/model selector')
        inputs = [p.resolve() for p in (args.previous, args.snapshot) if p]
        if args.out.resolve() in inputs:
            parser.error('--out must differ from snapshot inputs')
        previous = load(args.previous) if args.previous else None
        if args.previous:
            validate(previous)
        snapshot = validate(load(args.snapshot)) if args.snapshot else collect(args.probe)
        if previous is not None and snapshot['complete']:
            snapshot['comparison'] = compare(previous, snapshot)
        args.out.write_text(json.dumps(snapshot, indent=2, sort_keys=True, allow_nan=False) + '\n', encoding='utf-8')
        failed = not snapshot['complete'] or any(p['classification'] != 'success' for p in snapshot.get('probes', []))
        summary = {'complete': snapshot['complete'], 'models': len(snapshot['catalog'] or []),
                   'quotaReports': len((snapshot['usage'] or {}).get('reports', [])),
                   'probes': len(snapshot.get('probes', []))}
        if 'comparison' in snapshot:
            summary['comparison'] = snapshot['comparison']
        print(json.dumps(summary, sort_keys=True))
        return int(failed)
    except (OSError, ValueError, KeyError, TypeError):
        print('audit: input/output or snapshot shape failure; no valid comparison produced', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
