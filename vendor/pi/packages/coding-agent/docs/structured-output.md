# Structured Headless Output

MyPi can produce an authoritative JSON value for print, JSON event, RPC, SDK,
and daemon-hosted clients. The caller supplies a bounded JSON Schema; MyPi
validates the schema before starting the run and validates the final value
locally before reporting success.

Structured output is a finalization phase after the ordinary agent run settles.
The ordinary run keeps its normal tools, safety policy, Goal behavior,
compaction, retries, and queue semantics. The finalizer uses the same model and
completed context without ordinary tools. It prefers the provider's native JSON
Schema response format and falls back to one constrained
`mypi_structured_result` tool when native output is unavailable or rejected.
Malformed values receive at most the configured validation retries; exhaustion
is a typed failure and never returns malformed JSON as success.

## CLI

Pass a schema file in print or JSON event mode:

```bash
mypi --print --output-schema ./result.schema.json "Summarize the repository"
mypi --mode json --output-schema ./result.schema.json "Summarize the repository"
```

Print mode writes exactly one compact JSON document to stdout. JSON mode keeps
its existing JSONL event stream and emits a distinct `structured_result` event;
it never inserts an unframed result object into the stream. Failures emit
`structured_result_error`, followed by `agent_settled` with an error outcome,
and the process exits non-zero.

`--output-schema` is intentionally unavailable in interactive and RPC startup
mode. RPC clients attach a schema to the individual `prompt` command instead.

## RPC

```json
{
  "id": "request-1",
  "type": "prompt",
  "message": "Summarize the repository",
  "structuredOutput": {
    "schema": {
      "type": "object",
      "properties": { "summary": { "type": "string" } },
      "required": ["summary"],
      "additionalProperties": false
    }
  }
}
```

The normal prompt response still acknowledges acceptance. The later
`structured_result.result.requestId` or
`structured_result_error.error.requestId` equals the prompt command ID. Session
daemon routing restores that ID only for the issuing surface, adds its normal
`sessionId`, and sends co-driving observers the same result without a foreign
request ID.

The TypeScript `RpcClient.promptStructured()` helper performs this correlation
and resolves with `StructuredOutputResult` or rejects with
`StructuredOutputError`.

One active run produces one structured result. Steering or follow-up messages
queued without another schema remain part of that run and are reflected in its
final value. A queued prompt carrying `structuredOutput` is rejected; submit a
new structured prompt after settlement instead.

## SDK

```typescript
const result = await session.promptStructured("Summarize the repository", {
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
});

console.log(result.value.summary);
```

`prompt()` remains `Promise<void>` for compatibility. Advanced callers may pass
`structuredOutput` in `PromptOptions` and consume the typed events directly.

## Schema and result bounds

- The root schema must be an object schema.
- Schemas are limited to 32 KiB, depth 12, 256 object/array nodes, 128
  properties per object, and 100 entries per schema array.
- External, recursive, and dynamic `$ref` forms are rejected. Use an inline
  bounded schema.
- Format names use only letters, digits, underscores, and dashes and are at
  most 64 characters.
- Results are limited to 256 KiB and are compiled and checked locally.
- `maxValidationRetries` defaults to 2 and may range from 0 through 3.

The canonical schema SHA-256 is stored in a branch-local
`mypi-structured-output` custom session entry. A resumed run or follow-up may
reuse the exact schema. A different schema on that branch fails before another
provider run; forks retain the source branch contract, while new sessions start
without one.

Provider-compatible custom models may set
`compat.supportsStructuredOutputs`. First-party OpenAI, Azure OpenAI, and
Anthropic transports enable their native response formats by default. Other
providers use the validated tool fallback.
