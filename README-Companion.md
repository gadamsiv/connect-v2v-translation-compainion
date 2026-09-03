# README-Companion

Fork-specific notes for the **Pop-Out Companion Panel** variant of the Amazon Connect V2V sample.

`README.md`, `SETUP.md`, and `DEMO.md` are the upstream docs and are intentionally left unmodified — deploy and configure using those. This file covers only what this fork changes and how to drive it.

Branch: `develop`.

## What this fork is for

Upstream, this webapp is the agent's *primary* interface: the agent logs into it, works the embedded CCP, and sets the translation languages by hand for every contact.

This fork repositions it as a **companion panel** that sits alongside the Amazon Connect agent workspace:

- Call control (accept, hold, transfer, end) happens in the agent workspace, not here.
- The CCP panel in this app is collapsed and out of the way.
- Translation languages configure themselves from Contact Attributes when the call connects.

Everything that makes the sample valuable is untouched: the WebRTC media-stream takeover, the Amazon Transcribe / Translate / Polly pipeline, and the audio streaming managers all behave exactly as upstream.

## Changes in this fork

### 1. CCP panel collapsed by default (`webapp/index.html`, `webapp/style.css`, `webapp/main.js`)

`#ccpSection` starts with the `ccp-collapsed` class and carries a **Show / Hide** button. The state is persisted to `localStorage` under `ccpPanelVisible`, so an agent who opens the panel for troubleshooting keeps it open across reloads.

Collapse is `height: 0`, **not** `display: none`. The iframe must remain rendered: it owns the softphone session and the `RTCPeerConnection` this app swaps Amazon Polly audio tracks into. Hiding it with `display: none` risks the browser tearing down media in the iframe.

### 2. `initCCP()` retained (not `initSharedWorker()`)

The original plan was to replace `initCCP()` with `connect.core.initSharedWorker()` to attach to the workspace's existing CCP session. **That is not implementable from this app**, and the code was left on `initCCP()` deliberately. Evidence from `webapp/node_modules/amazon-connect-streams/release/connect-streams.js`:

| Line | Finding |
| --- | --- |
| `:9976` | `initSharedWorker` is documented *"Used only by the CCP"* |
| `:9982-9986` | Hard-asserts `sharedWorkerUrl`, `authToken`, `refreshToken`, `authTokenExpiration`, `region` |
| `:10004` | `new SharedWorker(sharedWorkerUrl, "ConnectSharedWorker")` |

A `SharedWorker` URL must be same-origin, so a CloudFront-hosted page cannot load Amazon Connect's worker script, and this app has no way to obtain Connect session tokens to satisfy the asserts. The call would throw on its first assert.

It is also unnecessary. `initCCP()` creates the CCP iframe on the Amazon Connect origin, and *that iframe* runs the shared worker — which is already the cross-window session-sharing mechanism. There is no duplicate softphone to eliminate. Keeping `initCCP()` is precisely what preserves this app's ownership of the peer connection.

### 3. Language auto-configuration from Contact Attributes (`webapp/main.js`, `webapp/constants.js`)

