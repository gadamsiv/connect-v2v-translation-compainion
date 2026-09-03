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

// Amazon Transcribe and Amazon Polly language code sets only partly overlap: 25 of Amazon
// Transcribe's 54 streaming codes have no identical Amazon Polly code. Amazon Polly supports
// these six under a different code, so map them rather than failing to synthesize.
export const TRANSCRIBE_TO_POLLY_LANGUAGE_OVERRIDES = {
  "zh-CN": "cmn-CN", // Mandarin
  "zh-HK": "yue-CN", // Cantonese
  "ar-SA": "arb", // Modern Standard Arabic
  "no-NO": "nb-NO", // Norwegian Bokmal
  "en-WL": "en-GB-WLS", // Welsh English
  "en-AB": "en-GB", // Scottish English - no distinct Amazon Polly voice
};

// The remaining Amazon Transcribe languages that Amazon Polly cannot synthesize at all. The
// agent is warned in the UI, because that direction of the call gets no translated speech -
// the far end hears only the original voice.
export const POLLY_UNSUPPORTED_LANGUAGE_NAMES = {
  "af-ZA": "Afrikaans",
  "el-GR": "Greek",
  "eu-ES": "Basque",
  "fa-IR": "Farsi",
  "gl-ES": "Galician",
  "he-IL": "Hebrew",
  "hr-HR": "Croatian",
  "id-ID": "Indonesian",
  "lv-LV": "Latvian",
  "ms-MY": "Malay",
  "sk-SK": "Slovak",
  "so-SO": "Somali",
  "sr-RS": "Serbian",
  "th-TH": "Thai",
  "tl-PH": "Tagalog",
  "uk-UA": "Ukrainian",
  "vi-VN": "Vietnamese",
  "zh-TW": "Mandarin (Taiwan)",
  "zu-ZA": "Zulu",
};
