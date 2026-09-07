# v1 Improvements Plan

This plan records improvements identified by comparing the Copilot Cost Counter with the bundled GitHub Copilot Chat source in `versions/0.2.69/codebase/2026_Vscode_copilot_refe`.

The goal is to improve accuracy and observability while keeping the extension independent from Copilot's private in-memory services and telemetry implementation.

## 1. Current Architecture

The extension currently uses a log-ledger architecture:

1. `UsageCollector` discovers `GitHub Copilot Chat.log` files and polls them for appended lines.
2. Successful `ccreq:<request-id>.copilotmd` entries are parsed from the log.
3. The parser extracts the request ID, model, feature, duration, and token counts when present.
4. The corresponding `ccreq:<request-id>.json` virtual document is opened through VS Code to read richer request data.
5. Copilot usage data is applied when available, including `usage.copilot_usage.total_nano_aiu`.
6. Chat and turn IDs are resolved from websocket log lines and persisted Copilot session JSONL files.
7. Records are written to workspace-local `.copilot/usage.jsonl`.
8. Chat titles and turn metadata are maintained in `.copilot/usage_metadata.json`.
9. A webview report renders estimated spend, AI credits, tokens, models, features, recent requests, and chats.

Primary implementation files:

- `src/extension.ts`: collection, parsing, enrichment, persistence, reconciliation, and report rendering.
- `src/chatMetadata.ts`: persisted session metadata and title parsing.
- `src/conversationContext.ts`: conversation and turn fallback resolution.
- `test/`: parser, metadata, recorded corpus, packaging, and conversation-context coverage.

## 2. Findings From Copilot's Implementation

### 2.1 Authoritative request metadata

Copilot's chat-session metadata model contains per-request fields that are more reliable than a request model inferred from a log line:

- `vscodeRequestId`
- `copilotRequestId`
- `responseModelId`
- `isUsingAutoModel`
- `creditsUsed`

The reference implementation persists request mappings in:

`~/.copilot/session-state/<sessionId>/vscode.requests.metadata.json`

The session metadata API is defined in:

`versions/0.2.69/codebase/2026_Vscode_copilot_refe/src/extension/chatSessions/common/chatSessionMetadataStore.ts`

The implementation uses `updateRequestDetails` and `getRequestDetails` in:

`versions/0.2.69/codebase/2026_Vscode_copilot_refe/src/extension/chatSessions/copilotcli/vscode-node/chatSessionMetadataStoreImpl.ts`

This is particularly important for `auto` model requests, where the requested model and the model that produced the response may differ.

### 2.2 Authoritative credits

Copilot's API usage shape includes:

- `copilot_usage.total_nano_aiu`
- `prompt_tokens`
- `completion_tokens`
- cached input tokens
- cache creation input tokens
- reasoning tokens
- accepted prediction tokens
- rejected prediction tokens

The reference helper converts nano-AIU to credits as:

`nanoAiu / 1_000_000_000`

The current extension already uses `total_nano_aiu` correctly, including an explicit zero. The next authoritative source to support is persisted `RequestDetails.creditsUsed`.

Recommended precedence:

1. Persisted Copilot `creditsUsed`.
2. `ccreq` usage `copilot_usage.total_nano_aiu`.
3. Token and pricing calculation.
4. Unavailable when neither authoritative usage nor enough pricing data exists.

The source of the value must be stored so a user can distinguish Copilot-reported credits from an estimate.

### 2.3 Response-model identity

Copilot's OTel and chat-session code distinguish request model from response model. It also normalizes model names when the server removes a reasoning-effort suffix or changes punctuation.

Reference file:

`versions/0.2.69/codebase/2026_Vscode_copilot_refe/src/platform/otel/common/responseModel.ts`

The counter should preserve both values instead of replacing one with the other:

- `requestedModel`
- `responseModel`
- `model` as the effective pricing/reporting model
- `isUsingAutoModel`

Pricing lookup should use a canonical normalized key, while display should preserve the original model strings.

### 2.4 Richer token details

The current record stores prompt, fresh input, output, cached input, and cache-write tokens. Copilot also exposes:

- reasoning output tokens
- accepted prediction tokens
- rejected prediction tokens
- cache creation input tokens
- provider-specific cache creation breakdowns, including Anthropic TTL categories

These fields should be optional so older records remain readable and newer Copilot versions can add data without breaking parsing.

### 2.5 Session and child-session relationships

Copilot's session metadata and telemetry distinguish:

- top-level chat sessions
- forked sessions
- sub-sessions
- parent session IDs
- title and categorization child requests
- run-subagent child requests

The counter currently uses websocket timing and voice-progress log heuristics to attach subagent activity to parent turns. Persisted parent-session relationships should be preferred when available, with the current heuristics retained as a fallback.

### 2.6 OTel data as architectural guidance

Copilot defines structured attributes for:

- request and response model
- response ID
- input, output, cache-read, cache-creation, and reasoning tokens
- chat session ID
- turn index and count
- tool-call round
- intent and location
- time to first token/chunk
- tool names, IDs, arguments, results, and outcomes
- AI-credit usage

