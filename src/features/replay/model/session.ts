import { reactive } from 'vue'
import type { FrameInput } from '@/shared/commands'
import type { PinballDocument } from '@/shared/document'
import { ReplayRecorder } from '@/features/replay/model/recorder'
import { ReplayPlayer } from '@/features/replay/model/player'
import { clearTape, hasTape, loadTape, saveTape } from '@/features/replay/model/store'
import {
  cloneDocument,
  createReplayDoc,
  overwriteDocument,
} from '@/features/replay/model/tape'
import type { ActionEvent, ReplaySource } from '@/features/replay/model/tape'

export type { ActionEvent } from '@/features/replay/model/tape'

export interface ReplayView {
  /** A tape exists (live or saved) and playback can be entered. */
  available: boolean
  open: boolean
  playing: boolean
  positionMs: number
  totalMs: number
  frame: number
  frames: number
  /** The finished tape was written to local storage. */
  saved: boolean
  /** Recording stopped at the ten-minute safety limit. */
  truncated: boolean
}

const ACTION_LOG = 8

/**
 * Owns the recording of the live run, the reserve copy taken when playback is
 * entered, and the playback session itself.
 *
 * Two documents are involved and they never mix: the live game sits frozen
 * behind the replay, while playback paints a private throwaway document.  That
 * document is simulated with record commits disabled, so reviewing a run can
 * never write history, challenge goals or a best score.
 */
