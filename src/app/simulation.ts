import type { FrameInput } from '@/shared/commands'
import type { PinballDocument } from '@/shared/document'
import { absorbZones, tickBonus } from '@/features/bonus'
import { advanceControls } from '@/features/flippers'
import { simulateBall } from '@/features/scoring'
import { anchors, consumeContacts, publishGates, sampleRamp, sampleScoop, stickPlunger, syncTable } from '@/features/table'
import { applyDrain } from '@/app/cabinet-actions'

/**
 * One deterministic simulation step.  The live loop and the replay player both
 * go through here, which is what guarantees a replay shows the same score and
 * mechanism state that were on screen at that instant.
 *
 * `commit` is false for replay: draining still works, but nothing may write
 * history, career goals or the stored best score.
 */
export function advanceSimulation(doc: PinballDocument, input: FrameInput, dtMs: number, commit: boolean): void {
  if (doc.phase !== 'paused' && doc.note.ms > 0) doc.note.ms -= dtMs
  if (doc.phase === 'paused' || doc.phase === 'gameover') return

  advanceControls(doc, input, dtMs, anchors())
  if (doc.ball.held === 'plunger') stickPlunger(doc)
  if (doc.phase !== 'playing') return

  doc.run.playMs += dtMs
  tickBonus(doc, dtMs)
  const solids = syncTable(doc, dtMs)
  if (doc.ball.held !== 'plunger') {
    const events = simulateBall(doc, solids, dtMs, { ramp: sampleRamp, scoop: sampleScoop })
    consumeContacts(doc, events)
    absorbZones(doc, events)
    publishGates(doc)
    if (doc.signals.drain) applyDrain(doc, commit)
  }
}

/** True when a frame in this phase actually advances the simulation. */
export function phaseAdvances(phase: PinballDocument['phase']): boolean {
  return phase === 'ready' || phase === 'playing'
}
