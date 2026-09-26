<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch } from "../lib/api";
import { useAuthStore } from "../stores/auth";

const props = defineProps<{ featureId: string; canManage: boolean }>();

type Weekly = {
  id: string;
  weekday: number;
  weekdayLabel: string;
  startTime: string;
  endTime: string;
  overnight: boolean;
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
};
type Exception = {
  id: string;
  kind: "closed" | "open";
  localDate: string;
  endLocalDate: string | null;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string;
};
type Schedule = {
  timezone: string | null;
  version: number | null;
  updatedAt: string | null;
  weekly: Weekly[];
  exceptions: Exception[];
  subscribed: boolean;
};
type Status = {
  at: string;
  timezone: string | null;
  state: "open" | "closed" | "unknown";
  closesAt: string | null;
  nextOpenAt: string | null;
};

const auth = useAuthStore();
const schedule = ref<Schedule | null>(null);
const status = ref<Status | null>(null);
const error = ref("");
const busy = ref(false);

const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
const groupedWeekly = () => {
  const rows = schedule.value?.weekly ?? [];
  return weekdayOrder
    .map((weekday) => ({ weekday, items: rows.filter((item) => item.weekday === weekday) }))
    .filter((group) => group.items.length);
};
const weekdayLabel = (weekday: number) => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday] ?? "";

const upcomingExceptions = () => {
  const today = new Date().toISOString().slice(0, 10);
  return (schedule.value?.exceptions ?? [])
    .filter((item) => (item.endLocalDate ?? item.localDate) >= today)
    .slice(0, 5);
};

function formatAt(value: string | null) {
  return value ? new Date(value).toLocaleString() : null;
}

async function toggleSubscription() {
  if (!auth.isAuthenticated) return;
  busy.value = true;
  error.value = "";
  try {
    if (schedule.value?.subscribed) {
      await apiFetch(`/features/${props.featureId}/schedule/subscription`, { method: "DELETE" });
      schedule.value.subscribed = false;
    } else {
      await apiFetch(`/features/${props.featureId}/schedule/subscription`, { method: "PUT" });
      schedule.value!.subscribed = true;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "订阅失败";
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    const [scheduleData, statusData] = await Promise.all([
      apiFetch<Schedule>(`/features/${props.featureId}/schedule`),
      apiFetch<Status>(`/features/${props.featureId}/schedule/status`).catch(() => null)
    ]);
    schedule.value = scheduleData;
    status.value = statusData;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "开放时段加载失败";
  }
});
</script>

<template>
  <section class="card"><div class="card-body">
    <div class="inline" style="justify-content: space-between">
      <h2 style="margin: 0">开放时段</h2>
      <span v-if="status" class="badge" :class="status.state === 'open' ? 'open-state' : status.state === 'closed' ? 'closed-state' : ''">
        {{ status.state === "open" ? "开放中" : status.state === "closed" ? "当前闭馆" : "时段未维护" }}
      </span>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <template v-if="schedule?.timezone">
      <p class="muted" style="margin: 8px 0">
        时区 {{ schedule.timezone }}
        <template v-if="status?.state === 'open'">· 关闭时间 {{ formatAt(status.closesAt) }}</template>
        <template v-else-if="status?.state === 'closed' && status.nextOpenAt">
          · 下次开放 {{ formatAt(status.nextOpenAt) }}
        </template>
      </p>

      <div v-if="groupedWeekly().length" class="weekly-list">
        <dl v-for="group in groupedWeekly()" :key="group.weekday" class="weekly-row">
          <dt>{{ weekdayLabel(group.weekday) }}</dt>
          <dd>
            <span v-for="item in group.items" :key="item.id" class="inline">
              {{ item.startTime }}–{{ item.endTime }}<small v-if="item.overnight" class="muted">次日</small>
            </span>
          </dd>
        </dl>
      </div>
      <p v-else class="muted">暂无每周固定时段。</p>

      <div v-if="upcomingExceptions().length" class="stack" style="margin-top: 10px">
        <div v-for="item in upcomingExceptions()" :key="item.id" class="exception-row">
          <span class="badge" :class="item.kind === 'closed' ? 'closed-state' : 'open-state'">
            {{ item.kind === "closed" ? "闭馆" : "特别开放" }}
          </span>
          <span>
            {{ item.localDate }}<template v-if="item.endLocalDate && item.endLocalDate !== item.localDate"> 至 {{ item.endLocalDate }}</template>
            <template v-if="!item.allDay && item.startTime"> {{ item.startTime }}–{{ item.endTime }}</template>
            <template v-else> 全天</template>
            · {{ item.reason }}
          </span>
        </div>
      </div>

      <div class="inline" style="margin-top: 14px">
        <button v-if="auth.isAuthenticated" class="button small" type="button" :disabled="busy" @click="toggleSubscription">
          {{ schedule.subscribed ? "取消订阅变更提醒" : "订阅变更提醒" }}
        </button>
        <RouterLink v-if="canManage" class="button secondary small" :to="`/features/${featureId}/schedule`">
          管理时段
        </RouterLink>
        <span v-else class="muted">登录后可订阅开放时段变更提醒。</span>
      </div>
    </template>
    <template v-else>
      <p class="muted">该地点尚未维护开放时段。</p>
      <RouterLink v-if="canManage" class="button secondary small" :to="`/features/${featureId}/schedule`">
        维护开放时段
      </RouterLink>
    </template>
  </div></section>
</template>
