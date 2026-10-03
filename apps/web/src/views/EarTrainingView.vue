<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { INTERVAL_NAMES } from "@practice/contracts";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import MetricCard from "../components/MetricCard.vue";
import { formatDateTime } from "../utils/format.js";

type DrillKind = "INTERVAL" | "RHYTHM";
interface PublicIntervalPayload { kind: "INTERVAL"; rootMidi: number; direction: "ASC" | "DESC" | "HARMONIC"; choices: number[] }
interface PublicRhythmPayload { kind: "RHYTHM"; bpm: number; beatsPerBar: number; steps: number; choices: string[] }
type PublicPayload = PublicIntervalPayload | PublicRhythmPayload;
interface Drill {
  id: string; kind: DrillKind; seed: string; questionIndex: number; generatorVersion: number;
  difficulty: number; status: "OPEN" | "ANSWERED"; answeredAt: string | null; createdAt: string;
  payload: PublicPayload & { semitones?: number; pattern?: number[] };
}
interface Attempt {
  id: string; drillId: string; clientAttemptId: string; answer: { semitones?: number; pattern?: string };
  correct: boolean; counted: boolean; responseMs: number | null; ruleVersion: number; scoreAwarded: number; createdAt: string;
  drill?: { id: string; kind: DrillKind; seed: string; questionIndex: number; difficulty: number };
}
interface LevelResult {
  mode: "snapshot" | "current"; ruleVersion: number; totalScore: number; level: number; levelLabel: string;
  nextLevelScore: number | null; countedAttempts: number; correctAttempts: number; accuracy: number;
}

const drills = ref<Drill[]>([]);
const attempts = ref<Attempt[]>([]);
const snapshotLevel = ref<LevelResult | null>(null);
const currentLevel = ref<LevelResult | null>(null);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const activeDrillId = ref<string | null>(null);
const activeFull = ref<Drill | null>(null);
const answering = ref(false);
const playing = ref(false);
const startedAtMs = ref(0);

const generateForm = reactive({ kind: "INTERVAL" as DrillKind, count: 5, difficulty: 1, seed: "" });

const activeDrill = computed(() => {
  if (activeFull.value && activeFull.value.id === activeDrillId.value) return activeFull.value;
  return drills.value.find((drill) => drill.id === activeDrillId.value) ?? null;
});
const openDrills = computed(() => drills.value.filter((drill) => drill.status === "OPEN"));

let audioContext: AudioContext | null = null;
function ensureAudioContext(): AudioContext {
  audioContext ??= new AudioContext();
  return audioContext;
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function scheduleTone(context: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.24, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.05);
}

function scheduleClick(context: AudioContext, startAt: number, accent: boolean): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = accent ? 1560 : 1040;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.3 : 0.18, startAt + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.09);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.12);
}

async function playDrill(drill: Drill): Promise<void> {
  if (playing.value) return;
  playing.value = true;
  startedAtMs.value = performance.now();
  try {
    const context = ensureAudioContext();
    await context.resume();
    const now = context.currentTime + 0.08;
    if (drill.payload.kind === "INTERVAL") {
      const payload = drill.payload;
      const semitones = payload.semitones ?? 0;
      const root = midiToFrequency(payload.rootMidi);
      const target = midiToFrequency(payload.rootMidi + (payload.direction === "DESC" ? -semitones : semitones));
      if (payload.direction === "HARMONIC") {
        scheduleTone(context, root, now, 1.2);
        scheduleTone(context, target, now, 1.2);
      } else {
        scheduleTone(context, root, now, 0.7);
        scheduleTone(context, target, now + 0.85, 0.9);
      }
    } else {
      const payload = drill.payload;
      const stepSeconds = 60 / payload.bpm / 4;
      const pattern = payload.pattern ?? [];
      for (let step = 0; step < payload.steps; step += 1) {
        if (pattern[step]) scheduleClick(context, now + step * stepSeconds, step % 4 === 0);
      }
    }
  } finally {
    window.setTimeout(() => { playing.value = false; }, 2200);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [drillResult, attemptResult, levelResult] = await Promise.all([
      apiFetch<{ data: Drill[] }>("/api/v1/ear/drills?limit=50"),
      apiFetch<{ data: Attempt[] }>("/api/v1/ear/attempts?limit=30"),
      apiFetch<{ snapshot: LevelResult; current: LevelResult }>("/api/v1/ear/level"),
    ]);
    drills.value = drillResult.data;
    attempts.value = attemptResult.data;
    snapshotLevel.value = levelResult.snapshot;
    currentLevel.value = levelResult.current;
    if (!activeDrillId.value && openDrills.value[0]) await selectDrill(openDrills.value[0]);
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "听辨数据加载失败";
  } finally {
    loading.value = false;
  }
}

