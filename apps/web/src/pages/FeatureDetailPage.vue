<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch } from "../lib/api";
import { useAuthStore } from "../stores/auth";

type Feature = {
  id: string;
  ownerId: string;
  categoryKey: string;
  categoryName: string;
  status: string;
  title: string;
  description: string;
  longitude: number;
  latitude: number;
  locationAccuracyM: number;
  condition: string;
  stepFree: boolean | null;
  wheelchairAccessible: boolean | null;
  noiseLevel: number | null;
  tags: string[];
  details: Record<string, unknown>;
  media: Array<{ id: string; url: string | null; thumbnailUrl: string | null }>;
  created_at?: string;
  updatedAt: string;
  firstPublishedAt: string | null;
  confirmations: Array<{ result: string; count: number }>;
};

type Comment = {
  id: string;
  parentId: string | null;
  body: string;
  authorName: string;
  createdAt: string;
  editedAt: string | null;
};

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

type OpeningStatus = {
  timezone: string | null;
  at: string;
  isOpen: boolean | null;
  currentWindow: { openAt: string; closeAt: string; source: string } | null;
  nextWindow: { openAt: string; closeAt: string; source: string } | null;
};

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const feature = ref<Feature | null>(null);
const comments = ref<Comment[]>([]);
const openingHours = ref<OpeningHours | null>(null);
const openingStatus = ref<OpeningStatus | null>(null);
const commentBody = ref("");
const error = ref("");
const notice = ref("");
const loading = ref(true);

const weekDayLabels: Array<[string, string]> = [
  ["mon", "周一"], ["tue", "周二"], ["wed", "周三"], ["thu", "周四"],
  ["fri", "周五"], ["sat", "周六"], ["sun", "周日"]
];

const detailLabels: Record<string, string> = {
  seatCount: "座位数", hasBackrest: "有靠背", covered: "有遮蔽", shaded: "有树荫", wheelchairSpace: "有轮椅空间",
  material: "材质", potable: "是否可饮用", waterType: "出水类型", bottleFiller: "可接瓶", working: "当前可用",
  pressure: "水压", capacity: "容纳人数", windProtection: "挡风程度", seating: "有座位", flooding: "容易积水",
  structureNotes: "结构备注", powerOutlet: "有电源", wifi: "有 Wi-Fi", crowdLevel: "拥挤程度", bestTimes: "推荐时段",
  brightness: "亮度", coverage: "覆盖范围", colorTemperature: "光色", lightType: "灯具类型", operatingHours: "亮灯时段",
  brokenLights: "损坏灯数", safetyFeeling: "安全感"
};

const canEdit = computed(() => Boolean(auth.user && feature.value && auth.user.id === feature.value.ownerId));
const canManageOpening = computed(() => Boolean(auth.user && feature.value && (auth.user.id === feature.value.ownerId || auth.canModerate)));
const detailEntries = computed(() => Object.entries(feature.value?.details ?? {}).filter(([, value]) => value !== null && value !== ""));

function displayValue(value: unknown) {
  if (value === true) return "是";
  if (value === false) return "否";
  if (value === "yes") return "是";
  if (value === "no") return "否";
  if (value === "unknown") return "未知";
  return String(value);
}

function formatPeriods(periods: OpeningPeriod[] | null | undefined) {
  if (!periods?.length) return "闭馆";
  return periods.map((period) => `${period.open}–${period.close}`).join("、");
}

function formatLocalInstant(iso: string, timezone: string | null | undefined) {
  return new Date(iso).toLocaleString("zh-CN", timezone ? { timeZone: timezone } : undefined);
}

function exceptionKindLabel(kind: string) {
  return kind === "temporary_closure" ? "临时闭馆" : "节假日例外";
}

