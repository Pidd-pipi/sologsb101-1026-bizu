<script setup lang="ts">
/** /operations 倒罐与压帽作业编排：版本化工单、容量排队、依据失效退回复核 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Rank } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import {
  db,
  type BatchRow,
  type OperationRow,
  type ParcelRow,
  type TankRow,
  type TrendRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useOperationStore, type OperationDraft } from '@/stores/operationStore'
import {
  OPERATION_STATES,
  OPERATION_TYPES,
  createEmptyOperation,
  isRackingOperation
} from '@/types/operation'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { showConflictIfAny } from '@/utils/conflictDialog'
import { useTankCapacities } from '@/hooks/useTankCapacities'

const route = useRoute()
const router = useRouter()
const store = useOperationStore()

const { rows: operations, ready } = useIdbTable<OperationRow>(() => db.operations, {
  compare: (a, b) => a.seq - b.seq || a.date.localeCompare(b.date)
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: trends } = useIdbTable<TrendRow>(() => db.trends)

const { capacities, freeWithReservations } = useTankCapacities(tanks, batches, operations)

const selects: FilterSelectConfig[] = [
  { key: 'types', label: '作业类型', options: OPERATION_TYPES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '状态', options: OPERATION_STATES.map((item) => ({ label: item, value: item })) }
]

function batchOf(batchId: string): BatchRow | undefined {
  return batches.value.find((item) => item.id === batchId)
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

function trendOf(batchId: string): TrendRow | undefined {
  return trends.value.find((item) => item.batchId === batchId)
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
  queued: filtered.value.filter((item) => item.state === '排队').length,
  review: filtered.value.filter((item) => item.state === '待复核').length,
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
  ElMessage.success('作业顺序已更新，排队先后已按新顺序重算')
}

async function moveBy(index: number, offset: number): Promise<void> {
  await store.move(filtered.value, index, index + offset)
}

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingRow = ref<OperationRow | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<OperationDraft, 'batchId'> & { batchId: string }>({
  ...createEmptyOperation()
})
/** 打开弹窗时锁定的批次读数版本（乐观锁基线） */
const baselineVersion = ref(0)

const rules = computed<FormRules>(() => ({
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
  targetTankId: racking.value ? [{ required: true, message: '倒罐请选择目标罐', trigger: 'change' }] : []
}))

const formBatch = computed(() => (form.batchId ? batchOf(form.batchId) : undefined))
const formTrend = computed(() => (form.batchId ? trendOf(form.batchId) : undefined))

/** 表单中目标罐的实时剩余容量（含其它计划单预留，不含当前编辑单自身） */
const targetFreeL = computed(() => {
  if (!form.targetTankId) return 0
  const free = freeWithReservations.value.get(form.targetTankId) ?? 0
  // 编辑自身已占位的计划单，其预留要加回
  if (editingRow.value && editingRow.value.targetTankId === form.targetTankId && editingRow.value.state === '计划') {
    return free + editingRow.value.transferVolumeL
  }
  return free
})

const targetTank = computed(() => tanks.value.find((item) => item.id === form.targetTankId))
const racking = computed(() => isRackingOperation(form))

/** 新建倒罐液量 = 源罐批次在罐全量（整罐转出）；编辑时沿用工单值，事务内仍以批次量核定 */
function syncDefaultVolume(): void {
  if (racking.value && formBatch.value) {
    form.transferVolumeL = editingRow.value ? editingRow.value.transferVolumeL || formBatch.value.volumeL : formBatch.value.volumeL
  }
}

function resetForm(): void {
  Object.assign(form, createEmptyOperation())
}

function openCreate(): void {
  editingRow.value = null
  resetForm()
  if (store.currentBatchId) {
    form.batchId = store.currentBatchId
    const batch = batchOf(store.currentBatchId)
    baselineVersion.value = batch?.readingVersion ?? 0
    syncDefaultVolume()
  } else {
    baselineVersion.value = 0
  }
  dialogVisible.value = true
}

function openEdit(row: OperationRow): void {
  editingRow.value = row
  Object.assign(form, {
    batchId: row.batchId,
    type: row.type,
    date: row.date,
    durationMin: row.durationMin,
    operator: row.operator,
    targetTankId: row.targetTankId,
    transferVolumeL: row.transferVolumeL
  })
  baselineVersion.value = batchOf(row.batchId)?.readingVersion ?? 0
  dialogVisible.value = true
}

watch(
  () => form.batchId,
  () => {
    const batch = formBatch.value
    baselineVersion.value = batch?.readingVersion ?? 0
    syncDefaultVolume()
  }
)

