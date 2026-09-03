// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import "./style.css";
import "amazon-connect-streams";

import MicrophoneStream from "microphone-stream";

import { getConnectURLS, addUpdateLocalStorageKey, getLocalStorageValueByKey, base64ToArrayBuffer, isStringUndefinedNullEmpty } from "./utils/commonUtility";
import {
  AGENT_TRANSLATION_TO_AGENT_VOLUME,
  AUDIO_FEEDBACK_FILE_PATH,
  CONTACT_ATTRIBUTE_NAMES,
  CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME,
  LOGGER_PREFIX,
  POLLY_UNSUPPORTED_LANGUAGE_NAMES,
  TRANSCRIBE_PARTIAL_RESULTS_STABILITY,
  TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES,
  TRANSLATE_LANGUAGE_CODE_OVERRIDES,
} from "./constants";
import { getLoginUrl, getValidTokens, handleRedirect, isAuthenticated, logout, setRedirectURI, startTokenRefreshTimer } from "./utils/authUtility";
import { AudioStreamManager } from "./managers/AudioStreamManager";
import { SessionTrackManager, TrackType } from "./managers/SessionTrackManager";
import { createMicrophoneStream } from "./utils/transcribeUtils";
import { listTranslateLanguages, translateText } from "./adapters/translateAdapter";
import { describeVoices, listPollyEngines, listPollyLanguages, synthesizeSpeech } from "./adapters/pollyAdapter";
import { listStreamingLanguages, startAgentStreamTranscription, startCustomerStreamTranscription } from "./adapters/transcribeAdapter";
import { CONNECT_CONFIG } from "./config";
import { AudioContextManager } from "./managers/AudioContextManager";
import { AudioInputTestManager } from "./managers/InputTestManager";

let connect = {};
let CurrentUser = {};
let CCP_V2V = {};

let CurrentAgentConnectionId;
let ConnectSoftPhoneManager;
let IsAgentTranscriptionMuted = false;

// AudioContextManager to manage the AudioContext
let AudioContextMgr = new AudioContextManager();

// AgentMicTestManager to test agent's mic
let AgentMicTestManager;

//Agent Mic Stream used as input for Amazon Transcribe when transcribing agent's voice
let AmazonTranscribeToCustomerAudioStream;
//Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
let AmazonTranscribeFromCustomerAudioStream;

// SessionTrackManager to manage the current track streaming to the customer
let RTCSessionTrackManager;

// AudioStreamManager to manage the stream that goes to Customer
let ToCustomerAudioStreamManager;

// AudioStreamManager to manage the stream that goes to Agent
let ToAgentAudioStreamManager;

async function getAudioContext() {
  if (AudioContextMgr == null) {
    AudioContextMgr = new AudioContextManager();
  }
  const audioContext = await AudioContextMgr.getAudioContext();
  return audioContext;
}

async function getAgentMicTestManager() {
  if (AgentMicTestManager == null) {
    AgentMicTestManager = new AudioInputTestManager(await getAudioContext());
  }
  return AgentMicTestManager;
}

async function replaceRTCSessionTrackManager(peerConnection) {
  if (RTCSessionTrackManager != null) {
    await RTCSessionTrackManager.dispose();
  }
  RTCSessionTrackManager = new SessionTrackManager(peerConnection, await getAudioContext());
}

async function replaceToCustomerAudioStreamManager() {
  if (ToCustomerAudioStreamManager != null) {
    await ToCustomerAudioStreamManager.dispose();
  }
  ToCustomerAudioStreamManager = new AudioStreamManager(CCP_V2V.UI.toCustomerAudioElement, await getAudioContext());
}

async function replaceToAgentAudioStreamManager() {
  if (ToAgentAudioStreamManager != null) {
    await ToAgentAudioStreamManager.dispose();
  }
  ToAgentAudioStreamManager = new AudioStreamManager(CCP_V2V.UI.toAgentAudioElement, await getAudioContext());
}

window.addEventListener("load", () => {
  initializeApp();
});