async function generate(): Promise<void> {
  error.value = "";
  notice.value = "";
  try {
    const result = await apiFetch<{ seed: string; data: Drill[] }>("/api/v1/ear/drills", {
      method: "POST",
      body: JSON.stringify({
        kind: generateForm.kind,
        count: generateForm.count,
        difficulty: generateForm.difficulty,
        ...(generateForm.seed.trim() ? { seed: generateForm.seed.trim() } : {}),
      }),
    });
    notice.value = `已生成 ${result.data.length} 题，种子 ${result.seed}（保存种子可复现同组题目）`;
    await load();
    if (result.data[0]) {
      activeDrillId.value = result.data[0].id;
      activeFull.value = result.data[0]; // 生成接口返回完整 payload，可直接播放
      startedAtMs.value = performance.now();
    }
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "题目生成失败";
  }
}

function newClientAttemptId(): string {
  return crypto.randomUUID();
}
const pendingClientIds = reactive<Record<string, string>>({});

async function submitAnswer(drill: Drill, answer: { semitones?: number; pattern?: string }): Promise<void> {
  if (answering.value || drill.status !== "OPEN") return;
  answering.value = true;
  error.value = "";
  try {
    pendingClientIds[drill.id] ??= newClientAttemptId();
    const responseMs = startedAtMs.value ? Math.round(performance.now() - startedAtMs.value) : null;
    const result = await apiFetch<{ attempt: Attempt; deduplicated: boolean }>(`/api/v1/ear/drills/${drill.id}/attempts`, {
      method: "POST",
      body: JSON.stringify({ clientAttemptId: pendingClientIds[drill.id], answer, responseMs }),
    });
    notice.value = result.deduplicated
      ? "该提交已记录过，未重复计分"
      : result.attempt.correct
        ? (result.attempt.counted ? `回答正确，+${result.attempt.scoreAwarded} 分` : "回答正确（本题已计过分，不再累计）")
        : "回答错误，再接再厉";
    delete pendingClientIds[drill.id];
    await load();
    const next = openDrills.value.find((item) => item.id !== drill.id);
    activeFull.value = null;
    if (next) await selectDrill(next);
    else activeDrillId.value = null;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "答案提交失败";
  } finally {
    answering.value = false;
  }
}

async function selectDrill(drill: Drill): Promise<void> {
  activeDrillId.value = drill.id;
  startedAtMs.value = performance.now();
  // 列表接口不含播放参数，选中后拉取详情获得完整 payload 用于合成音频
  try {
    const detail = await apiFetch<{ drill: Drill }>(`/api/v1/ear/drills/${drill.id}`);
    activeFull.value = detail.drill;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "题目详情加载失败";
  }
}

