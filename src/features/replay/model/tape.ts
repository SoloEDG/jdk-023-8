import { idleInput, type FrameInput } from '@/shared/commands'
import { createDocument, type HoldKind, type Phase, type PinballDocument } from '@/shared/document'
import { createMechanisms } from '@/features/table/model/mechanism-rules'

/**
 * How often a full simulation keyframe is captured while recording.  Seeking
 * backwards then only has to re-simulate at most this much, never the whole
 * game from the start.
 */
export const KEYFRAME_MS = 2000
/** Safety valve: a tape longer than ten minutes stops growing. */
export const MAX_TAPE_MS = 600_000
export const MAX_TAPE_FRAMES = 72_000

/**
 * Inputs that are replayed.  Pause and restart are cabinet commands, not part
 * of a run, so they never enter the tape.
 */
const INPUT_BITS = ['left', 'right', 'plunger', 'plungerReleased', 'nudgeLeft', 'nudgeRight'] as const
const INPUT_BITS_COUNT = INPUT_BITS.length
const INPUT_MASK = (1 << INPUT_BITS_COUNT) - 1
const DT_SHIFT = INPUT_BITS_COUNT
const DT_MAX = (1 << (16 - DT_SHIFT)) - 1

/** One packed frame: low bits are the input mask, the rest the elapsed ms. */
export function packFrame(input: FrameInput, dtMs: number): number {
  let mask = 0
  for (let index = 0; index < INPUT_BITS_COUNT; index += 1) {
    if (input[INPUT_BITS[index]]) mask |= 1 << index
  }
  return (Math.min(DT_MAX, Math.max(0, dtMs)) << DT_SHIFT) | (mask & INPUT_MASK)
}

export function frameMask(frame: number): number {
  return frame & INPUT_MASK
}

export function frameDtMs(frame: number): number {
  return frame >>> DT_SHIFT
}

export function unpackInput(mask: number): FrameInput {
  const input = idleInput()
  for (let index = 0; index < INPUT_BITS_COUNT; index += 1) {
    input[INPUT_BITS[index]] = (mask & (1 << index)) !== 0
  }
  return input
}

/**
 * The complete simulation state at a frame boundary.
 *
 * Career goals, history and the stored best score are intentionally absent:
 * a replay can only ever touch the table, never the record book.  Every timer
 * is an integer millisecond because the live loop quantises its delta, so
 * resuming from a keyframe reproduces the recorded run exactly.
 */
export interface SimState {
  /** Frame index this state belongs to (frames [0, f) have been applied). */
  f: number
  phase: Phase
  score: number
  ballsLeft: number
  bx: number
  by: number
  bvx: number
  bvy: number
  br: number
  held: HoldKind
  holdMs: number
  rideMs: number
  rideDur: number
  idleMs: number
  la: number
  lo: number
  lh: number
  ra: number
  ro: number
  rh: number
  pp: number
  pc: number
  nw: number
  ntilt: number
  nflashMs: number
  nflashDir: number
  gate: number
  chainCount: number
  chainZone: string | null
  chainRemain: number
  chainBonus: number
  chainMult: number
  liveEntries: number
  liveBanks: number
  liveTilted: number
  liveBankPending: number
  liveBankReset: number
  /** Five slots per mechanism: flags, cooldownMs, openMs, spin, spinOmega. */
  mech: number[]
  feed: [string, number][]
  feedSeq: number
  noteText: string
  noteMs: number
  playMs: number
  launched: number
  drain: number
}

export function captureState(doc: PinballDocument, f: number): SimState {
  return {
    f,
    phase: doc.phase,
    score: doc.score,
    ballsLeft: doc.ballsLeft,
    bx: doc.ball.x,
    by: doc.ball.y,
    bvx: doc.ball.vx,
    bvy: doc.ball.vy,
    br: doc.ball.radius,
    held: doc.ball.held,
    holdMs: doc.ball.holdMs,
    rideMs: doc.ball.rideMs,
    rideDur: doc.ball.rideDur,
    idleMs: doc.ball.idleMs,
    la: doc.flippers.left.angle,
    lo: doc.flippers.left.omega,
    lh: doc.flippers.left.held ? 1 : 0,
    ra: doc.flippers.right.angle,
    ro: doc.flippers.right.omega,
    rh: doc.flippers.right.held ? 1 : 0,
    pp: doc.plunger.power,
    pc: doc.plunger.charging ? 1 : 0,
    nw: doc.nudge.warnings,
    ntilt: doc.nudge.tilted ? 1 : 0,
    nflashMs: doc.nudge.flashMs,
    nflashDir: doc.nudge.flashDir,
    gate: doc.gates.rampOpen ? 1 : 0,
    chainCount: doc.chain.count,
    chainZone: doc.chain.lastZone,
    chainRemain: doc.chain.remainMs,
    chainBonus: doc.chain.bonusMs,
    chainMult: doc.chain.multiplier,
    liveEntries: doc.live.bonusEntries,
    liveBanks: doc.live.bankClears,
    liveTilted: doc.live.tilted ? 1 : 0,
    liveBankPending: doc.live.bankPending ? 1 : 0,
    liveBankReset: doc.live.bankResetMs,
    mech: doc.mechanisms.flatMap((item) => [
      (item.up ? 1 : 0) | (item.lamp << 1) | (item.lit ? 8 : 0),
      item.cooldownMs,
      item.openMs,
      item.spin,
      item.spinOmega,
    ]),
    feed: doc.feed.map((item) => [item.text, item.points] as [string, number]),
    feedSeq: doc.feedSeq,
    noteText: doc.note.text,
    noteMs: doc.note.ms,
    playMs: doc.run.playMs,
    launched: doc.run.launched ? 1 : 0,
    drain: doc.signals.drain ? 1 : 0,
  }
}

