<script setup lang="ts">
/** /operations 倒罐与压帽作业编排：按日期排序、拖拽调序、容量校验与待复核处理 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Rank } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictDialog from '@/components/common/ConflictDialog.vue'
import { db, type BatchRow, type OperationRow, type ParcelRow, type ReadingRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useOperationStore } from '@/stores/operationStore'
import { analyzeReadings } from '@/utils/trend'
import { OPERATION_STATES, OPERATION_TYPES, createEmptyOperation, type Operation } from '@/types/operation'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useOperationStore()

const { rows: operations, ready } = useIdbTable<OperationRow>(() => db.operations, {
  compare: (a, b) => a.seq - b.seq || a.date.localeCompare(b.date)
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: readings } = useIdbTable<ReadingRow>(() => db.readings, {
  compare: (a, b) => a.date.localeCompare(b.date)
})

const selects: FilterSelectConfig[] = [
  { key: 'types', label: '作业类型', options: OPERATION_TYPES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '状态', options: OPERATION_STATES.map((item) => ({ label: item, value: item })) }
]

function batchOf(batchId: string): BatchRow | null {
  return batches.value.find((item) => item.id === batchId) ?? null
}

function batchLabel(batchId: string): string {
  const batch = batchOf(batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate}`
}

function tankCode(tankId: string): string {
  if (!tankId) return '—'
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

/** 目标罐剩余容量：容量 − 在罐批次占用（含已完成倒罐改绑进来的批次） */
function remainingOf(tankId: string): number {
  const tank = tanks.value.find((item) => item.id === tankId)
  if (!tank) return 0
  const used = batches.value
    .filter((batch) => batch.tankId === tankId && batch.state !== '已出罐')
    .reduce((sum, batch) => sum + batch.volumeL, 0)
  return tank.capacityL - used
}

/** 排队工单实时的容量短差（升） */
function shortfallOf(row: OperationRow): number {
  const batch = batchOf(row.batchId)
  if (!batch || !row.targetTankId) return 0
  return Math.max(0, batch.volumeL - remainingOf(row.targetTankId))
}

