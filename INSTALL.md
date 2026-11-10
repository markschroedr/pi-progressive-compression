# Install and compatibility reference

- Package name: `pi-progressive-compression`, version `0.1.0`.
- Runtime: Node.js 22.19 or newer; Pi coding-agent **1.4.0**; system `patch` command for patch application.
- Pi 1.4.0 needs the included MIT host patch. Unpatched Pi does not provide equivalent atomic compaction behavior.
- Native projection and standalone context-edit APIs remain upstream APIs; this package does not replace them.
- Patch scope: safe-boundary threshold event, atomic checkpoint edits, replay, capability declarations, concurrent-run guard.
- No Pi AI patch, private provider, external compactor, or separate history database is required.

## Isolated local installation

- Keep this repository beside a new `pi-context-host` directory.
- Run from their common parent:

```sh
mkdir pi-context-host
cd pi-context-host
npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0
PACKAGE=../pi-progressive-compression
HOST=node_modules/@earendil-works/pi-coding-agent
node "$PACKAGE/scripts/apply-host-patch.mjs" "$HOST"
export PI_PROGRESSIVE_COMPRESSION_HOST="$PWD/$HOST"
export PI_CODING_AGENT_DIR="$PWD/agent"
node "$PACKAGE/scripts/pi.mjs" --check-host
node "$PACKAGE/scripts/pi.mjs"
```

- Set `PACKAGE` to the actual local package directory when it differs.
- Review the patch before application. The application script checks every original file hash before writing.
- Repeated application is a no-op when every patched file hash matches.
- Reinstalling/updating Pi removes the patch. Reapply only to the exact supported version.
- The launcher checks all six patched files before starting. A mismatch stops startup.
- The launcher automatically loads this extension and executes **`dist/cli.js`**, not Pi's independent `dist/bundle/cli.js`.
- The upstream `pi` executable still executes unpatched bundled code. Do not use it for continuous-context sessions.
- SDK integrations must import the patched installation's unbundled `dist/index.js` and load `src/index.ts`.
- Other Pi versions, compiled Pi binaries, bundled RPC entrypoints, and virtual-model routing are unverified and unsupported in v1.

## Providers and writer

- Authenticate through Pi's `/login`, environment variables, or registered provider extensions.
- Writer calls use `ctx.modelRegistry.streamSimple`; Pi resolves provider configuration and request-time authentication.
- `writer: "current"` selects the session model at call time. No model-tier routing occurs.
- Set `writer` to `provider/model` for a different registered chat model.
- The writer must return JSON using the existing prompts. Invalid output gets bounded retries, not a private fallback.
- Private Claude bridge integration is unsupported in v1, including its isolated-summary event protocol.
- Native registered Anthropic streaming works through the ordinary provider path; no bridge is required.
- Writer calls can incur provider charges. Background preparation starts automatically in continuous mode.
- Token budgets use Pi character estimates, adjusted by available assistant input-usage receipts; they are not tokenizer guarantees.

## Session commands

| Command | Effect |
| --- | --- |
| `/context-mode` | Show mode and effective configuration |
| `/context-mode continuous` | Enable continuous context and `context_zoom` |
| `/context-mode native` | Stop background preparation; use upstream compaction; withdraw zoom |
| `/context-config` | Show effective configuration |
| `/context-config {"writer":"provider/model"}` | Merge and persist a validated session configuration |
| `/compact` | Ask Pi to compact; continuous mode supplies an atomic checkpoint |

| Setting | Default | Meaning |
| --- | --- | --- |
| `writer` | `"current"` | Current model or explicit `provider/model` |
| `lo` | `60000` | Target conversation allocation after reorganization |
| `hi` | `200000` | Continuous reorganization threshold |
| `lines` | `40000` | Numbered-history allocation within `lo` |
| `protectLatestRun` | `40000` | Soft latest-run allowance; fresh evidence may exceed it |
| `midRun` | `true` | Permit threshold reorganization at safe tool-step boundaries |

- Budgets are positive safe integers; require `hi > lo > lines`. `midRun` must be Boolean.
- Unknown configuration keys fail validation. Configuration and mode follow the active session branch.
- New sessions default to continuous. Existing sessions remain unchanged on reopen.
- An existing native checkpoint can seed bounded history lines at the next reorganization unless native mode was explicitly selected.
- Pi's own context-window threshold and overflow recovery remain active regardless of `hi` or `midRun`.
- Background preparation starts halfway between `lo` and `hi`; earlier batches prepare older exchanges incrementally.
- Native Anthropic sessions also consider reorganization after 25 idle minutes above that midpoint.

## Archive, branches, and recovery

- Session JSONL holds numbered archive nodes, writer receipts, prepared snapshots, and checkpoints.
- Checkpoints commit retained-content edits in one record. Original message entries remain unchanged.
- `context_zoom({"id":"#12"})` returns archived line versions and children or lossless source JSON.
- Leaf source pages contain up to 24,000 characters. Continue with the returned `nextOffset` in `offset`.
- Tool access follows active continuous mode. Tree navigation restores branch-specific context and archive references.
- Forks materialize inherited archive nodes. Keep the parent session until the fork has opened successfully.
- Missing writer/authentication, invalid output, or failed preparation never imports another compactor.
- Incomplete leaf preparation cancels compaction; current projected context and raw history remain usable for retry.
- Failed merges retain a covered prefix and raw suffix only when coverage is safe; otherwise compaction cancels.
- Reconciliation failure keeps the prior history view. It does not claim that reconciliation succeeded.
- Cancellation does not guarantee enough room for another provider request. Repair the writer/configuration and retry `/compact`.
- Keep backups of session JSONL. To inspect originals, open raw JSONL or navigate before the checkpoint.
- Do not open patched checkpoints with unpatched Pi: it ignores checkpoint edits and can reconstruct different context.
- Native mode does not undo earlier checkpoints. Continue using the patched host while those checkpoints remain in history.
- Treat archives as private conversation data. This repository contains no session data or credentials.

## Licensing

- Extension source and patch additions: MIT; see `LICENSE`.
- Upstream Pi notices and license: `THIRD_PARTY_NOTICES`.
