type SpeechTask = 'vad' | 'transcribe' | 'speech' | 'voiceprint'

const threads: Record<SpeechTask, number> = { vad: 1, transcribe: 2, speech: 4, voiceprint: 2 }

/** Keep the measured CPU budgets; a provider override stays internal to workers. */
export function localSpeechConfig(task: SpeechTask, provider = 'cpu') {
  return { provider, numThreads: threads[task], debug: false }
}
