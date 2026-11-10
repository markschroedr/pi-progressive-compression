# Progressive Compression

Continuous context for Pi.

Long-running Pi conversations with numbered summaries you can open back up.

Older exchanges become short history lines. Recent conversation and tool evidence stay directly in context. When a summary leaves out something the agent needs, `context_zoom` follows its reference back to the original messages.

<p align="center"><img src="assets/context-timeline.svg" alt="Older conversation becomes numbered history lines, followed by recent conversation and tool evidence. The agent can retrieve originals from the session archive." width="760"></p>

**Experimental v1. Requires the included patch for Pi 1.4.0.** This is not yet a drop-in extension for an ordinary Pi installation.

## How it works

A writer model prepares summaries in the background while the main agent continues working. Before adopting a prepared context, the system reconciles history against later evidence: a changed decision can replace an older line without deleting its original version.

When history exceeds its budget, the writer selects less-important lines for merging with their neighbours. The history stays chronological, but age alone does not decide what loses detail. Old requirements can remain detailed while a less useful recent exchange gets compressed.

<p align="center"><img src="assets/context-preparation-flow.svg" alt="Background preparation produces summaries, reconciliation updates history and merges neighbouring lines, and compaction adopts the prepared context. Originals remain archived." width="760"></p>

The context changes at compaction boundaries rather than after every new message. A ready snapshot can be adopted without waiting for another model call. Messages received after preparation stay raw until a later pass. Cold starts and unfinished preparation can still take time.

The session JSONL contains the original messages, summary tree, earlier line versions and checkpoints. There is no separate database or memory service. Forks and branch navigation retain their own context views.

## Try it locally

Use an isolated Pi installation first. You need Node.js 22.19 or newer and the system `patch` command.

Follow [installation instructions](INSTALL.md#isolated-local-installation) to install Pi 1.4.0, apply the checked host patch and start the supplied launcher. Authenticate with Pi as usual. Background writing uses the current model by default and can incur provider charges.

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

Two operations need host support that clean Pi 1.4.0 does not expose:

- Check the conversation threshold before the next model response.
- Commit retained-message edits together with the compaction checkpoint, then replay them consistently after reopening.

Saving edits separately from compaction could leave a session half-updated after an interruption. The included six-file patch keeps those changes atomic. It also guards against concurrent runs during compaction.

The launcher checks the patched files and runs Pi's unbundled entrypoint. The ordinary `pi` command runs a separate bundle and does **not** pick up those patched files. Other Pi versions and compiled binaries are unsupported in this release. No automatic patching of your existing installation occurs.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES).