/** Writes a keyframe over `target`; career/history are left untouched. */
export function restoreState(target: PinballDocument, state: SimState): void {
  target.phase = state.phase
  target.score = state.score
  target.ballsLeft = state.ballsLeft
  target.ball.x = state.bx
  target.ball.y = state.by
  target.ball.vx = state.bvx
  target.ball.vy = state.bvy
  target.ball.radius = state.br
  target.ball.held = state.held
  target.ball.holdMs = state.holdMs
  target.ball.rideMs = state.rideMs
  target.ball.rideDur = state.rideDur
  target.ball.idleMs = state.idleMs
  target.flippers.left.angle = state.la
  target.flippers.left.omega = state.lo
  target.flippers.left.held = state.lh === 1
  target.flippers.right.angle = state.ra
  target.flippers.right.omega = state.ro
  target.flippers.right.held = state.rh === 1
  target.plunger.power = state.pp
  target.plunger.charging = state.pc === 1
  target.nudge.warnings = state.nw
  target.nudge.tilted = state.ntilt === 1
  target.nudge.flashMs = state.nflashMs
  target.nudge.flashDir = state.nflashDir === 1 || state.nflashDir === -1 ? state.nflashDir : 0
  target.gates.rampOpen = state.gate === 1
  target.chain.count = state.chainCount
  target.chain.lastZone = state.chainZone
  target.chain.remainMs = state.chainRemain
  target.chain.bonusMs = state.chainBonus
  target.chain.multiplier = state.chainMult
  target.live.bonusEntries = state.liveEntries
  target.live.bankClears = state.liveBanks
  target.live.tilted = state.liveTilted === 1
  target.live.bankPending = state.liveBankPending === 1
  target.live.bankResetMs = state.liveBankReset
  if (target.mechanisms.length * 5 !== state.mech.length) target.mechanisms = createMechanisms()
  for (let index = 0; index < target.mechanisms.length; index += 1) {
    const item = target.mechanisms[index]
    const offset = index * 5
    if (!item) continue
    const flags = state.mech[offset] ?? 0
    item.up = (flags & 1) !== 0
    item.lamp = (flags >> 1) & 3
    item.lit = (flags & 8) !== 0
    item.cooldownMs = state.mech[offset + 1] ?? 0
    item.openMs = state.mech[offset + 2] ?? 0
    item.spin = state.mech[offset + 3] ?? 0
    item.spinOmega = state.mech[offset + 4] ?? 0
  }
  target.feed.splice(
    0,
    target.feed.length,
    ...state.feed.map(([text, points], index) => ({ uid: state.feedSeq - index, text, points })),
  )
  target.feedSeq = state.feedSeq
  target.note.text = state.noteText
  target.note.ms = state.noteMs
  target.run.playMs = state.playMs
  target.run.launched = state.launched === 1
  target.signals.drain = state.drain === 1
}

/** A replay-only document: mechanisms exist, but no stored records. */
export function createReplayDoc(): PinballDocument {
  const doc = createDocument()
  doc.mechanisms = createMechanisms()
  return doc
}

/** Deep copy of a live document, used to remember the game before replay. */
export function cloneDocument(doc: PinballDocument): PinballDocument {
  return JSON.parse(JSON.stringify(doc)) as PinballDocument
}

/**
 * Restores a cloned document over the existing (reactive) one in place, so
 * the live object identity and every reference to it survive.
 */
export function overwriteDocument(target: PinballDocument, source: PinballDocument): void {
  Object.assign(target, cloneDocument(source))
}

export type ActionKind = 'left' | 'right' | 'plunger' | 'release' | 'nudgeLeft' | 'nudgeRight'

export interface ActionEvent {
  t: number
  kind: ActionKind
}

/** Turns the recorded inputs into a list of operator actions. */
export function buildActions(frames: Uint16Array, count: number, times: Float64Array): ActionEvent[] {
  const events: ActionEvent[] = []
  let previous = 0
  for (let index = 0; index < count; index += 1) {
    const mask = frameMask(frames[index] ?? 0)
    const t = times[index] ?? 0
    if (mask & 1 && !(previous & 1)) events.push({ t, kind: 'left' })
    if (mask & 2 && !(previous & 2)) events.push({ t, kind: 'right' })
    if (mask & 4 && !(previous & 4)) events.push({ t, kind: 'plunger' })
    if (mask & 8) events.push({ t, kind: 'release' })
    if (mask & 16) events.push({ t, kind: 'nudgeLeft' })
    if (mask & 32) events.push({ t, kind: 'nudgeRight' })
    previous = mask
  }
  return events
}

export interface ReplaySource {
  /** Packed frames. Only the first `count` entries are meaningful. */
  frames: Uint16Array
  count: number
  /** Keyframes, sorted by frame index. Always begins with f = 0. */
  keyframes: SimState[]
  /** Cumulative time in ms at each frame boundary; length count + 1. */
  timesMs: Float64Array
  totalMs: number
  actions: ActionEvent[]
}

export function buildTimes(frames: Uint16Array, count: number): Float64Array {
  const times = new Float64Array(count + 1)
  let elapsed = 0
  for (let index = 0; index < count; index += 1) {
    times[index] = elapsed
    elapsed += frameDtMs(frames[index] ?? 0)
  }
  times[count] = elapsed
  return times
}
