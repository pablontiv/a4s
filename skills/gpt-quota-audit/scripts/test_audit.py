import json
import os
import sqlite3
import time
from datetime import timedelta

import pytest

import audit


@pytest.mark.parametrize(('calls', 'expected'), [
    ([], 'text-only'),
    ([('wait', {}), ('wait', {})], 'wait-only'),
    ([('read', {'path': 'history://one'})], 'read history://'),
    ([('read', {'path': 'agent://one'})], 'agent:// messaging'),
    ([('write', {'path': 'agent://one', 'content': 'hello'})], 'write'),
    ([('bash', {'command': 'sleep 2; xcrun devicectl list'})], 'bash sleep/poll'),
    ([('bash', {'command': 'until ready; do wait; done'})], 'bash sleep/poll'),
    ([('bash', {'command': 'while true; do work; done'})], 'bash sleep/poll'),
    ([('bash', {'command': 'xcodebuild test'})], 'ios build/e2e'),
    ([('read', {'path': 'e2e/results'})], 'ios build/e2e'),
    ([('edit', {'patch': 'content'})], 'edit'),
    ([('bash', {'command': 'sleep 1', 'note': 'history://one'})], 'read history://'),
])
def test_classifier(calls, expected):
    assert audit.classify(calls) == expected


def test_tool_arguments():
    message = {'content': [
        {'type': 'toolCall', 'name': 'bash', 'arguments': '{"command":"sleep 1"}'},
        {'type': 'tool_use', 'name': 'read', 'input': {'path': 'history://one'}},
    ]}
    assert audit.classify(audit.tool_calls(message)) == 'read history://'
    assert audit.tool_calls({'content': [{'type': 'toolCall', 'name': 'read',
                                         'arguments': 'agent://one'}]}) == [
                                             ('read', {'raw': 'agent://one'})]


