<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { apiFetch } from "../lib/api";

type OpeningPeriod = { open: string; close: string };

type OpeningHours = {
  schedule: {
    id: string;
    timezone: string;
    weekPattern: Record<string, OpeningPeriod[]>;
    version: number;
    updatedAt: string;
  } | null;
  exceptions: Array<{
    id: string;
    kind: "temporary_closure" | "holiday";
    startsOn: string;
    endsOn: string;
    overridePeriods: OpeningPeriod[] | null;
    reason: string | null;
  }>;
  subscribed: boolean;
};

const route = useRoute();
const featureId = String(route.params.id);

const loading = ref(true);
const saving = ref(false);
const error = ref("");
const notice = ref("");
const timezone = ref("");
const weekPattern = reactive<Record<string, OpeningPeriod[]>>({
  mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: []
});
const exceptions = ref<OpeningHours["exceptions"]>([]);
const hasSchedule = ref(false);

const weekDayLabels: Array<[string, string]> = [
  ["mon", "周一"], ["tue", "周二"], ["wed", "周三"], ["thu", "周四"],
  ["fri", "周五"], ["sat", "周六"], ["sun", "周日"]
];

const exceptionForm = reactive({
  kind: "temporary_closure" as "temporary_closure" | "holiday",
  startsOn: "",
  endsOn: "",
  reason: "",
  overridePeriods: [] as OpeningPeriod[]
});