async function load() {
  loading.value = true;
  try {
    const id = String(route.params.id);
    feature.value = await apiFetch<Feature>(`/features/${id}`);
    comments.value = await apiFetch<Comment[]>(`/features/${id}/comments`);
    const [hours, status] = await Promise.all([
      apiFetch<OpeningHours>(`/features/${id}/opening-hours`),
      apiFetch<OpeningStatus>(`/features/${id}/opening-hours/status`)
    ]);
    openingHours.value = hours;
    openingStatus.value = status;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function toggleOpeningSubscription() {
  if (!feature.value || !openingHours.value) return;
  if (!auth.isAuthenticated) {
    await router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  error.value = "";
  try {
    if (openingHours.value.subscribed) {
      await apiFetch(`/features/${feature.value.id}/opening-subscription`, { method: "DELETE" });
      openingHours.value.subscribed = false;
      notice.value = "已取消开放时段变更提醒。";
    } else {
      await apiFetch(`/features/${feature.value.id}/opening-subscription`, { method: "PUT" });
      openingHours.value.subscribed = true;
      notice.value = "已订阅开放时段变更提醒。";
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "操作失败";
  }
}

async function addComment() {
  if (!feature.value || !commentBody.value.trim()) return;
  error.value = "";
  try {
    await apiFetch(`/features/${feature.value.id}/comments`, {
      method: "POST",
      body: { body: commentBody.value }
    });
    commentBody.value = "";
    notice.value = "评论已提交，审核通过后公开。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "评论失败";
  }
}

async function confirm(result: "still_accurate" | "changed" | "closed") {
  if (!feature.value) return;
  if (!auth.isAuthenticated) {
    await router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  try {
    await apiFetch(`/features/${feature.value.id}/confirmations`, { method: "POST", body: { result } });
    notice.value = "确认已记录，感谢帮助其他使用者。";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "确认失败";
  }
}

async function report() {
  if (!feature.value) return;
  if (!auth.isAuthenticated) {
    await router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  const reasonCode = window.prompt("请输入举报原因码，例如 WRONG_LOCATION、PERSONAL_INFORMATION、SPAM_OR_ADVERTISING");
  if (!reasonCode) return;
  const notes = window.prompt("补充说明（可选）") ?? undefined;
  try {
    await apiFetch("/reports", {
      method: "POST",
      body: { targetType: "feature", targetId: feature.value.id, reasonCode, notes }
    });
    notice.value = "举报已进入审核队列。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "举报失败";
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="error && !feature" class="error-box">{{ error }}</div>
    <template v-else-if="feature">
      <div class="page-heading">
        <div>
          <div class="inline">
            <span class="badge">{{ feature.categoryName }}</span>
            <span class="badge">{{ feature.condition }}</span>
            <span v-if="feature.firstPublishedAt" class="badge">最近更新 {{ new Date(feature.updatedAt).toLocaleDateString() }}</span>
          </div>
          <h1>{{ feature.title }}</h1>
          <p>{{ feature.description }}</p>
        </div>
        <div class="inline">
          <RouterLink v-if="canEdit" class="button secondary" :to="`/submit/${feature.id}`">创建修订</RouterLink>
          <button class="button ghost" type="button" @click="report">举报</button>
        </div>
      </div>

      <p v-if="error" class="error-box">{{ error }}</p>
      <p v-if="notice" class="success-box">{{ notice }}</p>

      <div class="detail-layout">
        <div class="stack">
          <section v-if="feature.media.length" class="card"><div class="card-body">
            <div class="media-grid">
              <a v-for="media in feature.media" :key="media.id" :href="media.url ?? '#'" target="_blank" rel="noreferrer">
                <img :src="media.thumbnailUrl ?? media.url ?? ''" alt="地点细节照片" />
              </a>
            </div>
          </div></section>

          <section class="card"><div class="card-body">
            <h2>实际细节</h2>
            <dl class="detail-list">
              <template v-for="[key, value] in detailEntries" :key="key">
                <dt>{{ detailLabels[key] ?? key }}</dt>
                <dd>{{ displayValue(value) }}</dd>
              </template>
              <dt>无台阶到达</dt><dd>{{ feature.stepFree === null ? "未知" : feature.stepFree ? "是" : "否" }}</dd>
              <dt>轮椅可用</dt><dd>{{ feature.wheelchairAccessible === null ? "未知" : feature.wheelchairAccessible ? "是" : "否" }}</dd>
              <dt>坐标</dt><dd>{{ feature.latitude.toFixed(6) }}, {{ feature.longitude.toFixed(6) }}（约 ±{{ feature.locationAccuracyM }} 米）</dd>
              <dt>标签</dt><dd>{{ feature.tags?.join("、") || "无" }}</dd>
            </dl>
            <div class="inline" style="margin-top: 18px">
              <button class="button secondary" type="button" @click="confirm('still_accurate')">仍然准确</button>
              <button class="button ghost" type="button" @click="confirm('changed')">已经变化</button>
              <button class="button ghost" type="button" @click="confirm('closed')">已经关闭</button>
            </div>
            <p v-if="feature.confirmations.length" class="muted" style="margin-top: 10px">
              已确认：{{ feature.confirmations.map((item) => `${item.result} ${item.count}`).join(" · ") }}
            </p>
          </div></section>

          <section class="card"><div class="card-body">
            <div class="inline" style="justify-content: space-between; width: 100%">
              <h2>开放时段</h2>
              <span v-if="openingStatus?.isOpen === true" class="badge">开放中</span>
              <span v-else-if="openingStatus?.isOpen === false" class="badge">已闭馆</span>
              <span v-else class="badge">未知</span>
            </div>
            <template v-if="openingHours?.schedule">
              <p class="muted">以下时间为地点当地时间（{{ openingHours.schedule.timezone }}）。</p>
              <dl class="detail-list">
                <template v-for="[key, label] in weekDayLabels" :key="key">
                  <dt>{{ label }}</dt>
                  <dd>{{ formatPeriods(openingHours.schedule.weekPattern[key]) }}</dd>
                </template>
              </dl>
              <p v-if="openingStatus?.currentWindow" class="muted">
                当前开放至 {{ formatLocalInstant(openingStatus.currentWindow.closeAt, openingHours.schedule.timezone) }}
              </p>
              <p v-else-if="openingStatus?.nextWindow" class="muted">
                下次开放：{{ formatLocalInstant(openingStatus.nextWindow.openAt, openingHours.schedule.timezone) }}
              </p>
              <div v-if="openingHours.exceptions.length">
                <h3>临时闭馆与节假日例外</h3>
                <ul>
                  <li v-for="exception in openingHours.exceptions" :key="exception.id">
                    {{ exceptionKindLabel(exception.kind) }}：{{ exception.startsOn }} 至 {{ exception.endsOn }}
                    <span v-if="exception.overridePeriods?.length">（按 {{ formatPeriods(exception.overridePeriods) }} 开放）</span>
                    <span v-else>（全天关闭）</span>
                    <span v-if="exception.reason">— {{ exception.reason }}</span>
                  </li>
                </ul>
              </div>
            </template>
            <p v-else class="muted">还没有维护开放时段。</p>
            <div class="inline" style="margin-top: 12px">
              <button v-if="openingHours?.schedule && feature.status === 'published'" class="button secondary small" type="button" @click="toggleOpeningSubscription">
                {{ openingHours.subscribed ? "取消变更提醒" : "订阅变更提醒" }}
              </button>
              <RouterLink v-if="canManageOpening" class="button ghost small" :to="`/features/${feature.id}/opening-hours`">
                管理开放时段
              </RouterLink>
            </div>
          </div></section>

          <section class="card"><div class="card-body">
            <h2>评论</h2>
            <form v-if="auth.isVerified" class="stack" style="margin: 14px 0" @submit.prevent="addComment">
              <textarea v-model="commentBody" maxlength="1000" placeholder="分享实际体验、时段变化或补充信息。评论同样需要审核。" />
              <button class="button" type="submit" :disabled="!commentBody.trim()">提交评论</button>
            </form>
            <p v-else class="notice-box">登录并验证邮箱后可以评论。</p>
            <div v-if="!comments.length" class="empty">还没有公开评论。</div>
            <article v-for="comment in comments" :key="comment.id" class="comment">
              <div class="comment-head">
                <strong>{{ comment.authorName }}</strong>
                <span>{{ new Date(comment.createdAt).toLocaleString() }}{{ comment.editedAt ? " · 已编辑" : "" }}</span>
              </div>
              <p>{{ comment.body }}</p>
            </article>
          </div></section>
        </div>

        <aside class="stack">
          <section class="card"><div class="card-body">
            <h2>位置</h2>
            <p class="muted">地图浏览页会对相同区域内容进行聚合，避免一次加载全部数据。</p>
            <a class="button secondary" :href="`/map`">回到地图</a>
          </div></section>
          <section class="card"><div class="card-body">
            <h2>内容状态</h2>
            <p class="muted">首次发布后有效期默认为 180 天。多人反馈变化或关闭时，内容会进入优先复核。</p>
          </div></section>
        </aside>
      </div>
    </template>
  </section>
</template>
