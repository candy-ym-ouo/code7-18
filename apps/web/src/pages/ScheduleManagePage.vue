<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch } from "../lib/api";
import { useAuthStore } from "../stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const featureId = String(route.params.id);

type Weekly = {
  id?: string;
  weekday: number;
  startTime: string;
  endTime: string;
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
  weekly: Weekly[];
  exceptions: Exception[];
  subscribed: boolean;
};

const schedule = ref<Schedule | null>(null);
const timezoneInput = ref("Asia/Shanghai");
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const notice = ref("");

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const emptyPeriod = (): Weekly => ({
  weekday: 1, startTime: "09:00", endTime: "18:00", validFrom: null, validTo: null, note: null
});
const periods = ref<Weekly[]>([]);
const draftException = ref({
  kind: "closed" as "closed" | "open",
  localDate: "",
  endLocalDate: "" as string | null,
  allDay: true,
  startTime: "09:00",
  endTime: "12:00",
  reason: ""
});

async function load() {
  loading.value = true;
  try {
    schedule.value = await apiFetch<Schedule>(`/features/${featureId}/schedule`);
    timezoneInput.value = schedule.value.timezone ?? "Asia/Shanghai";
    periods.value = schedule.value.weekly.map((item) => ({ ...item }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function saveTimezone() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await apiFetch(`/features/${featureId}/schedule/settings`, {
      method: "PUT",
      body: { timezone: timezoneInput.value }
    });
    notice.value = "时区已保存，规则将按此时区解释。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

function addPeriod() {
  periods.value.push(emptyPeriod());
}
function removePeriod(index: number) {
  periods.value.splice(index, 1);
}

async function saveWeekly() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await apiFetch(`/features/${featureId}/schedule/weekly`, {
      method: "PUT",
      body: {
        periods: periods.value.map((period) => ({
          weekday: Number(period.weekday),
          startTime: period.startTime,
          endTime: period.endTime,
          validFrom: period.validFrom || null,
          validTo: period.validTo || null,
          note: period.note || null
        }))
      }
    });
    notice.value = "周期时段已保存，订阅者会收到变更通知。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

async function addException() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const body: Record<string, unknown> = {
      kind: draftException.value.kind,
      localDate: draftException.value.localDate,
      endLocalDate: draftException.value.endLocalDate || null,
      reason: draftException.value.reason
    };
    if (draftException.value.kind === "open" || !draftException.value.allDay) {
      body.startTime = draftException.value.startTime;
      body.endTime = draftException.value.endTime;
    }
    await apiFetch(`/features/${featureId}/schedule/exceptions`, { method: "POST", body });
    notice.value = draftException.value.kind === "closed" ? "临时闭馆已记录。" : "节假日例外已记录。";
    draftException.value = {
      kind: "closed", localDate: "", endLocalDate: null, allDay: true,
      startTime: "09:00", endTime: "12:00", reason: ""
    };
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

async function deleteException(id: string) {
  if (!window.confirm("删除该条例外？删除后同样会通知订阅者。")) return;
  error.value = "";
  try {
    await apiFetch(`/features/${featureId}/schedule/exceptions/${id}`, { method: "DELETE" });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除失败";
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div v-if="loading" class="loading">加载中…</div>
    <template v-else>
      <div class="page-heading">
        <div>
          <h1>开放时段管理</h1>
          <p class="muted">维护周期时段、临时闭馆与节假日例外。规则按地点时区解释，跨时区查询结果一致。</p>
        </div>
        <RouterLink class="button secondary" :to="`/features/${featureId}`">返回地点</RouterLink>
      </div>

      <p v-if="error" class="error-box">{{ error }}</p>
      <p v-if="notice" class="success-box">{{ notice }}</p>

      <div class="detail-layout">
        <div class="stack">
          <section class="card"><div class="card-body">
            <h2>每周周期时段</h2>
            <p class="muted">结束时间早于或等于开始时间表示跨夜（如 22:00–02:00）。</p>
            <div v-for="(period, index) in periods" :key="index" class="period-row">
              <label>
                星期
                <select v-model.number="period.weekday">
                  <option v-for="(label, weekday) in weekdays" :key="weekday" :value="weekday">{{ label }}</option>
                </select>
              </label>
              <label>开始 <input v-model="period.startTime" type="time" /></label>
              <label>结束 <input v-model="period.endTime" type="time" /></label>
              <label class="grow">生效起 <input v-model="period.validFrom" type="date" /></label>
              <label class="grow">生效止 <input v-model="period.validTo" type="date" /></label>
              <label class="grow">备注 <input v-model="period.note" maxlength="200" placeholder="可选" /></label>
              <button class="button ghost small" type="button" @click="removePeriod(index)">删除</button>
            </div>
            <div class="inline" style="margin-top: 10px">
              <button class="button secondary" type="button" @click="addPeriod">添加一天</button>
              <button class="button" type="button" :disabled="saving" @click="saveWeekly">保存周期时段</button>
            </div>
            <p v-if="!periods.length" class="empty">还没有周期时段。</p>
          </div></section>

          <section class="card"><div class="card-body">
            <h2>临时闭馆 / 节假日例外</h2>
            <div class="period-row">
              <label>类型
                <select v-model="draftException.kind">
                  <option value="closed">临时闭馆</option>
                  <option value="open">节假日特别开放</option>
                </select>
              </label>
              <label>日期 <input v-model="draftException.localDate" type="date" /></label>
              <label>截止日期 <input v-model="draftException.endLocalDate" type="date" /></label>
              <label v-if="draftException.kind === 'closed'">
                <input v-model="draftException.allDay" type="checkbox" /> 全天
              </label>
              <template v-if="draftException.kind === 'open' || !draftException.allDay">
                <label>开始 <input v-model="draftException.startTime" type="time" /></label>
                <label>结束 <input v-model="draftException.endTime" type="time" /></label>
              </template>
              <label class="grow">原因 <input v-model="draftException.reason" maxlength="200" placeholder="如：国庆调整、设备检修" /></label>
              <button class="button" type="button" :disabled="saving || !draftException.localDate || !draftException.reason.trim()" @click="addException">
                添加例外
              </button>
            </div>

            <table v-if="schedule?.exceptions.length" class="exception-table">
              <thead><tr><th>类型</th><th>日期</th><th>时间</th><th>原因</th><th></th></tr></thead>
              <tbody>
                <tr v-for="item in schedule.exceptions" :key="item.id">
                  <td>
                    <span class="badge" :class="item.kind === 'closed' ? 'closed-state' : 'open-state'">
                      {{ item.kind === "closed" ? "闭馆" : "开放" }}
                    </span>
                  </td>
                  <td>{{ item.localDate }}<template v-if="item.endLocalDate && item.endLocalDate !== item.localDate"> 至 {{ item.endLocalDate }}</template></td>
                  <td>{{ item.allDay ? "全天" : `${item.startTime}–${item.endTime}` }}</td>
                  <td>{{ item.reason }}</td>
                  <td><button class="button ghost small" type="button" @click="deleteException(item.id)">删除</button></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="empty">暂无例外安排。</p>
          </div></section>
        </div>

        <aside class="stack">
          <section class="card"><div class="card-body">
            <h2>地点时区</h2>
            <p class="muted">所有周期时段与例外日期均按此时区解释。查询统一换算为 UTC，观察者所在时区不影响结果。</p>
            <label class="stack">
              IANA 时区
              <input v-model="timezoneInput" placeholder="Asia/Shanghai" list="timezone-list" />
              <datalist id="timezone-list">
                <option value="Asia/Shanghai"></option>
                <option value="Asia/Hong_Kong"></option>
                <option value="Asia/Tokyo"></option>
                <option value="Asia/Singapore"></option>
                <option value="Asia/Kolkata"></option>
                <option value="Europe/London"></option>
                <option value="Europe/Berlin"></option>
                <option value="America/New_York"></option>
                <option value="America/Los_Angeles"></option>
                <option value="Australia/Sydney"></option>
                <option value="UTC"></option>
              </datalist>
            </label>
            <button class="button" style="margin-top: 10px" type="button" :disabled="saving" @click="saveTimezone">保存时区</button>
            <p v-if="schedule?.version" class="muted" style="margin-top: 8px">当前规则版本：{{ schedule.version }}</p>
          </div></section>
        </aside>
      </div>
    </template>
  </section>
</template>
