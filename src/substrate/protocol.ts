import { endianness } from 'node:os';

export const PACKET_HEADER_BYTES = 8;
export const MAX_PAYLOAD_BYTES = 4088;

export const MESSAGE_TYPES = {
  content: 0,
  attach: 1,
  detach: 2,
  resize: 3,
  exit: 4,
  pid: 5,
} as const;

const isLittleEndian = endianness() === 'LE';

export interface AbducoFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

function readUInt32(buffer: Buffer, offset: number): number {
  return isLittleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function writeUInt32(buffer: Buffer, value: number, offset: number): void {
  if (isLittleEndian) buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}

export function decodeUint32(payload: Uint8Array): number {
  if (payload.length < 4)
    throw new Error(`abduco uint32 payload must be at least 4 bytes, got ${payload.length}`);
  const buffer = Buffer.from(payload);
  return isLittleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 0xffffffff)
    throw new RangeError(`abduco packet type must be a uint32: ${type}`);
  if (payload.length > MAX_PAYLOAD_BYTES)
    throw new RangeError(`abduco packet payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  const frame = Buffer.allocUnsafe(PACKET_HEADER_BYTES + payload.length);
  writeUInt32(frame, type, 0);
  writeUInt32(frame, payload.length, 4);
  Buffer.from(payload).copy(frame, PACKET_HEADER_BYTES);
  return frame;
}

export function encodeUint32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new RangeError(`abduco uint32 value is invalid: ${value}`);
  const payload = Buffer.allocUnsafe(4);
  writeUInt32(payload, value, 0);
  return payload;
}

export function encodeResize(rows: number, cols: number): Buffer {
  if (!Number.isInteger(rows) || rows < 0 || rows > 0xffff)
    throw new RangeError(`abduco row count is invalid: ${rows}`);
  if (!Number.isInteger(cols) || cols < 0 || cols > 0xffff)
    throw new RangeError(`abduco column count is invalid: ${cols}`);
  const payload = Buffer.allocUnsafe(4);
  if (isLittleEndian) {
    payload.writeUInt16LE(rows, 0);
    payload.writeUInt16LE(cols, 2);
  } else {
    payload.writeUInt16BE(rows, 0);
    payload.writeUInt16BE(cols, 2);
  }
  return payload;
}

export function decodeUint64(payload: Uint8Array): bigint {
  if (payload.length !== 8)
    throw new Error(`abduco PID payload must be 8 bytes, got ${payload.length}`);
  const buffer = Buffer.from(payload);
  return isLittleEndian ? buffer.readBigUInt64LE(0) : buffer.readBigUInt64BE(0);
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  public push(chunk: Uint8Array): AbducoFrame[] {
    if (chunk.length > 0)
      this.buffered =
        this.buffered.length > 0 ? Buffer.concat([this.buffered, chunk]) : Buffer.from(chunk);

    const frames: AbducoFrame[] = [];
    let offset = 0;
    while (this.buffered.length - offset >= PACKET_HEADER_BYTES) {
      const type = readUInt32(this.buffered, offset);
      const length = readUInt32(this.buffered, offset + 4);
      if (length > MAX_PAYLOAD_BYTES)
        throw new RangeError(`abduco packet payload exceeds ${MAX_PAYLOAD_BYTES} bytes: ${length}`);
      const frameEnd = offset + PACKET_HEADER_BYTES + length;
      if (this.buffered.length < frameEnd) break;
      frames.push({
        type,
        payload: Uint8Array.from(this.buffered.subarray(offset + PACKET_HEADER_BYTES, frameEnd)),
      });
      offset = frameEnd;
    }
    if (offset > 0) this.buffered = this.buffered.subarray(offset);
    return frames;
  }

  public get pendingBytes(): number {
    return this.buffered.length;
  }
}

export const encodePacket = encodeFrame;
export const PacketDecoder = FrameDecoder;
