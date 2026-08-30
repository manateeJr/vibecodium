import { blobToBase64 } from '../lib/base64.js';

const IDLE_LABEL = 'MIC';
const RECORDING_LABEL = 'REC';

export function createVoiceRecorder({ client, button, input, note, onError, errorMessage }) {
  const supported =
    typeof globalThis.MediaRecorder === 'function' &&
    Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);
  if (!supported) {
    // getUserMedia needs a secure context (HTTPS or localhost); hide rather than fail on tap.
    button.hidden = true;
    return { supported: false };
  }

  let recorder;
  let stream;
  let chunks = [];
  let busy = false;

  const setIdle = () => {
    button.textContent = IDLE_LABEL;
    button.dataset.recording = 'no';
    button.setAttribute('aria-pressed', 'false');
    button.disabled = false;
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
    note('');
    input.focus();
  };

  const transcribe = async (blob, mime) => {
    busy = true;
    button.disabled = true;
    note('transcribing…');
    try {
      const audioBase64 = await blobToBase64(blob);
      const args = mime ? { audio_base64: audioBase64, mime } : { audio_base64: audioBase64 };
      const result = await client.transcribe(args);
      insert(result.text);
    } catch (error) {
      fail(`voice transcribe failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
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
    note('recording… tap to transcribe');
  };

  button.addEventListener('click', () => {
    if (busy) return;
    if (recorder) {
      button.disabled = true;
      recorder.stop();
      return;
    }
    void start();
  });

  setIdle();
  return { supported: true };
}
