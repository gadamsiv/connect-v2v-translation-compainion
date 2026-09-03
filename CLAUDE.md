# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AWS sample project (MIT-0, explicitly **not production-ready**) that adds near-real-time bidirectional voice translation to Amazon Connect. An agent-facing webapp embeds the Connect CCP, takes over the WebRTC audio path via `connect-rtc-js`, and runs both audio directions through Amazon Transcribe → Translate → Polly entirely in the browser.

Two halves:

- `webapp/` — vanilla ESM JavaScript + Vite. No framework, no TypeScript, no test suite.
- `cdk-stacks/` — TypeScript CDK app (Cognito backend + S3/CloudFront frontend hosting). Also hosts the npm scripts that drive the whole repo.

`SETUP.md` is the deployment guide, `DEMO.md` documents the UI controls and the Transcribe partial-results-stability behaviour.

## This fork: companion panel

This checkout is a fork that repositions the webapp as a **companion panel** beside the Amazon Connect agent workspace rather than the agent's primary interface: call control happens in the workspace, the CCP panel here is collapsed, and the translation languages configure themselves from Contact Attributes on connect.

`README-Companion.md` documents the fork in full. `README.md`, `SETUP.md`, and `DEMO.md` are upstream docs — **do not edit them**. Fork-specific behaviour changes go in `README-Companion.md`, and it must be updated in the same change as the code, not afterwards.

`CHANGELOG.md` tracks every fork change (Keep a Changelog format, semver). The companion-panel work to date is `1.0.0`; new changes go in a fresh `[Unreleased]` section above it. Add the entry in the same commit as the change. It carries `Rejected` and `Known gaps` sections as well as the usual ones — record dead ends and unverified assumptions there, not just features.

### Closed questions — do not re-litigate

Three plausible-sounding changes have been investigated and rejected. Each has its reasoning and evidence in `README-Companion.md`; the short version:

- **Do not switch `initCCP()` to `connect.core.initSharedWorker()`.** That function is CCP-internal, hard-asserts Connect session tokens this app cannot obtain, and needs a same-origin `SharedWorker` URL. It throws on its first assert. The CCP iframe already runs the shared worker, so `initCCP()` is what preserves peer-connection ownership.
- **Do not package this as an Amazon Connect 3PA.** A 3PA panel is a separate document, and neither `RTCPeerConnection` (not structured-cloneable) nor `MediaStream` (not transferable between documents) can cross that boundary. The panel could never reach the workspace's audio. The standalone pop-out is the final architecture here, not a stopgap.
- **Do not remove the Cognito login.** The Cognito Identity Pool is the only source of the AWS credentials signing Transcribe/Translate/Polly. Removing it means enabling unauthenticated Identity Pool access, which would let anyone reaching the CloudFront URL spend AWS budget.

### Three services, three language code sets

The single most error-prone thing in this fork. The Transcribe, Translate, and Polly language selects are populated from three unrelated sources — Transcribe's `LanguageCode` enum (`main.js:732`), Translate's `ListLanguages` API (`main.js:938`), and Polly's `LanguageCode` enum (`main.js:1074`) — so a code from one is not valid in another. `constants.js` holds two conversion maps:

- `TRANSLATE_LANGUAGE_CODE_OVERRIDES` — Translate wants the region stripped (`es-ES` → `es`) except for variants it treats as distinct languages.
- `TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES` — six languages Polly supports under a different code (`zh-CN` → `cmn-CN`, `ar-SA` → `arb`, …).

Only **35 of Transcribe's 54** streaming languages are synthesizable by Polly. The other 19 are listed in `POLLY_UNSUPPORTED_LANGUAGE_NAMES` and produce a page-level banner, because that direction of the call gets no translated speech at all. If you touch the language plumbing, re-run the exhaustiveness check: the unsupported list must stay exactly `(Transcribe codes absent from Polly) − (overridden codes)`.

Also note the direction inversion, which reads backwards until you see why: the **Customer** column transcribes the customer and speaks *to the agent*, so its Polly language is the agent's — and vice versa. The Polly language in each column is the listener's, not the speaker's.

### Contact Attributes are untrusted input

