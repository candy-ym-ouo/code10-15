<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  INTERVAL_NAMES,
  RHYTHM_TOLERANCE_MS,
  type EarTrainingType,
  type EarTrainingLevel,
  type IntervalQuestionPayload,
  type RhythmQuestionPayload,
} from "@practice/contracts";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import { playInterval, playRhythm } from "../utils/ear-training-audio.js";

interface GradeResult {
  correct: boolean;
  expectedSemitones?: number;
  answeredSemitones?: number;
  expectedOnsets?: number[];
  actualOnsets?: number[];
  matched?: number;
  missing?: number;
  extra?: number;
  toleranceMs?: number;
}
interface QuestionResponse {
  question: {
    id: string;
    type: EarTrainingType;
    level: number;
    seed: string;
    createdAt: string;
    ruleVersion?: number;
    answer: { id: string; correct: boolean; grade: GradeResult; answeredAt: string } | null;
    payload: IntervalQuestionPayload | RhythmQuestionPayload;
  };
  nextLevel?: number;
}
interface HistoryItem {
  id: string;
  questionId: string;
  type: EarTrainingType;
  level: number;
  ruleVersion: number;
  correct: boolean;
  seed: string;
  grade: GradeResult;
  answeredAt: string;
}
interface Profile {
  ruleVersion: number;
  types: Record<EarTrainingType, { attempted: number; correct: number; accuracy: number; currentStreak: number; bestLevel: number; nextLevel: number }>;
}

const activeType = ref<EarTrainingType>("INTERVAL");
const profile = ref<Profile | null>(null);
const current = ref<QuestionResponse["question"] | null>(null);
const history = ref<HistoryItem[]>([]);
const loading = ref(false);
const submitting = ref(false);
const error = ref("");
const notice = ref<{ kind: "success" | "warning"; text: string } | null>(null);

const intervalPayload = computed(() => (current.value?.payload.kind === "interval" ? current.value.payload : null));
const rhythmPayload = computed(() => (current.value?.payload.kind === "rhythm" ? current.value.payload : null));
const rhythmTolerance = computed(() =>
  current.value ? RHYTHM_TOLERANCE_MS[current.value.level as EarTrainingLevel] : 0,
);
const alreadyAnswered = computed(() => current.value?.answer ?? null);
const shuffledOptions = computed<number[]>(() => {
  const options = intervalPayload.value?.options ?? [];
  const seedValue = current.value?.seed ?? "";
  return [...options].sort((a, b) => hashSeed(`${seedValue}:${a}`) - hashSeed(`${seedValue}:${b}`));
});

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function loadProfile(): Promise<void> {
  profile.value = await apiFetch<Profile>("/api/v1/ear-training/profile");
}

async function loadHistory(): Promise<void> {
  const result = await apiFetch<{ data: HistoryItem[] }>("/api/v1/ear-training/answers?limit=30");
  history.value = result.data;
}

async function newQuestion(seed?: string): Promise<void> {
  loading.value = true;
  error.value = "";
  notice.value = null;
  try {
    const result = await apiFetch<QuestionResponse>("/api/v1/ear-training/questions", {
      method: "POST",
      body: JSON.stringify({ type: activeType.value, ...(seed ? { seed } : {}) }),
    });
    current.value = result.question;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "出题失败";
  } finally {
    loading.value = false;
  }
}

async function switchType(type: EarTrainingType): Promise<void> {
  if (type === activeType.value) return;
  activeType.value = type;
  current.value = null;
  await newQuestion();
}

async function answerInterval(answerSemitones: number): Promise<void> {
  if (!current.value || submitting.value) return;
  await submit({ answerSemitones });
}

let intervalPlayback: { stop: () => void } | null = null;
function replayInterval(): void {
  if (!intervalPayload.value) return;
  intervalPlayback?.stop();
  intervalPlayback = playInterval(intervalPayload.value);
}

// --- 节奏作答：开始播放后记录点击相对题面起点的时刻（预备拍内的点击忽略） ---
const playing = ref(false);
const playbackStartedAt = ref(0);
const tapTimesMs = ref<number[]>([]);
let stopPlayback: (() => void) | null = null;

function startRhythm(): void {
  if (!rhythmPayload.value || playing.value) return;
  tapTimesMs.value = [];
  playing.value = true;
  const handle = playRhythm(rhythmPayload.value, () => {
    playing.value = false;
  });
  playbackStartedAt.value = handle.musicStartedAt;
  stopPlayback = handle.stop;
}

function recordTap(event: MouseEvent | TouchEvent): void {
  event.preventDefault();
  if (!playing.value) return;
  const elapsed = performance.now() - playbackStartedAt.value;
  // 预备拍内的提前点击不计入轨迹
  if (elapsed < 0) return;
  tapTimesMs.value.push(Math.round(elapsed));
}

