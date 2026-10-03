<script setup lang="ts">
/** /batches 入罐登记与发酵读数录入：逐日比重/温度/糖度趋势、超温标记与版本链追溯 */
import { computed, onMounted, onScopeDispose, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { liveQuery } from 'dexie'
import { ElMessage, ElMessageBox, ElNotification, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import ConflictDialog from '@/components/common/ConflictDialog.vue'
import {
  db,
  type BatchRow,
  type BatchVersionRow,
  type ChangeLogRow,
  type ParcelRow,
  type ReadingRow,
  type TankRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useFermentTrend } from '@/hooks/useFermentTrend'
import { useBatchStore } from '@/stores/batchStore'
import { useReadingStore } from '@/stores/readingStore'
import { BATCH_STATES, createEmptyBatch, type Batch } from '@/types/batch'
import { OVER_TEMP_C, createEmptyReading, type Reading } from '@/types/reading'
import { CHANGE_ACTION_LABELS } from '@/types/changeLog'
import type { RecalcResult } from '@/types/transfer'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useBatchStore()
const readingStore = useReadingStore()

const { rows: batches, ready } = useIdbTable<BatchRow>(() => db.batches, {
  compare: (a, b) => b.harvestDate.localeCompare(a.harvestDate)
})
const { rows: readings } = useIdbTable<ReadingRow>(() => db.readings, {
  compare: (a, b) => a.date.localeCompare(b.date)
})
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: changeLogs } = useIdbTable<ChangeLogRow>(() => db.changeLogs, {
  compare: (a, b) => b.at - a.at
})

/** 批次数据版本表主键是 batchId（无 id 字段），直接用 liveQuery 订阅 */
const batchVersions = ref<BatchVersionRow[]>([])
const versionSubscription = liveQuery(() => db.batchVersions.toArray()).subscribe((list) => {
  batchVersions.value = list
})
onScopeDispose(() => versionSubscription.unsubscribe())

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'states', label: '批次状态', options: BATCH_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'parcelIds', label: '地块', options: parcels.value.map((item) => ({ label: item.name, value: item.id })) }
])