Values from `contact.getAttributes()` originate in the contact flow. Never interpolate them into `innerHTML`; build DOM nodes with `textContent`, as `showLanguageWarnings()` does.

## Commands

Nearly everything is run from `cdk-stacks/`.

```bash
cd cdk-stacks
npm run install:all         # installs both cdk-stacks and webapp deps
npm run configure           # interactive; writes params to SSM under /AmazonConnectV2V/
npm run configure:help      # flag reference
npm run configure:test      # dry run: writes config.cache.json only, no SSM writes
npm run configure:delete    # removes all SSM params (post-destroy cleanup)
npm run build:webapp        # vite build into webapp/dist (prereq for deploy)
npm run cdk:deploy          # rm cdk.context.json, then cdk deploy --all --disable-rollback
npm run build:deploy:all    # build:webapp + cdk:deploy
npm run build               # tsc typecheck of the CDK code
npm test                    # jest — the only test file is entirely commented out
```

On Windows/Git BASH use the `:gitbash` variants (`build:webapp:gitbash`, `cdk:deploy:gitbash`, `build:deploy:all:gitbash`).

Local webapp development:

```bash
cd cdk-stacks && npm run sync-config   # downloads frontend-config.js from S3 into webapp/
cd ../webapp && npm run dev            # Vite on https://localhost:5173
```

`sync-config` is mandatory — `webapp/frontend-config.js` is generated at deploy time and gitignored, and `index.html` loads it before `main.js`. HTTPS is required (`vite-plugin-mkcert`) because of `getUserMedia` and the Connect CCP. `https://localhost:5173` must also be a Connect **Approved origin** and a Cognito callback/logout URL.

Teardown: `cdk destroy --all` then `npm run configure:delete`.

## Config plumbing

A single parameter flows through five places. Adding one means editing all of them:

1. `cdk-stacks/config/config.params.json` — declares name, CLI flag, default, `boolean` flag.
2. `configure.js` prompts for it and `PutParameter`s it under `/AmazonConnectV2V/<name>`.
3. `config/ssm-params-util.ts` `loadSSMParams()` reads every declared param via `ssm.StringParameter.valueFromLookup()` at synth time.
4. `cdk-backend-stack.ts` pushes selected values onto `backendStackOutputs`.
5. `frontend/frontend-config-stack.ts` renders that array into `window.WebappConfig = {...}` as `frontend-config.js`, written to S3 by a Python custom-resource Lambda; `webapp/config.js` reads `window.WebappConfig` (treating the sentinel string `"not-defined"` as `undefined`).

`valueFromLookup` results are cached in `cdk.context.json`, which is why `cdk:deploy` deletes it first. Reconfiguring without that deletion silently deploys stale values.

## Webapp architecture

### Taking over the audio path

`initCCP` is called with `softphone.allowFramedSoftphone: false`, then `connect.core.initSoftphoneManager({ allowFramedSoftphone: true })` is called from the host page — so this app, not the CCP iframe, owns the media session.

Both audio directions are obtained by reaching into **private** `connect-rtc-js` internals from `main.js`:

- `ConnectSoftPhoneManager.getSession(connectionId)._pc` → the `RTCPeerConnection`, handed to `SessionTrackManager`.
- `session._remoteAudioStream` → customer audio, wrapped in a `MicrophoneStream` for Transcribe.

These are unstable across `connect-rtc-js` / `amazon-connect-streams` upgrades; `webapp/lib/connect-rtc-1.1.26.min.js` is vendored and copied verbatim into `dist` by `viteStaticCopy`.

### Signal flow

Customer → agent: `_remoteAudioStream` → `startCustomerStreamTranscription` → `translateText` → `synthesizeSpeech` → `ToAgentAudioStreamManager.playAudioBuffer`.

Agent → customer: mic `MicrophoneStream` → `startAgentStreamTranscription` → `translateText` → `synthesizeSpeech` → `ToCustomerAudioStreamManager`, whose `MediaStreamDestination` track is swapped into the peer connection's audio sender by `SessionTrackManager.replaceTrack(track, TrackType.POLLY)`.

