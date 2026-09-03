# Copilot Cost Counter

A standalone VS Code companion extension that records completed GitHub Copilot requests from a Copilot output log and writes workspace-local usage summaries.

## Install From Source

Requirements: VS Code 1.85 or later, Node.js 20 or later, npm, and GitHub Copilot for VS Code.

From this directory:

```sh
npm install
npm run package
code --install-extension copilot-cost-counter-0.1.0.vsix
```

Restart or reload VS Code after installation. The generated `.vsix` file can also be installed through **Extensions: Install from VSIX...** in the Extensions view.

## Configure The Log

The extension defaults to `usage.log` in the first workspace folder. Copilot’s actual output log is commonly outside the workspace, so configure it using either method:

1. Run `Copilot Cost Counter: Choose Output Log` and select the log file.
2. Set `copilotCostCounter.logPath` in workspace settings. Relative paths are resolved from the first workspace folder.

The extension polls the selected log and records each successful `ccreq` request once. Use `Copilot Cost Counter: Open Workspace Usage` to open `.copilot/usage.jsonl`.

Raw Copilot logs and generated usage records may contain private workspace or request information. They are excluded by `.gitignore`; do not force-add them to a public repository.

## Generated Pricing

`npm run compile` fetches the [GitHub Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) page before compiling. It generates:

- `src/pricing.generated.json`, packaged and used as the offline pricing catalog
- `pricing.generated.csv`, a human-readable export

Each pricing row has a `since` date. Unchanged prices are not duplicated on later builds; changed model, tier, or threshold prices are appended with the build date while previous rows remain in history. Rates are stored per million tokens. GitHub defines `1 AI credit = $0.01 USD`.

To refresh only the generated artifacts:

```sh
npm run fetch-pricing
```

## Recorded Data And Limits

Records contain the timestamp, request ID, model, feature, duration, token counts when present in the log, pricing rates, USD costs, and AI-credit costs. The current Copilot output format shown in `usage.log` contains model and duration but not prompt/output token counts. Such records deliberately use `costKind: "unavailable"`.

A companion extension cannot access Copilot’s private in-memory telemetry through the public VS Code extension API. Exact per-request billing requires Copilot to emit token usage in the log or expose it through a supported API.

## Development

Run the TypeScript compiler without creating a VSIX:

```sh
npm run compile
```

To run the extension under the VS Code Extension Development Host, open this directory in VS Code and press `F5`.
