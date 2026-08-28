import Database from 'better-sqlite3';

export interface StoredEvent<TPayload = unknown> {
  readonly seq: number;
  readonly streamId: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly createdAt: string;
}

type EventListener = (event: StoredEvent) => void;
type EventRow = {
  seq: number;
  stream_id: string;
  type: string;
  payload: string;
  created_at: string;
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_stream_seq ON events (stream_id, seq);
    `);
    this.insertEvent = this.database.prepare(
      'INSERT INTO events (stream_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
    );
  }

  public append<TPayload>(streamId: string, type: string, payload: TPayload): number {
    if (!streamId) throw new Error('streamId is required');
    if (!type) throw new Error('event type is required');
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) throw new Error('event payload must be JSON serializable');
    const createdAt = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const result = this.insertEvent.run(streamId, type, serializedPayload, createdAt);
      return Number(result.lastInsertRowid);
    });
    const seq = transaction();
    const event: StoredEvent<TPayload> = {
      seq,
      streamId,
      type,
      payload,
      createdAt,
    };
    for (const listener of this.listeners.get(streamId) ?? []) listener(event);
    return seq;
  }

  public read<TPayload = unknown>(streamId: string, fromSeq = 0): StoredEvent<TPayload>[] {
    if (!streamId) throw new Error('streamId is required');
    if (!Number.isInteger(fromSeq) || fromSeq < 0)
      throw new Error('fromSeq must be a non-negative integer');
    const rows = this.database
      .prepare(
        'SELECT seq, stream_id, type, payload, created_at FROM events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(streamId, fromSeq) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      streamId: row.stream_id,
      type: row.type,
      payload: JSON.parse(row.payload) as TPayload,
      createdAt: row.created_at,
    }));
  }

  public latestSequence(streamId?: string): number {
    if (streamId) {
      const row = this.database
        .prepare('SELECT seq FROM events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1')
        .get(streamId) as { seq?: number } | undefined;
      return row?.seq ?? 0;
    }
    const row = this.database.prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1').get() as
      { seq?: number } | undefined;
    return row?.seq ?? 0;
  }

  public subscribe(streamId: string, listener: EventListener): () => void;
  public subscribe(streamId: string, fromSeq: number, listener: EventListener): () => void;
  public subscribe(
    streamId: string,
    fromSeqOrListener: number | EventListener,
    maybeListener?: EventListener,
  ): () => void {
    const fromSeq = typeof fromSeqOrListener === 'number' ? fromSeqOrListener : 0;
    const listener = typeof fromSeqOrListener === 'function' ? fromSeqOrListener : maybeListener;
    if (!listener) throw new Error('listener is required');
    for (const event of this.read(streamId, fromSeq)) listener(event);
    const streamListeners = this.listeners.get(streamId) ?? new Set<EventListener>();
    streamListeners.add(listener);
    this.listeners.set(streamId, streamListeners);
    return () => {
      streamListeners.delete(listener);
      if (streamListeners.size === 0) this.listeners.delete(streamId);
    };
  }

  public close(): void {
    this.listeners.clear();
    this.database.close();
  }
}
