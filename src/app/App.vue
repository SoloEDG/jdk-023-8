<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { createInputController } from '@/app/input-map'
import { runFrame, startLoop } from '@/app/game-loop'
import { restartGame, togglePause } from '@/app/cabinet-actions'
import { createDocument } from '@/shared/document'
import { BonusBanner, ChainMeter } from '@/features/bonus'
import { ControlDeck, TiltLamp } from '@/features/flippers'
import { ChallengeBoard, HistoryList, persist, readSave, ResultCard } from '@/features/records'
import { createReplaySession, ReplayPanel } from '@/features/replay'
import { EventTicker, ScoreHud } from '@/features/scoring'
import { MechanismPanel, mountFresh, TableView } from '@/features/table'

const live = reactive(createDocument())
mountFresh(live, readSave())
const input = createInputController(window)
const replay = createReplaySession(live)
/** The cabinet shows the live game, or the replay document while one is open. */
const doc = computed(() => (replay.view.open ? replay.replayDoc : live))
let stop = (): void => {}

onMounted(() => {
  stop = startLoop(
    {
      frame: onFrame,
      onHide: () => persist(live),
      onLeave: () => persist(live),
    },
    () => input.snapshot(),
  )
})

onBeforeUnmount(() => {
  stop()
  input.destroy()
  replay.close()
})

function onFrame(frameInput: ReturnType<typeof input.snapshot>, dtMs: number): void {
  // While a replay is open the live game is frozen: its inputs are dropped and
  // no simulation step runs, so reviewing a replay cannot advance the run.
  if (replay.view.open) {
    // P merely pauses the replay itself; it never reaches the live game.
    if (frameInput.pauseEdge) replay.toggle()
    return
  }

  if (frameInput.restartEdge) {
    // A new game starts clean; the previous tape is discarded, not inherited.
    replay.discardRun()
    restartGame(live)
    return
  }
  if (frameInput.pauseEdge) {
    togglePause(live)
    return
  }
  if (live.phase === 'paused' || live.phase === 'gameover') return

  // Start the tape as soon as the ball is charged for a launch: that is the
  // beginning of the run the player will want to review.
  const charging =
    live.phase === 'ready' && live.ball.held === 'plunger' && frameInput.plunger && !replay.recorder.active
  if (charging) replay.beginRun(live)

  const outcome = runFrame(live, frameInput, dtMs, replay.recorder)
  replay.observe()
  if (outcome === 'ended') replay.endRun()
}

const canPause = computed(
  () => !replay.view.open && (live.phase === 'ready' || live.phase === 'playing' || live.phase === 'paused'),
)
const plungerReady = computed(
  () => !replay.view.open && live.ball.held === 'plunger' && live.phase !== 'paused' && live.phase !== 'gameover',
)

function onPlunger(down: boolean): void {
  if (replay.view.open) return
  if (down) input.setPlunger(true)
  else input.releasePlunger()
}

/** Deck hold controls never reach the live game while a replay is open. */
function onLeft(down: boolean): void {
  if (!replay.view.open) input.setLeft(down)
}

function onRight(down: boolean): void {
  if (!replay.view.open) input.setRight(down)
}

function onNudge(direction: -1 | 1): void {
  if (!replay.view.open) input.pulseNudge(direction)
}

function onDeckPause(): void {
  if (!replay.view.open) input.pulsePause()
}

function onDeckRestart(): void {
  if (!replay.view.open) input.pulseRestart()
}
</script>

<template>
  <div class="hall">
    <main class="cabinet">
      <header class="backglass">
        <div class="bulb-row" aria-hidden="true">
          <i v-for="index in 11" :key="index" :style="{ animationDelay: `${index * 0.12}s` }"></i>
        </div>
        <div class="marquee">
          <p class="marquee-kicker">街机弹球</p>
          <h1>霓虹弹珠厅</h1>
        </div>
        <ScoreHud :doc="doc" />
      </header>

      <section class="play-row">
        <div class="table-wrap">
          <TableView :doc="doc" />
          <p class="how">
            A 与左 Shift 是左挡板，D 与右 Shift 是右挡板。按住空格蓄力，松开把球打上发射槽。Q、E 轻推，三次会倾斜。P 暂停。
          </p>
        </div>
        <aside class="side">
          <TiltLamp :warnings="doc.nudge.warnings" :tilted="doc.nudge.tilted" />
          <BonusBanner :doc="doc" />
          <ResultCard :doc="doc" />
          <ChainMeter :doc="doc" />
          <EventTicker :doc="doc" />
          <ChallengeBoard :doc="doc" />
          <MechanismPanel :doc="doc" />
          <HistoryList :doc="doc" />
          <ReplayPanel
            :view="replay.view"
            :ready="replay.view.open || replay.canOpen()"
            cold-hint="把球打出去，操作和每一帧的时间就会边打边记下来。"
            :actions="replay.recentActions()"
            @open="replay.open"
            @close="replay.close"
            @toggle="replay.toggle"
            @scrub="replay.scrub"
            @step="replay.step"
          />
        </aside>
      </section>

      <ControlDeck
        :plunger-power="doc.plunger.power"
        :plunger-ready="plungerReady"
        :paused="!replay.view.open && live.phase === 'paused'"
        :can-pause="canPause"
        :replay-open="replay.view.open"
        @left="onLeft"
        @right="onRight"
        @plunger="onPlunger"
        @nudge-left="onNudge(-1)"
        @nudge-right="onNudge(1)"
        @pause="onDeckPause"
        @restart="onDeckRestart"
      />
    </main>
  </div>
</template>