const filteredBatches = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const parcelIds = Array.isArray(store.filters.parcelIds) ? store.filters.parcelIds : []
  return batches.value.filter((batch) => {
    const parcel = parcels.value.find((item) => item.id === batch.parcelId)
    const label = `${parcel ? parcel.name : ''} ${batch.id} ${batch.state}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (states.length > 0 && !states.includes(batch.state)) return false
    if (parcelIds.length > 0 && !parcelIds.includes(batch.parcelId)) return false
    return true
  })
})

const currentBatch = computed<BatchRow | null>(
  () => batches.value.find((batch) => batch.id === store.currentBatchId) ?? null
)

const batchReadings = computed<ReadingRow[]>(() =>
  readings.value
    .filter((row) => row.batchId === store.currentBatchId)
    .sort((a, b) => a.date.localeCompare(b.date))
)

const trend = useFermentTrend(batchReadings)

/** 当前批次的数据版本（版本链：读数 / 工单每次变更 +1） */
const currentVersion = computed(() => {
  if (!store.currentBatchId) return 0
  return batchVersions.value.find((row) => row.batchId === store.currentBatchId)?.version ?? 0
})

/** 当前批次的变更日志（可追溯时间线） */
const batchLogs = computed(() =>
  changeLogs.value.filter((log) => log.batchId === store.currentBatchId).slice(0, 30)
)

const batchTotals = computed(() => {
  const active = batches.value.filter((batch) => batch.state !== '已出罐')
  return {
    batchCount: batches.value.length,
    activeCount: active.length,
    activeVolume: active.reduce((sum, batch) => sum + batch.volumeL, 0),
    avgBrix:
      active.length > 0 ? Number((active.reduce((sum, batch) => sum + batch.brix, 0) / active.length).toFixed(1)) : 0,
    readingCount: readings.value.length
  }
})

function parcelName(parcelId: string): string {
  return parcels.value.find((item) => item.id === parcelId)?.name ?? '未绑定地块'
}

function tankCode(tankId: string): string {
  if (!tankId) return '已释放'
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

/** 趋势条高度百分比（比重越大条越高） */
function barHeight(gravity: number): number {
  const { min, max } = trend.range.value
  const ratio = (gravity - min) / Math.max(0.001, max - min)
  return Math.max(6, Math.min(100, Math.round(ratio * 100)))
}

function formatLogTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/** 保存 / 撤回后提示重算结论与退回的工单 */
function notifyRecalc(recalc: RecalcResult): void {
  const parts = [
    recalc.stuck ? '疑似停滞' : '发酵正常',
    `超温 ${recalc.overTempDays} 天`,
    recalc.transferable ? '可转罐' : '暂不可转罐'
  ]
  if (recalc.invalidated.length > 0) {
    parts.push(`退回 ${recalc.invalidated.length} 条工单复核`)
  }
  ElNotification({
    title: `已从 ${recalc.fromDate} 起重算趋势`,
    message: parts.join('；'),
    type: recalc.invalidated.length > 0 ? 'warning' : 'success',
    duration: 6000
  })
}

/* ------------------------------ 入罐登记 ------------------------------ */
const batchDialog = ref(false)
const batchFormRef = ref<FormInstance>()
const batchForm = reactive<Omit<Batch, 'id' | 'lastOperationAt'>>(createEmptyBatch())

const batchRules: FormRules = {
  parcelId: [{ required: true, message: '请选择地块', trigger: 'change' }],
  tankId: [{ required: true, message: '请选择发酵罐', trigger: 'change' }],
  volumeL: [{ required: true, message: '请填写入罐量', trigger: 'blur' }]
}

/** 可选罐位：状态非「清洗中」，且未被其它在罐批次占用 */
const assignableTanks = computed(() =>
  tanks.value.filter((tank) => {
    if (tank.state === '清洗中') return false
    const occupied = batches.value.some(
      (batch) => batch.tankId === tank.id && batch.state !== '已出罐' && batch.id !== store.currentBatchId
    )
    return !occupied
  })
)

function openCreateBatch(): void {
  Object.assign(batchForm, createEmptyBatch())
  const parcelFromQuery = typeof route.query.parcelId === 'string' ? route.query.parcelId : ''
  if (parcelFromQuery) batchForm.parcelId = parcelFromQuery
  batchDialog.value = true
}

async function submitBatch(): Promise<void> {
  const valid = await batchFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    await store.createBatch({ ...batchForm })
    ElMessage.success('批次已入罐，罐位置为「在用」')
    batchDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '入罐失败')
  }
}

async function shipBatch(batch: BatchRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认批次 ${batch.id} 出罐？出罐后将自动释放罐位并归档该批次全部读数。`, '出罐确认', {
      type: 'warning',
      confirmButtonText: '确认出罐'
    })
  } catch {
    return
  }
  const promoted = await store.ship(batch.id)
  ElMessage.success(
    promoted > 0 ? `批次已出罐，罐位已释放；${promoted} 条排队工单容量已够，恢复计划` : '批次已出罐，罐位已释放'
  )
}

async function removeBatch(batch: BatchRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除批次 ${batch.id} 会同时删除其读数 / 作业 / 苹乳 / 品评记录，是否继续？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteBatch(batch.id)
  ElMessage.success('批次及其下级记录已删除')
}

/* ------------------------------ 读数录入 / 编辑 / 撤回 ------------------------------ */
const readingDialog = ref(false)
const readingFormRef = ref<FormInstance>()
const editingReadingId = ref<string | null>(null)
const readingForm = reactive<Omit<Reading, 'id'>>(createEmptyReading())

const readingRules: FormRules = {
  date: [{ required: true, message: '请选择日期', trigger: 'change' }],
  gravity: [{ required: true, message: '请填写比重', trigger: 'blur' }]
}

/** 新增时若该日期已有读数，保存将覆盖更新当日记录（同批次同日唯一） */
const sameDayExisting = computed<ReadingRow | null>(() => {
  if (editingReadingId.value) return null
  return batchReadings.value.find((row) => row.date === readingForm.date) ?? null
})

