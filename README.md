# dsh-hindsight-bridge

A standalone Cordis bundle providing automatic Hindsight memory for DeepSeek Harness. It uses native lifecycle events, not model-dependent MCP calls, and does not patch the Harness source.

## Requirements

- DeepSeek Harness `0.2.0-rc.2`, Node `^22.19.0 || >=24`.
- A reachable Hindsight `0.10` API. Use the dataplane API key, not the management UI access key.
- Install in the profile you actually run (`web`, `desktop`, or your own profile). Keep only one automatic memory plugin enabled.

The implementation was checked against the current upstream source and explicitly versioned npm packages. Unversioned DSH subpackages may resolve to old `latest` tags; tests pin the release versions.

## Installation

Download the installable tarball from [GitHub Release v1.0.0](https://github.com/online111111/dsh-hindsight-bridge/releases/tag/v1.0.0), then run this command in the download directory:

```sh
dsh plugin --profile web add ./dsh-hindsight-bridge-1.0.0.tgz
```

There is no published npm release yet. Do not install the package name alone. For Desktop, use the bundled DSH CLI and its `desktop` profile. Let the user restart the chosen DSH service when convenient; installation does not modify the memory server or automatically restart a running application.

Configure the `hindsight-memory` plugin entry. Prefer an environment variable for the API key; the host process must inherit it. Example profile patch:

```yaml
- id: hindsight-memory
  config:
    apiUrl: https://memory.example.com
    apiKeyEnv: HINDSIGHT_API_KEY
    bankId: deepseek-harness
    autoRecall: true
    autoRetain: true
```

For a shared Hermes bank, explicitly select `hermes-default`. This grants this DSH instance access to that bank and allows it to add memories there. The default `deepseek-harness` bank keeps DSH separate. Use the HTTPS API root, without `/mcp/...` or `/v1` suffixes; never point this plugin at the UI.

The Web client companion provides a Hindsight settings section. Configuration changes use the current ConfigForms atomic mutation and revision mechanism. Conflicting writes preserve the draft; an explicit discard action reloads the current configuration rather than silently rebasing it. Secrets are redacted by the host schema and password inputs never echo the existing key.

## Behavior

- Recall runs once before the first model request of each turn, using genuine user text. A bounded, explicitly labelled memory block enters durable user-role history. Tool continuations reuse it rather than recalling repeatedly.
- Retain collects live committed events, retaining only genuine user text and the final successful assistant text. It excludes plugin context, reasoning, tool payloads, restored history, model-only surface replacements, and interrupted or failed turns.
- Each turn has a stable, distinct document ID. Hindsight replacement semantics cannot erase earlier turns.
- Retention is non-blocking. An accepted asynchronous operation is polled until completion; acceptance is not reported as completion. `session/flush` and plugin disposal drain pending writes within a deadline.
- Queue overflow and failed writes are logged using non-sensitive error codes. No POST is automatically retried. Forced process exit, server outage, and bounded flush expiry can still lose unsent work; this is not a durable offline journal.
- HTTP redirects are refused. HTTPS is required except for loopback HTTP. Request and response deadlines, byte limits, and cancellation bound service failures.
- `redactSecrets` is enabled by default and removes common key/token/password/private-key patterns. It is best-effort, not a guarantee that arbitrary sensitive natural-language content is detected.
- Child sessions are excluded by default. Turn this on deliberately if their synthetic content belongs in your memory bank.

## Configuration

Important fields are `enabled`, `apiUrl`, `apiKey` / `apiKeyEnv`, `bankId`, `autoRecall`, `autoRetain`, `recallBudget`, and `recallTypes`. Recall defaults to observation memories; include `world` and `experience` if the selected bank has not accumulated observations yet. Limits include `recallTimeoutMs`, `retainTimeoutMs`, `operationTimeoutMs`, `flushTimeoutMs`, `maxQueryChars`, `maxBlockChars`, `maxRetainChars`, and `maxPendingWrites`. The exported Config schema is the complete reference.

Memory increases model input by up to `maxBlockChars` characters per turn. It is appended to history rather than rewriting the system prompt or earlier messages; repeated tool steps see identical injected bytes.

## Source development verification

Run these commands in a clone of this source repository, not inside the installed tarball. The tarball intentionally excludes test fixtures.

```sh
git clone https://github.com/online111111/dsh-hindsight-bridge.git
cd dsh-hindsight-bridge
npm ci
npm test
npm run check
npm pack
```

## Installed profile verification and removal

```sh
dsh --profile web --dump-config
dsh plugin --profile web remove dsh-hindsight-bridge
```

Do not publish `--dump-config` output: your profile may contain credentials.

Tests use real local HTTP servers, the released Cordis Loader and real DSH agent/session services. Model adapters and Hindsight fixtures are explicitly local test doubles; tests do not write fictitious facts to a production bank. Live service acceptance can be checked through authenticated health/recall reads, followed by an actual user conversation and a completed retain operation.