async function initializeApp() {
  try {
    console.info(`${LOGGER_PREFIX} - initializeApp - Initializing app`);
    setRedirectURI();
    // Check if we're returning from Cognito login
    const isRedirect = await handleRedirect();
    if (isRedirect) {
      console.info(`${LOGGER_PREFIX} - initializeApp - Redirected from Cognito login`);
      startTokenRefreshTimer();
      showApp();
      return;
    }

    // Check authentication and token expiration
    if (!isAuthenticated()) {
      const tokens = await getValidTokens();
      if (tokens?.accessToken == null || tokens?.idToken == null || tokens?.refreshToken == null) {
        // No valid token available, redirect to login
        console.info(`${LOGGER_PREFIX} - initializeApp - No valid token available, redirecting to login`);
        window.location.href = getLoginUrl();
        return;
      }
    }

    // Show app with valid token
    console.info(`${LOGGER_PREFIX} - initializeApp - Valid token available, showing app`);
    startTokenRefreshTimer();
    showApp();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeApp - Error initializing app:`, error);
    window.location.href = getLoginUrl();
  }
}

function showApp() {
  onLoad();
}

const onLoad = async () => {
  console.info(`${LOGGER_PREFIX} - index loaded`);
  bindUIElements();
  initEventListeners();
  CCP_V2V.UI.logoutButton.style.display = "block";
  restoreCCPPanelVisibility();
  getDevices();
  setAudioElementsSinkIds();
  loadTranscribeLanguageCodes();
  loadTranscribePartialResultsStability();
  loadTranslateLanguageCodes();
  loadPollyEngines();
  loadPollyLanguageCodes();
  loadCustomerPollyVoiceIds().then(() => loadAgentPollyVoiceIds());
  initCCP(onConnectInitialized);
};

const bindUIElements = () => {
  window.connect.CCP_V2V = CCP_V2V;

  CCP_V2V.UI = {
    logoutButton: document.getElementById("logoutButton"),
    divInstanceSetup: document.getElementById("divInstanceSetup"),
    divMain: document.getElementById("divMain"),

    ccpContainer: document.querySelector("#ccpContainer"),
    ccpSection: document.getElementById("ccpSection"),
    ccpToggleButton: document.getElementById("ccpToggleButton"),
    languageWarningBanner: document.getElementById("languageWarningBanner"),

    spnCurrentConnectInstanceURL: document.getElementById("spnCurrentConnectInstanceURL"),
    tbConnectInstanceURL: document.getElementById("tbConnectInstanceURL"),
    btnSetConnectInstanceURL: document.getElementById("btnSetConnectInstanceURL"),
    btnStreamFile: document.getElementById("btnStreamFile"),
    btnStreamMic: document.getElementById("btnStreamMic"),
    btnRemoveAudioStream: document.getElementById("btnRemoveAudioStream"),

    //mic & speaker UI elements
    micSelect: document.getElementById("micSelect"),
    speakerSelect: document.getElementById("speakerSelect"),

    fromCustomerAudioElement: document.getElementById("remote-audio"),
    toCustomerAudioElement: document.getElementById("toCustomerAudioElement"),
    toAgentAudioElement: document.getElementById("toAgentAudioElement"),

    testAudioButton: document.getElementById("testAudioButton"),
    testMicButton: document.getElementById("testMicButton"),
    speakerSaveButton: document.getElementById("speakerSaveButton"),
    micSaveButton: document.getElementById("micSaveButton"),

    echoCancellationCheckbox: document.getElementById("echoCancellationCheckbox"),
    noiseSuppressionCheckbox: document.getElementById("noiseSuppressionCheckbox"),
    autoGainControlCheckbox: document.getElementById("autoGainControlCheckbox"),

    //Transcribe Customer UI Elements
    customerTranscribeLanguageSelect: document.getElementById("customerTranscribeLanguageSelect"),
    customerTranscribeLanguageSaveButton: document.getElementById("customerTranscribeLanguageSaveButton"),
    customerTranscribePartialResultsStabilitySelect: document.getElementById("customerTranscribePartialResultsStabilitySelect"),
    customerTranscribePartialResultsStabilitySaveButton: document.getElementById("customerTranscribePartialResultsStabilitySaveButton"),
    customerStartTranscriptionButton: document.getElementById("customerStartTranscriptionButton"),
    customerStopTranscriptionButton: document.getElementById("customerStopTranscriptionButton"),
    customerTranscriptionTextOutputDiv: document.getElementById("customerTranscriptionTextOutputDiv"),
    customerStreamMicCheckbox: document.getElementById("customerStreamMicCheckbox"),
    customerStreamTranslationCheckbox: document.getElementById("customerStreamTranslationCheckbox"),
    customerAudioFeedbackEnabledCheckbox: document.getElementById("customerAudioFeedbackEnabledCheckbox"),
    //Translate Customer UI Elements
    customerTranslateFromLanguageSelect: document.getElementById("customerTranslateFromLanguageSelect"),
    customerTranslateToLanguageSelect: document.getElementById("customerTranslateToLanguageSelect"),
    customerTranslateFromLanguageSaveButton: document.getElementById("customerTranslateFromLanguageSaveButton"),
    customerTranslateToLanguageSaveButton: document.getElementById("customerTranslateToLanguageSaveButton"),
    customerTranslatedTextOutputDiv: document.getElementById("customerTranslatedTextOutputDiv"),
    //Polly Customer UI Elements
    customerPollyLanguageCodeSelect: document.getElementById("customerPollyLanguageCodeSelect"),
    customerPollyLanguageCodeSaveButton: document.getElementById("customerPollyLanguageCodeSaveButton"),
    customerPollyEngineSelect: document.getElementById("customerPollyEngineSelect"),
    customerPollyEngineSaveButton: document.getElementById("customerPollyEngineSaveButton"),
    customerPollyVoiceIdSelect: document.getElementById("customerPollyVoiceIdSelect"),
    customerPollyVoiceIdSaveButton: document.getElementById("customerPollyVoiceIdSaveButton"),

    //Transcribe Agent UI Elements
    agentTranscribeLanguageSelect: document.getElementById("agentTranscribeLanguageSelect"),
    agentTranscribeLanguageSaveButton: document.getElementById("agentTranscribeLanguageSaveButton"),
    agentTranscribePartialResultsStabilitySelect: document.getElementById("agentTranscribePartialResultsStabilitySelect"),
    agentTranscribePartialResultsStabilitySaveButton: document.getElementById("agentTranscribePartialResultsStabilitySaveButton"),
    agentStartTranscriptionButton: document.getElementById("agentStartTranscriptionButton"),
    agentStopTranscriptionButton: document.getElementById("agentStopTranscriptionButton"),
    agentMuteTranscriptionButton: document.getElementById("agentMuteTranscriptionButton"),
    agentTranscriptionTextOutputDiv: document.getElementById("agentTranscriptionTextOutputDiv"),
    agentAudioFeedbackEnabledCheckbox: document.getElementById("agentAudioFeedbackEnabledCheckbox"),
    agentStreamMicCheckbox: document.getElementById("agentStreamMicCheckbox"),
    agentStreamMicVolume: document.getElementById("agentStreamMicVolume"),
    agentStreamTranslationCheckbox: document.getElementById("agentStreamTranslationCheckbox"),
    //Translate Agent UI Elements
    agentTranslateFromLanguageSelect: document.getElementById("agentTranslateFromLanguageSelect"),
    agentTranslateToLanguageSelect: document.getElementById("agentTranslateToLanguageSelect"),
    agentTranslateFromLanguageSaveButton: document.getElementById("agentTranslateFromLanguageSaveButton"),
    agentTranslateToLanguageSaveButton: document.getElementById("agentTranslateToLanguageSaveButton"),
    agentTranslateTextInput: document.getElementById("agentTranslateTextInput"),
    agentTranslateTextButton: document.getElementById("agentTranslateTextButton"),
    agentTranslatedTextOutputDiv: document.getElementById("agentTranslatedTextOutputDiv"),
    //Polly Agent UI Elements
    agentPollyLanguageCodeSelect: document.getElementById("agentPollyLanguageCodeSelect"),
    agentPollyLanguageCodeSaveButton: document.getElementById("agentPollyLanguageCodeSaveButton"),
    agentPollyEngineSelect: document.getElementById("agentPollyEngineSelect"),
    agentPollyEngineSaveButton: document.getElementById("agentPollyEngineSaveButton"),
    agentPollyVoiceIdSelect: document.getElementById("agentPollyVoiceIdSelect"),
    agentPollyVoiceIdSaveButton: document.getElementById("agentPollyVoiceIdSaveButton"),
    agentPollyTextInput: document.getElementById("agentPollyTextInput"),
    agentSynthesizeSpeechButton: document.getElementById("agentSynthesizeSpeechButton"),

    //Transcript UI Elements
    divTranscriptContainer: document.getElementById("divTranscriptContainer"),
  };
};

const initEventListeners = () => {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    console.info(`${LOGGER_PREFIX} - devicechange event fired`);
    getDevices();
  });

  CCP_V2V.UI.logoutButton.addEventListener("click", logout);

  CCP_V2V.UI.ccpToggleButton.addEventListener("click", () => {
    setCCPPanelVisible(CCP_V2V.UI.ccpSection.classList.contains("ccp-collapsed"));
  });

  CCP_V2V.UI.btnStreamFile.addEventListener("click", streamFile);
  CCP_V2V.UI.btnStreamMic.addEventListener("click", streamMic);
  CCP_V2V.UI.btnRemoveAudioStream.addEventListener("click", removeAudioTrack);

  //mic & speaker ui buttons
  CCP_V2V.UI.testAudioButton.addEventListener("click", testAudioOutput);
  CCP_V2V.UI.testMicButton.addEventListener("click", () => {
    if (CCP_V2V.UI.testMicButton.innerText === "Test") {
      testMicrophone();
      CCP_V2V.UI.testMicButton.innerText = "Stop";
    } else if (CCP_V2V.UI.testMicButton.innerText === "Stop") {
      stopTestMicrophone();
      CCP_V2V.UI.testMicButton.innerText = "Test";
    }
  });

  CCP_V2V.UI.speakerSaveButton.addEventListener("click", () => addUpdateLocalStorageKey("selectedSpeakerId", CCP_V2V.UI.speakerSelect.value));
  CCP_V2V.UI.micSaveButton.addEventListener("click", () => addUpdateLocalStorageKey("selectedMicId", CCP_V2V.UI.micSelect.value));

  //Transcribe Customer UI buttons
  CCP_V2V.UI.customerTranscribeLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranscribeLanguage", CCP_V2V.UI.customerTranscribeLanguageSelect.value);
  });
  CCP_V2V.UI.customerTranscribePartialResultsStabilitySaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranscribePartialResultsStability", CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value);
  });

  CCP_V2V.UI.customerStartTranscriptionButton.addEventListener("click", customerStartTranscription);
  CCP_V2V.UI.customerStopTranscriptionButton.addEventListener("click", customerStopTranscription);

  CCP_V2V.UI.customerStreamMicCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      CCP_V2V.UI.fromCustomerAudioElement.muted = false;
    } else {
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }
  });

  CCP_V2V.UI.customerAudioFeedbackEnabledCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    } else {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.disableAudioFeedback();
    }
  });

  //Translate Customer UI buttons
  CCP_V2V.UI.customerTranslateFromLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranslateFromLanguage", CCP_V2V.UI.customerTranslateFromLanguageSelect.value);
  });
  CCP_V2V.UI.customerTranslateToLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranslateToLanguage", CCP_V2V.UI.customerTranslateToLanguageSelect.value);
  });
  //Polly Customer UI buttons
  CCP_V2V.UI.customerPollyLanguageCodeSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerPollyLanguageCode", CCP_V2V.UI.customerPollyLanguageCodeSelect.value);
  });
  CCP_V2V.UI.customerPollyEngineSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerPollyEngine", CCP_V2V.UI.customerPollyEngineSelect.value);
  });
  CCP_V2V.UI.customerPollyVoiceIdSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerPollyVoiceId", CCP_V2V.UI.customerPollyVoiceIdSelect.value);
  });
  CCP_V2V.UI.customerPollyLanguageCodeSelect.addEventListener("change", loadCustomerPollyVoiceIds);
  CCP_V2V.UI.customerPollyEngineSelect.addEventListener("change", loadCustomerPollyVoiceIds);

  //Transcribe Agent UI buttons
  CCP_V2V.UI.agentTranscribeLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranscribeLanguage", CCP_V2V.UI.agentTranscribeLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranscribePartialResultsStabilitySaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranscribePartialResultsStability", CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value);
  });

  CCP_V2V.UI.agentStartTranscriptionButton.addEventListener("click", agentStartTranscription);

  CCP_V2V.UI.agentStopTranscriptionButton.addEventListener("click", agentStopTranscription);

  CCP_V2V.UI.agentMuteTranscriptionButton.addEventListener("click", () => {
    CCP_V2V.UI.agentMuteTranscriptionButton.textContent = IsAgentTranscriptionMuted ? "Unmute" : "Mute";
    toggleAgentTranscriptionMute();
  });

  CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      if (ToAgentAudioStreamManager != null) ToAgentAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    } else {
      if (ToAgentAudioStreamManager != null) ToAgentAudioStreamManager.disableAudioFeedback();
    }
  });

  CCP_V2V.UI.agentStreamMicCheckbox.addEventListener("change", (event) => {
    const selectedMic = CCP_V2V.UI.micSelect.value;
    const micConstraints = getMicrophoneConstraints(selectedMic);
    if (event.target.checked) {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.startMicrophone(micConstraints);
    } else {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.stopMicrophone();
    }
  });

  CCP_V2V.UI.agentStreamMicVolume.addEventListener("input", (event) => {
    const micVolume = parseFloat(event.target.value);
    if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.setMicrophoneVolume(micVolume);
  });

  //Translate Agent UI buttons
  CCP_V2V.UI.agentTranslateFromLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranslateFromLanguage", CCP_V2V.UI.agentTranslateFromLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranslateToLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranslateToLanguage", CCP_V2V.UI.agentTranslateToLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranslateToLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranslateToLanguage", CCP_V2V.UI.agentTranslateToLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranslateTextButton.addEventListener("click", handleAgentTranslateText);
  CCP_V2V.UI.agentTranslateTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleAgentTranslateText();
    }
  });
  //Polly Agent UI buttons
  CCP_V2V.UI.agentPollyLanguageCodeSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentPollyLanguageCode", CCP_V2V.UI.agentPollyLanguageCodeSelect.value);
  });
  CCP_V2V.UI.agentPollyEngineSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentPollyEngine", CCP_V2V.UI.agentPollyEngineSelect.value);
  });
  CCP_V2V.UI.agentPollyVoiceIdSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentPollyVoiceId", CCP_V2V.UI.agentPollyVoiceIdSelect.value);
  });
  CCP_V2V.UI.agentPollyLanguageCodeSelect.addEventListener("change", loadAgentPollyVoiceIds);
  CCP_V2V.UI.agentPollyEngineSelect.addEventListener("change", loadAgentPollyVoiceIds);
  CCP_V2V.UI.agentSynthesizeSpeechButton.addEventListener("click", handleAgentSynthesizeSpeech);
  CCP_V2V.UI.agentPollyTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleAgentSynthesizeSpeech();
    }
  });
};

// The CCP iframe is collapsed rather than removed: it owns the softphone session and the
// WebRTC peer connection that this app replaces audio tracks on. Agents drive call control
// from the Amazon Connect agent workspace, so the panel is only shown for troubleshooting.
function setCCPPanelVisible(isVisible) {
  CCP_V2V.UI.ccpSection.classList.toggle("ccp-collapsed", !isVisible);
  CCP_V2V.UI.ccpToggleButton.textContent = isVisible ? "Hide" : "Show";
  addUpdateLocalStorageKey("ccpPanelVisible", String(isVisible));
}

function restoreCCPPanelVisibility() {
  setCCPPanelVisible(getLocalStorageValueByKey("ccpPanelVisible") === "true");
}

const initCCP = async (onConnectInitialized) => {
  const { connectCCPURL } = getConnectURLS();
  if (!window.connect.core.initialized) {
    console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization started`);
    window.connect.core.initCCP(CCP_V2V.UI.ccpContainer, {
      ccpUrl: connectCCPURL,
      loginPopup: true,
      loginPopupAutoClose: true,
      loginOptions: {
        // optional, if provided opens login in new window
        autoClose: true, // optional, defaults to `false`
        height: 600, // optional, defaults to 578
        width: 400, // optional, defaults to 433
        top: 0, // optional, defaults to 0
        left: 0, // optional, defaults to 0
      },
      region: CONNECT_CONFIG.connectInstanceRegion,
      softphone: {
        allowFramedSoftphone: false, //we don't want the default softphone
        allowFramedVideoCall: true, //allow the agent to add video to the call
        disableRingtone: false,
      },
      pageOptions: {
        enableAudioDeviceSettings: true,
        enableVideoDeviceSettings: true,
        enablePhoneTypeSettings: true,
      },
      shouldAddNamespaceToLogs: true,
    });

    window.connect.agent((agent) => {
      console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization completed`);
      if (onConnectInitialized) onConnectInitialized(agent);
    });
  } else {
    console.info(`${LOGGER_PREFIX} - Amazon Connect CCP Already Initialized`);
  }
};

const onConnectInitialized = (connectAgent) => {
  connect = window.connect;
  connect.core.initSoftphoneManager({ allowFramedSoftphone: true });

  const connectAgentConfiguration = connectAgent.getConfiguration();
  CurrentUser["currentUser_ConnectUsername"] = connectAgentConfiguration.username;

  subscribeToAgentEvents();
  subscribeToContactEvents();

  connect.core.onSoftphoneSessionInit(function ({ connectionId }) {
    ConnectSoftPhoneManager = connect.core.getSoftphoneManager();
    //console.info(`${LOGGER_PREFIX} - softphoneManager`, softphoneManager);
  });
};

function subscribeToAgentEvents() {
  // Subscribe to Agent Events from Streams API, and handle Agent events with functions defined above
  console.info(`${LOGGER_PREFIX} - subscribing to events for agent`);

  connect.agent((agent) => {
    agent.onLocalMediaStreamCreated(onAgentLocalMediaStreamCreated);
    // agent.onStateChange(agentStateChange);
    // agent.onRefresh(agentRefresh);
    // agent.onOffline(agentOffline);
  });
}

function subscribeToContactEvents() {
  // Subscribe to Contact Events from Streams API, and handle Contact events
  console.info(`${LOGGER_PREFIX} - subscribing to events for contact`);
  connect.contact((contact) => {
    console.info(`${LOGGER_PREFIX} - new contact`, contact);
    if (contact.getActiveInitialConnection() && contact.getActiveInitialConnection().getEndpoint()) {
      console.info(`${LOGGER_PREFIX} - new contact is from ${contact.getActiveInitialConnection().getEndpoint().phoneNumber}`);
    } else {
      console.info(`${LOGGER_PREFIX} - this is an existing contact for this agent`);
    }

    contact.onConnecting(onContactConnecting);
    contact.onConnected(onContactConnected);
    contact.onEnded(onContactEnded);
    contact.onDestroy(onContactDestroyed);
    // contact.onRefresh(contactRefreshed);
  });
}

function onContactConnecting(contact) {
  console.info(`${LOGGER_PREFIX} - contact is connecting`, contact);
}

function onContactConnected(contact) {
  console.info(`${LOGGER_PREFIX} - contact connected`, contact);

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;

  autoConfigureLanguagesFromContact(contact);
}

function onContactEnded(contact) {
  console.info(`${LOGGER_PREFIX} - contact has ended`, contact);
  CurrentAgentConnectionId = null;
  if (ToCustomerAudioStreamManager != null) {
    ToCustomerAudioStreamManager.dispose();
    ToCustomerAudioStreamManager = null;
  }
  if (ToAgentAudioStreamManager != null) {
    ToAgentAudioStreamManager.dispose();
    ToAgentAudioStreamManager = null;
  }
  if (RTCSessionTrackManager != null) {
    RTCSessionTrackManager.dispose();
    RTCSessionTrackManager = null;
  }
  customerStopTranscription();
  agentStopTranscription();
  cleanUpUI();
}

function onContactDestroyed(contact) {
  console.info(`${LOGGER_PREFIX} - contact has been destroyed`, contact);

  clearTranscriptCards();
}

function onAgentLocalMediaStreamCreated(data) {
  //console.info(`${LOGGER_PREFIX} - onAgentLocalMediaStreamCreated`, data);
  CurrentAgentConnectionId = data.connectionId;
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const peerConnection = session?._pc;
  replaceToCustomerAudioStreamManager();
  replaceToAgentAudioStreamManager();
  replaceRTCSessionTrackManager(peerConnection);
}

function setAudioElementsSinkIds() {
  CCP_V2V.UI.fromCustomerAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
  CCP_V2V.UI.toCustomerAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
  CCP_V2V.UI.toAgentAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
}

//Instead of streaming Microphone, stream an Audio File
function streamFile() {
  try {
    const fileStreamAudioTrack = RTCSessionTrackManager.createFileTrack("./assets/speech_20241113001759828.mp3");
    //console.info(`${LOGGER_PREFIX} - streamFile`, fileStreamAudioTrack);
    RTCSessionTrackManager.replaceTrack(fileStreamAudioTrack, TrackType.FILE);
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - streamFile`, error);
    raiseError(`Error steaming file: ${error}`);
  }
}

