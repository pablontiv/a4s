# Pi Channel Adapter PoC

Proof of concept for the Channel Adapter described in
`.workspace/docs/research/2026-10-02-agent-messaging-adapter-pattern-boceto.md`.
It uses two directories as an emulated external bus, with one JSON file per
canonical message.

Set `A4S_CHANNEL_SEND_DIR`, `A4S_CHANNEL_RECEIVE_DIR`, and
`A4S_CHANNEL_ADDRESS`, load the package as a Pi extension, then send with:

```text
/channel-send <to> <body>
```

The command atomically publishes a canonical `prompt` message into the send
directory. During a session, the adapter reads new canonical messages addressed
to `A4S_CHANNEL_ADDRESS` from the receive directory and passes them to Pi with
`sendUserMessage`.

This PoC does not provide durable ACKs, retention, redelivery, deduplication, or
ordering guarantees. Those belong to a real bus, not the adapter.