function useBrowserTimezone() {
  timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function addPeriod(day: string) {
  weekPattern[day]!.push({ open: "09:00", close: "17:00" });
}

function removePeriod(day: string, index: number) {
  weekPattern[day]!.splice(index, 1);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await apiFetch<OpeningHours>(`/features/${featureId}/opening-hours`);
    hasSchedule.value = Boolean(data.schedule);
    timezone.value = data.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [day] of weekDayLabels) {
      weekPattern[day] = (data.schedule?.weekPattern[day] ?? []).map((period) => ({ ...period }));
    }
    exceptions.value = data.exceptions;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function saveSchedule() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await apiFetch<{ status: string; windowsChanged: boolean }>(`/features/${featureId}/opening-hours`, {
      method: "PUT",
      body: { timezone: timezone.value, weekPattern }
    });
    hasSchedule.value = true;
    notice.value = result.windowsChanged
      ? "开放时段已保存，未来开窗已复算，订阅者已收到提醒。"
      : "开放时段已保存，未来开窗无变化。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

async function addException() {
  error.value = "";
  notice.value = "";
  try {
    await apiFetch(`/features/${featureId}/opening-hours/exceptions`, {
      method: "POST",
      body: {
        kind: exceptionForm.kind,
        startsOn: exceptionForm.startsOn,
        endsOn: exceptionForm.endsOn,
        overridePeriods: exceptionForm.kind === "holiday" && exceptionForm.overridePeriods.length
          ? exceptionForm.overridePeriods
          : null,
        reason: exceptionForm.reason || undefined
      }
    });
    exceptionForm.startsOn = "";
    exceptionForm.endsOn = "";
    exceptionForm.reason = "";
    exceptionForm.overridePeriods = [];
    notice.value = "例外已添加，开窗已复算。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "添加例外失败";
  }
}

async function removeException(exceptionId: string) {
  error.value = "";
  notice.value = "";
  try {
    await apiFetch(`/features/${featureId}/opening-hours/exceptions/${exceptionId}`, { method: "DELETE" });
    notice.value = "例外已删除，开窗已复算。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除例外失败";
  }
}

function exceptionKindLabel(kind: string) {
  return kind === "temporary_closure" ? "临时闭馆" : "节假日例外";
}

function formatPeriods(periods: OpeningPeriod[] | null | undefined) {
  if (!periods?.length) return "全天关闭";
  return periods.map((period) => `${period.open}–${period.close}`).join("、");
}

onMounted(load);
</script>

<template>
  <section>
    <div class="page-heading">
      <div>
        <h1>开放时段管理</h1>
        <p>维护周期开放时段、临时闭馆和节假日例外。所有时间按地点时区解释，保存后系统自动复算未来开窗并提醒订阅者。</p>
      </div>
      <RouterLink class="button ghost" :to="`/features/${featureId}`">返回地点详情</RouterLink>
    </div>

    <div v-if="loading" class="loading">加载中…</div>
    <template v-else>
      <p v-if="error" class="error-box">{{ error }}</p>
      <p v-if="notice" class="success-box">{{ notice }}</p>

      <div class="detail-layout">
        <div class="stack">
          <section class="card"><div class="card-body">
            <h2>周期开放时段</h2>
            <div class="field" style="max-width: 360px">
              <label for="timezone">地点时区（IANA 名称）</label>
              <input id="timezone" v-model.trim="timezone" placeholder="例如 Asia/Shanghai" />
              <button class="button ghost small" type="button" @click="useBrowserTimezone">使用浏览器时区</button>
            </div>
            <div v-for="[day, label] in weekDayLabels" :key="day" class="card" style="margin-bottom: 10px">
              <div class="card-body">
                <div class="inline" style="justify-content: space-between; width: 100%">
                  <strong>{{ label }}</strong>
                  <button class="button ghost small" type="button" @click="addPeriod(day)">添加时段</button>
                </div>
                <p v-if="!weekPattern[day]!.length" class="muted">闭馆</p>
                <div v-for="(period, index) in weekPattern[day]" :key="index" class="inline" style="margin-top: 8px">
                  <input v-model="period.open" type="time" aria-label="开始时间" />
                  <span>至</span>
                  <input v-model="period.close" type="time" aria-label="结束时间" />
                  <button class="button ghost small" type="button" @click="removePeriod(day, index)">删除</button>
                </div>
                <p class="muted" style="font-size: 12px">结束时间早于开始时间表示跨午夜（如 22:00–02:00）。</p>
              </div>
            </div>
            <button class="button" type="button" :disabled="saving || !timezone" @click="saveSchedule">
              {{ saving ? "保存中…" : "保存周期时段" }}
            </button>
          </div></section>
        </div>

        <aside class="stack">
          <section class="card"><div class="card-body">
            <h2>临时闭馆与节假日例外</h2>
            <div v-if="!exceptions.length" class="empty">暂无例外。</div>
            <article v-for="exception in exceptions" :key="exception.id" class="comment">
              <div class="comment-head">
                <strong>{{ exceptionKindLabel(exception.kind) }}</strong>
                <span>{{ exception.startsOn }} 至 {{ exception.endsOn }}</span>
              </div>
              <p>
                {{ formatPeriods(exception.overridePeriods) }}
                <span v-if="exception.reason">— {{ exception.reason }}</span>
              </p>
              <button class="button ghost small" type="button" @click="removeException(exception.id)">删除</button>
            </article>
          </div></section>

          <section class="card"><div class="card-body">
            <h2>添加例外</h2>
            <p v-if="!hasSchedule" class="notice-box">请先保存周期时段，再添加例外。</p>
            <form v-else class="stack" @submit.prevent="addException">
              <div class="field">
                <label for="exception-kind">类型</label>
                <select id="exception-kind" v-model="exceptionForm.kind">
                  <option value="temporary_closure">临时闭馆（全天关闭）</option>
                  <option value="holiday">节假日例外（可关闭或改时段）</option>
                </select>
              </div>
              <div class="grid-2">
                <div class="field">
                  <label for="exception-start">开始日期</label>
                  <input id="exception-start" v-model="exceptionForm.startsOn" type="date" required />
                </div>
                <div class="field">
                  <label for="exception-end">结束日期</label>
                  <input id="exception-end" v-model="exceptionForm.endsOn" type="date" required />
                </div>
              </div>
              <div v-if="exceptionForm.kind === 'holiday'" class="field">
                <label>覆盖时段（留空表示全天关闭）</label>
                <div v-for="(period, index) in exceptionForm.overridePeriods" :key="index" class="inline">
                  <input v-model="period.open" type="time" aria-label="覆盖开始时间" />
                  <span>至</span>
                  <input v-model="period.close" type="time" aria-label="覆盖结束时间" />
                  <button class="button ghost small" type="button" @click="exceptionForm.overridePeriods.splice(index, 1)">删除</button>
                </div>
                <button class="button ghost small" type="button" @click="exceptionForm.overridePeriods.push({ open: '10:00', close: '16:00' })">
                  添加覆盖时段
                </button>
              </div>
              <div class="field">
                <label for="exception-reason">原因（可选）</label>
                <input id="exception-reason" v-model.trim="exceptionForm.reason" maxlength="200" placeholder="例如：设备检修、春节假期" />
              </div>
              <button class="button" type="submit" :disabled="!exceptionForm.startsOn || !exceptionForm.endsOn">添加例外</button>
            </form>
          </div></section>
        </aside>
      </div>
    </template>
  </section>
</template>
