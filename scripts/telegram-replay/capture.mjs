import {
  assistantTextForTurn,
  readEvents,
  readTranscript,
  transcriptPath,
  waitFor,
} from './io.mjs';

export async function captureSession({ runtime, sessionId, turn, timeoutMs, signal, onTimeout }) {
  const events = await readEvents(runtime, sessionId);
  const filePath = transcriptPath(runtime, sessionId);
  const transcript = await waitFor(
    `transcript ${sessionId}`,
    () => {
      const current = readTranscript(filePath);
      return turn === undefined || current.turns.length >= turn ? current : false;
    },
    { timeoutMs, signal, onTimeout },
  );
  return {
    events,
    transcript,
    transcriptText: turn === undefined ? undefined : assistantTextForTurn(transcript, turn),
  };
}
