# Synthetic Regression Corpus

This committed fixture is privacy-safe and mirrors the data shapes used by the
Copilot Cost Counter correlation code. It contains no copied user messages,
local paths, account names, workspace names, or captured responses.

The three sessions cover a persisted custom title, an initial-label fallback,
and a subagent request correlated through a bare UUID `VoiceProgress` loop.
The extension-host log uses production `ccreq`, `VoiceProgress`, and
`ChatWebSocketManager` formats. All identifiers and numeric usage values are invented.

`test/recorded-corpus.test.mjs` validates this fixture on every test run. The
ignored `test_data/recorded/` directory remains a private debugging corpus and
is not used by automated tests.