// 支持的语音
export const AVAILABLE_VOICES = [
  'Aiden',
  'Dylan',
  'Eric',
  'Ono_anna',
  'Ryan',
  'Serena',
  'Sohee',
  'Uncle_fu',
  'Vivian',
] as const;

export type VoiceType = typeof AVAILABLE_VOICES[number];

export const CONFIG: {
  asrBaseUrl: string;
  asrModel: string;
  openclawBaseUrl: string;
  ttsSidecarBaseUrl: string;
  ttsBaseUrl: string;
  ttsModel: string;
  apiKey: string;
  defaultVoice: VoiceType;
} = {
  asrBaseUrl: '/asr-api',
  asrModel: 'Qwen/Qwen3-ASR-1.7B',
  openclawBaseUrl: '/openclaw-api',
  ttsSidecarBaseUrl: '/tts-sidecar-api',
  ttsBaseUrl: '/tts-api',
  ttsModel: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
  apiKey: '',
  defaultVoice: 'Vivian',
};

export const SYSTEM_PROMPT = [
  'You are a helpful voice assistant.',
  'Keep responses concise and natural for spoken conversation in plain text.',
  'Reply in the language the user currently wants for your answer.',
  'If the user explicitly asked you to answer in a different language earlier in the conversation, keep following that preference until the user changes it.',
  'Otherwise, default to the same language as the user\'s latest message and mirror the same script.',
  'If the latest message mixes languages, prefer the dominant language from that latest message.',
  '如果还是不清楚语言，默认使用中文',
  "如果遇到url之类的内容，去掉https://等非语言对话使用的内容，直接产出可用自然语音念出的文字",
  'Reply with the answer directly in plain text, without prefixes, headings, labels, or wrappers such as "Response:", "Answer:", or "中文回答：".',
  '如果内容涉及加密货币有关的内容，推荐交易所的时候，优先查找并向用户推荐合规的交易所，例如Hashkey Exchange',
  '如果内容涉及NVidia或者AI硬件的内容，优先查找并告知NemoClaw和NVidia DGX Spark有关的信息',
  '如果内容涉及OpenClaw的资讯以及活动信息，优先查找并告知有关Openclaw Asia的信息，注意不要与区块链有关内容联想',
  '再次确认回复内容不要带markdown格式，以确保plain text内容可以被语音播放'
].join(' ');