//Instead of streaming File, stream Mic
async function streamMic() {
  const selectedMic = CCP_V2V.UI.micSelect.value;
  if (!selectedMic) {
    raiseError("Please select a microphone!");
    return;
  }

  const micConstraints = getMicrophoneConstraints(selectedMic);
  const micStreamAudioTrack = await RTCSessionTrackManager.createMicTrack(micConstraints);
  //console.info(`${LOGGER_PREFIX} - streamMic`, micStreamAudioTrack);
  RTCSessionTrackManager.replaceTrack(micStreamAudioTrack, TrackType.MIC);
}

//Instead of removing AudioTrack, stream a silent AudioTrack
async function removeAudioTrack() {
  const silentTrack = RTCSessionTrackManager.createSilentTrack();
  // console.info(
  //   `${LOGGER_PREFIX} - removeAudioTrack - replacing with a silent track`
  // );
  RTCSessionTrackManager.replaceTrack(silentTrack, TrackType.SILENT);
}

async function testMicrophone() {
  const selectedMic = CCP_V2V.UI.micSelect.value;

  if (!selectedMic) {
    raiseError("Please select a microphone!");
    return;
  }

  try {
    // Request access to the selected microphone
    const micConstraints = getMicrophoneConstraints(selectedMic);
    const micStream = await navigator.mediaDevices.getUserMedia(micConstraints);

    const volumeBar = document.getElementById("volumeBar");
    const agentMicTestManager = await getAgentMicTestManager();
    agentMicTestManager.startAudioTest(micStream, volumeBar);
  } catch (err) {
    console.error(`${LOGGER_PREFIX} - testMicrophone - Error accessing microphone`, err);
    raiseError("Failed to access microphone.");
  }
}