Agent and customer paths are deliberately parallel near-duplicates (separate Transcribe clients, two concurrent websockets from the agent's browser). Changes usually need applying to both sides.

### Managers (`webapp/managers/`)

- **`AudioContextManager`** — one shared `AudioContext`. Browsers start it suspended, so it resumes on the first user gesture and falls back to a modal "Click to Enable Audio" overlay. `getActualSampleRate()` deliberately opens and closes a throwaway `AudioContext`: the real rate changes when the agent switches audio devices, and Transcribe must be told the true rate.
- **`AudioStreamManager`** — wraps one `<audio>` element + `MediaStreamDestination`. Queues decoded Polly buffers for gapless sequential playback, with per-item gain. "Audio feedback" is a looping background-noise/white-noise source started whenever the queue empties, so the far end doesn't hear dead silence between utterances. `ToCustomerAudioStreamManager` also mixes in the live mic through a gain node.
- **`SessionTrackManager`** — creates and swaps peer-connection audio tracks (`TrackType` = `FILE` | `MIC` | `POLLY` | `SILENT`). "Removing" audio streams a silent track rather than removing the sender.
- **`InputTestManager`** — mic level meter for the device-test UI.

### Adapters (`webapp/adapters/`)

Each adapter memoizes one AWS SDK v3 client in a module-level `_amazonXClient` and re-creates it when `hasValidAwsCredentials()` goes false. Transcribe keeps two clients (agent + customer) so the two streams don't share one.

Language and engine lists come from SDK enums (`Object.values(LanguageCode)`, `Object.values(Engine)`), not hardcoded arrays — the old `TRANSCRIBE_STREAMING_LANGUAGES` / `POLLY_LANGUAGE_CODES` constants were removed.

**CORS proxying:** Polly and Translate calls get an SDK middleware injected at the `finalizeRequest` step — i.e. *after* SigV4 signing — that rewrites `hostname` to the CloudFront domain and prefixes the path with `/amazon-polly-proxy` or `/amazon-translate-proxy`. `cdk-frontend-stack.ts` adds matching CloudFront behaviours with an `HttpOrigin` to the real service endpoint, a CloudFront Function that strips the prefix, and an origin request policy that denylists `host` so the signature survives. The middleware is skipped when `isDevEnvironment()` (Vite dev server). Transcribe is never proxied — it's a websocket.

### Auth (`webapp/utils/authUtility.js`)

Hand-rolled, no Amplify: OAuth2 authorization-code flow against the Cognito hosted UI, tokens and derived AWS credentials in `localStorage` (a documented limitation — XSS-exposed), a `setTimeout` refresh timer firing 4 minutes before expiry, and a 15-minute safety buffer in `hasValidAwsCredentials()`.

Note `getCognitoIdentityCredentials()` uses a global `AWS.CognitoIdentity` with v2-style `.promise()` calls, unlike every other AWS call in the app, which uses v3 clients.

### UI

All markup lives in `webapp/index.html`. `main.js` collects every element by id into `CCP_V2V.UI` in `bindUIElements()` and wires handlers in `initEventListeners()`. Each setting has an explicit **Save** button that writes to `localStorage` under a well-known key, re-read on load by the `load*` functions. So adding a control means touching `index.html`, `bindUIElements`, `initEventListeners`, and usually a `load*` function.

`main.js` is a single ~1300-line module of module-level `let` state; there is no state container.

## IAM

Browser-side AWS permissions all come from the Cognito Identity Pool authenticated role in `cdk-stacks/lib/infrastructure/cognito-stack.ts`. Any new AWS API the webapp calls needs its action added to that policy statement.

## Conventions

- Prettier-style formatting, ~160 char lines, double quotes, semicolons. No linter is configured.
- Every `console.*` call is prefixed with `LOGGER_PREFIX` (`"CCP-V2V"`) and the function name.
- Public functions start with guard clauses using the `isStringUndefinedNullEmpty` / `isObjectUndefinedNullEmpty` / `isFunction` helpers from `utils/commonUtility.js`.
- User-facing errors go through `raiseError()` in `main.js`, which is an `alert()`.
- Prefer `== null` / `!= null` for nullish checks, matching existing code.
