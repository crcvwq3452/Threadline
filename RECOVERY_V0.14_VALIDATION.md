# Threadline Recovery v0.14 — Validated Build

This branch is the validated recovery build for the lost-account ChatGPT archive work.

## Baseline

Applied directly on top of upstream PR #6 head:

`38385a345cb5675ad528330714adecdaadae98cc`

Validated branch commit:

`ca74dceaa5422f7898575242a91773cf63e1d63b`

## Validation completed

The recovery patch was applied to a pristine checkout in GitHub Actions and passed:

- `pnpm install --frozen-lockfile`
- `pnpm exec tsc --noEmit`
- Threadline unit suite: **258 / 258 passed**
- Recovery contracts/integration harness: **35 / 35 passed**
- `pnpm build` (Plasmo Chrome MV3)
- Chromium MV3 end-to-end import test
- ChatGPT ZIP import through the actual floating-panel UI
- preservation of both active and inactive assistant branches
- original message IDs and distinct path IDs preserved
- lexical search successfully recovered the inactive side-branch sentinel

The full validation workflow completed successfully more than once.

## Install the validated browser build

The GitHub Actions artifact is named:

`threadline-recovery-v0.14-chrome-mv3`

The inner ZIP contains the built Chrome MV3 extension.

To load manually in Chromium/Chrome:

1. Download and extract the artifact ZIP.
2. Extract the inner `threadline-recovery-v0.14-chrome-mv3.zip`.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted extension directory containing `manifest.json`.

## Important data rule

The imported/recovered representation is **derived**. Original ChatGPT JSON/ZIP exports remain canonical and should be retained unchanged.

Recovery graph authority is carried by raw provider/export graph metadata; DOM/live sync must not overwrite it.

## Current private-corpus status

The currently accessible real review export was revalidated on this recovery layer:

- 1,594 raw mapping nodes
- 59 physical stored records
- 21 reconstructed logical memories
- 11 user / 10 assistant logical messages
- 9 interrupted outcomes retained
- 22 source references
- 1 attachment
- max recovery chunk: 499 UTF-16 code units
- no malformed logical lanes detected

The larger 94-conversation archive remains private and was **not** uploaded to this public fork or GitHub Actions.


## Extended acceptance completed before user trial

Additional browser-level acceptance was completed after the initial validation.

### Import and persistence

- duplicate ChatGPT ZIP re-import is idempotent;
- direct ChatGPT JSON import works;
- long logical messages reconstruct exactly from <=500 UTF-16 chunks, including surrogate-pair boundaries;
- lexical search finds content inside reconstructed long messages;
- imported data and search survive closing/reopening the extension page.

A 94-conversation stress ZIP imported all 94 sessions and remained searchable after reopen.

### Full-scale archive parity

A synthetic archive was constructed to closely match the known lost-account archive:

- 94 separate JSON entries;
- ZIP size: **143,009,763 bytes**;
- uncompressed JSON payload: **658,114,022 bytes**.

This is intentionally close to the known real archive shape (~143 MB compressed / 662,221,597 bytes uncompressed).

Real Chromium import completed successfully in about **35.8 seconds**:

- 94 / 94 sessions present;
- 188 / 188 projected memories present;
- final conversation searchable;
- all 94 sessions still present after reopening the extension.

### Embeddings and semantic retrieval

The real built extension successfully initialized the Transformers.js embedding engine in Chromium:

- stored embedding dimension: **384**;
- first tested embedding became ready in roughly 2–4 seconds;
- semantic-only query `kitten napping on a couch` recovered a memory phrased as
  `A domestic feline is resting peacefully on a comfortable sofa near the window.`;
- tested semantic query latency was about 25–29 ms after model initialization.

### Recall and Current Authority

The actual Recall content script, results Shadow DOM, result selection, confirmation, and composer rewrite were exercised.

CI's logged-out ChatGPT page did not render a usable composer, so the final composer portion used the exact production DOM hooks targeted by the injector (`#prompt-textarea` plus the composer speech-container anchor). Threadline's real MutationObserver injected Recall into that DOM.

Assertions proved that the injected prompt contained:

- the selected historical evidence;
- the `CURRENT AUTHORITY` section;
- the `RETRIEVED HISTORICAL EVIDENCE` section;
- an active global Current Authority rule;
- an active session-scoped Current Authority rule;

and excluded a retired Current Authority rule.

### Raw graph authority against live DOM

A raw-export side branch was imported, then an adversarial `DOM_SYNC` was sent with intentionally incorrect:

- turn index;
- round index;
- branch index;
- branch ID;
- path ID;
- parent message ID.

The stored raw graph fields remained unchanged. Safe enrichment such as the live URL and conversation title was accepted.

### Backup durability

Browser-level roundtrip passed:

`import raw archive -> export Threadline backup -> clear all memories -> import backup -> search restored side branch`

Raw graph authority, branch identity, path identity and provenance survived the roundtrip.

### ChatGPT backend-history flow

The actual **Load all ChatGPT history** UI path was tested against intercepted realistic ChatGPT backend responses.

The test exercised:

- `/api/auth/session` access-token retrieval;
- authenticated `/backend-api/conversations` list request;
- authenticated per-conversation detail requests;
- multiple conversations;
- provider-graph side branches;
- background persistence;
- search after history sync.

All backend requests after token acquisition carried the expected Bearer token, both mocked conversations were stored under distinct sessions, the inactive provider side branch survived with `graphAuthority: provider_graph`, and it was searchable.

## What is still environmental rather than software-verified

No automated test can honestly establish these without the user's own authenticated browser/account:

1. that OpenAI's private ChatGPT backend endpoints/schema have not changed for the user's account at the moment of use;
2. that the user's current logged-in ChatGPT composer DOM exactly matches the production hooks tested here;
3. the exact contents of the private 94-chat ZIP, because its known Library object is currently blocked from raw-byte materialization in this chat.

Those are the remaining first-use/environment checks. They are not known software failures.

The real 94-chat corpus was never uploaded to GitHub or GitHub Actions.