async function stopTestMicrophone() {
  const agentMicTestManager = await getAgentMicTestManager();
  agentMicTestManager.stopAudioTest();
}

// Function to test the selected audio output device
function testAudioOutput() {
  const selectedSpeaker = CCP_V2V.UI.speakerSelect.value;
  if (!selectedSpeaker) {
    raiseError("Please select a speaker!");
    return;
  }

  // Create an audio context and set the output device using setSinkId()
  const audio = new Audio("/assets/chime-sound-7143.mp3");
  audio
    .setSinkId(selectedSpeaker)
    .then(() => {
      console.info(`${LOGGER_PREFIX} - testAudioOutput - Audio output device set successfully`);
      audio
        .play()
        .then(() => {
          console.info(`${LOGGER_PREFIX} - testAudioOutput - Audio played successfully`);
        })
        .catch((err) => {
          console.error(`${LOGGER_PREFIX} - testAudioOutput - Error playing audio:`, err);
          raiseError("Failed to play audio.");
        });
    })
    .catch((err) => {
      console.error(`${LOGGER_PREFIX} - testAudioOutput - Error setting output device:`, err);
      raiseError("Failed to set audio output device.");
    });
}

async function getDevices() {
  try {
    //check Microphone permission
    const micPermission = await navigator.permissions.query({ name: "microphone" });
    if (micPermission.state === "prompt") {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (micPermission.state === "denied") {
      raiseError("Microphone permission is denied. Please allow microphone access in your browser settings.");
      return;
    }

    // Get all media devices (input and output)
    const devices = await navigator.mediaDevices.enumerateDevices();

    // Arrays to store cam, mic and speaker devices
    const micDevices = [];
    const speakerDevices = [];

    // Loop through devices and filter by kind
    devices.forEach((device) => {
      if (device.kind === "audioinput") {
        micDevices.push(device);
      } else if (device.kind === "audiooutput") {
        speakerDevices.push(device);
      }
    });

    //raise an error if we only found devices without deviceId
    if (micDevices.every((device) => !device.deviceId)) {
      raiseError("No Microphone found. Please check your microphone and reload the page.");
      return;
    }

    if (speakerDevices.every((device) => !device.deviceId)) {
      raiseError("No Speaker found. Please check your speaker and reload the page.");
      return;
    }

    // Populate the microphone dropdown
    CCP_V2V.UI.micSelect.innerHTML = "";
    micDevices.forEach((mic) => {
      const option = document.createElement("option");
      option.value = mic.deviceId;
      option.textContent = mic.label || `Microphone ${mic.deviceId}`;
      CCP_V2V.UI.micSelect.appendChild(option);
    });

    //pre-select the Default mic
    const defaultMic = micDevices.find((mic) => mic.deviceId.startsWith("default"));
    if (defaultMic) {
      CCP_V2V.UI.micSelect.value = defaultMic.deviceId;
    }
    //pre-select the saved mic
    const savedMicId = getLocalStorageValueByKey("selectedMicId");
    if (savedMicId) {
      CCP_V2V.UI.micSelect.value = savedMicId;
    }

    // Populate the speaker dropdown
    CCP_V2V.UI.speakerSelect.innerHTML = "";
    speakerDevices.forEach((speaker) => {
      const option = document.createElement("option");
      option.value = speaker.deviceId;
      option.textContent = speaker.label || `Speaker ${speaker.deviceId}`;
      CCP_V2V.UI.speakerSelect.appendChild(option);
    });

    //pre-select the Default speaker
    const defaultSpeaker = speakerDevices.find((speaker) => speaker.deviceId.startsWith("default"));
    if (defaultSpeaker) {
      CCP_V2V.UI.speakerSelect.value = defaultSpeaker.deviceId;
    }
    //pre-select the saved speaker
    const savedSpeakerId = getLocalStorageValueByKey("selectedSpeakerId");
    if (savedSpeakerId) {
      CCP_V2V.UI.speakerSelect.value = savedSpeakerId;
    }
  } catch (err) {
    console.error(`${LOGGER_PREFIX} - getDevices - Error accessing devices:`, err);
  }
}

async function loadTranscribeLanguageCodes() {
  const transcribeStreamingLanguages = listStreamingLanguages();
  transcribeStreamingLanguages.forEach((language) => {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = language;
    CCP_V2V.UI.customerTranscribeLanguageSelect.appendChild(option);
    CCP_V2V.UI.agentTranscribeLanguageSelect.appendChild(option.cloneNode(true));
  });
  //set en-US as default
  CCP_V2V.UI.customerTranscribeLanguageSelect.value = "en-US";
  CCP_V2V.UI.agentTranscribeLanguageSelect.value = "en-US";

  //pre-select saved transcribeLanguage
  const savedCustomerTranscribeLanguage = getLocalStorageValueByKey("customerTranscribeLanguage");
  if (savedCustomerTranscribeLanguage) {
    CCP_V2V.UI.customerTranscribeLanguageSelect.value = savedCustomerTranscribeLanguage;
  }

  const savedAgentTranscribeLanguage = getLocalStorageValueByKey("agentTranscribeLanguage");
  if (savedAgentTranscribeLanguage) {
    CCP_V2V.UI.agentTranscribeLanguageSelect.value = savedAgentTranscribeLanguage;
  }
}

function loadTranscribePartialResultsStability() {
  TRANSCRIBE_PARTIAL_RESULTS_STABILITY.forEach((stability) => {
    const option = document.createElement("option");
    option.value = stability;
    option.textContent = stability;
    CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.appendChild(option);
    CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.appendChild(option.cloneNode(true));
  });
  //set none as default
  CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value = "none";
  CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value = "none";

  //pre-select saved transcribePartialResultStability
  const savedCustomerTranscribePartialResultsStability = getLocalStorageValueByKey("customerTranscribePartialResultsStability");
  if (savedCustomerTranscribePartialResultsStability) {
    CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value = savedCustomerTranscribePartialResultsStability;
  }

  const savedAgentTranscribePartialResultsStability = getLocalStorageValueByKey("agentTranscribePartialResultsStability");
  if (savedAgentTranscribePartialResultsStability) {
    CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value = savedAgentTranscribePartialResultsStability;
  }
}

//Creates Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
async function captureFromCustomerAudioStream() {
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const audioStream = session?._remoteAudioStream;
  if (audioStream == null) {
    console.error(`${LOGGER_PREFIX} - captureFromCustomerAudioStream - No audio stream found from customer`);
    throw new Error("No audio stream found from customer, please check you browser sound settings");
  }

  const amazonTranscribeFromCustomerAudioStream = new MicrophoneStream();
  amazonTranscribeFromCustomerAudioStream.setStream(audioStream);
  return amazonTranscribeFromCustomerAudioStream;
}

async function customerStartTranscription() {
  try {
    if (CCP_V2V.UI.customerStreamMicCheckbox.checked === true) {
      //we want agent to hear the customer's original voice, so we reduce the fromCustomerAudioElement volume
      CCP_V2V.UI.fromCustomerAudioElement.volume = 0.3;
    } else {
      //we don't want agent to hear the customer's original voice, so we mute the fromCustomerAudioElement
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }

    //Play the audio feedback to customer
    if (CCP_V2V.UI.customerAudioFeedbackEnabledCheckbox.checked === true) {
      ToCustomerAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    //getting the remote audio stream from the current RTC session into AmazonTranscribeFromCustomerAudioStream variable
    AmazonTranscribeFromCustomerAudioStream = await captureFromCustomerAudioStream();
    const customerStreamSampleRate = AudioContextMgr.getActualSampleRate();
    console.info(`${LOGGER_PREFIX} - customerStartTranscription - AmazonTranscribeFromCustomerAudioStream Sample Rate: ${customerStreamSampleRate}`);

    startCustomerStreamTranscription(
      AmazonTranscribeFromCustomerAudioStream,
      customerStreamSampleRate,
      CCP_V2V.UI.customerTranscribeLanguageSelect.value,
      CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value,
      handleCustomerTranscript,
      handleCustomerPartialTranscript
    );

    CCP_V2V.UI.customerTranscribeLanguageSelect.disabled = true;
    CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.disabled = true;
    CCP_V2V.UI.customerStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.customerStopTranscriptionButton.disabled = false;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - customerStartTranscription - Error starting customer transcription:`, error);
    raiseError(`Error starting customer transcription: ${error}`);
  }
}

async function customerStopTranscription() {
  if (AmazonTranscribeFromCustomerAudioStream) {
    //replace the stream with a silent stream
    const audioContext = await getAudioContext();
    const silentStream = audioContext.createMediaStreamDestination().stream;
    AmazonTranscribeFromCustomerAudioStream.setStream(silentStream);
    AmazonTranscribeFromCustomerAudioStream.stop();
    AmazonTranscribeFromCustomerAudioStream.destroy();
    AmazonTranscribeFromCustomerAudioStream = undefined;
  }

  //un-mute the audio element
  CCP_V2V.UI.fromCustomerAudioElement.muted = false;

  CCP_V2V.UI.customerTranscribeLanguageSelect.disabled = false;
  CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.disabled = false;
  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.customerStopTranscriptionButton.disabled = true;
}

async function agentStartTranscription() {
  try {
    const selectedMic = CCP_V2V.UI.micSelect.value;
    const micConstraints = getMicrophoneConstraints(selectedMic);

    if (CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.checked === true) {
      ToAgentAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    if (CCP_V2V.UI.agentStreamMicCheckbox.checked === true) {
      await ToCustomerAudioStreamManager.startMicrophone(micConstraints);
      const micVolume = parseFloat(CCP_V2V.UI.agentStreamMicVolume.value);
      ToCustomerAudioStreamManager.setMicrophoneVolume(micVolume);
    }

    //getting the local Mic stream into AmazonTranscribeMicStream variable
    AmazonTranscribeToCustomerAudioStream = await createMicrophoneStream(micConstraints);
    const agentStreamSampleRate = AudioContextMgr.getActualSampleRate();
    console.info(`${LOGGER_PREFIX} - agentStartTranscription - AmazonTranscribeToCustomerAudioStream Sample Rate: ${agentStreamSampleRate}`);

    startAgentStreamTranscription(
      AmazonTranscribeToCustomerAudioStream,
      agentStreamSampleRate,
      CCP_V2V.UI.agentTranscribeLanguageSelect.value,
      CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value,
      handleAgentTranscript,
      handleAgentPartialTranscript
    );

    CCP_V2V.UI.agentTranscribeLanguageSelect.disabled = true;
    CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.disabled = true;
    CCP_V2V.UI.agentStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.agentStopTranscriptionButton.disabled = false;

    disableMicrophoneAndSpeakerSelection();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - agentStartTranscription - Error starting agent transcription:`, error);
    raiseError(`Error starting agent transcription: ${error}`);
  }
}

async function agentStopTranscription() {
  if (AmazonTranscribeToCustomerAudioStream) {
    //replace the stream with a silent stream
    const audioContext = await getAudioContext();
    const silentStream = audioContext.createMediaStreamDestination().stream;
    AmazonTranscribeToCustomerAudioStream.setStream(silentStream);
    AmazonTranscribeToCustomerAudioStream.stop();
    AmazonTranscribeToCustomerAudioStream.destroy();
    AmazonTranscribeToCustomerAudioStream = undefined;
  }

  CCP_V2V.UI.agentTranscribeLanguageSelect.disabled = false;
  CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.disabled = false;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStopTranscriptionButton.disabled = true;

  enableMicrophoneAndSpeakerSelection();
}

function toggleAgentTranscriptionMute() {
  if (AmazonTranscribeToCustomerAudioStream) {
    const audioTrack = AmazonTranscribeToCustomerAudioStream.stream.getAudioTracks()[0];
    if (audioTrack) {
      //Disable the track in AmazonTranscribeToCustomerAudioStream
      audioTrack.enabled = !audioTrack.enabled;
      IsAgentTranscriptionMuted = !audioTrack.enabled;
      //Mute the Mic so it is not streamed to Customer
      const selectedMic = CCP_V2V.UI.micSelect.value;
      const micConstraints = getMicrophoneConstraints(selectedMic);
      IsAgentTranscriptionMuted ? ToCustomerAudioStreamManager.stopMicrophone() : ToCustomerAudioStreamManager.startMicrophone(micConstraints);
      CCP_V2V.UI.agentMuteTranscriptionButton.textContent = IsAgentTranscriptionMuted ? "Unmute" : "Mute";
    }
  }
}

async function loadTranslateLanguageCodes() {
  const translateLanguages = await listTranslateLanguages().catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadTranslateLanguageCodes - Error listing languages:`, error);
    raiseError(`Error listing languages: ${error}`);
    return [];
  });

  translateLanguages.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.LanguageCode;
    option.textContent = language.LanguageName;

    CCP_V2V.UI.customerTranslateFromLanguageSelect.appendChild(option);
    CCP_V2V.UI.customerTranslateToLanguageSelect.appendChild(option.cloneNode(true));

    CCP_V2V.UI.agentTranslateFromLanguageSelect.appendChild(option.cloneNode(true));
    CCP_V2V.UI.agentTranslateToLanguageSelect.appendChild(option.cloneNode(true));
  });
  //set en as default
  CCP_V2V.UI.customerTranslateFromLanguageSelect.value = "en";
  CCP_V2V.UI.customerTranslateToLanguageSelect.value = "es";

  CCP_V2V.UI.agentTranslateFromLanguageSelect.value = "en";
  CCP_V2V.UI.agentTranslateToLanguageSelect.value = "es";

  //pre-select saved translateFromLanguage
  const savedCustomerTranslateFromLanguage = getLocalStorageValueByKey("customerTranslateFromLanguage");
  if (savedCustomerTranslateFromLanguage) {
    CCP_V2V.UI.customerTranslateFromLanguageSelect.value = savedCustomerTranslateFromLanguage;
  }

  const savedAgentTranslateFromLanguage = getLocalStorageValueByKey("agentTranslateFromLanguage");
  if (savedAgentTranslateFromLanguage) {
    CCP_V2V.UI.agentTranslateFromLanguageSelect.value = savedAgentTranslateFromLanguage;
  }

  //pre-select saved translateToLanguage
  const savedCustomerTranslateToLanguage = getLocalStorageValueByKey("customerTranslateToLanguage");
  if (savedCustomerTranslateToLanguage) {
    CCP_V2V.UI.customerTranslateToLanguageSelect.value = savedCustomerTranslateToLanguage;
  }

  const savedAgentTranslateToLanguage = getLocalStorageValueByKey("agentTranslateToLanguage");
  if (savedAgentTranslateToLanguage) {
    CCP_V2V.UI.agentTranslateToLanguageSelect.value = savedAgentTranslateToLanguage;
  }
}

async function handleCustomerPartialTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;
  //update CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv, "bg-pale-yellow");
    CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);
}

async function handleCustomerTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  //update CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv, "bg-pale-green");
    CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);

  const fromLanguage = CCP_V2V.UI.customerTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.customerTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - handleCustomerTranscript - Error translating text:`, error);
    raiseError(`Error translating text: ${error}`);
    return null;
  });

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeCustomerVoice(translatedText);
    //update CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent = translatedText;
      addTranscriptCard(inputText, translatedText, "toAgent");
    }, 100);
  }
}

