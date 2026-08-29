import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMMAND_NAMES } from '../src/contracts/commands.js';
import { createVoiceSubsystem, type VoiceSubsystem } from '../src/voice/index.js';
import type { CommandHandler, SubsystemContext } from '../src/contracts/subsystem.js';
function registeredHandler(subsystem: VoiceSubsystem): CommandHandler {
  let handler: CommandHandler | undefined;
  const context = {
    registerCommand(name: string, candidate: CommandHandler): void {
      assert.equal(name, COMMAND_NAMES.voiceTranscribe);
      handler = candidate;
    },
  } as unknown as SubsystemContext;
  subsystem.register(context);
  assert.ok(handler);
  return handler;
}

test('voice.transcribe decodes base64 audio and returns injected transcription', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-voice-test-'));
  const source = Buffer.from('offline wav fixture');
  let invokedPath = '';
  try {
    const subsystem = createVoiceSubsystem({
      temporaryDirectory,
      transcriber: async (wavPath) => {
        invokedPath = wavPath;
        assert.deepEqual(fs.readFileSync(wavPath), source);
        return '  hello from the mock  ';
      },
    });
    const result = await registeredHandler(subsystem)({
      audio_base64: source.toString('base64'),
      mime: 'audio/wav',
    });
    assert.deepEqual(result, { text: 'hello from the mock' });
    assert.match(invokedPath, /vibecodium-voice-[^/]+\/input\.wav$/);
    assert.equal(fs.existsSync(path.dirname(invokedPath)), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('voice.transcribe reports the setup command when the local venv is missing', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecodium-voice-test-'));
  try {
    const subsystem = createVoiceSubsystem({
      temporaryDirectory,
      venvDirectory: path.join(temporaryDirectory, 'missing-voice-venv'),
    });
    const handler = registeredHandler(subsystem);
    await assert.rejects(
      Promise.resolve(
        handler({
          audio_base64: Buffer.from('offline wav fixture').toString('base64'),
          mime: 'audio/wav',
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /node scripts\/setup-voice\.mjs/);
        return true;
      },
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
