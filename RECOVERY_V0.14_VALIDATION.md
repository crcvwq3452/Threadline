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