async function handleAgentPartialTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;
  //update CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv, "bg-pale-yellow");
    CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);
}

async function handleAgentTranslateText() {
  const inputText = CCP_V2V.UI.agentTranslateTextInput.value;
  if (isStringUndefinedNullEmpty(inputText)) return;

  const fromLanguage = CCP_V2V.UI.agentTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.agentTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    //update CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = translatedText;
      addTranscriptCard(inputText, translatedText, "fromAgent");
    }, 100);
  }
  CCP_V2V.UI.agentTranslateTextInput.value = "";
  CCP_V2V.UI.agentTranslateTextInput.focus();
}

async function handleAgentTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  //update CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv, "bg-pale-green");
    CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);

  const fromLanguage = CCP_V2V.UI.agentTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.agentTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    //update CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = translatedText;
      addTranscriptCard(inputText, translatedText, "fromAgent");
    }, 100);
  }
}

function loadPollyLanguageCodes() {
  const pollyLanguageCodes = listPollyLanguages();
  pollyLanguageCodes.forEach((languageCode) => {
    const option = document.createElement("option");
    option.value = languageCode;
    option.textContent = languageCode;
    CCP_V2V.UI.customerPollyLanguageCodeSelect.appendChild(option);
    CCP_V2V.UI.agentPollyLanguageCodeSelect.appendChild(option.cloneNode(true));
  });
  //set un - US as default
  CCP_V2V.UI.customerPollyLanguageCodeSelect.value = "en-US";
  CCP_V2V.UI.agentPollyLanguageCodeSelect.value = "en-US";

  //pre-select saved pollyLanguageCode
  const savedCUstomerPollyLanguageCode = getLocalStorageValueByKey("customerPollyLanguageCode");
  if (savedCUstomerPollyLanguageCode) {
    CCP_V2V.UI.customerPollyLanguageCodeSelect.value = savedCUstomerPollyLanguageCode;
  }

  const savedAgentPollyLanguageCode = getLocalStorageValueByKey("agentPollyLanguageCode");
  if (savedAgentPollyLanguageCode) {
    CCP_V2V.UI.agentPollyLanguageCodeSelect.value = savedAgentPollyLanguageCode;
  }
}

