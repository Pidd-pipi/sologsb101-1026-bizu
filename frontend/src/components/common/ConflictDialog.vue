<script setup lang="ts">
/**
 * 跨窗口保存冲突对话框：列出本窗口基准版本之后发生的变更
 * （冲突的读数日期与工单），用户确认后基于最新版本重试。
 * 被批次读数页与作业编排页消费。
 */
import { computed } from 'vue'
import type { VersionConflict } from '@/types/transfer'

const props = defineProps<{
  conflict: VersionConflict | null
}>()

const emit = defineEmits<{
  accept: []
  close: []
}>()

const visible = computed({
  get: () => props.conflict !== null,
  set: (value: boolean) => {
    if (!value) emit('close')
  }
})
</script>

<template>
  <el-dialog v-model="visible" title="保存被拒绝：数据已被其它窗口更新" width="560px">
    <template v-if="conflict">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="`你的修改基于版本 v${conflict.baseVersion}，当前最新为 v${conflict.currentVersion}`"
        description="为保住两个窗口的改动，本次保存未写入。请核对下列变更后，基于最新版本重新保存。"
        class="mb"
      />
      <div class="conflict-section">
        <div class="conflict-section__title">冲突的读数日期（{{ conflict.readingDates.length }}）</div>
        <div v-if="conflict.readingDates.length === 0" class="muted">无读数变更</div>
        <el-tag v-for="date in conflict.readingDates" :key="date" type="danger" effect="plain" class="conflict-tag">
          {{ date }}
        </el-tag>
      </div>
      <div class="conflict-section">
        <div class="conflict-section__title">冲突的工单（{{ conflict.operations.length }}）</div>
        <div v-if="conflict.operations.length === 0" class="muted">无工单变更</div>
        <div v-for="op in conflict.operations" :key="`${op.id}-${op.action}`" class="conflict-op">
          <el-tag size="small" type="warning" effect="plain">{{ op.action }}</el-tag>
          <span>{{ op.label }}</span>
        </div>
      </div>
    </template>
    <template #footer>
      <el-button @click="emit('close')">先放弃本次修改</el-button>
      <el-button type="primary" @click="emit('accept')">基于最新版本重试</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}

.conflict-section {
  margin-top: 12px;
}

.conflict-section__title {
  font-weight: 600;
  margin-bottom: 8px;
}

.conflict-tag {
  margin-right: 8px;
  margin-bottom: 6px;
}

.conflict-op {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.muted {
  color: #8c8479;
  font-size: 13px;
}
</style>