function rhythmLabel(pattern: string): string {
  return pattern.replace(/x/g, "●").replace(/-/g, "·");
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>听辨训练</h1>
        <p>种子化生成音程与节奏题，答题轨迹只追加不修改；等级由历史轨迹派生，规则升级不改写历史。</p>
      </div>
    </header>

    <div v-if="error" class="alert" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert success" role="status">{{ notice }}</div>

    <div class="grid grid-3" style="margin: 18px 0">
      <MetricCard label="当前等级（历史快照）" :value="snapshotLevel ? `${snapshotLevel.levelLabel} Lv.${snapshotLevel.level}` : '—'" :hint="snapshotLevel ? `总分 ${snapshotLevel.totalScore}` : ''" />
      <MetricCard label="现行规则重放" :value="currentLevel ? `${currentLevel.levelLabel} Lv.${currentLevel.level}` : '—'" :hint="currentLevel ? `规则 v${currentLevel.ruleVersion} · 总分 ${currentLevel.totalScore}` : ''" />
      <MetricCard label="计分答题正确率" :value="snapshotLevel ? `${Math.round(snapshotLevel.accuracy * 100)}%` : '—'" :hint="snapshotLevel ? `${snapshotLevel.correctAttempts}/${snapshotLevel.countedAttempts} 题` : ''" />
    </div>

    <div class="grid grid-2">
      <div class="stack">
        <form class="card form-grid" @submit.prevent="generate">
          <div class="card-title full"><h2>生成题目</h2></div>
          <label class="field"><span>题型</span>
            <select v-model="generateForm.kind">
              <option value="INTERVAL">音程听辨</option>
              <option value="RHYTHM">节奏听辨</option>
            </select>
          </label>
          <label class="field"><span>难度</span>
            <select v-model.number="generateForm.difficulty">
              <option :value="1">1 · 基础</option>
              <option :value="2">2 · 进阶</option>
              <option :value="3">3 · 挑战</option>
            </select>
          </label>
          <label class="field"><span>题数</span><input v-model.number="generateForm.count" type="number" min="1" max="20" /></label>
          <label class="field"><span>种子（可选，用于复现）</span><input v-model="generateForm.seed" maxlength="64" placeholder="留空则随机生成" /></label>
          <div class="full"><button class="button" type="submit">生成题目</button></div>
        </form>

        <div class="card">
          <div class="card-title"><h2>待答题目</h2><span class="badge">{{ openDrills.length }} 题</span></div>
          <EmptyState v-if="!openDrills.length && !loading" title="没有待答题目" description="生成一组题目开始听辨训练" />
          <div v-else class="stack" style="gap: 8px">
            <button
              v-for="drill in openDrills"
              :key="drill.id"
              class="button ghost block"
              :class="{ secondary: drill.id === activeDrillId }"
              type="button"
              @click="selectDrill(drill)"
            >
              {{ drill.kind === "INTERVAL" ? "音程" : "节奏" }} · 难度 {{ drill.difficulty }} · #{{ drill.questionIndex + 1 }}
            </button>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-title"><h2>答题区</h2></div>
          <LoadingBlock v-if="loading" />
          <EmptyState v-else-if="!activeDrill" title="请选择一道待答题目" description="从左侧列表选择，或生成新题目" />
          <div v-else class="stack">
            <div class="row between">
              <span class="badge">{{ activeDrill.kind === "INTERVAL" ? "音程听辨" : "节奏听辨" }}</span>
              <small>种子 {{ activeDrill.seed }} · 第 {{ activeDrill.questionIndex + 1 }} 题 · 难度 {{ activeDrill.difficulty }}</small>
            </div>
            <button class="button secondary" type="button" :disabled="playing" @click="playDrill(activeDrill!)">
              {{ playing ? "播放中…" : "▶ 播放题目" }}
            </button>
            <div v-if="activeDrill.payload.kind === 'INTERVAL'" class="grid grid-2">
              <button
                v-for="choice in (activeDrill.payload as PublicIntervalPayload).choices"
                :key="choice"
                class="button ghost"
                type="button"
                :disabled="answering"
                @click="submitAnswer(activeDrill!, { semitones: choice })"
              >
                {{ INTERVAL_NAMES[choice] ?? `${choice} 半音` }}
              </button>
            </div>
            <div v-else class="stack" style="gap: 8px">
              <button
                v-for="choice in (activeDrill.payload as PublicRhythmPayload).choices"
                :key="choice"
                class="button ghost"
                type="button"
                style="font-family: ui-monospace, monospace; letter-spacing: .18em"
                :disabled="answering"
                @click="submitAnswer(activeDrill!, { pattern: choice })"
              >
                {{ rhythmLabel(choice) }}
              </button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title"><h2>答题轨迹</h2><span class="badge">只增不改</span></div>
          <EmptyState v-if="!attempts.length && !loading" title="还没有答题记录" description="提交答案后，轨迹会按时间倒序列在这里" />
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>题型</th><th>结果</th><th>计分</th><th>得分</th><th>规则</th></tr>
              </thead>
              <tbody>
                <tr v-for="attempt in attempts" :key="attempt.id">
                  <td>{{ formatDateTime(attempt.createdAt) }}</td>
                  <td>{{ attempt.drill?.kind === "INTERVAL" ? "音程" : "节奏" }}</td>
                  <td><span class="badge" :class="attempt.correct ? 'ACHIEVED' : 'MISSED'">{{ attempt.correct ? "正确" : "错误" }}</span></td>
                  <td>{{ attempt.counted ? "计入" : "不计" }}</td>
                  <td>{{ attempt.scoreAwarded }}</td>
                  <td>v{{ attempt.ruleVersion }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