@pytest.fixture
def sample(tmp_path, monkeypatch):
    old_tz = os.environ.get('TZ')
    monkeypatch.setenv('TZ', 'UTC')
    time.tzset()
    start = audit.parse_time('2026-10-16T20:00:00Z')
    now = start + timedelta(hours=10)
    root = tmp_path / 'sessions'
    project = root / '--project--'
    children = project / 'parent'
    children.mkdir(parents=True)

    def message(timestamp, model, tokens, provider='openai-codex'):
        return {'type': 'message', 'timestamp': timestamp.isoformat(), 'message': {
            'role': 'assistant', 'provider': provider, 'model': model,
            'usage': {'input': tokens // 4, 'cacheRead': tokens // 4,
                      'cacheWrite': tokens // 2, 'output': 999, 'totalTokens': tokens + 999},
            'stopReason': 'toolUse',
            'content': [{'type': 'toolCall', 'name': 'wait', 'arguments': {}}]}}

    parent = [
        {'type': 'session', 'id': 'parent', 'timestamp': start.isoformat(), 'cwd': '/tmp/project'},
        message(start, 'model-a', 0),
        message(now + timedelta(seconds=1), 'model-a', 99_000_000),
        message(start, 'other', 99_000_000, provider='other'),
    ]
    files = {project / 'parent.jsonl': parent}
    for name, model in [('A', 'model-a'), ('B', 'model-b')]:
        records = [{'type': 'session_init', 'agent': 'task', 'modelRole': 'task',
                    'task': 'Implement measured work', 'resolvedModel': model}]
        for hour in range(1, 10):
            amount = hour if name == 'A' else 10 - hour
            records.append(message(start + timedelta(hours=hour - 0.5), model, amount * 1_000_000))
        files[children / f'{name}.jsonl'] = records
    for path, records in files.items():
        path.write_text('\n'.join(json.dumps(record) for record in records) + '\n')
        os.utime(path, (now.timestamp(), now.timestamp()))
    db = tmp_path / 'quota.sqlite'
    with sqlite3.connect(db) as connection:
        connection.execute('CREATE TABLE usage_history '
                           '(provider TEXT, limit_id TEXT, used_fraction REAL, recorded_at INTEGER, resets_at INTEGER)')
        fraction = 0.1
        for hour in range(10):
            if hour == 5:
                fraction = 0.02
            elif hour:
                fraction += hour * 0.0002 + (10 - hour) * 0.0003
            reset = start + timedelta(days=7 if hour < 5 else 9)
            if hour == 2:
                reset += timedelta(seconds=1)  # Same quota window, provider jitter.
            connection.execute('INSERT INTO usage_history VALUES (?,?,?,?,?)',
                               ('openai-codex', 'openai-codex:primary', fraction,
                                int((start + timedelta(hours=hour)).timestamp() * 1000),
                                int(reset.timestamp() * 1000)))
    yield root, db, now
    if old_tz is None:
        os.environ.pop('TZ', None)
    else:
        os.environ['TZ'] = old_tz
    time.tzset()


def test_three_file_report_and_calibration(sample, tmp_path):
    root, db, now = sample
    dataset = audit.load_sessions(root, 'openai-codex', 3.5, now)
    assert dataset.selected_files == 3
    assert len(dataset.inits) == 2
    assert len(dataset.turns) == 19
    assert sum(turn.tokens for turn in dataset.turns) == 90_000_000
    daily = audit.aggregate(dataset.turns, lambda turn: turn.timestamp.astimezone().date().isoformat())
    assert daily == {'2026-10-16': [9, 40_000_000], '2026-10-17': [10, 50_000_000]}
    readings = audit.quota_readings(db, 'openai-codex', 'openai-codex:primary', now)
    assert len(readings) == 10
    windows = audit.quota_windows(readings)
    assert [window[-1] for window in windows] == [5, 5]
    assert windows[0][0] != windows[1][0]
    assert windows[0][1] == readings[0]
    assert windows[0][2] == readings[4]
    assert windows[0][3] == pytest.approx(readings[4][1])
    fit = audit.calibrate(dataset.turns, readings)
    assert fit['n'] == 8  # Nine consecutive intervals minus one reset boundary.
    assert fit['models'] == ['model-a', 'model-b']
    assert fit['coefficients'] == pytest.approx([0.0002, 0.0003])
    assert fit['r_squared'] == pytest.approx(1)
    for coefficient, (low, high) in zip(fit['coefficients'], fit['ci']):
        assert low == pytest.approx(coefficient)
        assert high == pytest.approx(coefficient)
    truncated = audit.calibrate(dataset.turns, readings, now - timedelta(hours=8))
    assert truncated['n'] == 6
    assert truncated['coefficients'] == pytest.approx([0.0002, 0.0003])
    assert audit.burn_rate(readings[0], readings[4]) == ('0.2750', '363.64')
    rendered = audit.render(dataset, readings, 'openai-codex', now, 3.5, 'openai-codex:primary')
    assert '| 2026-10-16 | model-a | 5 | 10.000000 |' in rendered
    assert '| 2026-10-17 | model-b | 5 | 15.000000 |' in rendered
    assert '| --project--/parent | 19 | 90.000000 | 2 |' in rendered
    assert '| model-a | 40.000000 | 2.000000 |' in rendered
    assert '| model-b | 40.000000 | 3.000000 |' in rendered
    output = tmp_path / 'report.md'
    audit.main(['--sessions-root', str(root), '--db', str(db), '--now', now.isoformat(), '--out', str(output)])
    assert output.read_text() == rendered


def test_mtime_selection(sample):
    root, _, now = sample
    path = root / '--project--' / 'parent' / 'A.jsonl'
    old = (now - timedelta(days=4)).timestamp()
    os.utime(path, (old, old))
    dataset = audit.load_sessions(root, 'openai-codex', 3.5, now)
    assert dataset.selected_files == 2
    assert sum(turn.tokens for turn in dataset.turns) == 45_000_000


def test_ols_reports_nonidentifiable_models():
    with pytest.raises(ValueError, match='Singular'):
        audit.ols([[1, 2], [2, 4], [3, 6]], [0.1, 0.2, 0.3])
    with pytest.raises(ValueError, match='Insufficient'):
        audit.ols([], [])


def test_missing_database_remains_read_only(tmp_path):
    path = tmp_path / 'missing.sqlite'
    with pytest.raises(sqlite3.OperationalError):
        audit.quota_readings(path, 'openai-codex', 'openai-codex:primary', audit.parse_time('2026-10-17Z'))
    assert not path.exists()
