import type { FrameInput } from '@/shared/commands'
import type { PinballDocument } from '@/shared/document'
import type { ReplayRecorder } from '@/features/replay/model/recorder'
import { syncRecords } from '@/features/records'
import { advanceSimulation } from '@/app/simulation'

export type FrameOutcome = 'running' | 'ended'

/**
 * Advances the live game by one frame.
 *
 * The recorder is fed *before* the step so its keyframes describe the state at
 * the start of the frame they belong to; replaying then reproduces the exact
 * run.  Pause and restart are cabinet commands handled by the caller and are
 * deliberately absent from the tape.
 */
export function runFrame(
  doc: PinballDocument,
  input: FrameInput,
  dtMs: number,
  recorder: ReplayRecorder | null,
): FrameOutcome {
  if (doc.phase === 'paused' || doc.phase === 'gameover') return 'ended'
  recorder?.record(input, dtMs, doc)
  advanceSimulation(doc, input, dtMs, true)
  syncRecords(doc)
  // The simulation may have just ended the run; read through a helper so
  // TypeScript does not keep the pre-step narrowing.
  return phaseOf(doc) === 'gameover' ? 'ended' : 'running'
}

function phaseOf(doc: PinballDocument): PinballDocument['phase'] {
  return doc.phase
}

export interface LoopHandlers {
  /** Called once per animation frame with the input snapshot and elapsed ms. */
  frame: (input: FrameInput, dtMs: number) => void
  /** Invoked when the tab becomes hidden. */
  onHide?: () => void
  /** Invoked before the page unloads. */
  onLeave?: () => void
}

export function startLoop(handlers: LoopHandlers, pull: () => FrameInput): () => void {
  let last = performance.now()
  let handle = 0
  const onHide = (): void => {
    if (document.hidden) handlers.onHide?.()
  }
  const onLeave = (): void => handlers.onLeave?.()
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', onLeave)
  const tick = (now: number): void => {
    // Whole milliseconds keep the live step and the recorded tape identical,
    // so replaying the inputs reproduces the run without accumulating drift.
    const step = Math.min(32, Math.max(0, Math.round(now - last)))
    last = now
    handlers.frame(pull(), step)
    handle = requestAnimationFrame(tick)
  }
  handle = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(handle)
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', onLeave)
  }
}