export function createReplaySession(live: PinballDocument) {
  const recorder = new ReplayRecorder()
  const replayDoc = reactive(createReplayDoc())
  const view = reactive<ReplayView>({
    available: false,
    open: false,
    playing: false,
    positionMs: 0,
    totalMs: 0,
    frame: 0,
    frames: 0,
    saved: false,
    truncated: false,
  })

  let source: ReplaySource | null = null
  let player: ReplayPlayer | null = null
  /** The live game as it was the instant playback was entered. */
  let reserve: PinballDocument | null = null
  let frameHandle = 0
  /** Whether a tape from an earlier visit is waiting in local storage. */
  let savedAvailable = hasTape()
  /** True once a run has been launched in this visit. */
  let runStarted = false
  /** True once the current tape has been sealed after its run ended. */
  let sealed = false

  function syncView(): void {
    if (!player) return
    view.playing = player.isPlaying
    view.positionMs = player.positionMs
    view.totalMs = player.totalMs
    view.frame = player.currentFrame
    view.frames = player.frameCount
  }

  function pump(now: number): void {
    frameHandle = 0
    if (!player || !view.open) return
    player.tick(now)
    syncView()
    if (player.isPlaying) frameHandle = requestAnimationFrame(pump)
  }

  function resetView(): void {
    view.available = false
    view.open = false
    view.playing = false
    view.positionMs = 0
    view.totalMs = 0
    view.frame = 0
    view.frames = 0
    view.saved = false
    view.truncated = false
  }

  /**
   * Starts recording for the game that is about to be launched, unless this
   * game already has a tape.  A tape truncated at the ten-minute cap must not
   * be replaced when the next ball is charged.
   */
  function beginRun(doc: PinballDocument = live): void {
    if (runStarted) return
    startRun(doc)
  }

  /** Called by the loop after a launch starts a fresh run. */
  function startRun(doc: PinballDocument = live): void {
    stopPlayback()
    if (reserve) restoreLive()
    // The tape slot belongs to the run that is starting.  Whatever was saved
    // before (a finished game or an abandoned one) is not inherited by it —
    // not even after a reload.
    clearTape()
    recorder.start(doc)
    source = null
    runStarted = true
    sealed = false
    resetView()
    savedAvailable = false
  }

  /** Throws the tape away; a restarted game inherits nothing. */
  function discardRun(): void {
    stopPlayback()
    if (reserve) restoreLive()
    recorder.discard()
    clearTape()
    source = null
    runStarted = false
    sealed = false
    savedAvailable = false
    resetView()
  }

  /**
   * One live frame: stores the inputs and, every KEYFRAME_MS, the simulation
   * state.  Called before the step so the tape lines up with the run.
   */
  function record(input: FrameInput, dtMs: number, doc: PinballDocument = live): void {
    if (!recorder.active) return
    recorder.record(input, dtMs, doc)
    observe()
  }

  /** Reflects tape growth / truncation in the panel while the run goes on. */
  function observe(): void {
    if (recorder.wasTruncated) view.truncated = true
    if (!view.available && recorder.hasTape()) view.available = true
    if (!source && recorder.hasTape()) {
      view.frames = recorder.frameCount
      view.totalMs = recorder.totalMs
    }
  }

  /** Seals the tape when the run ends and keeps a compact copy on disk. */
  function endRun(): void {
    // A tape stopped by the ten-minute cap is still a valid, reviewable tape.
    if (!recorder.hasTape() || sealed) return
    sealed = true
    recorder.finish()
    source = recorder.buildSource()
    view.available = source !== null
    if (source) {
      view.totalMs = source.totalMs
      view.frames = source.count
      view.saved = saveTape(source)
      savedAvailable = savedAvailable || view.saved
    }
  }

  /**
   * Freezes the live game and enters playback.  The live document is cloned
   * first, so `close()` can put the ball, score and bonus clocks back exactly
   * where they were before entering.
   */
  function open(): void {
    if (view.open) return
    // A running game's tape grows; rebuild it so playback covers everything
    // recorded up to this instant.
    if (recorder.active || recorder.hasTape()) source = recorder.buildSource()
    if (!source && !runStarted) {
      source = loadTape()
      savedAvailable = source !== null
    }
    if (!source) return
    reserve = cloneDocument(live)
    // The replay panels show goals/history too; give the replay document a
    // detached copy so nothing it renders is shared with the live records.
    replayDoc.career = clonePlain(live.career)
    replayDoc.history = clonePlain(live.history)
    replayDoc.bestScore = live.bestScore
    player = new ReplayPlayer(source, replayDoc)
    player.seek(0)
    view.open = true
    view.available = true
    view.playing = false
    view.positionMs = 0
    view.totalMs = source.totalMs
    view.frames = source.count
    view.frame = 0
    syncView()
  }

  /** Leaves playback and restores the live game untouched. */
  function close(): void {
    if (!view.open) return
    stopPlayback()
    if (reserve) restoreLive()
    view.open = false
    view.playing = false
    // The live game carries on; keep the panel pointing at the growing tape.
    if (!recorder.active) view.available = source !== null || savedAvailable
  }

  function restoreLive(): void {
    if (!reserve) return
    overwriteDocument(live, reserve)
    reserve = null
  }

  function stopPlayback(): void {
    if (frameHandle) cancelAnimationFrame(frameHandle)
    frameHandle = 0
    player?.pause()
    player = null
  }

  function toggle(): void {
    if (!player) return
    player.toggle()
    syncView()
    if (player.isPlaying && !frameHandle) frameHandle = requestAnimationFrame(pump)
  }

  /** Jumps to an arbitrary instant without changing play/pause. */
  function seek(ms: number): void {
    if (!player) return
    player.seek(ms)
    syncView()
  }

  /**
   * A manual scrub always pauses first and then lands on the requested
   * instant, so the dragged position is not fought by the playback clock.
   */
  function scrub(ms: number): void {
    if (!player) return
    player.pause()
    player.seek(ms)
    syncView()
  }

  /** Frame-by-frame stepping always pauses first. */
  function step(direction: -1 | 1): void {
    if (!player || !source) return
    player.pause()
    if (frameHandle) cancelAnimationFrame(frameHandle)
    frameHandle = 0
    const index = Math.max(0, Math.min(source.count, player.currentFrame + direction))
    player.seek(source.timesMs[index] ?? 0)
    syncView()
  }

  /** The operator actions recorded up to the playhead, newest first. */
  function recentActions(): ActionEvent[] {
    if (!source || !view.open) return []
    const actions = source.actions
    // Actions are sorted by time; find the first one past the playhead.
    let low = 0
    let high = actions.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if ((actions[mid]?.t ?? 0) <= view.positionMs) low = mid + 1
      else high = mid
    }
    return actions.slice(Math.max(0, low - ACTION_LOG), low).reverse()
  }

  function canOpen(): boolean {
    if (view.available || recorder.hasTape()) return true
    return !runStarted && savedAvailable
  }

  return {
    recorder,
    view,
    replayDoc,
    startRun,
    beginRun,
    discardRun,
    record,
    observe,
    endRun,
    open,
    close,
    toggle,
    seek,
    scrub,
    step,
    recentActions,
    canOpen,
  }
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