function loadPollyEngines() {
  const pollyEngines = listPollyEngines();
  pollyEngines.forEach((engine) => {
    const option = document.createElement("option");
    option.value = engine;
    option.textContent = engine;
    CCP_V2V.UI.customerPollyEngineSelect.appendChild(option);
    CCP_V2V.UI.agentPollyEngineSelect.appendChild(option.cloneNode(true));
  });

  //pre-select saved pollyEngine
  const savedCustomerPollyEngine = getLocalStorageValueByKey("customerPollyEngine");
  if (savedCustomerPollyEngine) {
    CCP_V2V.UI.customerPollyEngineSelect.value = savedCustomerPollyEngine;
  }

  const savedAgentPollyEngine = getLocalStorageValueByKey("agentPollyEngine");
  if (savedAgentPollyEngine) {
    CCP_V2V.UI.agentPollyEngineSelect.value = savedAgentPollyEngine;
  }
}

//Returns true when the voice list was refreshed. Pass suppressAlert when called automatically
//(i.e. from contact connect) rather than from an agent gesture: raiseError is an alert(), which
//blocks the main thread mid-call. Destructuring an options object also makes this safe to use
//directly as a "change" listener - an Event has no suppressAlert property, so it defaults to false.
async function loadCustomerPollyVoiceIds({ suppressAlert = false } = {}) {
  const customerSelectedLanguageCode = CCP_V2V.UI.customerPollyLanguageCodeSelect.value;
  const customerSelectedPollyEngine = CCP_V2V.UI.customerPollyEngineSelect.value;

  let pollyVoices;
  try {
    pollyVoices = await describeVoices(customerSelectedLanguageCode, customerSelectedPollyEngine);
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - loadCustomerPollyVoiceIds - Error describing voices:`, error);
    //Leave the existing options in place. Emptying the select would leave Amazon Polly with no
    //VoiceId, breaking synthesis for the rest of the call.
    if (!suppressAlert) raiseError(`Error describing voices: ${error}`);
    return false;
  }

  //clear pollyVoiceIdSelect
  CCP_V2V.UI.customerPollyVoiceIdSelect.innerHTML = "";

  pollyVoices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.Id;
    option.textContent = voice.Name;
    CCP_V2V.UI.customerPollyVoiceIdSelect.appendChild(option);
  });
  //pre-select saved pollyVoiceId
  const savedCustomerPollyVoiceId = getLocalStorageValueByKey("customerPollyVoiceId");
  if (savedCustomerPollyVoiceId) {
    CCP_V2V.UI.customerPollyVoiceIdSelect.value = savedCustomerPollyVoiceId;
  }
  return true;
}

//See loadCustomerPollyVoiceIds for why suppressAlert exists
async function loadAgentPollyVoiceIds({ suppressAlert = false } = {}) {
  const agentSelectedLanguageCode = CCP_V2V.UI.agentPollyLanguageCodeSelect.value;
  const agentSelectedPollyEngine = CCP_V2V.UI.agentPollyEngineSelect.value;

  let pollyVoices;
  try {
    pollyVoices = await describeVoices(agentSelectedLanguageCode, agentSelectedPollyEngine);
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - loadAgentPollyVoiceIds - Error describing voices:`, error);
    if (!suppressAlert) raiseError(`Error describing voices: ${error}`);
    return false;
  }

  //clear pollyVoiceIdSelect
  CCP_V2V.UI.agentPollyVoiceIdSelect.innerHTML = "";

  pollyVoices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.Id;
    option.textContent = voice.Name;
    CCP_V2V.UI.agentPollyVoiceIdSelect.appendChild(option);
  });
  //pre-select saved pollyVoiceId
  const savedAgentPollyVoiceId = getLocalStorageValueByKey("agentPollyVoiceId");
  if (savedAgentPollyVoiceId) {
    CCP_V2V.UI.agentPollyVoiceIdSelect.value = savedAgentPollyVoiceId;
  }
  return true;
}

