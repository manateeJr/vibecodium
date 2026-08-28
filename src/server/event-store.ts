import Database from 'better-sqlite3';
import type { EventEnvelope, EventKind, EventPayload } from '../contracts/events.js';

type EventListener = (event: EventEnvelope) => void;
type EventRow = {
  seq: number;
  stream_id: string;
  type: string;
  payload: string;
  ts: string;
};

export interface EventStoreOptions {
  readonly filename: string;
}

export class EventStore {
  private readonly database: Database.Database;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly insertEvent;

  public constructor(options: EventStoreOptions) {
    this.database = new Database(options.filename);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_stream_seq ON events (stream_id, seq);
    `);
    this.insertEvent = this.database.prepare(
      'INSERT INTO events (stream_id, type, payload, ts) VALUES (?, ?, ?, ?)',
    );
  }

  public append<K extends EventKind>(stream_id: string, type: K, payload: EventPayload<K>): number {
    if (!stream_id) throw new Error('stream_id is required');
    if (!type) throw new Error('event type is required');
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) throw new Error('event payload must be JSON serializable');
    const ts = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const result = this.insertEvent.run(stream_id, type, serializedPayload, ts);
      return Number(result.lastInsertRowid);
    });
    const seq = transaction();
    const event: EventEnvelope<K> = {
      stream_id,
      seq,
      type,
      payload,
      ts,
    };
    for (const listener of this.listeners.get(stream_id) ?? []) listener(event);
    return seq;
  }

  public read(stream_id: string, from_seq = 0): EventEnvelope[] {
    if (!stream_id) throw new Error('stream_id is required');
    if (!Number.isInteger(from_seq) || from_seq < 0)
      throw new Error('from_seq must be a non-negative integer');
    const rows = this.database
      .prepare(
        'SELECT seq, stream_id, type, payload, ts FROM events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(stream_id, from_seq) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      stream_id: row.stream_id,
      type: row.type as EventKind,
      payload: JSON.parse(row.payload) as EventPayload,
      ts: row.ts,
    }));
  }

  public latestSequence(stream_id?: string): number {
    if (stream_id) {
      const row = this.database
        .prepare('SELECT seq FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1')
        .get(stream_id) as { seq?: number } | undefined;
      return row?.seq ?? 0;
    }
    const row = this.database.prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1').get() as
      { seq?: number } | undefined;
    return row?.seq ?? 0;
  }

  public subscribe(stream_id: string, listener: EventListener): () => void;
  public subscribe(stream_id: string, from_seq: number, listener: EventListener): () => void;
  public subscribe(
    stream_id: string,
    from_seq_or_listener: number | EventListener,
    maybe_listener?: EventListener,
  ): () => void {
    const from_seq = typeof from_seq_or_listener === 'number' ? from_seq_or_listener : 0;
    const listener =
      typeof from_seq_or_listener === 'function' ? from_seq_or_listener : maybe_listener;
    if (!listener) throw new Error('listener is required');
    for (const event of this.read(stream_id, from_seq)) listener(event);
    const stream_listeners = this.listeners.get(stream_id) ?? new Set<EventListener>();
    stream_listeners.add(listener);
    this.listeners.set(stream_id, stream_listeners);
    return () => {
      stream_listeners.delete(listener);
      if (stream_listeners.size === 0) this.listeners.delete(stream_id);
    };
  }

  public close(): void {
    this.listeners.clear();
    this.database.close();
  }
}
