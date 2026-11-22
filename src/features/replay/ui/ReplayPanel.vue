<script setup lang="ts">
import { computed } from 'vue'
import type { ActionEvent } from '@/features/replay/model/tape'
import type { ReplayView } from '@/features/replay/model/session'

const props = defineProps<{
  view: ReplayView
  /** Whether any tape (live or saved) can be opened. */
  ready: boolean
  /** Text shown while there is nothing to replay yet. */
  coldHint: string
  /** Recorded actions up to the playhead, newest first. */
  actions: ActionEvent[]
}>()

const emit = defineEmits<{
  open: []
  close: []
  toggle: []
  scrub: [ms: number]
  step: [direction: -1 | 1]
}>()

const progress = computed(() => {
  if (props.view.totalMs <= 0) return 0
  return Math.min(1, Math.max(0, props.view.positionMs / props.view.totalMs))
})

const clock = computed(() => format(props.view.positionMs))
const total = computed(() => format(props.view.totalMs))
const percent = computed(() => Math.round(progress.value * 1000) / 10)

const ACTION_NAMES: Record<ActionEvent['kind'], string> = {
  left: '左挡板',
  right: '右挡板',
  plunger: '蓄力',
  release: '发射',
  nudgeLeft: '左推',
  nudgeRight: '右推',
}

function format(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, '0')}`
}

function stamp(ms: number): string {
  const whole = Math.max(0, ms)
  const seconds = Math.floor(whole / 1000)
  const tenths = Math.floor((whole % 1000) / 100)
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}.${tenths}`
}

function onScrub(event: Event): void {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  emit('scrub', Number(input.value))
}
</script>

<template>
  <section class="replay" aria-label="回放">
    <header class="replay-head">
      <div>
        <p class="eyebrow">回放</p>
        <h2>{{ view.open ? '正在重看这一局' : '重看这一局' }}</h2>
      </div>
      <button v-if="!view.open" type="button" class="replay-key" :disabled="!ready" @click="emit('open')">
        进入回放
      </button>
      <button v-else type="button" class="replay-key replay-key-strong" @click="emit('close')">
        退出回放
      </button>
    </header>

    <template v-if="view.open">
      <p class="replay-copy">
        这里显示的是当时那一刻的分数和机关。暂停只停住回放，不会推进正在打的那一局；退出后球、分数和奖励时间都回到进入之前。
      </p>
      <div class="replay-transport">
        <button type="button" class="replay-key" aria-label="上一帧" @click="emit('step', -1)">◀ 帧</button>
        <button type="button" class="replay-key replay-key-strong replay-play" @click="emit('toggle')">
          {{ view.playing ? '暂停回放' : '播放' }}
        </button>
        <button type="button" class="replay-key" aria-label="下一帧" @click="emit('step', 1)">帧 ▶</button>
      </div>
      <label class="replay-scrub">
        <span class="replay-scrub-label">
          <strong>{{ clock }}</strong>
          <span>/ {{ total }} · 第 {{ view.frame }} / {{ view.frames }} 帧 · {{ percent }}%</span>
        </span>
        <input
          type="range"
          min="0"
          :max="Math.max(0, Math.round(view.totalMs))"
          step="1"
          :value="view.positionMs"
          aria-label="回放进度"
          @input="onScrub"
        />
      </label>
      <ol v-if="actions.length > 0" class="replay-log" aria-label="回放到此为止的操作">
        <li v-for="(action, index) in actions" :key="`${action.t}-${action.kind}-${index}`">
          <span>{{ stamp(action.t) }}</span>
          <strong>{{ ACTION_NAMES[action.kind] }}</strong>
        </li>
      </ol>
      <p v-if="view.saved" class="replay-copy replay-saved">这一局已存在本机，下次还能重看。</p>
    </template>
    <p v-else class="replay-copy">
      {{ view.available ? '边打边记下了操作和经过的时间。进入回放可以拖到任意时刻。' : coldHint }}
    </p>
    <p v-if="view.truncated" class="replay-copy replay-warn">回放已达十分钟上限，之后的操作没有再记录。</p>
  </section>
</template>