function getContactAttributeValue(contactAttributes, attributeNames) {
  for (const attributeName of attributeNames) {
    const attributeValue = contactAttributes?.[attributeName]?.value;
    if (!isStringUndefinedNullEmpty(attributeValue)) return attributeValue.trim();
  }
  return null;
}

function toTranslateLanguageCode(transcribeLanguageCode) {
  if (isStringUndefinedNullEmpty(transcribeLanguageCode)) return null;
  return TRANSLATE_LANGUAGE_CODE_OVERRIDES[transcribeLanguageCode] ?? transcribeLanguageCode.split("-")[0];
}

//Amazon Polly's language codes are not the same set as Amazon Transcribe's, so a Transcribe
//code cannot be handed to the Amazon Polly select unmapped
function toPollyLanguageCode(transcribeLanguageCode) {
  if (isStringUndefinedNullEmpty(transcribeLanguageCode)) return null;
  return TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES[transcribeLanguageCode] ?? transcribeLanguageCode;
}

const SELECT_RESULT = { APPLIED: "applied", UNAVAILABLE: "unavailable", LOCKED: "locked", SKIPPED: "skipped" };

//Only applies a value the select actually offers, so an unexpected contact attribute leaves
//the agent's saved preference in place instead of blanking the select
function setSelectValueIfAvailable(selectElement, value, description) {
  if (isStringUndefinedNullEmpty(value)) return SELECT_RESULT.SKIPPED;

  if (selectElement.disabled) {
    console.warn(`${LOGGER_PREFIX} - autoConfigureLanguages - ${description} is locked, not setting [${value}]`);
    return SELECT_RESULT.LOCKED;
  }

  const isAvailable = Array.from(selectElement.options).some((option) => option.value === value);
  if (!isAvailable) {
    console.warn(`${LOGGER_PREFIX} - autoConfigureLanguages - ${description} does not offer [${value}], leaving [${selectElement.value}]`);
    return SELECT_RESULT.UNAVAILABLE;
  }

  selectElement.value = value;
  console.info(`${LOGGER_PREFIX} - autoConfigureLanguages - ${description} set to [${value}]`);
  return SELECT_RESULT.APPLIED;
}

function showLanguageWarnings(warnings) {
  if (warnings.length < 1) {
    clearLanguageWarnings();
    return;
  }

  //Built as DOM nodes rather than innerHTML: these strings embed Contact Attribute values,
  //which come from the contact flow and must never be parsed as markup
  CCP_V2V.UI.languageWarningBanner.textContent = "";

  const heading = document.createElement("strong");
  heading.textContent = "Translation is limited on this call";
  CCP_V2V.UI.languageWarningBanner.appendChild(heading);

  const warningList = document.createElement("ul");
  warnings.forEach((warning) => {
    const warningItem = document.createElement("li");
    warningItem.textContent = warning;
    warningList.appendChild(warningItem);
  });
  CCP_V2V.UI.languageWarningBanner.appendChild(warningList);

  CCP_V2V.UI.languageWarningBanner.classList.remove("hidden");
  warnings.forEach((warning) => console.warn(`${LOGGER_PREFIX} - autoConfigureLanguages - ${warning}`));
}

function clearLanguageWarnings() {
  CCP_V2V.UI.languageWarningBanner.textContent = "";
  CCP_V2V.UI.languageWarningBanner.classList.add("hidden");
}

//Sets one direction's Amazon Polly language, returning a warning string when Amazon Polly cannot
//speak that language at all. Without translated speech that direction falls back to the untranslated
//voice, so the agent has to know before answering.
function applyPollyLanguage(selectElement, transcribeLanguageCode, description, listenerDescription) {
  const pollyLanguageCode = toPollyLanguageCode(transcribeLanguageCode);
  const result = setSelectValueIfAvailable(selectElement, pollyLanguageCode, description);

  if (result === SELECT_RESULT.APPLIED || result === SELECT_RESULT.SKIPPED) return { changed: result === SELECT_RESULT.APPLIED, warning: null };

  if (result === SELECT_RESULT.LOCKED) {
    return { changed: false, warning: `${description} is locked while transcription is running - stop transcription to change it.` };
  }

  const languageName = POLLY_UNSUPPORTED_LANGUAGE_NAMES[transcribeLanguageCode] ?? transcribeLanguageCode;
  return {
    changed: false,
    warning:
      `Amazon Polly cannot synthesize ${languageName} (${transcribeLanguageCode}). ` +
      `The ${listenerDescription} will hear the original voice only, with no translated speech. ` +
      `Amazon Polly is still set to ${selectElement.value} - change it manually if a different language is closer.`,
  };
}

//Auto-configures the V2V language pair from Amazon Connect Contact Attributes, so the agent
//does not have to set From/To languages and Amazon Polly voices manually on every contact.
//The Customer section transcribes the customer and speaks the translation TO the agent, so its
//Amazon Polly language is the agent's language - and vice versa for the Agent section.
async function autoConfigureLanguagesFromContact(contact) {
  try {
    clearLanguageWarnings();

    const contactAttributes = contact.getAttributes();

    const customerLanguage = getContactAttributeValue(contactAttributes, CONTACT_ATTRIBUTE_NAMES.customerLanguage);
    if (isStringUndefinedNullEmpty(customerLanguage)) {
      console.info(`${LOGGER_PREFIX} - autoConfigureLanguages - No customer language Contact Attribute found, keeping current selection`);
      return;
    }

    //Fall back to whatever the agent already has selected (saved preference, or the en-US default)
    const agentLanguage = getContactAttributeValue(contactAttributes, CONTACT_ATTRIBUTE_NAMES.agentLanguage) ?? CCP_V2V.UI.agentTranscribeLanguageSelect.value;

    console.info(`${LOGGER_PREFIX} - autoConfigureLanguages - customer [${customerLanguage}], agent [${agentLanguage}]`);

    const customerTranslateLanguage = toTranslateLanguageCode(customerLanguage);
    const agentTranslateLanguage = toTranslateLanguageCode(agentLanguage);

    //Customer speaks -> transcribe in the customer's language -> translate to the agent's language
    setSelectValueIfAvailable(CCP_V2V.UI.customerTranscribeLanguageSelect, customerLanguage, "Customer Transcribe language");
    setSelectValueIfAvailable(CCP_V2V.UI.customerTranslateFromLanguageSelect, customerTranslateLanguage, "Customer Translate from language");
    setSelectValueIfAvailable(CCP_V2V.UI.customerTranslateToLanguageSelect, agentTranslateLanguage, "Customer Translate to language");
    //...and is synthesized in the agent's language, because the agent hears it
    const customerPolly = applyPollyLanguage(CCP_V2V.UI.customerPollyLanguageCodeSelect, agentLanguage, "Customer Amazon Polly language", "agent");

    //Agent speaks -> transcribe in the agent's language -> translate to the customer's language
    setSelectValueIfAvailable(CCP_V2V.UI.agentTranscribeLanguageSelect, agentLanguage, "Agent Transcribe language");
    setSelectValueIfAvailable(CCP_V2V.UI.agentTranslateFromLanguageSelect, agentTranslateLanguage, "Agent Translate from language");
    setSelectValueIfAvailable(CCP_V2V.UI.agentTranslateToLanguageSelect, customerTranslateLanguage, "Agent Translate to language");
    //...and is synthesized in the customer's language, because the customer hears it
    const agentPolly = applyPollyLanguage(CCP_V2V.UI.agentPollyLanguageCodeSelect, customerLanguage, "Agent Amazon Polly language", "customer");

    //Show the language warnings before awaiting anything - they must not wait on a network call
    const warnings = [agentPolly.warning, customerPolly.warning].filter((warning) => warning != null);
    showLanguageWarnings(warnings);

    //Amazon Polly voices are per language + engine, so reload the voice lists before applying
    //overrides. suppressAlert because this runs on contact connect: a modal alert() here would
    //block the main thread mid-call.
    const [customerVoicesLoaded, agentVoicesLoaded] = await Promise.all([
      customerPolly.changed ? loadCustomerPollyVoiceIds({ suppressAlert: true }) : true,
      agentPolly.changed ? loadAgentPollyVoiceIds({ suppressAlert: true }) : true,
    ]);

    if (!agentVoicesLoaded) warnings.push("Could not load Amazon Polly voices for the customer's language. The previously selected Agent voice is still in use.");
    if (!customerVoicesLoaded) warnings.push("Could not load Amazon Polly voices for the agent's language. The previously selected Customer voice is still in use.");
    if (!agentVoicesLoaded || !customerVoicesLoaded) showLanguageWarnings(warnings);

    setSelectValueIfAvailable(
      CCP_V2V.UI.customerPollyVoiceIdSelect,
      getContactAttributeValue(contactAttributes, CONTACT_ATTRIBUTE_NAMES.customerVoiceId),
      "Customer Amazon Polly VoiceId"
    );
    setSelectValueIfAvailable(
      CCP_V2V.UI.agentPollyVoiceIdSelect,
      getContactAttributeValue(contactAttributes, CONTACT_ATTRIBUTE_NAMES.agentVoiceId),
      "Agent Amazon Polly VoiceId"
    );
  } catch (error) {
    //Never block the call on auto-configuration - the agent can always set the languages manually
    console.error(`${LOGGER_PREFIX} - autoConfigureLanguages - Error auto-configuring languages from Contact Attributes:`, error);
  }
}

