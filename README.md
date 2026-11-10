# Progressive Compression

Continuous context for Pi.

Long-running Pi conversations with numbered summaries you can open back up.

Older exchanges become short history lines. Recent conversation and tool evidence stay directly in context. When a summary leaves out something the agent needs, `context_zoom` follows its reference back to the original messages.

<p align="center"><img src="assets/context-timeline.svg" alt="Older conversation becomes numbered history lines, followed by recent conversation and tool evidence. The agent can retrieve originals from the session archive." width="760"></p>

Setup installs an isolated Pi host with the required patch. Your existing Pi installation stays untouched.

## How it works

A writer model prepares summaries in the background while the main agent continues working. Before adopting a prepared context, the system reconciles history against later evidence: a changed decision can replace an older line without deleting its original version.

When history exceeds its budget, the writer selects less-important lines for merging with their neighbours. The history stays chronological, but age alone does not decide what loses detail. Old requirements can remain detailed while a less useful recent exchange gets compressed.

<p align="center"><img src="assets/context-preparation-flow.svg" alt="Background preparation produces summaries, reconciliation updates history and merges neighbouring lines, and compaction adopts the prepared context. Originals remain archived." width="760"></p>

The context changes at compaction boundaries rather than after every new message. A ready snapshot can be adopted without waiting for another model call. Messages received after preparation stay raw until a later pass. Cold starts and unfinished preparation can still take time.

The session JSONL contains the original messages, summary tree, earlier line versions and checkpoints. There is no separate database or memory service. Forks and branch navigation retain their own context views.

## Try it locally

You need Node.js 22.19 or newer, [Bun](https://bun.sh), and the system `patch` command.

```sh
git clone https://github.com/markschroedr/pi-progressive-compression.git
cd pi-progressive-compression
bun run setup
bun start
```

Setup handles the Pi version and patch automatically. The launcher uses your normal Pi login, settings, extensions and sessions. No environment variables or changes to your installed Pi executable are needed. Background writing uses the current model by default. See [installation details](INSTALL.md) for advanced usage and session storage.

Inside the session:

```text
/context-mode
/context-config
/compact
```

The agent can retrieve a summary's underlying detail with:

```text
context_zoom({"id":"#12"})
```

Merged references expose their children; leaf references expose original source JSON. Long results are paginated.

## Configuration

Configuration is session-local. `/context-config` accepts a JSON object and changes only the supplied settings.

| Setting | Default | Purpose |
| --- | --- | --- |
| `writer` | `"current"` | Current Pi model, or a registered `provider/model` |
| `lo` | `60000` | Target conversation allocation after compaction |
| `hi` | `200000` | Conversation threshold for compaction |
| `lines` | `40000` | History-summary ceiling within the target |
| `protectLatestRun` | `40000` | Soft allowance for the latest run |
| `midRun` | `true` | Allow compaction at safe tool-step boundaries |

These are estimated token budgets, not exact tokenizer limits. The system prompt and tool definitions are outside the conversation budget. The 40k history allowance is a ceiling, not space filled with padding. Protected recent evidence and messages arriving after preparation can make the result larger than the target.

`/context-mode native` stops background preparation and returns future compactions to Pi's native mechanism. It does not undo existing checkpoints: sessions containing patched checkpoints still need the patched host. See [configuration and recovery](INSTALL.md) for the complete contract.

## Why a host patch?

Pi 1.4.0 exposes safe turn-boundary compaction, but writes retained-message edits separately from the checkpoint. It also does not reliably carry earlier edits across later checkpoints. Saving those operations separately could leave a session half-updated after an interruption.

The included six-file patch commits edits with the checkpoint and replays them after reopening. It also supplies the pre-response threshold hook and concurrent-run guard used by this implementation.

The launcher checks the patched files and runs Pi's unbundled entrypoint. The ordinary `pi` command runs a separate bundle and does **not** pick up those patched files. Other Pi versions and compiled binaries are unsupported in this release. No automatic patching of your existing installation occurs.

## Mechanism inspiration

This project grew out of my earlier Progressive Compression memory system and [UniiChat by Victor Taelin](https://github.com/VictorTaelin/UniiChat). UniiChat's neighbouring summary lines, recursive memory tree, background summarization and zoom back to originals helped shape the mechanism here. This implementation adapts those ideas to Pi sessions, with importance-based merging and reconciliation of superseded decisions.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES).