The counter should use these names and concepts when designing its own record schema. It should not import Copilot's private OTel services or attempt to read private in-memory telemetry directly.

## 3. Design Constraints

- Do not depend on Copilot's private TypeScript modules at runtime.
- Do not assume internal Copilot filenames or object shapes are permanent.
- Keep log parsing as a compatibility fallback.
- Treat all new Copilot metadata files as optional and unreadable without failing collection.
- Preserve existing workspace-local storage behavior.
- Do not persist prompts, responses, tool arguments, or raw request documents.
- Keep request metadata joins bounded and efficient.
- Make schema changes tolerant of old records.
- Do not present estimates as billing statements.
- Avoid changing unrelated report behavior while introducing the new data.

## 4. Recommended Implementation Order

### Phase 1: Request metadata reader

Add a small, isolated reader for Copilot's persisted request metadata.

Checklist:

- [ ] Define a local minimal type for the fields the counter needs:
  - [ ] `vscodeRequestId`
  - [ ] `responseModelId`
  - [ ] `isUsingAutoModel`
  - [ ] `creditsUsed`
  - [ ] optional `copilotRequestId`
- [ ] Resolve Copilot's home directory from `COPILOT_HOME` or `~/.copilot`.
- [ ] Read `session-state/<sessionId>/vscode.requests.metadata.json` only when a session ID is known.
- [ ] Read the relevant session IDs from persisted chat metadata and/or turn-to-chat mappings.
- [ ] Support the JSON shape used by the current Copilot snapshot without requiring every field.
- [ ] Ignore missing files, malformed JSON, unknown fields, and permission errors.
- [ ] Cache reads briefly during one reconciliation pass to avoid repeated filesystem work.
- [ ] Add unit tests for valid data, missing data, malformed data, and partial request entries.

Suggested location: a new focused module such as `src/copilotRequestMetadata.ts`, keeping `src/extension.ts` focused on orchestration.

### Phase 2: Join metadata to usage records

Join persisted request metadata to parsed records before cost calculation is finalized.

Checklist:

- [ ] Match by `vscodeRequestId` first.
- [ ] Fall back to the Copilot request ID only when an unambiguous match exists.
- [ ] Never merge two records merely because their timestamps or models are similar.
- [ ] Store `requestedModel` from the log/request data.
- [ ] Store `responseModel` from `responseModelId` when available.
- [ ] Set the effective `model` used for pricing to the response model when it is authoritative.
- [ ] Preserve the original log model for diagnostics if it differs.
- [ ] Store `isUsingAutoModel` when available.
- [ ] Keep the current log-derived model when metadata is absent.
- [ ] Re-run the join during reconciliation so metadata that appears after the initial request can repair old records.

### Phase 3: Add authoritative credit sources

Extend the cost calculation to recognize persisted credits.

Checklist:

- [ ] Add a `creditSource` field with values such as `requestMetadata`, `copilotUsage`, `tokenEstimate`, or `unavailable`.
- [ ] Add an optional `creditsUsed` field for the direct Copilot value.
- [ ] Use persisted `creditsUsed` before `copilot_usage.total_nano_aiu`.
- [ ] Preserve an explicit numeric zero as valid usage.
- [ ] Convert direct credits to USD using the existing one-credit-equals-0.01-USD rule for display consistency.
- [ ] Keep token-derived component costs available for diagnostics even when authoritative credits replace the total.
- [ ] Mark the record as estimated only when the total is not authoritative.
- [ ] Update report labels or tooltips so users can see whether totals are reported or estimated.
- [ ] Add tests for positive credits, zero credits, negative/invalid credits, and missing credits.

### Phase 4: Expand token accounting

Add optional fields for the usage data already modeled by Copilot.

Checklist:

- [ ] Add `reasoningTokens`.
- [ ] Add `acceptedPredictionTokens`.
- [ ] Add `rejectedPredictionTokens`.
- [ ] Add `cacheCreationInputTokens` where provided.
- [ ] Preserve the existing cached-input and cache-write fields.
- [ ] Read both the current `prompt_tokens_details` shape and compatible alternate field names.
- [ ] Add token totals to the report only after confirming the fields are present in real request documents.
- [ ] Keep unknown provider-specific details out of the persisted record unless there is a clear reporting need.
- [ ] Add fixtures covering OpenAI-style reasoning and cache data.

### Phase 5: Response-model normalization

Separate display names, pricing keys, and request/response model relationships.

Checklist:

- [ ] Add a helper equivalent to Copilot's request/response normalization behavior.
- [ ] Treat punctuation-only differences as equivalent for matching.
- [ ] Handle a response model that is a less-specific prefix of the request model.
- [ ] Avoid treating `gpt-4` as a prefix of `gpt-40`.
- [ ] Use the effective response model for pricing when it is known.
- [ ] Keep the original model strings in the JSONL record for troubleshooting.
- [ ] Add tests for reasoning suffixes, punctuation differences, genuinely different models, and missing response models.

### Phase 6: Session parent relationships

Improve assignment of child requests and subagent usage.

Checklist:

