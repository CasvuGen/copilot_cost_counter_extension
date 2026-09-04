# Copilot Cost Counter

**Version:** 0.1.27

A standalone VS Code companion extension that records completed GitHub Copilot requests from a Copilot output log and writes workspace-local usage summaries.

> **Disclaimer:** This project was vibe coded and is provided as-is for experimentation. Use it entirely at your own risk. It is not affiliated with or endorsed by GitHub or Microsoft.

## Install From Source

Requirements: VS Code 1.85 or later, Node.js 20 or later, npm, and GitHub Copilot for VS Code.

From this directory:

```sh
npm install
npm run package
```

`npm run package` increments the patch version, compiles the extension, and creates `packages/copilot-cost-counter-<version>.vsix`. Install that generated VSIX with **Extensions: Install from VSIX...** or with `code --install-extension ./packages/copilot-cost-counter-<version>.vsix`.

Restart or reload VS Code after installation. The generated `.vsix` file can also be installed through **Extensions: Install from VSIX...** in the Extensions view.

## Configure The Log

The `copilotCostCounter.logPath` setting is intentionally empty by default. An empty value is the recommended mode: the extension automatically searches the current VS Code window’s extension-host log directory for the most recently updated `GitHub Copilot Chat.log`. The discovered path is used at runtime and is not written into the setting. Copilot’s logs are commonly outside the workspace, so configure an explicit path only when automatic discovery does not find the right session:

1. Run `Copilot Cost Counter: Choose Output Log` and select the log file.
2. Set `copilotCostCounter.logPath` in workspace settings. Relative paths are resolved from the first workspace folder; absolute paths are accepted.

The extension polls the selected log and records each successful `ccreq` request once. Use `Copilot Cost Counter: Open Workspace Usage` to open `.copilot/usage.jsonl`.

Use the Usage Report view title menu for Refresh and Open Workspace Usage. The gear button beside that menu opens the extension settings.

Raw Copilot logs and generated usage records may contain private workspace or request information. They are excluded by `.gitignore`; do not force-add them to a public repository.

## Usage Report

After installation, select the **Copilot Cost Counter** graph icon in the Activity Bar to open the workspace-local report. It shows:

- Estimated USD spend and AI credits
- Request count and records with available cost data
- Daily spend for the latest 14 days with estimated costs
- Cost and request counts by model
- The eight most recent requests

Use **Refresh** in the report when needed. The report also refreshes when the extension appends a new request. Values are calculated only from records written to the current workspace’s `.copilot/usage.jsonl`; records with missing token telemetry are counted as requests but excluded from spend totals. The Copilot Chat log currently exposes the model and duration, but not consumed prompt, output, or cache tokens. The report cannot calculate exact costs until Copilot emits those token counts or exposes them through a supported API.

Use the **Credits** and **Tokens** tabs to switch between dollar/AI-credit totals and token totals. When token counts are present but a model has no input or output rate, the report shows a gray warning naming the model and points to `copilotCostCounter.modelPricingOverrides`.

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

Records contain the timestamp, request ID, model, raw feature, derived request type, duration, token counts when present in the log, pricing rates, USD costs, and AI-credit costs. Request types are `chat`, `completion`, `nextEditSuggestion`, and `utility`. The type is inferred from Copilot's feature label; older JSONL records without `requestType` are classified at display time. The current Copilot output format shown in `usage.log` contains model and duration but not prompt/output token counts. Such records deliberately use `costKind: "unavailable"`.

A companion extension cannot access Copilot’s private in-memory telemetry through the public VS Code extension API. Exact per-request billing requires Copilot to emit token usage in the log or expose it through a supported API.

## Pricing Overrides

For models that are not listed on GitHub’s public pricing page, configure rates in `copilotCostCounter.modelPricingOverrides`. Rates are USD per million tokens. The `input` and `output` values are required; `cachedInput` and `cacheWrite` are optional.

Example workspace settings:

```json
{
	"copilotCostCounter.modelPricingOverrides": {
		"gpt-4o-mini-2024-07-18": {
			"input": 0.15,
			"cachedInput": 0.075,
			"output": 0.6
		},
		"my-custom-model": {
			"input": 1.0,
			"output": 4.0
		}
	}
}
```

Model names are normalized before matching, so names with version or provider formatting differences can be entered as they appear in the Copilot log. Overrides are used for newly recorded requests; existing JSONL records are not rewritten.

The Settings editor exposes the override object as a custom-model map. Add a model name as a property and set its `input` and `output` rates; `cachedInput` and `cacheWrite` are optional. Rates remain USD per million tokens even when the report uses another display currency.

## Display Currency

Set `copilotCostCounter.currency` to `USD`, `EUR`, `GBP`, `SEK`, `NOK`, or `DKK`. Because pricing sources are USD-based, set `copilotCostCounter.currencyConversionRate` to the number of display-currency units per USD. Stored JSONL costs remain in USD; the report and money-burn animation use the selected display currency.

## Money-Burn Animation

Enable `copilotCostCounter.showMoneyBurn` to display the estimated spend after a request. The animation can be customized with:

- `copilotCostCounter.moneyBurnDurationMs` for the duration in milliseconds
- `copilotCostCounter.moneyBurnSizePx` for the amount's font size in pixels
- `copilotCostCounter.moneyBurnOrigin` for `top-left`, `top-right`, `bottom-left`, or `bottom-right`
- `copilotCostCounter.moneyBurnThresholdUsd` for the cumulative USD threshold before it fires

The threshold defaults to `0`, which shows an animation for every estimated request. With a positive threshold, estimated costs accumulate and the animation fires each time a threshold block is crossed. Any remainder carries into the next request. For example, a `$0.70` request with a `$0.50` threshold displays `$0.50` and carries `$0.20` forward. Sub-cent amounts use additional decimal places when shown in the animation.

## Development

Run the TypeScript compiler without creating a VSIX:

```sh
npm run compile
```

The Usage Report markup is kept in `templates/report.html` and its reusable fragments are in the same directory. Edit those HTML files to change the report layout, styles, labels, or client-side interactions; TypeScript supplies the calculated values.

To run the extension under the VS Code Extension Development Host, open this directory in VS Code and press `F5`.
