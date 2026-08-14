#!/usr/bin/env python3
"""Durable lifecycle budget; native iteration, not command visits, owns accounting."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def seconds(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def normalize(text):
    return re.sub(r'\s+', ' ', re.sub(r'\x1b\[[0-9;]*m', '', text)).strip().lower()


def atomic(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def details():
    base = os.environ.get('DAGU_URL', 'http://127.0.0.1:' + os.environ.get('DAGU_PORT', '8080')).rstrip('/')
    with urllib.request.urlopen(base + '/api/v1/dag-runs/feature/' + os.environ['RUN'], timeout=10) as response:
        return json.load(response)['dagRunDetails']


def output(key, value):
    with open(os.environ['DAGU_OUTPUT_FILE'], 'a') as target:
        target.write(key + '=' + value + '\n')


def positive(name, default):
    value = int(os.environ.get(name, default))
    if value < 1:
        raise ValueError(name + ' must be positive')
    return value


def main():
    action = sys.argv[1]
    run = os.environ['RUN']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', run):
        raise ValueError('Invalid run identity')
    common = subprocess.check_output(['git', '-C', os.environ['PRIMARY'], 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True).strip()
    root = Path(common) / 'dagu-feature' / 'runs' / run
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'escalation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Pinned Dagu injects the current node's run-wide rewind iteration.
        # CLI status renders it only for waiting human tasks, not running commands.
        iteration = int(os.environ.get('DAG_PUSHBACK_ITERATION', '0'))
        if iteration < 0:
            raise ValueError('Invalid native push-back iteration')
        path = root / 'escalation.json'
        now = timestamp()
        if path.exists():
            state = json.loads(path.read_text())
        else:
            receipt = root / 'receipt.json'
            admitted = json.loads(receipt.read_text())['initial']['admittedAt'] if receipt.exists() else now
            state = dict(schemaVersion=1, run=run, admittedAt=admitted, windowStartedAt=admitted,
                         windowIteration=0, iteration=iteration, findings=[], trigger=None, decisions=[])
        if iteration < state['iteration']:
            raise ValueError('Native iteration moved backwards')
        state['iteration'] = iteration
        if state.get('stopped'):
            sys.exit(77)
        candidate = root / 'candidate.json'
        if candidate.exists():
            state['sha'] = json.loads(candidate.read_text())['sha']
        else:
            state.setdefault('sha', 'unavailable')
        elapsed = max(0, int(time.time() - seconds(state['windowStartedAt'])))
        if action == 'finding':
            kind, evidence = sys.argv[2:4]
            text = Path(evidence).read_text(errors='replace')
            if kind == 'conflict':
                text = '\n'.join(sorted(set(text.splitlines())))
            fingerprint = hashlib.sha256((kind + ':' + normalize(text)).encode()).hexdigest()
            # A command retry at the same native iteration is the same occurrence.
            key = kind + ':' + str(iteration)
            if not any(finding['event'] == key for finding in state['findings']):
                state['findings'].append(dict(event=key, kind=kind, iteration=iteration,
                    fingerprint=fingerprint, text=text[-12000:], evidence=str(Path(evidence)), at=now))
        elif action in ('decision', 'route'):
            trigger = state['trigger']
            if action == 'route':
                # Only a native rewind from the declared escalation checkpoint can
                # revisit triage with an outstanding trigger and a higher iteration.
                if trigger and iteration > trigger['iteration']:
                    decision = 'change-route'
                else:
                    return
            else:
                decision = os.environ['ACTION']
                if decision not in ('continue', 'stop'):
                    raise ValueError('Invalid escalation decision')
                if not os.environ.get('REASON', '').strip() or not os.environ.get('DECIDED_BY', '').strip():
                    raise ValueError('Escalation decision requires REASON and DECIDED_BY')
                if not trigger:
                    # Redelivery after the atomic decision write is idempotent.
                    if any(item['iteration'] == iteration and item['action'] == decision for item in state['decisions']):
                        return
                    raise ValueError('No active escalation request')
            native_audit = next((event for node in details().get('nodes', [])
                for event in node.get('pushBackHistory', []) if event.get('iteration') == iteration), None) if action == 'route' else None
            state['decisions'].append(dict(action=decision, iteration=iteration, at=now,
                request=trigger['id'], reason=os.environ.get('REASON', 'Native escalation push-back to triage'),
                provenance=dict(mechanism='native-human-task-' + ('push-back' if action == 'route' else 'complete'),
                    run=run, iteration=iteration, ownerSession=os.environ.get('OMP_SESSION_ID', ''),
                    nativeAudit=native_audit,
                    attributedTo=os.environ.get('DECIDED_BY', 'OS-attributed native push-back; identity not authenticated'))))
            if decision != 'stop':
                state.update(windowStartedAt=now, windowIteration=iteration, findings=[], trigger=None)
            else:
                state['stopped'] = True
        elif action == 'check':
            reasons = []
            if iteration - state['windowIteration'] >= positive('ESCALATION_PUSHBACKS', '3'):
                reasons.append('push-back budget exhausted')
            counts = {}
            for finding in state['findings']:
                key = finding['fingerprint']
                counts[key] = counts.get(key, 0) + 1
            if any(count >= positive('ESCALATION_FINDINGS', '2') for count in counts.values()):
                reasons.append('repeated finding fingerprint')
            if elapsed >= positive('ESCALATION_SECONDS', '3600'):
                reasons.append('elapsed budget exhausted')
            if reasons and not state['trigger']:
                state['trigger'] = dict(id=hashlib.sha256((run + ':' + str(iteration) + ':' + state['windowStartedAt']).encode()).hexdigest(),
                    reasons=reasons, iteration=iteration, sha=state['sha'], elapsedSeconds=elapsed,
                    spend=dict(state='unknown', cause='No authoritative run-wide cost receipt is available'),
                    latestFindings=state['findings'][-3:], ownerSession=os.environ.get('OMP_SESSION_ID', ''), at=now,
                    options=['continue with renewed budget', 'change scope or delivery route', 'stop'])
            output('ESCALATE', 'yes' if state['trigger'] else 'no')
            output('REQUEST', json.dumps(state['trigger'], separators=(',', ':')))
        else:
            raise ValueError('Unknown escalation action')
        atomic(path, state)
        print(json.dumps(state))
        if state.get('stopped'):
            sys.exit(77)


if __name__ == '__main__':
    main()
