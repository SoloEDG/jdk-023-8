import { STORAGE_KEY } from '@/shared/ids'
import { buildActions, buildTimes, type ReplaySource, type SimState } from '@/features/replay/model/tape'

export const REPLAY_STORAGE_KEY = `${STORAGE_KEY}.replay`
/**
 * The compact format is deliberately far below the usual 5 MB origin quota:
 * inputs are packed two bytes per frame and only sparse keyframes are kept.
 */
const MAX_STORED_CHARS = 2_400_000

interface StoredTape {
  v: 1
  count: number
  /** Base64 of little-endian uint16 frames (input mask + elapsed ms). */
  frames: string
  keyframes: SimState[]
  savedAt: number
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let index = 0; index < BASE64.length; index += 1) table[BASE64.charCodeAt(index)] = index
  return table
})()

export function encodeBytes(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    out += BASE64[a >> 2]
    out += BASE64[((a & 3) << 4) | (b >> 4)]
    out += index + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '='
    out += index + 2 < bytes.length ? BASE64[c & 63] : '='
  }
  return out
}

export function decodeBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let out = 0
  let buffer = 0
  let bits = 0
  for (let index = 0; index < clean.length; index += 1) {
    const code = clean.charCodeAt(index)
    const value = code < 128 ? LOOKUP[code] ?? -1 : -1
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[out] = (buffer >> bits) & 255
      out += 1
    }
  }
  return bytes.subarray(0, out)
}

function framesToBytes(frames: Uint16Array, count: number): Uint8Array {
  const bytes = new Uint8Array(count * 2)
  for (let index = 0; index < count; index += 1) {
    const value = frames[index] ?? 0
    bytes[index * 2] = value & 255
    bytes[index * 2 + 1] = value >> 8
  }
  return bytes
}

function bytesToFrames(bytes: Uint8Array, count: number): Uint16Array {
  const frames = new Uint16Array(count)
  for (let index = 0; index < count; index += 1) {
    frames[index] = (bytes[index * 2] ?? 0) | ((bytes[index * 2 + 1] ?? 0) << 8)
  }
  return frames
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** Keeps the tape across visits without ever storing every frame's table. */
export function saveTape(source: ReplaySource): boolean {
  const bin = storage()
  if (!bin) return false
  const payload: StoredTape = {
    v: 1,
    count: source.count,
    frames: encodeBytes(framesToBytes(source.frames, source.count)),
    keyframes: source.keyframes,
    savedAt: Date.now(),
  }
  let text: string
  try {
    // A ball that left the table can make a coordinate non-finite; JSON has
    // no representation for that, so clamp it in the final keyframe.
    text = JSON.stringify(payload, (_key, value) =>
      typeof value === 'number' && !Number.isFinite(value) ? 0 : value,
    )
  } catch {
    return false
  }
  if (text.length > MAX_STORED_CHARS) return false
  try {
    bin.setItem(REPLAY_STORAGE_KEY, text)
    return true
  } catch {
    return false
  }
}

export function loadTape(): ReplaySource | null {
  const bin = storage()
  if (!bin) return null
  try {
    const text = bin.getItem(REPLAY_STORAGE_KEY)
    if (!text) return null
    const parsed = JSON.parse(text) as Partial<StoredTape>
    if (parsed.v !== 1 || typeof parsed.frames !== 'string') return null
    if (typeof parsed.count !== 'number' || parsed.count < 2) return null
    if (!Array.isArray(parsed.keyframes) || parsed.keyframes.length === 0) return null
    const keyframes = parsed.keyframes.filter(isSimState).sort((a, b) => a.f - b.f)
    if (keyframes.length === 0 || keyframes[0]!.f !== 0) return null
    const bytes = decodeBytes(parsed.frames)
    if (bytes.length < parsed.count * 2) return null
    const frames = bytesToFrames(bytes, parsed.count)
    const timesMs = buildTimes(frames, parsed.count)
    return {
      frames,
      count: parsed.count,
      keyframes,
      timesMs,
      totalMs: timesMs[parsed.count] ?? 0,
      actions: buildActions(frames, parsed.count, timesMs),
    }
  } catch {
    return null
  }
}

export function clearTape(): void {
  const bin = storage()
  if (!bin) return
  try {
    bin.removeItem(REPLAY_STORAGE_KEY)
  } catch {
    // Storage being unavailable never affects the in-memory tape.
  }
}

/** Cheap existence check; avoids parsing the tape at startup. */
export function hasTape(): boolean {
  const bin = storage()
  if (!bin) return false
  try {
    return bin.getItem(REPLAY_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

function isSimState(value: unknown): value is SimState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<SimState>
  return typeof state.f === 'number' && Array.isArray(state.mech)
}
