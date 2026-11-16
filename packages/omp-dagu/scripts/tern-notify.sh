#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! $1 =~ ^[0-9]+$ || -z $2 || $2 == *$'\n'* || $2 == *$'\r'* ]]; then
  echo 'Usage: tern-notify.sh <pane> <single line>' >&2
  exit 2
fi
pane=$1
line=$2
payload=$line
if [[ $payload == \[*\]\ * ]]; then
  payload=${payload#*] }
fi
absolute_path=$'(^|[[:space:]"\'`(])/[^[:space:]]+'
sentence_boundary=$'[.!?][]"\')]*[[:space:]]+[^[:space:]]'
if [[ ! $payload =~ $absolute_path && $payload =~ $sentence_boundary ]]; then
  echo 'Rejected: multi-sentence payload requires an absolute artifact path; nothing was pasted' >&2
  exit 3
fi
tern_bin=${TERN_BIN:-tern}
timeout=${TERN_NOTIFY_TIMEOUT:-120}
if [[ ! $timeout =~ ^[0-9]+$ ]]; then
  echo 'TERN_NOTIFY_TIMEOUT must be a nonnegative number of whole seconds' >&2
  exit 2
fi

printf -v token '[msg %s-%s%05d%05d]' "$(date +%s)" "$BASHPID" "$RANDOM" "$RANDOM"
sent="$line $token"
if ! "$tern_bin" send "$pane" paste "$sent" || ! "$tern_bin" send "$pane" keys Enter; then
  echo "Unconfirmed: send failed for pane $pane; do not resend blindly ($token)" >&2
  exit 2
fi

deadline=$((SECONDS + 10#$timeout))
session_file=''
while :; do
  if [[ -z $session_file ]]; then
    session_file=$("$tern_bin" inspect --json | jq -er --arg pane "$pane" '
      [.panes[] | select((.pane | tostring) == $pane) | .omp_session_file
        | select(type == "string" and length > 0)]
      | if length == 1 then .[0] else empty end
    ') || session_file=''
  fi
  if [[ -n $session_file && -r $session_file ]]; then
    # An actively written JSONL may end in a partial record; retry it on the next poll.
    result=$(jq -Rn --arg token "$token" --arg line "$sent" '
      reduce inputs as $raw (2;
        (try ($raw | fromjson) catch null) as $entry
        | if $entry.type == "message" and $entry.message.role == "user" then
            ($entry.message.content
              | if type == "string" then .
                elif type == "array" then map(select(.type == "text") | .text) | join("")
                else "" end) as $text
            | if $text | contains($token) then
                if . == 1 or $text != $line then 1 else 0 end
              else . end
          else . end)
    ' "$session_file") || result=2
    if [[ $result == 0 ]]; then
      echo "Confirmed: pane $pane ($token)"
      exit 0
    elif [[ $result == 1 ]]; then
      echo "Contaminated: pane $pane; do not resend blindly ($token)" >&2
      exit 1
    fi
  fi
  if (( SECONDS >= deadline )); then
    echo "Unconfirmed: pane $pane after ${timeout}s; do not resend blindly ($token)" >&2
    exit 2
  fi
  sleep 1
done