- [ ] Read optional `parentSessionId` and session `kind` from Copilot session metadata.
- [ ] Prefer explicit parent relationships over timing correlation.
- [ ] Retain the existing websocket and voice-progress logic as fallback behavior.
- [ ] Distinguish title/categorization requests from billable chat or agent requests.
- [ ] Record the parent chat/turn relationship without persisting prompt content.
- [ ] Add fixtures for top-level sessions, sub-sessions, forked sessions, and orphaned child requests.
- [ ] Verify that one child request cannot be assigned to multiple parent chats.

### Phase 7: Report improvements

Expose the new provenance and model information without making the report noisy.

Checklist:

- [ ] Show effective response model in recent activity when it differs from the requested model.
- [ ] Indicate `auto` requests where response-model metadata is available.
- [ ] Add a compact credit-source indicator or tooltip.
- [ ] Keep estimated and authoritative totals visually distinct.
- [ ] Add optional reasoning and cache-write token totals.
- [ ] Preserve existing chat, spend, token, and activity tabs.
- [ ] Escape all new values before inserting them into HTML templates.
- [ ] Verify long model names do not overflow the report layout.

### Phase 8: Documentation and migration

Checklist:

- [ ] Document the new metadata sources and their optional nature in `README.md`.
- [ ] Document the credit-source precedence.
- [ ] Document that Copilot request metadata may be unavailable depending on Copilot version and session state.
- [ ] Increment the usage schema ID only when the persisted shape changes.
- [ ] Make old schema records readable without a migration command.
- [ ] Decide whether reconciliation should rewrite old records with newly discovered metadata.
- [ ] Update the changelog with user-visible accuracy and reporting improvements.

## 5. Proposed Record Additions

The following fields are candidates for the next usage schema. All should be optional unless the existing parser already guarantees them:

```typescript
requestedModel?: string;
responseModel?: string;
isUsingAutoModel?: boolean;
creditsUsed?: number;
creditSource?: 'requestMetadata' | 'copilotUsage' | 'tokenEstimate' | 'unavailable';
reasoningTokens?: number | null;
acceptedPredictionTokens?: number | null;
rejectedPredictionTokens?: number | null;
cacheCreationInputTokens?: number | null;
parentSessionId?: string;
sessionKind?: 'forked' | 'sub-session';
```

The existing `model`, `aiCredits`, `costUsd`, `costKind`, and token fields should remain readable for old records. Avoid replacing them in one step; add the more precise fields and let reconciliation populate them when evidence exists.

## 6. Validation Plan

### Unit tests

- [ ] Parse request metadata files with complete and partial fields.
- [ ] Ignore malformed metadata files.
- [ ] Join metadata by VS Code request ID.
- [ ] Reject ambiguous fallback joins.
- [ ] Prefer response model over requested model for pricing.
- [ ] Preserve requested model when response model is missing.
- [ ] Prefer persisted credits over `total_nano_aiu`.
- [ ] Treat zero credits as authoritative.
- [ ] Fall back to token estimates when authoritative credits are absent.
- [ ] Parse reasoning, prediction, and cache-creation token details.
- [ ] Normalize model names correctly.
- [ ] Preserve old usage schemas.
- [ ] Reconcile a record after metadata becomes available.
- [ ] Assign subagent records to the correct parent session.

### Corpus and integration checks

- [ ] Add a sanitized fixture containing request metadata mappings.
- [ ] Run the existing recorded corpus tests unchanged.
- [ ] Verify no prompts, responses, tool arguments, or raw request documents are written to `.copilot`.
- [ ] Verify duplicate polling does not duplicate records.
- [ ] Verify log rotation and truncation still reset offsets correctly.
- [ ] Verify missing Copilot metadata does not prevent normal log collection.
- [ ] Verify report rendering with old records and new enriched records.

### Commands

```sh
npm test
npm run compile
```

Run the narrowest relevant test file first during implementation, then run the complete suite before packaging.

## 7. Explicitly Out of Scope

The following should not be implemented as direct integrations:

- Importing Copilot's private TypeScript services at runtime.
- Calling Copilot's private dependency-injection services from the companion extension.
- Depending on private OTel span stores or in-memory telemetry.
- Reading prompts, responses, tool arguments, or full raw request documents into the counter's persistent store.
- Treating internal Copilot implementation filenames as a stable public contract.
- Replacing the log parser entirely before a supported public usage API exists.

The bundled Copilot source is valuable as a reference for data modeling and field names, but the counter should consume only optional persisted artifacts and public VS Code surfaces.

## 8. Definition of Done

- [ ] Existing users can open reports containing old schema records.
- [ ] New records use authoritative persisted credits when available.
- [ ] Auto-model requests show the response model when Copilot has persisted it.
- [ ] Token reports include reasoning and cache-creation data when Copilot provides it.
- [ ] Missing or incompatible Copilot metadata falls back cleanly to current behavior.
- [ ] No private Copilot module is imported at runtime.
- [ ] No sensitive prompt or response content is newly persisted.
- [ ] Unit, corpus, compile, and full test checks pass.
- [ ] README and changelog describe the new behavior and its limitations.
