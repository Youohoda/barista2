// STTProvider / TTSProvider — real Voice interfaces. No audio provider is
// integrated by default (needs a real API key + billing decision from you), so
// this returns a clear NOT_CONFIGURED error rather than silent fake transcription
// or a beep pretending to be speech.
//
// To connect one: implement against a real STT/TTS API (e.g. Groq Whisper, OpenAI
// Whisper/TTS, ElevenLabs, Deepgram — whatever you already have a key for), set
// STT_PROVIDER / TTS_PROVIDER, and add the matching *_API_KEY env var.
//
// Interface every STT provider must implement:
//   transcribe(audioBuffer, { mimeType, language }): Promise<{ text, language }>
// Interface every TTS provider must implement:
//   synthesize(text, { voice, format }): Promise<{ audioBuffer, mimeType }>
// Both should support a streaming variant (transcribeStream/synthesizeStream)
// where the underlying provider offers one; not required for a first integration.

class NotConfiguredSTT {
  async transcribe() { throw this._err(); }
  _err() { return Object.assign(new Error('التحويل من صوت لنص يحتاج STT_PROVIDER حقيقي متصل. مش متظبط دلوقتي.'), { status: 501, code: 'STT_NOT_CONFIGURED' }); }
}
class NotConfiguredTTS {
  async synthesize() { throw this._err(); }
  _err() { return Object.assign(new Error('التحويل من نص لصوت يحتاج TTS_PROVIDER حقيقي متصل. مش متظبط دلوقتي.'), { status: 501, code: 'TTS_NOT_CONFIGURED' }); }
}

const sttRegistry = {};
const ttsRegistry = {};

export function getSTTProvider() {
  const name = process.env.STT_PROVIDER;
  if (!name || !sttRegistry[name]) return new NotConfiguredSTT();
  return sttRegistry[name]();
}
export function getTTSProvider() {
  const name = process.env.TTS_PROVIDER;
  if (!name || !ttsRegistry[name]) return new NotConfiguredTTS();
  return ttsRegistry[name]();
}