`autoConfigureLanguagesFromContact(contact)` runs from `onContactConnected` and reads `contact.getAttributes()`. See [Contact Attributes](#contact-attributes) below.

## Contact Attributes

Set these in the contact flow (a **Set contact attributes** block, or a Lambda) before the call reaches the agent. Attribute names are declared in `CONTACT_ATTRIBUTE_NAMES` in `webapp/constants.js`.

| Attribute | Required | Value | Notes |
| --- | --- | --- | --- |
| `v2vCustomerLanguage` | yes | Amazon Transcribe language code, e.g. `es-ES` | Falls back to `LanguageCode` if absent |
| `LanguageCode` | — | as above | Fallback name, for flows that already set it |
| `v2vAgentLanguage` | no | e.g. `en-US` | Defaults to whatever the agent already has selected |
| `v2vCustomerVoiceId` | no | Amazon Polly `VoiceId`, e.g. `Joanna` | Voice the **agent** hears |
| `v2vAgentVoiceId` | no | e.g. `Lupe` | Voice the **customer** hears |

If no customer-language attribute is present, nothing is changed and the agent's saved selections stand.

### How the languages map

This is the part that trips people up. The **Customer** column transcribes the customer and speaks the translation *to the agent*; the **Agent** column transcribes the agent and speaks the translation *to the customer*. So the Amazon Polly language in each column is the **listener's** language, not the speaker's.

Given customer language `CL` and agent language `AL`:

| UI control | Value |
| --- | --- |
| Customer → Transcribe language | `CL` |
| Customer → Translate from | `tr(CL)` |
| Customer → Translate to | `tr(AL)` |
| Customer → Amazon Polly language | `po(AL)` |
| Agent → Transcribe language | `AL` |
| Agent → Translate from | `tr(AL)` |
| Agent → Translate to | `tr(CL)` |
| Agent → Amazon Polly language | `po(CL)` |

Each of the three services has its own language code set, and the three selects are populated from three different sources — Transcribe's `LanguageCode` enum (`main.js:732`), Amazon Translate's `ListLanguages` API (`main.js:938`), and Polly's `LanguageCode` enum (`main.js:1074`). Two conversions are therefore needed:

`tr()` → Amazon Translate. Strip the region (`es-ES` → `es`), except for the variants Amazon Translate treats as distinct languages, listed in `TRANSLATE_LANGUAGE_CODE_OVERRIDES` (`zh-TW`, `pt-PT`, `fr-CA`, `es-MX`), which pass through unchanged.

`po()` → Amazon Polly. Pass the Transcribe code through unchanged unless it appears in `TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES`.

### Amazon Polly language coverage

**Only 35 of Amazon Transcribe's 54 streaming languages can be synthesized by Amazon Polly.** This is a hard service limitation, not a bug in this fork.

25 Transcribe codes have no identical Polly code. Six of those Polly supports under a different code, and `TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES` maps them:

| Transcribe | Amazon Polly | |
| --- | --- | --- |
| `zh-CN` | `cmn-CN` | Mandarin |
| `zh-HK` | `yue-CN` | Cantonese |
| `ar-SA` | `arb` | Modern Standard Arabic |
| `no-NO` | `nb-NO` | Norwegian Bokmål |
| `en-WL` | `en-GB-WLS` | Welsh English |
| `en-AB` | `en-GB` | Scottish English — no distinct Polly voice |

The remaining 19 Amazon Polly cannot speak at all, listed in `POLLY_UNSUPPORTED_LANGUAGE_NAMES`: Afrikaans, Greek, Basque, Farsi, Galician, Hebrew, Croatian, Indonesian, Latvian, Malay, Slovak, Somali, Serbian, Thai, Tagalog, Ukrainian, Vietnamese, Mandarin (Taiwan), Zulu.

For those, **that direction of the call gets no translated speech** — the far end hears only the original, untranslated voice. Transcription and translation still work, so the text still appears in the transcript; only the synthesized audio is missing.

Because that changes what the agent must do on the call, it surfaces as a **page-level amber banner** above the columns (`#languageWarningBanner`), not just a console message. Example wording for a Thai customer:

> **Translation is limited on this call**
> Amazon Polly cannot synthesize Thai (th-TH). The customer will hear the original voice only, with no translated speech. Amazon Polly is still set to en-US — change it manually if a different language is closer.

The banner clears on the next contact and in `cleanUpUI()` when the contact ends. The agent-direction warning is listed first, since that is the one the customer experiences. `Mandarin (Taiwan)` is worth knowing about specifically: `zh-TW` is unmapped, but `cmn-CN` is a usable manual substitute if you accept mainland-accented Mandarin.

### Safety behaviour

- A value is applied only if the `<select>` actually offers it. An unrecognised attribute logs a warning and leaves the agent's saved preference in place rather than blanking the control.
- Controls locked mid-transcription are skipped, and that also raises a banner warning telling the agent to stop transcription first.
- Amazon Polly voice lists are reloaded for the new language/engine *before* the optional `VoiceId` overrides are applied.
- The banner is built with `createElement` / `textContent`, never `innerHTML`. The strings embed Contact Attribute values, which originate in the contact flow and must not be parsed as markup.
- The whole function is wrapped in `try`/`catch`. Auto-configuration can never block or fail a call — worst case the agent sets the languages by hand, as upstream.

Watch the browser console for `CCP-V2V - autoConfigureLanguages - ...` lines to see what was detected and applied.

## Using the companion panel

Deploy per `SETUP.md` first. Then:

1. Open the Amazon Connect agent workspace and go available there.
2. Open this app in a second window or tab (the CloudFront URL, or `https://localhost:5173` for local dev). Log in when Cognito prompts — see [Open item](#open-item-cognito-login) below.
3. Click anywhere in the page once if the "Click to Enable Audio" overlay appears. Browsers start an `AudioContext` suspended and it needs a user gesture.
4. Select speaker and microphone under **Audio Controls** and **Save**. These persist to `localStorage`.
5. Accept the call **in the agent workspace**.
6. On connect, the language and voice selects populate from Contact Attributes, and the **Start Transcription** buttons enable.
7. Click **Start Transcription** in both the Customer and Agent columns. Both directions are independent — starting only one gives you one-way translation.

The CCP panel stays collapsed. Click **Show** only when troubleshooting; it is the same CCP as upstream and will reflect call state.

### Local development

Unchanged from upstream, but repeated here because it is easy to miss:

```bash
cd cdk-stacks && npm run sync-config   # downloads frontend-config.js from S3 into webapp/
cd ../webapp && npm run dev            # Vite on https://localhost:5173
```

`sync-config` is mandatory — `webapp/frontend-config.js` is generated at deploy time and gitignored. `https://localhost:5173` must be an Amazon Connect **Approved origin** and a Cognito callback/logout URL.

To verify a build after changing webapp code:

```bash
cd webapp && npx vite build
```

Two pre-existing warnings are expected and harmless: the non-module `<script>` tags in `index.html`, and `styles.css doesn't exist at build time` (`index.html` has a dead `styles.css` link; the real stylesheet is `style.css`, bundled via the `import "./style.css"` in `main.js`).

## Decided: Cognito login stays

**Agents log in twice** — once to the agent workspace, once to this app's Cognito hosted UI. Removing the second login was originally in scope for this fork. It is **deliberately not done**, and the Cognito auth in `webapp/utils/authUtility.js` is unchanged from upstream.

The reason: the Cognito Identity Pool is the only source of the AWS credentials that sign the Amazon Transcribe, Translate, and Polly calls. Stripping the login without replacing that credential source breaks the entire translation pipeline.

The two alternatives, both rejected for now:

- **Unauthenticated Identity Pool** — set `allowUnauthenticatedIdentities: true` in `cdk-stacks/lib/infrastructure/cognito-stack.ts` and grant the unauthenticated role the Transcribe/Translate/Polly actions. This genuinely removes the login, but **anyone who can reach the CloudFront URL could then consume your AWS budget.** Not acceptable even for a demo on a shared account.
- **Federate the workspace SSO/SAML identity into the Identity Pool** — the correct long-term answer if this ever moves past POC, and the most work. Revisit here if single sign-on becomes a requirement.

Practical consequence: the agent must have this app open and logged in *before* taking a call, and the login must be re-done when the Cognito session expires. `hasValidAwsCredentials()` keeps a 15-minute safety buffer and the refresh timer fires 4 minutes before expiry, so a mid-call expiry is unlikely but not impossible on very long calls.

## Ruled out: packaging as a 3PA (third-party app)

Embedding this app as an Amazon Connect 3PA panel inside the agent workspace **cannot work**, and the reason is a browser limit rather than a Connect configuration gap. Do not spend time on it.

This app owns the media session itself. `initCCP()` is called with `softphone.allowFramedSoftphone: false` (`webapp/main.js:434`) and then `connect.core.initSoftphoneManager({ allowFramedSoftphone: true })` is called from the host page (`webapp/main.js:457`). That combination makes *this page's* JS context create the `RTCPeerConnection`. Everything downstream is a live object reference in that same context:

- `webapp/main.js:545` — `session._pc`, the `RTCPeerConnection` handed to `SessionTrackManager`
- `webapp/main.js:784` — `session._remoteAudioStream`, the customer's inbound `MediaStream`

As a 3PA, the **workspace** owns the softphone and the panel is a separate document. Neither object can cross that boundary:

- `RTCPeerConnection` is not structured-cloneable, so it cannot be `postMessage`'d at all.
- `MediaStream` / `MediaStreamTrack` are not transferable between documents. Chrome's transferable `MediaStreamTrack` (Breakout Box) targets a dedicated worker, not another browsing context.

So a 3PA panel has no way to reach the workspace's audio sender to call `replaceTrack()` on, and no way to read the customer's inbound stream. No Permissions Policy grant, Connect feature flag, or SDK upgrade changes this.

Two secondary blockers, for completeness:

- `getUserMedia` in a cross-origin iframe requires `allow="microphone"` on the iframe element, which the workspace controls, not this app. Whether Connect's 3PA iframe sets it is **unverified** — it is moot given the blocker above.
- Calling `initCCP()` *inside* the 3PA panel does not rescue it: that creates a second softphone session for the same agent, and Connect's shared worker arbitrates a single active media session, so the second one gets no media. It also nests the CCP iframe inside the 3PA iframe, requiring microphone delegation through both. This is the same duplicate-softphone problem described in [§2](#2-initccp-retained-not-initsharedworker), reached from the other direction.

### The one design that would work

If in-workspace UX becomes a requirement, split the app in two:

- **3PA tab** — transcript display and language controls only. No CCP, no audio.
- **Pop-out window** — a top-level browsing context that keeps `initCCP()`, the softphone manager, and the whole audio pipeline exactly as it is today.

Both are served from the same CloudFront origin, so they are same-origin and can communicate over `BroadcastChannel` regardless of framing. The 3PA tab becomes a launcher and a viewport; the pop-out remains the thing that owns audio.

This is real work and buys UX polish only — the current standalone pop-out already delivers the function. Not worth it at POC stage.

## Not addressed

- The upstream security caveats still apply in full: tokens and derived AWS credentials live in `localStorage`, and the app depends on private `connect-rtc-js` internals (`getSession(connectionId)._pc`, `session._remoteAudioStream`) that can break on any dependency upgrade. This remains an AWS sample, MIT-0, **not production-ready**.