function stopRhythm(): void {
  playing.value = false;
  stopPlayback?.();
  stopPlayback = null;
}

async function submitRhythm(): Promise<void> {
  if (!current.value || submitting.value || tapTimesMs.value.length === 0) return;
  stopRhythm();
  await submit({ tapTimesMs: tapTimesMs.value });
}

async function submit(body: Record<string, unknown>): Promise<void> {
  if (!current.value) return;
  submitting.value = true;
  error.value = "";
  notice.value = null;
  try {
    const result = await apiFetch<QuestionResponse>(`/api/v1/ear-training/questions/${current.value.id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await reloadCurrentAndStats();
    if (typeof result.nextLevel === "number" && result.nextLevel !== current.value.level) {
      notice.value = {
        kind: "success",
        text: result.nextLevel > current.value.level ? `已升级到第 ${result.nextLevel} 级！` : `等级降回第 ${result.nextLevel} 级，继续加油。`,
      };
    }
  } catch (reason) {
    if (reason instanceof ApiError && reason.code === "ALREADY_ANSWERED") {
      notice.value = { kind: "warning", text: "该题已提交过，重复提交只计一次；以下是首次作答结果。" };
      await reloadCurrentAndStats();
    } else {
      error.value = reason instanceof ApiError ? reason.message : "提交失败";
    }
  } finally {
    submitting.value = false;
  }
}

async function reloadCurrentAndStats(): Promise<void> {
  if (!current.value) return;
  const detail = await apiFetch<QuestionResponse>(`/api/v1/ear-training/questions/${current.value.id}`);
  current.value = detail.question;
  await Promise.all([loadProfile(), loadHistory()]);
}

const replaySeed = ref("");
async function replayBySeed(): Promise<void> {
  const seed = replaySeed.value.trim();
  if (!seed) return;
  await newQuestion(seed);
}

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([loadProfile(), loadHistory()]);
  } catch {
    // 未登录或加载失败时静默，出题时再暴露错误
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>听辨训练</h1>
        <p>音程与节奏题由种子确定性生成，可复现；每题只计一次，历史轨迹只追加不修改。</p>
      </div>
    </header>

    <div class="tabs" style="margin-bottom: 18px">
      <button class="tab" :class="{ active: activeType === 'INTERVAL' }" @click="switchType('INTERVAL')">音程听辨</button>
      <button class="tab" :class="{ active: activeType === 'RHYTHM' }" @click="switchType('RHYTHM')">节奏听辨</button>
    </div>

    <div class="training-layout">
      <div class="card stack question-card">
        <LoadingBlock v-if="loading && !current" />
        <template v-else-if="current">
          <div class="row between">
            <span class="badge">第 {{ current.level }} 级 · {{ current.type === "INTERVAL" ? "音程" : "节奏" }}</span>
            <small>规则 v{{ current.ruleVersion ?? profile?.ruleVersion ?? 1 }} · 种子 {{ current.seed.slice(0, 18) }}{{ current.seed.length > 18 ? "…" : "" }}</small>
          </div>

          <div v-if="error" class="alert">{{ error }}</div>
          <div v-if="notice" class="alert" :class="notice.kind === 'success' ? 'success' : 'warning'">{{ notice.text }}</div>

          <!-- 音程作答区 -->
          <template v-if="intervalPayload">
            <p class="muted">先听两个音，再选择它们之间的音程距离。</p>
            <button class="button secondary" @click="replayInterval">▶ 重新播放</button>
            <div class="interval-options">
              <button
                v-for="option in shuffledOptions"
                :key="option"
                class="button ghost option"
                :disabled="submitting || Boolean(alreadyAnswered)"
                :class="{ correct: alreadyAnswered && option === current.answer?.grade.expectedSemitones }"
                @click="answerInterval(option)"
              >
                {{ INTERVAL_NAMES[option] ?? `${option} 半音` }}
              </button>
            </div>
          </template>

          <!-- 节奏作答区 -->
          <template v-else-if="rhythmPayload">
            <p class="muted">
              {{ rhythmPayload.beatsPerBar }}/4 拍 · {{ rhythmPayload.bpm }} BPM · {{ rhythmPayload.barCount }} 小节
              <template v-if="rhythmPayload.allowRests">（含休止符，休止处不要点击）</template>
            </p>
            <div class="row wrap">
              <button class="button secondary" :disabled="playing" @click="startRhythm">▶ 播放并开始</button>
              <button class="button ghost" :disabled="!playing" @click="stopRhythm">停止</button>
              <button class="button" :disabled="submitting || !tapTimesMs.length || Boolean(alreadyAnswered)" @click="submitRhythm">
                提交（{{ tapTimesMs.length }} 次点击）
              </button>
            </div>
            <button
              class="tap-pad"
              :class="{ active: playing }"
              :disabled="!playing"
              @mousedown="recordTap"
              @touchstart.prevent="recordTap"
            >
              <strong>{{ playing ? "踏！" : "点击“播放并开始”" }}</strong>
              <small>在每个音符发声时点击，第 {{ current.level }} 级误差容差 {{ rhythmTolerance }}ms</small>
            </button>
          </template>

          <!-- 作答结果 -->
          <div v-if="alreadyAnswered" class="card flat result" :class="alreadyAnswered.correct ? 'is-correct' : 'is-wrong'">
            <strong>{{ alreadyAnswered.correct ? "回答正确" : "回答错误" }}</strong>
            <template v-if="current.type === 'INTERVAL'">
              <p>
                正确答案：<strong>{{ INTERVAL_NAMES[alreadyAnswered.grade.expectedSemitones ?? -1] ?? "—" }}</strong>
                ，你的答案：{{ INTERVAL_NAMES[alreadyAnswered.grade.answeredSemitones ?? -1] ?? "—" }}
              </p>
            </template>
            <template v-else>
              <p>
                命中 {{ alreadyAnswered.grade.matched }} 个音，漏掉 {{ alreadyAnswered.grade.missing ?? 0 }} 个，
                多击 {{ alreadyAnswered.grade.extra ?? 0 }} 次。
              </p>
            </template>
            <small>首次作答时间：{{ new Date(alreadyAnswered.answeredAt).toLocaleString("zh-CN") }}</small>
          </div>

          <div class="row between">
            <div class="seed-replay">
              <input v-model="replaySeed" placeholder="输入种子复现题目" maxlength="200" />
              <button class="button small ghost" @click="replayBySeed">用种子出题</button>
            </div>
            <button class="button" :disabled="loading" @click="newQuestion()">下一题</button>
          </div>
        </template>
        <EmptyState
          v-else
          title="准备好开始听辨训练了吗"
          description="点击按钮生成第一道题，系统会根据你的历史轨迹自动调整难度。"
          action-label="开始出题"
          @action="newQuestion()"
        />
      </div>

      <aside class="card stack side-panel">
        <h2>训练档案</h2>
        <div v-if="profile" class="profile-grid">
          <div v-for="type in (['INTERVAL', 'RHYTHM'] as EarTrainingType[])" :key="type" class="profile-block">
            <strong>{{ type === "INTERVAL" ? "音程" : "节奏" }}</strong>
            <div class="profile-row"><span>已作答</span><b>{{ profile.types[type].attempted }}</b></div>
            <div class="profile-row"><span>正确率</span><b>{{ Math.round(profile.types[type].accuracy * 100) }}%</b></div>
            <div class="profile-row"><span>当前连胜</span><b>{{ profile.types[type].currentStreak }}</b></div>
            <div class="profile-row"><span>最高等级</span><b>第 {{ profile.types[type].bestLevel }} 级</b></div>
            <div class="profile-row"><span>下一题等级</span><b>第 {{ profile.types[type].nextLevel }} 级</b></div>
          </div>
        </div>

        <h3 style="margin-top: 8px">最近答题轨迹</h3>
        <div v-if="!history.length" class="muted">还没有作答记录。</div>
        <ul v-else class="history-list">
          <li v-for="item in history.slice(0, 10)" :key="item.id">
            <span class="badge" :class="item.correct ? 'ACHIEVED' : 'MISSED'">{{ item.correct ? "正确" : "错误" }}</span>
            <span class="muted">{{ item.type === "INTERVAL" ? "音程" : "节奏" }} · 第 {{ item.level }} 级 · v{{ item.ruleVersion }}</span>
            <small>{{ new Date(item.answeredAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }}</small>
          </li>
        </ul>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.training-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 18px; align-items: start; }
.interval-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.option.correct { border-color: #24644a; background: #dff1e8; color: #24644a; }
.tap-pad {
  display: grid;
  place-items: center;
  gap: 8px;
  min-height: 150px;
  border: 2px dashed var(--line);
  border-radius: var(--radius);
  background: var(--surface-soft);
  cursor: pointer;
  touch-action: manipulation;
}
.tap-pad.active { border-style: solid; border-color: var(--primary); background: var(--primary-soft); }
.tap-pad strong { font-size: 1.4rem; color: var(--primary-strong); }
.result.is-correct { background: #e1f1e9; border-color: #c2e1d2; }
.result.is-wrong { background: var(--danger-soft); border-color: #efc9c3; }
.seed-replay { display: flex; gap: 8px; flex: 1; max-width: 360px; }
.profile-grid { display: grid; gap: 14px; }
.profile-block { display: grid; gap: 4px; padding: 12px; border-radius: 10px; background: var(--surface-soft); }
.profile-row { display: flex; justify-content: space-between; font-size: .9rem; }
.history-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.history-list li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.history-list small { margin-left: auto; }
@media (max-width: 980px) { .training-layout { grid-template-columns: 1fr; } }
</style>