async function synthesizeCustomerVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const selectedLanguageCode = CCP_V2V.UI.customerPollyLanguageCodeSelect.value;
  const selectedPollyEngine = CCP_V2V.UI.customerPollyEngineSelect.value;
  const selectedVoiceId = CCP_V2V.UI.customerPollyVoiceIdSelect.value;

  const synthetizedSpeech = await synthesizeSpeech(selectedLanguageCode, selectedPollyEngine, selectedVoiceId, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - synthesizeCustomerVoice - Error synthesizing speech:`, error);
    raiseError(`Error synthesizing speech: ${error}`);
    return null;
  });
  if (!synthetizedSpeech) return;

  //Play Customer Speech to Agent
  const audioContentArrayBufferPrimary = base64ToArrayBuffer(synthetizedSpeech);
  if (ToAgentAudioStreamManager != null) {
    ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferPrimary);
  }

  //Play Customer Speech to Customer
  if (CCP_V2V.UI.customerStreamTranslationCheckbox.checked === true) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    if (ToCustomerAudioStreamManager != null) {
      ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME);
    }
  }
}

async function synthesizeAgentVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const selectedLanguageCode = CCP_V2V.UI.agentPollyLanguageCodeSelect.value;
  const selectedPollyEngine = CCP_V2V.UI.agentPollyEngineSelect.value;
  const selectedVoiceId = CCP_V2V.UI.agentPollyVoiceIdSelect.value;

  const synthetizedSpeech = await synthesizeSpeech(selectedLanguageCode, selectedPollyEngine, selectedVoiceId, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - synthesizeAgentVoice - Error synthesizing speech:`, error);
    raiseError(`Error synthesizing speech: ${error}`);
    return null;
  });
  if (!synthetizedSpeech) return;

  //Play Agent Speech to Customer
  const audioContentArrayBufferPrimary = base64ToArrayBuffer(synthetizedSpeech);
  if (ToCustomerAudioStreamManager != null) {
    ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferPrimary);
  }

  //Play Agent Speech to Agent
  if (CCP_V2V.UI.agentStreamTranslationCheckbox.checked === true) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    if (ToAgentAudioStreamManager != null) {
      ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, AGENT_TRANSLATION_TO_AGENT_VOLUME);
    }
  }
}

async function handleAgentSynthesizeSpeech() {
  const inputText = CCP_V2V.UI.agentPollyTextInput.value;
  if (isStringUndefinedNullEmpty(inputText)) return;

  synthesizeAgentVoice(inputText);
  CCP_V2V.UI.agentPollyTextInput.value = "";
  CCP_V2V.UI.agentPollyTextInput.focus();
  addTranscriptCard(inputText, inputText, "fromAgent");
}

function cleanUpUI() {
  CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = "";
  setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv);
  CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent = "";

  CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = "";
  setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv);
  CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = "";

  CCP_V2V.UI.agentTranslateTextInput.value = "";
  CCP_V2V.UI.agentPollyTextInput.value = "";

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = true;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = true;

  clearLanguageWarnings();

  enableMicrophoneAndSpeakerSelection();
}

function raiseError(errorMessage) {
  alert(`${errorMessage}`);
}

function setBackgroundColour(element, cssClass) {
  // Remove all background classes first
  element.classList.remove("bg-pale-green", "bg-pale-yellow", "bg-none");

  // Add the requested background if specified
  if (cssClass) {
    element.classList.add(cssClass);
  }
}

function addTranscriptCard(originalTranscript, translatedTranscript, type) {
  const card = document.createElement("div");
  card.className = `transcript-card ${type}`; // type is either 'fromAgent' or 'toAgent'

  // Create original text element
  const originalText = document.createElement("div");
  originalText.className = "transcript-original";
  originalText.textContent = originalTranscript;

  // Create separator
  const separator = document.createElement("div");
  separator.className = "transcript-separator";

  // Create translated text element
  const translatedText = document.createElement("div");
  translatedText.className = "transcript-translated";
  translatedText.textContent = translatedTranscript;

  // Append all elements to the card
  card.appendChild(originalText);
  card.appendChild(separator);
  card.appendChild(translatedText);

  CCP_V2V.UI.divTranscriptContainer.insertBefore(card, CCP_V2V.UI.divTranscriptContainer.lastChild);

  // Auto scroll to the bottom
  CCP_V2V.UI.divTranscriptContainer.scrollTop = CCP_V2V.UI.divTranscriptContainer.scrollHeight;
}

function clearTranscriptCards() {
  const container = CCP_V2V.UI.divTranscriptContainer;

  // Remove all children except the last one (spacer)
  document.querySelectorAll(".transcript-container .transcript-card").forEach((card) => card.remove());
}

function getMicrophoneConstraints(deviceId) {
  let microphoneConstraints = {
    audio: {
      deviceId: deviceId,
      echoCancellation: CCP_V2V.UI.echoCancellationCheckbox.checked === true,
      noiseSuppression: CCP_V2V.UI.noiseSuppressionCheckbox.checked === true,
      autoGainControl: CCP_V2V.UI.autoGainControlCheckbox.checked === true,
    },
  };

  console.info(`${LOGGER_PREFIX} - getMicrophoneConstraints: ${JSON.stringify(microphoneConstraints)}`);
  return microphoneConstraints;
}

function enableMicrophoneAndSpeakerSelection() {
  CCP_V2V.UI.micSelect.disabled = false;
  CCP_V2V.UI.speakerSelect.disabled = false;

  CCP_V2V.UI.testAudioButton.disabled = false;
  CCP_V2V.UI.speakerSaveButton.disabled = false;

  CCP_V2V.UI.testMicButton.disabled = false;
  CCP_V2V.UI.micSaveButton.disabled = false;

  CCP_V2V.UI.echoCancellationCheckbox.disabled = false;
  CCP_V2V.UI.noiseSuppressionCheckbox.disabled = false;
  CCP_V2V.UI.autoGainControlCheckbox.disabled = false;
}

function disableMicrophoneAndSpeakerSelection() {
  CCP_V2V.UI.micSelect.disabled = true;
  CCP_V2V.UI.speakerSelect.disabled = true;

  CCP_V2V.UI.testAudioButton.disabled = true;
  CCP_V2V.UI.speakerSaveButton.disabled = true;

  CCP_V2V.UI.testMicButton.disabled = true;
  CCP_V2V.UI.micSaveButton.disabled = true;

  CCP_V2V.UI.echoCancellationCheckbox.disabled = true;
  CCP_V2V.UI.noiseSuppressionCheckbox.disabled = true;
  CCP_V2V.UI.autoGainControlCheckbox.disabled = true;
}
