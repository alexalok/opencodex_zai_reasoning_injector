# OpenCodex Z.AI reasoning injector

An experimental, server-side [OpenCodex](https://github.com/lidge-jun/opencodex)
plugin that turns `<reasoning>...</reasoning>` blocks in a user prompt into
synthetic reasoning context for Z.AI's Responses API. It is intended for
experiments with supplied reasoning context, not guaranteed control over a
model's private reasoning or a way to resume reasoning mid-sentence.

Tested with OpenCodex **2.96.7** (`@bitkyc08/opencodex`) using its Bun runtime,
Z.AI `glm-5.3`, and the Responses API. The standalone regression suite passes
with Bun **1.2.19**. There are no package dependencies. Other OpenCodex versions,
models, providers, and runtimes are not covered by these compatibility claims.

## How it works

Only HTTP sends to `https://api.z.ai/api/v1/responses` are redirected. The relay
accepts only POST requests to that exact path behind a random 256-bit path token.
The token changes on each plugin installation. Queries are preserved.

1. Remove every complete, case-sensitive `<reasoning>...</reasoning>` block from
   every user-role message's string content or `input_text`/`text` parts.
2. On the first turn, collect blocks from the **last user-role item**, even if a
   developer message follows it. Trim the blocks and join nonempty blocks with
   two newlines. First turn means no assistant-role item and no explicitly typed
   non-message item (such as `reasoning` or `function_call`) in `input`.
3. Append a reasoning item, followed by user messages `<turn_interrupted/>` and
   `Continue`.
4. For a user message in a later turn (an assistant-role item or typed non-message
   item comes before it in `input`), insert its trimmed, joined blocks as a
   reasoning item **just before that message**. This applies to every such message,
   not only the last one, so replayed history gets the same insertion on every
   request.

Text parts or messages emptied by stripping are removed; a later-turn reasoning
item stays in the removed message's place. Other content, including images and
developer messages, is preserved. Blocks in first-turn user messages other than
the last one, and blocks in first-turn messages once the conversation has moved
on, are only stripped.
The original parsed object is not mutated.

OpenCodex's `ctx.registerUpstreamRewriter(fn)` can change URLs and headers but not
request bodies. The plugin therefore starts an ephemeral `Bun.serve` relay on
`127.0.0.1`, transforms the body there, and forwards it over TLS to the fixed
Z.AI endpoint. Authentication and other end-to-end headers are forwarded;
hop-by-hop headers and fields named by `Connection` are removed. Request
`Host` and `Content-Length` are recalculated. Redirects are not followed.
Responses, including SSE, are streamed without buffering the complete reply.

## Install

Install OpenCodex separately; its npm package is
[`@bitkyc08/opencodex`](https://www.npmjs.com/package/@bitkyc08/opencodex).
Use the configuration directory of the OpenCodex process that sends requests to
Z.AI. **With OpenCodex Link, install this plugin on the hub that actually connects
to `api.z.ai`; installing only on the Link client will not affect hub sends.**

Run the following from this repository as the OS user that runs OpenCodex, with
`OPENCODEX_HOME` set to that process's configuration directory:

```sh
: "${OPENCODEX_HOME:?Set this to the OpenCodex service configuration directory}"
mkdir -p "$OPENCODEX_HOME/plugins"
chmod 700 "$OPENCODEX_HOME/plugins"
install -m 600 zai-reasoning-inject.mjs "$OPENCODEX_HOME/plugins/zai-reasoning-inject.mjs"
```

The installed file must be owned by the service user, must not be group- or
other-writable, and must not be a symlink. If installing as an administrator,
set ownership to the service user before starting OpenCodex. Only the root
`zai-reasoning-inject.mjs` file belongs in the plugins directory; do not install
the tests there. Plugins execute trusted code with the service user's privileges.

Restart that OpenCodex instance through its normal process/service manager.
For a manually started instance, stop its existing process and run `ocx start`
again under the same user and configuration. OpenCodex loads trusted `*.mjs`
files from `$OPENCODEX_HOME/plugins/` at startup. No live restart is performed by
this repository's scripts.

## Usage

Configure OpenCodex to send Responses requests to Z.AI, start a fresh conversation,
and include a block in your user message:

```text
Find why this function returns the wrong total.
<reasoning>
The total may count the last entry twice. Check the loop boundary first.
</reasoning>
```

The upstream input contains the cleaned user prompt and then:

```json
[
  {
    "type": "reasoning",
    "summary": [],
    "content": [
      {
        "type": "reasoning_text",
        "text": "The total may count the last entry twice. Check the loop boundary first."
      }
    ],
    "encrypted_content": null
  },
  {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<turn_interrupted/>"}]},
  {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Continue"}]}
]
```

The plugin does not hide this text from Z.AI. Blocks are sent as
reasoning context; treat them as provider-bound prompt data, not secrets.

## Disable or remove

Create the kill-switch file in the same configuration directory:

```sh
touch "$OPENCODEX_HOME/zai-reasoning-inject.disabled"
```

New sends bypass the injector, and its registered capture transform also becomes
a no-op. Already transformed/in-flight sends cannot be undone. Remove the file
to re-enable without restarting:

```sh
rm "$OPENCODEX_HOME/zai-reasoning-inject.disabled"
```

To uninstall, remove the installed plugin file and restart the relevant instance.

## Observations and limitations

These are empirical findings from **2026-11-16**, against Z.AI `glm-5.3` through
the Responses API, not guarantees of future provider behavior:

- Reasoning items after the last user message appeared to be silently dropped:
  reported input tokens stayed essentially unchanged (for example, 29 vs 30).
  Adding a trailing assistant message did not make the reasoning effective.
- Chat Completions attempts using a trailing assistant `reasoning_content` or
  `prefix: true` were also dropped in those experiments.
- Reasoning before a later user message was retained (34 → 67 input tokens).
  The model acted on the supplied reasoning in 7/10 synthetic runs; roughly
  2/10 runs flagged imperative injected text as suspicious.
- The model starts a new reasoning pass, rather than continuing mid-sentence.
  It may treat `Continue` as a new instruction. The appended messages change
  conversation semantics and can affect output and token cost.
- Reasoning inserted before a later user message, after a finished assistant
  reply, was retained (42 → 72 input tokens). When it contradicted the visible
  earlier reply, the model usually followed the visible reply (1/6 followed the
  reasoning).

The plugin does not handle Chat Completions, WebSockets, alternate provider
hosts/paths, compressed request bodies, or string-valued `input`. Invalid JSON
passes through unchanged. Encoded bodies pass through with their encoding
header intact. In those cases tags are **not** stripped. Unterminated tags and
other capitalization are ordinary text. Stateful requests using
`previous_response_id` are not inspected for remote history: first-turn detection
uses only the supplied `input` array. Use full-history requests for predictable
first-turn detection.

Request bodies are buffered, capped at 64 MiB before and after transformation;
JSON parsing and serialization require additional memory. There is no global
concurrency/memory limit. Long-lived streams have no relay idle timeout. The
loopback token is a local capability, not isolation from other trusted processes
running as the same user. The plugin does not persist prompts or credentials.

## Optional capture-relay contract

No capture plugin is required or included. An optional relay in the same process
can coordinate using:

- `Symbol.for('opencodex.zai.requestTransforms')`: a shared `Map` containing the
  `zai-reasoning-inject` byte transform. Call it with `(Uint8Array, pathname)`
  and forward its returned bytes. Pass `/api/v1/responses` as the pathname.
- `Symbol.for('opencodex.zai.captureActive')`: a function returning `true` while
  that relay owns Z.AI forwarding. The injector's URL rewriter then steps aside.

The capture relay must apply registered transforms itself and manage its own
transport/security rules. The injector's kill switch disables its transform,
not the separate relay. Shutdown unregisters the injector hook, removes its
transform, and stops its loopback server.

## Test

```sh
bun run test
```

Tests use a local relay and a stub upstream; they never send requests to Z.AI.
They cover transforms, first-turn detection, capture coordination, disabling,
URL/method/token restrictions, body limits, header handling, errors, and streaming.
The relay uses Bun's documented [HTTP server](https://bun.sh/docs/runtime/http/server)
and [fetch](https://bun.sh/docs/runtime/networking/fetch) APIs.

## License

MIT, copyright 2026 alexalok. See [LICENSE](LICENSE).