watch(
  () => form.type,
  () => syncDefaultVolume()
)

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const saved = await store.saveOperation(
      {
        batchId: form.batchId,
        type: form.type,
        date: form.date,
        durationMin: form.durationMin,
        operator: form.operator,
        targetTankId: racking.value ? form.targetTankId : '',
        transferVolumeL: racking.value ? form.transferVolumeL : 0
      },
      baselineVersion.value,
      editingRow.value
    )
    if (racking.value && saved.state === '排队') {
      ElMessage.warning(`目标罐容量不足，工单已排队等待，还差 ${saved.shortfallL}L`)
    } else {
      ElMessage.success(editingRow.value ? '工单已更新' : '作业已排入队列')
    }
    dialogVisible.value = false
  } catch (error) {
    const handled = await showConflictIfAny(error, { batchLabel, tankCode })
    if (!handled) ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function finish(row: OperationRow): Promise<void> {
  try {
    await store.finish(row.id)
    ElMessage.success(
      row.type === '倒罐' ? '倒罐已完成，批次转入目标罐，占住容量已保留' : '作业已完成，批次最近作业时间已回写'
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '完成失败')
  }
}

async function review(row: OperationRow): Promise<void> {
  let note = row.reviewNote
  try {
    const result = await ElMessageBox.prompt(
      `依据读数版本 v${row.basisVersion} 已过期。复核当前停滞 / 超温 / 可转罐结论后确认，工单将按目标罐容量重新决定「计划 / 排队」。`,
      '倒罐工单退回复核',
      {
        confirmButtonText: '复核通过',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputValue: note,
        inputPlaceholder: '复核备注（可留空）'
      }
    )
    note = result.value
  } catch {
    return
  }
  try {
    const saved = await store.review(row.id, note)
    ElMessage.success(saved.state === '排队' ? `复核通过，但容量仍不足，继续排队（还差 ${saved.shortfallL}L）` : '复核通过，工单恢复为计划')
  } catch (error) {
    const handled = await showConflictIfAny(error, { batchLabel, tankCode })
    if (!handled) ElMessage.error(error instanceof Error ? error.message : '复核失败')
  }
}

async function remove(row: OperationRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的「${row.type}」工单？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.deleteOperation(row.id)
  ElMessage.success('工单已删除，排队顺序已重算')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
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
          倒罐工单只接受基于最新读数版本的排单；可转罐要求源罐液量不超过目标罐剩余容量，容量不足自动排队并显示差额。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增作业</el-button>
    </div>

    <el-card shadow="never" class="mb">
      <div class="metric-row">
        <el-tag type="info" effect="plain">工单 {{ summary.total }} 条</el-tag>
        <el-tag type="info" effect="plain">计划中 {{ summary.planned }}</el-tag>
        <el-tag type="warning" effect="plain">排队 {{ summary.queued }}</el-tag>
        <el-tag type="danger" effect="plain">待复核 {{ summary.review }}</el-tag>
        <el-tag type="success" effect="plain">已完成 {{ summary.done }}</el-tag>
        <el-tag effect="plain">合计工时 {{ summary.totalMinutes }} 分钟</el-tag>
        <el-select
          v-model="store.currentBatchId"
          clearable
          placeholder="全部批次"
          class="batch-filter"
          @change="store.select(store.currentBatchId)"
        >
          <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
        </el-select>
      </div>
    </el-card>

    <el-card shadow="never" class="mb">
      <template #header><span>罐位容量（已完成倒罐占住的容量持续保留）</span></template>
      <div class="cap-grid">
        <div v-for="cap in Array.from(capacities.values())" :key="cap.tankId" class="cap-item">
          <div class="cap-item__head">
            <strong>{{ cap.code }}</strong>
            <span class="muted">{{ cap.capacityL }}L</span>
          </div>
          <el-progress
            :percentage="Math.round((cap.occupiedL / cap.capacityL) * 100)"
            :status="cap.freeL === 0 ? 'exception' : undefined"
            :stroke-width="10"
          />
          <div class="cap-item__meta">
            已占 {{ cap.occupiedL }}L · 剩 {{ cap.freeL }}L
          </div>
        </div>
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
      description="为在罐批次添加倒罐 / 压帽 / 淋皮作业；倒罐会自动校验可转罐条件与目标罐容量。"
      create-text="新增作业"
      @create="openCreate"
    />

    <div v-else class="op-list">
      <div
        v-for="(row, index) in filtered"
        :key="row.id"
        class="op-item"
        :class="{
          'is-dragging': dragIndex === index,
          'is-over': overIndex === index,
          'is-review': row.state === '待复核',
          'is-queue': row.state === '排队'
        }"
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
            <el-tag v-if="row.type === '倒罐'" size="small" type="info" effect="plain">
              依据读数 v{{ row.basisVersion }}
            </el-tag>
          </div>
          <div class="op-item__meta">
            {{ row.date }} · 操作人 {{ row.operator }} · {{ batchLabel(row.batchId) }}
          </div>
          <div v-if="row.type === '倒罐'" class="op-item__rack">
            <el-tag size="small" effect="plain">
              罐 {{ tankCode(batchOf(row.batchId)?.tankId ?? '') }}（源）
            </el-tag>
            <span class="arrow">→</span>
            <el-tag size="small" type="warning" effect="plain">罐 {{ tankCode(row.targetTankId) }}（目标）</el-tag>
            <el-tag size="small" type="info" effect="plain">倒出 {{ row.transferVolumeL }}L</el-tag>
            <el-tag
              v-if="row.state === '排队'"
              size="small"
              type="danger"
              effect="dark"
            >排队等待 · 还差 {{ row.shortfallL }}L</el-tag>
            <el-tag v-else-if="row.state === '计划'" size="small" type="success" effect="plain">
              目标罐剩 {{ freeWithReservations.get(row.targetTankId) ?? '—' }}L（含本单预留）
            </el-tag>
          </div>
          <el-alert
            v-if="row.state === '待复核'"
            type="error"
            :closable="false"
            show-icon
            class="review-alert"
            :title="`读数依据已失效（冲突日期：${row.staleDates.join('、') || '见批次追溯'}）`"
            :description="row.reviewNote"
          />
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

    <el-dialog
      v-model="dialogVisible"
      :title="editingRow ? '编辑工单' : '新增作业'"
      width="560px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" class="full" placeholder="选择批次">
            <el-option
              v-for="item in batches.filter((batch) => batch.state !== '已出罐')"
              :key="item.id"
              :label="`${batchLabel(item.id)} · ${item.volumeL}L · 读数 v${item.readingVersion}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="item in OPERATION_TYPES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-if="racking">
          <el-alert
            v-if="formBatch"
            :type="formTrend?.rackable ? 'success' : 'warning'"
            :closable="false"
            show-icon
            class="mb"
            :title="formTrend?.rackable
              ? `批次满足可转罐条件（读数 v${formBatch.readingVersion}，最新比重 ${formTrend?.latestGravity}）`
              : `批次当前不可转罐：${formTrend?.rackableReasons.join('；') ?? '暂无趋势数据'}`"
          />
          <el-form-item label="源罐液量">
            <el-tag effect="plain">
              罐 {{ tankCode(formBatch?.tankId ?? '') }} · 在罐 {{ formBatch?.volumeL ?? 0 }}L（整罐转出）
            </el-tag>
          </el-form-item>
          <el-form-item label="目标罐" prop="targetTankId">
            <el-select v-model="form.targetTankId" class="full" placeholder="选择目标罐（清洗中不可选）">
              <el-option
                v-for="item in tanks.filter(
                  (tank) => tank.state !== '清洗中' && tank.id !== formBatch?.tankId
                )"
                :key="item.id"
                :label="`${item.code} · ${item.material} 容量 ${item.capacityL}L · 当前剩 ${freeWithReservations.get(item.id) ?? item.capacityL}L`"
                :value="item.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item v-if="targetTank" label="目标剩余容量">
            <el-tag :type="targetFreeL >= (formBatch?.volumeL ?? 0) ? 'success' : 'danger'" effect="plain">
              剩余 {{ targetFreeL }}L
              <template v-if="targetFreeL < (formBatch?.volumeL ?? 0)">
                ，容量不足，保存后排队（还差 {{ (formBatch?.volumeL ?? 0) - targetFreeL }}L）
              </template>
            </el-tag>
          </el-form-item>
        </template>

        <el-form-item label="日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="时长(分钟)">
          <el-input-number v-model="form.durationMin" :min="5" :max="600" :step="5" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：陈岩" />
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          :title="`保存时校验批次读数版本 v${baselineVersion}；另一窗口若已保存新读数，本单将被拒绝并提示冲突日期与工单。`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存工单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
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

.cap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.cap-item__head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}

.cap-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
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

.op-item.is-queue {
  border-left-color: #c9863c;
  background: #fffaf2;
}

.op-item.is-review {
  border-left-color: #c45656;
  background: #fef6f6;
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

.op-item__rack {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.arrow {
  color: #8a3b56;
  font-weight: 700;
}

.review-alert {
  margin-top: 8px;
}

.op-item__actions {
  display: flex;
  align-items: center;
}
</style>
