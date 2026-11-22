import type { FrameInput } from '@/shared/commands'
import type { PinballDocument } from '@/shared/document'
import {
  KEYFRAME_MS,
  MAX_TAPE_FRAMES,
  MAX_TAPE_MS,
  buildActions,
  buildTimes,
  captureState,
  frameDtMs,
  packFrame,
  type ReplaySource,
  type SimState,
} from '@/features/replay/model/tape'

const INITIAL_FRAMES = 4096
/** Streaming keyframes keep memory linear in time and seeking bounded. */
const MAX_KEYFRAMES = Math.ceil(MAX_TAPE_MS / KEYFRAME_MS) + 2

/**
 * Records the live run frame by frame.
 *
 * Each frame costs 16 bits: the pressed inputs and that frame's elapsed time.
 * Every KEYFRAME_MS a complete simulation state is also stored.  Replaying
 * therefore never needs to store a full table per frame (which would fill the
 * local-storage quota), yet seeking back still only re-simulates at most the
 * distance to the nearest keyframe instead of the whole game.
 *
 * The recorder is passive: it reads the document, never writes to it.
 */
export class ReplayRecorder {
  private frames = new Uint16Array(INITIAL_FRAMES)
  private count = 0
  private keyframes: SimState[] = []
  private elapsedMs = 0
  private nextKeyMs = KEYFRAME_MS
  private recording = false
  private truncated = false

  get active(): boolean {
    return this.recording
  }

  get wasTruncated(): boolean {
    return this.truncated
  }

  get frameCount(): number {
    return this.count
  }

  get totalMs(): number {
    return this.elapsedMs
  }

  /** Begins a brand-new tape; the current state becomes keyframe 0. */
  start(doc: PinballDocument): void {
    this.clear()
    this.keyframes.push(captureState(doc, 0))
    this.recording = true
  }

  /** Forgets the tape entirely. A restarted game must inherit nothing. */
  discard(): void {
    this.clear()
  }

  /**
   * Appends the frame that is about to be simulated.  Must be called with the
   * document state *before* that step, so keyframes and frames line up.
   */
  record(input: FrameInput, dtMs: number, doc: PinballDocument): void {
    if (!this.recording) return
    if (this.count >= MAX_TAPE_FRAMES || this.elapsedMs >= MAX_TAPE_MS) {
      this.recording = false
      this.truncated = true
      return
    }
    if (this.elapsedMs >= this.nextKeyMs) {
      // Keyframe 0 is the anchor every backward seek falls back to, so it is
      // never dropped. Once the cap is hit (unreachable before MAX_TAPE_MS)
      // recording continues with the existing keyframes.
      if (this.keyframes.length < MAX_KEYFRAMES) {
        this.keyframes.push(captureState(doc, this.count))
      }
      this.nextKeyMs = this.elapsedMs + KEYFRAME_MS
    }
    const step = Math.max(0, Math.min(1023, Math.round(dtMs)))
    this.push(packFrame(input, step))
    this.elapsedMs += step
  }

  /** Stops accepting frames; the run has ended. */
  finish(): void {
    this.recording = false
  }

  hasTape(): boolean {
    return this.count > 1
  }

  /** Builds the immutable source handed to the player. */
  buildSource(): ReplaySource | null {
    if (this.count < 2) return null
    const frames = this.frames.slice(0, this.count)
    let totalMs = 0
    for (let index = 0; index < this.count; index += 1) totalMs += frameDtMs(frames[index] ?? 0)
    const keyframes = this.keyframes
      .filter((state) => state.f <= this.count)
      .slice()
      .sort((a, b) => a.f - b.f)
    const timesMs = buildTimes(frames, this.count)
    return {
      frames,
      count: this.count,
      keyframes,
      timesMs,
      totalMs,
      actions: buildActions(frames, this.count, timesMs),
    }
  }

  private clear(): void {
    this.frames = new Uint16Array(INITIAL_FRAMES)
    this.count = 0
    this.keyframes = []
    this.elapsedMs = 0
    this.nextKeyMs = KEYFRAME_MS
    this.recording = false
    this.truncated = false
  }

  private push(value: number): void {
    if (this.count === this.frames.length) {
      const grown = new Uint16Array(this.frames.length * 2)
      grown.set(this.frames)
      this.frames = grown
    }
    this.frames[this.count] = value
    this.count += 1
  }
}