async function openCreateReading(): Promise<void> {
  if (!currentBatch.value) {
    ElMessage.warning('请先选择批次')
    return
  }
  editingReadingId.value = null
  Object.assign(readingForm, createEmptyReading())
  readingForm.batchId = currentBatch.value.id
  // 打开对话框即快照基准版本：此后其它窗口的提交会让本次保存判冲突
  await readingStore.syncBaseVersion(currentBatch.value.id)
  readingDialog.value = true
}

async function openEditReading(row: ReadingRow): Promise<void> {
  editingReadingId.value = row.id
  Object.assign(readingForm, {
    batchId: row.batchId,
    date: row.date,
    gravity: row.gravity,
    tempC: row.tempC,
    brix: row.brix
  })
  await readingStore.syncBaseVersion(row.batchId)
  readingDialog.value = true
}

async function submitReading(): Promise<void> {
  const valid = await readingFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const result = await readingStore.saveReading({
      batchId: readingForm.batchId,
      date: readingForm.date,
      gravity: readingForm.gravity,
      tempC: readingForm.tempC,
      brix: readingForm.brix,
      editingId: editingReadingId.value
    })
    if (!result) return // 版本冲突：冲突对话框已弹出
    notifyRecalc(result.recalc)
    readingDialog.value = false
    editingReadingId.value = null
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function withdrawReading(row: ReadingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤回 ${row.date} 的读数？撤回后将从该日期起重算停滞 / 超温 / 可转罐结论，失效工单退回复核。`,
      '撤回确认',
      { type: 'warning', confirmButtonText: '确认撤回' }
    )
  } catch {
    return
  }
  try {
    const result = await readingStore.withdrawReading({ id: row.id, batchId: row.batchId })
    if (result) notifyRecalc(result.recalc)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '撤回失败')
  }
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
  if (!store.currentBatchId && filteredBatches.value.length > 0) {
    store.select(filteredBatches.value[0].id)
  }
  if (store.currentBatchId) void readingStore.syncBaseVersion(store.currentBatchId)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(currentBatch, (batch) => {
  if (batch) {
    void readingStore.syncBaseVersion(batch.id)
    void router.replace({ path: route.path, query: { ...filtersToQuery(store.filters), batchId: batch.id } })
  }
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">入罐登记与发酵读数</h2>
        <p class="page__subtitle">
          逐日记录比重 / 温度 / 糖度（同批次同日唯一），改动或撤回后从受影响日期起重算停滞、超温与可转罐结论。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreateBatch">新建入罐批次</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="批次数" :value="batchTotals.batchCount" suffix="批" icon="Files" tone="primary" />
      <StatBadge label="在罐批次" :value="batchTotals.activeCount" suffix="批" icon="Grid" tone="warning" />
      <StatBadge label="在罐量" :value="batchTotals.activeVolume" suffix="L" icon="Histogram" tone="success" />
      <StatBadge label="平均入罐糖度" :value="batchTotals.avgBrix" suffix="°Bx" icon="TrendCharts" tone="info" />
      <StatBadge label="读数条数" :value="batchTotals.readingCount" suffix="条" icon="DataLine" tone="danger" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索地块 / 批次号 / 状态…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-row :gutter="16">
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>批次清单（{{ filteredBatches.length }}）</span>
              <span class="muted">点击选择批次</span>
            </div>
          </template>
          <EmptyPanel
            v-if="ready && filteredBatches.length === 0"
            title="暂无批次"
            description="先做一次入罐登记，把地块与发酵罐绑定起来。"
            create-text="新建入罐批次"
            @create="openCreateBatch"
          />
          <div v-else class="batch-list">
            <div
              v-for="batch in filteredBatches"
              :key="batch.id"
              class="batch-item"
              :class="{ 'is-active': batch.id === store.currentBatchId }"
              @click="store.select(batch.id)"
            >
              <div class="batch-item__head">
                <span class="batch-item__name">{{ parcelName(batch.parcelId) }}</span>
                <StageTag :value="batch.state" size="small" />
              </div>
              <div class="batch-item__meta">
                {{ batch.harvestDate }} · {{ batch.volumeL }}L · {{ batch.brix }}°Bx · 罐 {{ tankCode(batch.tankId) }}
              </div>
              <div class="batch-item__actions">
                <el-button link type="primary" size="small" @click.stop="shipBatch(batch)">出罐</el-button>
                <el-button link type="danger" size="small" @click.stop="removeBatch(batch)">删除</el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>
                读数明细
                <template v-if="currentBatch"> · {{ parcelName(currentBatch.parcelId) }}</template>
              </span>
              <div class="card-title__side">
                <el-tag v-if="currentBatch" type="info" effect="plain" size="small">
                  数据版本 v{{ currentVersion }}
                </el-tag>
                <el-button type="primary" size="small" :icon="Plus" @click="openCreateReading">录入读数</el-button>
              </div>
            </div>
          </template>

          <EmptyPanel
            v-if="!currentBatch"
            title="未选择批次"
            description="在左侧选择一个批次后即可录入发酵读数。"
            :show-create="false"
          />

          <template v-else>
            <el-alert
              v-if="trend.stuck.value"
              type="warning"
              :closable="false"
              show-icon
              title="疑似发酵停滞"
              description="末尾两次读数的比重日下降速率低于 0.002，建议检查温度与营养盐。"
              class="mb"
            />
            <el-alert
              v-if="trend.overTempDays.value > 0"
              type="error"
              :closable="false"
              show-icon
              :title="`累计超温 ${trend.overTempDays.value} 天`"
              :description="`存在温度高于 ${OVER_TEMP_C} ℃ 的读数，已在明细中标记。`"
              class="mb"
            />

            <div class="metric-row">
              <StageTag :value="trend.stage.value" />
              <el-tag type="info" effect="plain">最新比重 {{ trend.latestGravity.value || '—' }}</el-tag>
              <el-tag type="info" effect="plain">日均下降 {{ trend.avgDeclinePerDay.value }}</el-tag>
              <el-tag type="info" effect="plain">潜在酒精度 {{ trend.potential.value }}%vol</el-tag>
              <el-tag :type="trend.transferable.value ? 'success' : 'info'" effect="plain">
                {{ trend.transferable.value ? '可转罐' : '暂不可转罐' }}
              </el-tag>
            </div>

            <div class="trend-bar">
              <div v-for="point in trend.points.value" :key="point.id" class="trend-bar__item" :title="`${point.date} · ${point.gravity}`">
                <div
                  class="trend-bar__fill"
                  :class="{ 'is-over': point.overTemp }"
                  :style="{ height: `${barHeight(point.gravity)}%` }"
                />
                <span class="trend-bar__label">{{ point.date.slice(5) }}</span>
              </div>
            </div>

            <el-table :data="trend.points.value" stripe border class="mt">
              <el-table-column prop="date" label="日期" width="110" />
              <el-table-column prop="gravity" label="比重" width="90" align="right" />
              <el-table-column prop="brix" label="糖度(°Bx)" width="100" align="right" />
              <el-table-column prop="tempC" label="温度(℃)" width="100" align="right">
                <template #default="{ row }">
                  <el-tag :type="row.overTemp ? 'danger' : 'success'" effect="plain" size="small">
                    {{ row.tempC }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="下降速率/日" width="110" align="right">
                <template #default="{ row }">{{ row.declinePerDay }}</template>
              </el-table-column>
              <el-table-column label="版本" width="70" align="right">
                <template #default="{ row }">v{{ row.version }}</template>
              </el-table-column>
              <el-table-column label="操作" width="120">
                <template #default="{ row }">
                  <el-button link type="primary" size="small" @click="openEditReading(row)">编辑</el-button>
                  <el-button link type="danger" size="small" @click="withdrawReading(row)">撤回</el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-card>

        <el-card v-if="currentBatch" shadow="never" class="mt">
          <template #header>
            <div class="card-title">
              <span>变更追溯</span>
              <span class="muted">读数 → 趋势重算 → 工单联动的版本链（当前 v{{ currentVersion }}）</span>
            </div>
          </template>
          <EmptyPanel
            v-if="batchLogs.length === 0"
            title="暂无变更记录"
            description="保存或撤回读数后，这里会记录每次重算与工单联动。"
            :show-create="false"
          />
          <el-timeline v-else class="log-timeline">
            <el-timeline-item v-for="log in batchLogs" :key="log.id" :timestamp="formatLogTime(log.at)" placement="top">
              <div class="log-item">
                <el-tag size="small" effect="plain" :type="log.action === 'invalidate' ? 'danger' : 'info'">
                  {{ CHANGE_ACTION_LABELS[log.action] }}
                </el-tag>
                <span class="log-item__label">{{ log.label }}</span>
                <span class="log-item__version">v{{ log.batchVersion }}</span>
              </div>
              <div class="log-item__detail">{{ log.detail }}</div>
            </el-timeline-item>
          </el-timeline>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="batchDialog" title="新建入罐批次" width="560px">
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="100px">
        <el-form-item label="地块" prop="parcelId">
          <el-select v-model="batchForm.parcelId" class="full" placeholder="选择地块">
            <el-option v-for="item in parcels" :key="item.id" :label="`${item.name}（${item.variety}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发酵罐" prop="tankId">
          <el-select v-model="batchForm.tankId" class="full" placeholder="仅列出可分配罐位">
            <el-option
              v-for="item in assignableTanks"
              :key="item.id"
              :label="`${item.code} · ${item.material} ${item.capacityL}L`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="采收日期">
          <el-date-picker v-model="batchForm.harvestDate" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="入罐量(L)" prop="volumeL">
          <el-input-number v-model="batchForm.volumeL" :min="10" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="入罐糖度">
          <el-input-number v-model="batchForm.brix" :min="5" :max="40" :step="0.5" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">确认入罐</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="readingDialog" :title="editingReadingId ? '编辑发酵读数' : '录入发酵读数'" width="520px">
      <el-alert
        v-if="sameDayExisting"
        type="warning"
        :closable="false"
        show-icon
        title="该日期已有读数"
        :description="`同批次同日只保留一条，保存将覆盖 ${sameDayExisting.date} 的现有读数（比重 ${sameDayExisting.gravity}）。`"
        class="mb"
      />
      <el-form ref="readingFormRef" :model="readingForm" :rules="readingRules" label-width="100px">
        <el-form-item label="日期" prop="date">
          <el-date-picker
            v-model="readingForm.date"
            type="date"
            value-format="YYYY-MM-DD"
            class="full"
            :disabled="editingReadingId !== null"
          />
          <div v-if="editingReadingId" class="form-hint">日期是唯一键的一部分，改日期请撤回后重新补录</div>
        </el-form-item>
        <el-form-item label="比重(SG)" prop="gravity">
          <el-input-number v-model="readingForm.gravity" :min="0.9" :max="1.2" :step="0.001" :precision="3" />
        </el-form-item>
        <el-form-item label="温度(℃)">
          <el-input-number v-model="readingForm.tempC" :min="5" :max="45" :step="0.5" />
        </el-form-item>
        <el-form-item label="糖度(°Bx)">
          <el-input-number v-model="readingForm.brix" :min="-5" :max="40" :step="0.1" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="readingDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReading">保存读数</el-button>
      </template>
    </el-dialog>

    <ConflictDialog
      :conflict="readingStore.conflict"
      @accept="readingStore.acceptLatest()"
      @close="readingStore.clearConflict()"
    />
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 12px;
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.card-title__side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-hint {
  font-size: 12px;
  color: #8c8479;
  line-height: 1.6;
}

.batch-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 620px;
  overflow-y: auto;
}

.batch-item {
  padding: 10px 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.batch-item.is-active {
  border-color: #b9688a;
  background: #fdf3f6;
}

.batch-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.batch-item__name {
  font-weight: 600;
}

.batch-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.batch-item__actions {
  margin-top: 4px;
}

.log-timeline {
  max-height: 320px;
  overflow-y: auto;
  padding-left: 4px;
}

.log-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-item__label {
  font-weight: 600;
  font-size: 13px;
}

.log-item__version {
  font-size: 12px;
  color: #8c8479;
}

.log-item__detail {
  margin-top: 2px;
  font-size: 12px;
  color: #8c8479;
}
</style>
