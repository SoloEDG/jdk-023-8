import type { PinballDocument } from '@/shared/document'
import { advanceSimulation } from '@/app/simulation'
import {
  frameDtMs,
  frameMask,
  restoreState,
  unpackInput,
  type ReplaySource,
  type SimState,
} from '@/features/replay/model/tape'

/**
 * Plays back a recorded run on a private document.
 *
 * A run only exists at frame boundaries, so the player always shows the
 * boundary at or before the playhead.  That keeps the score and every
 * mechanism identical to what was on screen at that moment.
 *
 * Seeking backward restores the nearest earlier keyframe and simulates at
 * most KEYFRAME_MS forward, so dragging the slider lands on an arbitrary
 * instant quickly instead of replaying from the start.  Playback owns its own
 * clock: pausing it only pauses the replay, never the live game.
 */
export class ReplayPlayer {
  private readonly source: ReplaySource
  private readonly doc: PinballDocument
  /** Index of the next frame to apply. */
  private frameIndex = 0
  /** Requested playhead in ms; may sit between frame boundaries. */
  private playheadMs = 0
  private playing = false
  private lastTick = 0

  constructor(source: ReplaySource, doc: PinballDocument) {
    this.source = source
    this.doc = doc
    const first = source.keyframes[0]
    if (first) restoreState(this.doc, first)
  }

  get document(): PinballDocument {
    return this.doc
  }

  get totalMs(): number {
    return this.source.totalMs
  }

  get positionMs(): number {
    return this.playheadMs
  }

  get currentFrame(): number {
    return this.frameIndex
  }

  get frameCount(): number {
    return this.source.count
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get atEnd(): boolean {
    return this.playheadMs >= this.source.totalMs
  }

  play(): void {
    if (this.atEnd) this.seek(0)
    this.playing = true
    this.lastTick = performance.now()
  }

  pause(): void {
    this.playing = false
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /**
   * Moves the playhead to `ms` and updates the document.  Forward seeks
   * continue from the current boundary; backward seeks resume from the
   * nearest keyframe.
   */
  seek(ms: number): void {
    const target = Math.max(0, Math.min(this.source.totalMs, Math.round(ms)))
    const targetFrame = this.frameAt(target)
    if (targetFrame >= this.frameIndex) {
      this.applyUntil(targetFrame)
      this.playheadMs = target
      return
    }
    const anchor = this.keyframeBefore(targetFrame) ?? this.source.keyframes[0]
    if (!anchor) return
    restoreState(this.doc, anchor)
    this.frameIndex = anchor.f
    this.playheadMs = this.source.timesMs[anchor.f] ?? 0
    this.applyUntil(targetFrame)
    this.playheadMs = target
  }

  /** Advances by wall-clock time while playing. */
  tick(now: number): void {
    if (!this.playing) return
    const delta = Math.min(64, Math.max(0, now - this.lastTick))
    this.lastTick = now
    this.advance(delta)
  }

  /**
   * Advances the playhead by `deltaMs` of tape time.
   * @returns true once the tape has been played to its end.
   */
  advance(deltaMs: number): boolean {
    if (this.atEnd) {
      this.playing = false
      return true
    }
    this.seek(this.playheadMs + Math.max(0, deltaMs))
    if (this.atEnd) this.playing = false
    return this.atEnd
  }

  /** Number of frames fully covered by the playhead. */
  private frameAt(ms: number): number {
    const times = this.source.timesMs
    // `times` has count + 1 entries: boundary k is times[k].
    let low = 0
    let high = this.source.count + 1
    while (low < high) {
      const mid = (low + high) >>> 1
      if ((times[mid] ?? Infinity) <= ms) low = mid + 1
      else high = mid
    }
    return Math.max(0, Math.min(this.source.count, low - 1))
  }

  private applyUntil(targetFrame: number): void {
    while (this.frameIndex < targetFrame) {
      const raw = this.source.frames[this.frameIndex] ?? 0
      advanceSimulation(this.doc, unpackInput(frameMask(raw)), frameDtMs(raw), false)
      this.frameIndex += 1
    }
  }

  private keyframeBefore(frame: number): SimState | null {
    let best: SimState | null = null
    for (const state of this.source.keyframes) {
      if (state.f > frame) break
      best = state
    }
    return best
  }
}
