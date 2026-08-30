import { blobToBase64 } from '../lib/base64.js';
import { isAbortError, postCommand } from '../lib/command.js';

const IDLE_LABEL = 'MIC';
const RECORDING_LABEL = 'REC';

// Two verbs, never one: MIC/REC stops and transcribes, and the cancel control beside it throws
// the recording away. Cancel is armed from the moment recording starts until the transcript is
// inserted, and it aborts the upload for real — a discarded voice note must never reach the
// transcription backend, whether the owner changes their mind before or during the request.
export function createVoiceRecorder({
  connection,
  button,
  cancelButton,
  input,
  note,
  onError,
  errorMessage,
}) {
  const supported =
    typeof globalThis.MediaRecorder === 'function' &&
    Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);
  if (!supported) {
    // getUserMedia needs a secure context (HTTPS or localhost); hide rather than fail on tap.
    button.hidden = true;
    cancelButton.hidden = true;
    return { supported: false };
  }

  let recorder;
  let stream;
  let chunks = [];
  let inFlight;
  let discarding = false;

  const setIdle = () => {
    button.textContent = IDLE_LABEL;
    button.dataset.recording = 'no';
    button.setAttribute('aria-pressed', 'false');
    button.disabled = false;
    cancelButton.hidden = true;
    cancelButton.disabled = false;
  };

  const armCancel = () => {
    cancelButton.hidden = false;
    cancelButton.disabled = false;
  };

  const releaseStream = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
  };

  const fail = (message) => {
    note(message);
    onError(message);
  };

  const insert = (text) => {
    const value = String(text ?? '').trim();
    if (!value) {
      note('nothing was transcribed');
      return;
    }
    const current = input.value.trim();
    input.value = current ? `${current} ${value}` : value;
    // The composer sizes itself from input events; a programmatic write has to announce itself.
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    note('');
    input.focus();
  };

  const transcribe = async (blob, mime) => {
    button.disabled = true;
    note('transcribing… tap CANCEL to discard');
    const controller = new globalThis.AbortController();
    inFlight = controller;
    try {
      const audioBase64 = await blobToBase64(blob);
      if (controller.signal.aborted) return;
      const args = mime ? { audio_base64: audioBase64, mime } : { audio_base64: audioBase64 };
      const { baseUrl, token } = connection();
      const result = await postCommand('voice.transcribe', args, {
        baseUrl,
        token,
        signal: controller.signal,
      });
      insert(result.text);
    } catch (error) {
      if (isAbortError(error)) return;
      fail(`voice transcribe failed: ${errorMessage(error)}`);
    } finally {
      inFlight = undefined;
      setIdle();
    }
  };

  const start = async () => {
    try {
      stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      fail(`microphone unavailable: ${errorMessage(error)}`);
      return;
    }
    chunks = [];
    discarding = false;
    try {
      recorder = new globalThis.MediaRecorder(stream);
    } catch (error) {
      releaseStream();
      fail(`recording unsupported: ${errorMessage(error)}`);
      return;
    }
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const mime = recorder?.mimeType ?? '';
      recorder = undefined;
      releaseStream();
      const blob = new globalThis.Blob(chunks, mime ? { type: mime } : undefined);
      chunks = [];
      // The discarded capture dies here: no blob is read, no request is ever made.
      if (discarding) {
        discarding = false;
        note('recording discarded');
        setIdle();
        return;
      }
      if (blob.size === 0) {
        note('no audio was captured');
        setIdle();
        return;
      }
      void transcribe(blob, mime);
    });
    recorder.start();
    button.textContent = RECORDING_LABEL;
    button.dataset.recording = 'yes';
    button.setAttribute('aria-pressed', 'true');
    armCancel();
    note('recording… tap REC to transcribe, CANCEL to discard');
  };

  const discard = () => {
    cancelButton.disabled = true;
    if (inFlight) {
      inFlight.abort();
      inFlight = undefined;
      note('recording discarded');
      setIdle();
      return;
    }
    if (recorder) {
      discarding = true;
      button.disabled = true;
      recorder.stop();
      return;
    }
    setIdle();
  };

  button.addEventListener('click', () => {
    if (inFlight) return;
    if (recorder) {
      button.disabled = true;
      recorder.stop();
      return;
    }
    void start();
  });
  cancelButton.addEventListener('click', discard);

  setIdle();
  return { supported: true };
}
