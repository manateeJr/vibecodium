import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { TopicBinding, TopicStore } from './types.js';

type TopicRow = {
  thread_id: number;
  session_id: string;
  label: string;
  created_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS topics (
  thread_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openTopicStore(filename: string): TopicStore {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });

  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.exec(SCHEMA);

  const bind = database.prepare(`
    INSERT INTO topics (thread_id, session_id, label, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      session_id = excluded.session_id,
      label = excluded.label,
      created_at = excluded.created_at
  `);
  const selectByThread = database.prepare<[number], TopicRow>(
    'SELECT thread_id, session_id, label, created_at FROM topics WHERE thread_id = ?',
  );
  const selectAll = database.prepare<[], TopicRow>(
    'SELECT thread_id, session_id, label, created_at FROM topics ORDER BY thread_id',
  );
  const unbind = database.prepare('DELETE FROM topics WHERE thread_id = ?');
  const selectOffset = database.prepare<[string], { value: string }>(
    'SELECT value FROM kv WHERE key = ?',
  );
  const setOffset = database.prepare(`
    INSERT INTO kv (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  return {
    bind(binding: TopicBinding): void {
      bind.run(binding.threadId, binding.sessionId, binding.label, binding.createdAt);
    },

    byThread(threadId: number): TopicBinding | null {
      const row = selectByThread.get(threadId);
      if (!row) return null;
      return {
        threadId: row.thread_id,
        sessionId: row.session_id,
        label: row.label,
        createdAt: row.created_at,
      };
    },

    all(): TopicBinding[] {
      return selectAll.all().map((row) => ({
        threadId: row.thread_id,
        sessionId: row.session_id,
        label: row.label,
        createdAt: row.created_at,
      }));
    },

    unbind(threadId: number): void {
      unbind.run(threadId);
    },

    getOffset(): number {
      const row = selectOffset.get('getUpdates_offset');
      if (!row) return 0;
      const offset = Number(row.value);
      return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    },

    setOffset(offset: number): void {
      setOffset.run('getUpdates_offset', String(offset));
    },

    close(): void {
      database.close();
    },
  };
}
