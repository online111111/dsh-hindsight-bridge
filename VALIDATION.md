# Validation scope

Target runtime: DeepSeek Harness `0.2.0-rc.2`, Cordis `4.0.4`, Schemastery `3.18.4`, Node 22/24. Current upstream source was inspected at commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`0.2.1-alpha.1`); release packages are separately pinned and exercised.

## Automated evidence

- Real released Cordis Loader boots an isolated profile with the shipped plugin patch, DSH AgentLoop/session services, and local deterministic model adapter.
- Two completed turns include recalled context in model requests and durable session events, submit distinct document IDs, and poll their asynchronous operations.
- Real DSH ConfigEditor and Settings services verify schema projection, secret redaction, persistence, volatile updates without fiber replacement, and revision conflicts.
- Local HTTP fixtures cover auth, response byte bounds, deadlines, cancellation, redirect refusal, operation GETs, malformed responses, and error redaction.
- Browser-companion behavior tests exercise the production UI script in a Node VM with an explicit local renderer fixture. An additional smoke check opens the installed plugin in the actual DSH Web UI and verifies rendering, saving, and absence of console errors; this does not test a real model conversation in the browser.

## External scope

The real Hindsight endpoint is checked only using authenticated health and Recall requests. No fabricated preference is written to a production bank. Public files and package contents contain no deployment-specific endpoints, private IPs, or real credentials.

Installation checks use a separate `DSH_HOME` and the supported `dsh plugin --profile ... add` command. No running production DSH service is reconfigured or restarted.

## Known limits

- Writes use an in-memory bounded queue, not a persistent offline outbox. A hard process crash or exhausted flush deadline can lose uncompleted work; failed POSTs are not replayed automatically.
- Plugin loaded in the middle of a turn does not recover the earlier part of that turn from old history. It starts complete capture at the next live turn/start.
- Secret filtering is pattern-based. Unusual credential formats or sensitive natural-language material may remain; operators must choose memory scope deliberately.
- Shared-bank configuration is opt-in. The default bank is `deepseek-harness`.
