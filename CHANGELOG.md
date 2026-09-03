# Changelog

Changes made in this fork of the Amazon Connect V2V sample, which repositions the webapp as a **companion panel** beside the Amazon Connect agent workspace. See `README-Companion.md` for the full design notes.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Upstream fork point: `382803a`.

## [Unreleased]

### Fixed

- **A failed `DescribeVoices` during a live call no longer blocks the agent or breaks synthesis.** `1.0.0` made `loadCustomerPollyVoiceIds()` / `loadAgentPollyVoiceIds()` run automatically on contact connect; previously they only ran on page load and on manual select changes. Their error path called `raiseError()` — an `alert()`, which blocks the main thread until dismissed, freezing transcription handling and translate calls mid-call — and then emptied the voice select, leaving Amazon Polly with no `VoiceId` so that direction's synthesis stayed broken for the rest of the call. Both functions now take `{ suppressAlert }`, return a success boolean, and leave the existing options in place on failure. The auto-config path passes `suppressAlert: true` and reports the failure as a banner line instead.

### Changed

- Language warnings now render before the Amazon Polly voice reload is awaited, so the "Polly cannot synthesize X" message is not delayed by a network call. The banner re-renders only if a voice reload subsequently fails.

## [1.0.0] - 2026-09-03

First cut of the companion-panel fork. Feature-complete against the original change list, but **not yet validated against a live Amazon Connect instance** — see Known gaps.

### Added

- **Sample contact flow** — `samples/contact-flows/V2V-Companion-Language-Select.json`. Collects the customer's language by DTMF and sets the `v2v*` Contact Attributes the companion app reads on connect. Includes a Mandarin branch (exercises the Polly code override) and a Thai branch (exercises the unsupported-language banner). The target queue ARN is a placeholder that must be replaced. **Not yet validated against a live Amazon Connect instance** — structure is verified (no dangling transitions, all actions reachable) but import has not been tested.
- **Amazon Polly language coverage warnings** — `TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES` and `POLLY_UNSUPPORTED_LANGUAGE_NAMES` in `webapp/constants.js`, plus a page-level `#languageWarningBanner`. When Amazon Polly cannot synthesize the detected language, the agent is told which language, that the far end will hear the original voice only, and what Polly is currently set to instead.
- **Language auto-configuration from Contact Attributes** — `autoConfigureLanguagesFromContact()` runs on `onContactConnected` and sets all eight language selects plus optional Polly voices from `v2vCustomerLanguage` / `v2vAgentLanguage` / `v2vCustomerVoiceId` / `v2vAgentVoiceId`, falling back to `LanguageCode` for the customer language. Agents no longer set From/To languages by hand on every contact.
- **CCP panel Show/Hide toggle** — the panel is collapsed by default, state persisted to `localStorage` under `ccpPanelVisible`.
- `CLAUDE.md` — repo commands, architecture overview, and the fork's closed architecture questions.
- `README-Companion.md` — fork-specific documentation, kept deliberately separate from the upstream `README.md` / `SETUP.md` / `DEMO.md`, which are unmodified.
- This changelog.

### Changed

- `setSelectValueIfAvailable()` returns a status (`applied` / `unavailable` / `locked` / `skipped`) rather than a boolean, so "Amazon Polly has no such language" is distinguishable from "control is locked mid-transcription". The two produce different agent-facing guidance.
- The CCP panel collapses via `height: 0`, **not** `display: none` — the iframe must stay rendered because it owns the softphone session and the `RTCPeerConnection` this app swaps Polly audio tracks into.

### Fixed

- **Amazon Transcribe language codes were passed unmapped to the Amazon Polly select.** The two services do not share a code set: 25 of Transcribe's 54 streaming codes have no identical Polly code. The select had no matching option, so the value silently stayed at `en-US` with only a console warning — a Mandarin customer would have heard the agent in English while the transcript looked correct. Six codes are now mapped (`zh-CN`→`cmn-CN`, `zh-HK`→`yue-CN`, `ar-SA`→`arb`, `no-NO`→`nb-NO`, `en-WL`→`en-GB-WLS`, `en-AB`→`en-GB`), taking synthesizable languages from 29 to 35 of 54. The remaining 19 raise the banner.

### Security

- The language warning banner is built with `createElement` / `textContent`, never `innerHTML`. Its messages embed Contact Attribute values, which originate in the contact flow and must not be parsed as markup.

### Rejected

Investigated and deliberately not done. Reasoning and evidence in `README-Companion.md`; recorded here so they are not reopened.

- **Switching `initCCP()` to `connect.core.initSharedWorker()`** — that function is CCP-internal, hard-asserts Connect session tokens this app cannot obtain, and needs a same-origin `SharedWorker` URL. It throws on its first assert.
- **Packaging as an Amazon Connect 3PA** — a 3PA panel is a separate document, and neither `RTCPeerConnection` (not structured-cloneable) nor `MediaStream` (not transferable between documents) can cross that boundary, so the panel could never reach the workspace's audio. The standalone pop-out is the final architecture, not a stopgap. A 3PA-shell-plus-pop-out hybrid would work but buys UX polish only.
- **Removing the Cognito login** — the Cognito Identity Pool is the only source of the AWS credentials signing Transcribe/Translate/Polly. Removing it would mean enabling unauthenticated Identity Pool access, letting anyone who reaches the CloudFront URL spend AWS budget. Agents log in twice for now.

### Known gaps

- `contact.getAttributes()` is assumed to return the documented `{ name, value }` envelope per attribute. `Contact.prototype.getAttributes` returns `this._getData().attributes` raw, so this could not be confirmed statically and **has never been executed against a live contact**.
- Only 35 of Amazon Transcribe's 54 streaming languages can be synthesized by Amazon Polly. This is a service limitation, surfaced rather than solved.
- Upstream caveats unchanged: tokens and derived AWS credentials in `localStorage`, and dependence on private `connect-rtc-js` internals (`getSession(connectionId)._pc`, `session._remoteAudioStream`) that can break on any dependency upgrade.

---

Commits, newest first:

| Commit | Date | Summary |
| --- | --- | --- |
| `434f929` | 2026-09-03 | Add sample contact flow and CHANGELOG |
| `2afe7ec` | 2026-09-03 | Record fork architecture decisions in CLAUDE.md |
| `5072f49` | 2026-09-03 | Map Transcribe language codes to Polly, warn when unsupported |
| `3d63d19` | 2026-09-03 | Reposition webapp as an agent-workspace companion panel |
| `216f3b4` | 2026-09-03 | Add CLAUDE.md with repo commands and architecture overview |
