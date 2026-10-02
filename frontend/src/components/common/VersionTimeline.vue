<script setup lang="ts">
/**
 * VersionTimeline：把审计流水渲染成可追溯时间线。
 * 被批次读数页消费（后续品评档案页也可复用）。
 */
import { computed } from 'vue'
import type { AuditRow } from '@/utils/db'

const props = defineProps<{
  logs: AuditRow[]
  tankCode?: (tankId: string) => string
}>()

interface TimelineItem {
  timestamp: number
  label: string
  version: string
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'info'
  message: string
  dates: string
}

const TONE_BY_ACTION: Record<AuditRow['action'], TimelineItem['tone']> = {
  读数新增: 'primary',
  读数改动: 'warning',
  读数撤回: 'danger',
  工单保存: 'primary',
  工单失效: 'danger',
  工单复核: 'success',
  工单完成: 'success',
  工单删除: 'info',
  容量排队: 'warning',
  容量放行: 'success'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

const items = computed<TimelineItem[]>(() =>
  props.logs.map((log) => ({
    timestamp: log.createdAt,
    label: log.action,
    version: `v${log.readingVersion}`,
    tone: TONE_BY_ACTION[log.action],
    message: log.message,
    dates: log.dates.length > 0 ? `涉及日期：${log.dates.join('、')}` : ''
  }))
)
</script>

<template>
  <el-empty v-if="items.length === 0" description="暂无版本变更记录" :image-size="60" />
  <el-timeline v-else>
    <el-timeline-item
      v-for="item in items"
      :key="`${item.timestamp}-${item.label}`"
      :type="item.tone"
      :timestamp="`${formatTime(item.timestamp)} · ${item.version}`"
    >
      <div class="vt-line">
        <el-tag :type="item.tone" size="small" effect="plain">{{ item.label }}</el-tag>
        <span class="vt-msg">{{ item.message }}</span>
      </div>
      <div v-if="item.dates" class="vt-dates">{{ item.dates }}</div>
    </el-timeline-item>
  </el-timeline>
</template>

<style scoped>
.vt-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.vt-msg {
  font-size: 13px;
}

.vt-dates {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}
</style>
