export const DEPRECATED_CONNECT_DOMAIN = "awsapps.com";

export const SESSION_STORAGE_KEYS = {};

export const LOGGER_PREFIX = "CCP-V2V";

export const CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME = 0.1;
export const AGENT_TRANSLATION_TO_AGENT_VOLUME = 0.1;

export const TRANSCRIBE_PARTIAL_RESULTS_STABILITY = ["low", "medium", "high"];

export const AUDIO_FEEDBACK_FILE_PATH = "./assets/background_noise.wav";

// Amazon Connect Contact Attributes used to auto-configure V2V on contact connect.
// Each entry lists the attribute names to check, in priority order.
export const CONTACT_ATTRIBUTE_NAMES = {
  // Customer's spoken language, as an Amazon Transcribe language code (i.e. es-ES)
  customerLanguage: ["v2vCustomerLanguage", "LanguageCode"],
  // Agent's spoken language, as an Amazon Transcribe language code (i.e. en-US)
  agentLanguage: ["v2vAgentLanguage"],
  // Optional Amazon Polly VoiceId overrides
  customerVoiceId: ["v2vCustomerVoiceId"],
  agentVoiceId: ["v2vAgentVoiceId"],
};

// Amazon Translate expects a bare language code (es-ES -> es), except for the
// variants it treats as distinct languages.
export const TRANSLATE_LANGUAGE_CODE_OVERRIDES = {
  "zh-TW": "zh-TW",
  "pt-PT": "pt-PT",
  "fr-CA": "fr-CA",
  "es-MX": "es-MX",
};