/** 批次趋势维度是否可转罐（与读数页、版本链重算共用同一套判定） */
function transferableOf(batchId: string): boolean {
  const rows = readings.value.filter((row) => row.batchId === batchId)
  return analyzeReadings(rows).transferable
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const types = Array.isArray(store.filters.types) ? store.filters.types : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const scoped = store.currentBatchId
    ? operations.value.filter((item) => item.batchId === store.currentBatchId)
    : operations.value
  return scoped
    .filter((item) => {
      const label = `${item.type} ${item.operator} ${batchLabel(item.batchId)}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (types.length > 0 && !types.includes(item.type)) return false
      if (states.length > 0 && !states.includes(item.state)) return false
      return true
    })
    .sort((a, b) => a.seq - b.seq)
})

const summary = computed(() => ({
  total: filtered.value.length,
  planned: filtered.value.filter((item) => item.state === '计划').length,
  queued: filtered.value.filter((item) => item.state === '排队中').length,
  reviewing: filtered.value.filter((item) => item.state === '待复核').length,
  done: filtered.value.filter((item) => item.state === '已完成').length,
  totalMinutes: filtered.value.reduce((sum, item) => sum + item.durationMin, 0)
}))

/* ------------------------------ 拖拽调序 ------------------------------ */
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(index: number): void {
  dragIndex.value = index
}

function onDragOver(index: number): void {
  overIndex.value = index
}

async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || from === index) return
  await store.move(filtered.value, from, index)
  ElMessage.success('作业顺序已更新并写回本地库')
}

/** 上下移按钮：无鼠标拖拽时的等价操作 */
async function moveBy(index: number, offset: number): Promise<void> {
  await store.move(filtered.value, index, index + offset)
}

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Operation, 'id' | 'seq'>>(createEmptyOperation())

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
  targetTankId: [
    {
      validator: (_rule, value, callback) => {
        if (form.type === '倒罐' && !value) callback(new Error('倒罐作业必须选择目标罐'))
        else callback()
      },
      trigger: 'change'
    }
  ]
}

/** 倒罐目标罐候选：非清洗中、非源罐，并展示剩余容量 */
const targetTankOptions = computed(() => {
  const sourceTankId = batchOf(form.batchId)?.tankId ?? ''
  return tanks.value
    .filter((tank) => tank.state !== '清洗中' && tank.id !== sourceTankId)
    .map((tank) => ({ ...tank, remainingL: remainingOf(tank.id) }))
})

/** 表单内实时容量短差 */
const formShortfall = computed(() => {
  if (form.type !== '倒罐' || !form.targetTankId) return 0
  const batch = batchOf(form.batchId)
  if (!batch) return 0
  return Math.max(0, batch.volumeL - remainingOf(form.targetTankId))
})

async function openCreate(): Promise<void> {
  editingId.value = null
  Object.assign(form, createEmptyOperation())
  if (store.currentBatchId) form.batchId = store.currentBatchId
  if (form.batchId) await store.syncBaseVersion(form.batchId)
  dialogVisible.value = true
}

async function openEdit(row: OperationRow): Promise<void> {
  editingId.value = row.id
  Object.assign(form, {
    batchId: row.batchId,
    type: row.type,
    date: row.date,
    durationMin: row.durationMin,
    operator: row.operator,
    state: row.state,
    targetTankId: row.targetTankId,
    invalidReason: row.invalidReason
  })
  await store.syncBaseVersion(row.batchId)
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const result = await store.saveOperation({
      id: editingId.value,
      batchId: form.batchId,
      type: form.type,
      date: form.date,
      durationMin: form.durationMin,
      operator: form.operator,
      targetTankId: form.type === '倒罐' ? form.targetTankId : ''
    })
    if (!result) return // 版本冲突：冲突对话框已弹出
    if (result.state === '排队中') {
      ElMessage.warning(`容量不足，工单已排队等待：还差 ${result.shortfallL} L`)
    } else {
      ElMessage.success(editingId.value ? '作业已更新' : '作业已排入队列')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function finish(row: OperationRow): Promise<void> {
  try {
    const ok = await store.finish(row)
    if (!ok) return // 版本冲突
    ElMessage.success('作业已完成，批次最近作业时间已回写')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '完成失败')
  }
}

async function review(row: OperationRow): Promise<void> {
  try {
    const result = await store.review(row)
    if (!result) return // 版本冲突
    if (result.state === '排队中') {
      ElMessage.warning(`复核后容量仍不足，还差 ${result.shortfallL} L，继续排队`)
    } else {
      ElMessage.success('工单已复核，恢复计划')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '复核失败')
  }
}

async function remove(row: OperationRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的「${row.type}」作业？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    const ok = await store.deleteOperation(row)
    if (ok) ElMessage.success('作业已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
  // 窗口加载即快照全部批次版本：此后其它窗口的提交会让本窗口的保存判冲突
  void store.syncAllBaseVersions()
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">倒罐与压帽作业编排</h2>
        <p class="page__subtitle">
          按日期排班并拖拽调整先后顺序；倒罐校验目标罐剩余容量，容量不足排队等待，读数变更后失效工单退回复核。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增作业</el-button>
    </div>

    <el-card shadow="never">
      <div class="metric-row">
        <el-tag type="info" effect="plain">作业 {{ summary.total }} 条</el-tag>
        <el-tag type="info" effect="plain">计划中 {{ summary.planned }}</el-tag>
        <el-tag type="warning" effect="plain">排队中 {{ summary.queued }}</el-tag>
        <el-tag type="danger" effect="plain">待复核 {{ summary.reviewing }}</el-tag>
        <el-tag type="success" effect="plain">已完成 {{ summary.done }}</el-tag>
        <el-tag effect="plain">合计工时 {{ summary.totalMinutes }} 分钟</el-tag>
        <el-select v-model="store.currentBatchId" clearable placeholder="全部批次" class="batch-filter" @change="store.select(store.currentBatchId)">
          <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
        </el-select>
      </div>
    </el-card>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索作业类型 / 操作人 / 批次…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有排定的作业"
      description="为在罐批次添加倒罐 / 压帽 / 淋皮作业，然后用拖拽排出执行顺序。"
      create-text="新增作业"
      @create="openCreate"
    />

    <div v-else class="op-list">
      <div
        v-for="(row, index) in filtered"
        :key="row.id"
        class="op-item"
        :class="{ 'is-dragging': dragIndex === index, 'is-over': overIndex === index }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="dragIndex = null"
      >
        <el-icon class="drag-handle"><Rank /></el-icon>
        <div class="op-item__seq">#{{ index + 1 }}</div>
        <div class="op-item__body">
          <div class="op-item__title">
            <strong>{{ row.type }}</strong>
            <StageTag :value="row.state" size="small" />
            <el-tag size="small" effect="plain">{{ row.durationMin }} 分钟</el-tag>
            <el-tag v-if="row.type === '倒罐'" size="small" type="warning" effect="plain">
              → 罐 {{ tankCode(row.targetTankId) }}
            </el-tag>
            <el-tag v-if="row.state === '排队中'" size="small" type="danger" effect="plain">
              还差 {{ shortfallOf(row) }} L
            </el-tag>
          </div>
          <div class="op-item__meta">
            {{ row.date }} · 操作人 {{ row.operator }} · {{ batchLabel(row.batchId) }} · v{{ row.version }}
          </div>
          <div v-if="row.state === '待复核' && row.invalidReason" class="op-item__reason">
            {{ row.invalidReason }}
          </div>
        </div>
        <div class="op-item__actions">
          <el-button link size="small" :disabled="index === 0" @click="moveBy(index, -1)">上移</el-button>
          <el-button link size="small" :disabled="index === filtered.length - 1" @click="moveBy(index, 1)">下移</el-button>
          <el-button v-if="row.state === '待复核'" link type="warning" size="small" @click="review(row)">复核</el-button>
          <el-button v-if="row.state === '计划'" link type="success" size="small" @click="finish(row)">完成</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑作业' : '新增作业'" width="540px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" class="full" placeholder="选择批次">
            <el-option
              v-for="item in batches.filter((batch) => batch.state !== '已出罐')"
              :key="item.id"
              :label="batchLabel(item.id)"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="item in OPERATION_TYPES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.type === '倒罐'" label="目标罐" prop="targetTankId">
          <el-select v-model="form.targetTankId" class="full" placeholder="选择目标罐（显示剩余容量）">
            <el-option
              v-for="item in targetTankOptions"
              :key="item.id"
              :label="`${item.code} · ${item.capacityL}L · 剩余 ${item.remainingL}L`"
              :value="item.id"
            />
          </el-select>
          <div class="form-hint">
            <template v-if="form.batchId && !transferableOf(form.batchId)">
              当前批次趋势未到位（需进入后发酵且未停滞），可转罐结论为「暂不可转罐」。
            </template>
            <template v-if="formShortfall > 0">
              目标罐剩余容量不足，保存后将排队等待，还差 {{ formShortfall }} L。
            </template>
          </div>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="时长(分钟)">
          <el-input-number v-model="form.durationMin" :min="5" :max="600" :step="5" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：陈岩" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <ConflictDialog
      :conflict="store.conflict"
      @accept="store.acceptLatest()"
      @close="store.clearConflict()"
    />
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.batch-filter {
  width: 240px;
  margin-left: auto;
}

.form-hint {
  font-size: 12px;
  color: #b23b48;
  line-height: 1.6;
}

.op-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.op-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--wine-border);
  border-left: 4px solid #b9688a;
  border-radius: 10px;
}

.op-item.is-dragging {
  opacity: 0.45;
}

.op-item.is-over {
  border-top: 2px dashed #b9688a;
}

.op-item__seq {
  width: 38px;
  font-weight: 700;
  color: #8a3b56;
  font-variant-numeric: tabular-nums;
}

.op-item__body {
  flex: 1;
}

.op-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.op-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.op-item__reason {
  margin-top: 4px;
  font-size: 12px;
  color: #b23b48;
}

.op-item__actions {
  display: flex;
  align-items: center;
}
</style>
