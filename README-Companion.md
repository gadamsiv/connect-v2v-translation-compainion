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
| Customer → Amazon Polly language | `AL` |
| Agent → Transcribe language | `AL` |
| Agent → Translate from | `tr(AL)` |
| Agent → Translate to | `tr(CL)` |
| Agent → Amazon Polly language | `CL` |

`tr()` converts a Transcribe code to an Amazon Translate code: strip the region (`es-ES` → `es`), except for the variants Amazon Translate treats as distinct languages, listed in `TRANSLATE_LANGUAGE_CODE_OVERRIDES` (`zh-TW`, `pt-PT`, `fr-CA`, `es-MX`), which pass through unchanged.

### Safety behaviour

- A value is applied only if the `<select>` actually offers it. An unrecognised attribute logs a warning and leaves the agent's saved preference in place rather than blanking the control.
- Controls locked mid-transcription are skipped with a warning.
- Amazon Polly voice lists are reloaded for the new language/engine *before* the optional `VoiceId` overrides are applied.
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

## Open item: Cognito login

**Agents currently log in twice** — once to the agent workspace, once to this app's Cognito hosted UI. Removing the second login was in scope for this fork but is **not done**, because the Cognito Identity Pool is the only source of the AWS credentials that sign the Amazon Transcribe, Translate, and Polly calls. Stripping the login without replacing that credential source breaks the entire translation pipeline.

Three ways forward, none yet chosen:

- **Unauthenticated Identity Pool** — set `allowUnauthenticatedIdentities: true` in `cdk-stacks/lib/infrastructure/cognito-stack.ts` and grant the unauthenticated role the Transcribe/Translate/Polly actions. This genuinely removes the login, but **anyone who can reach the CloudFront URL can then consume your AWS budget.** Not appropriate beyond a closed demo.
- **Keep the Cognito login** — the current state. Two logins, no security change. Fine for a POC.
- **Federate the workspace SSO/SAML identity into the Identity Pool** — the correct long-term answer, and the most work.

## Not addressed

- **Deployment packaging** as a true Amazon Connect 3PA / third-party app. This fork is still a standalone hosted page opened next to the workspace, not an app registered with Amazon Connect.
- The upstream security caveats still apply in full: tokens and derived AWS credentials live in `localStorage`, and the app depends on private `connect-rtc-js` internals (`getSession(connectionId)._pc`, `session._remoteAudioStream`) that can break on any dependency upgrade. This remains an AWS sample, MIT-0, **not production-ready**.
