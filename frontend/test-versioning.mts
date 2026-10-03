/**
 * 版本链冒烟测试（node + fake-indexeddb，不进入应用包）：
 * 读数唯一性 / 趋势重算与工单退回 / 跨窗口乐观锁冲突 / 倒罐容量排队、占住与释放。
 * 运行：npx esbuild test-versioning.mts --bundle --platform=node --format=esm --outfile=/tmp/tv.mjs && node /tmp/tv.mjs
 */
import 'fake-indexeddb/auto'
import { db, initDatabase, countAll } from './src/utils/db'
import {
  getBatchVersion,
  isVersionConflict,
  saveReadingVersioned,
  withdrawReadingVersioned,
  type VersionConflictError
} from './src/utils/versioning'
import {
  completeOperationVersioned,
  evaluateTransfer,
  requeueWaitingOps,
  reviewOperationVersioned,
  saveOperationVersioned,
  tankCapacityInfo
} from './src/utils/transfer'
import { shipBatch } from './src/utils/db'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

async function main(): Promise<void> {
  await initDatabase()

  console.log('A. 播种与初始版本')
  check('b-001 初始版本 v1', (await getBatchVersion('b-001')) === 1)
  check('op-004 种子为排队中', (await db.operations.get('op-004'))?.state === '排队中')

  console.log('B. 保存读数 → 重算并退回失效工单')
  const r1 = await saveReadingVersioned({
    batchId: 'b-001', date: '2024-09-20', gravity: 1.012, tempC: 26, brix: 3, baseVersion: 1
  })
  check('批次版本升到 v2', r1.version === 2)
  check('重算后可转罐（1.012 后发酵）', r1.recalc.transferable === true)
  check('op-004 被退回复核', r1.recalc.invalidated.some((op) => op.id === 'op-004'))
  const op004 = await db.operations.get('op-004')
  check('op-004 状态=待复核且有原因', op004?.state === '待复核' && !!op004.invalidReason)
  const invalidateLog = await db.changeLogs.where('entityId').equals('op-004').first()
  check('退回已写审计日志', invalidateLog?.action === 'invalidate')

  console.log('C. 读数唯一性：同批次同日覆盖')
  const r2 = await saveReadingVersioned({
    batchId: 'b-001', date: '2024-09-20', gravity: 1.011, tempC: 25.5, brix: 2.8, baseVersion: 2
  })
  check('同日合并为同一行', r2.id === r1.id)
  const sameDayCount = await db.readings.where('[batchId+date]').equals(['b-001', '2024-09-20']).count()
  check('同日仅一条读数', sameDayCount === 1)
  const row = await db.readings.get(r1.id)
  check('行数据版本递增且值已覆盖', row?.version === 2 && row.gravity === 1.011)

  console.log('D. 跨窗口乐观锁：旧版本保存被拒并列出冲突')
  let conflict: VersionConflictError['conflict'] | null = null
  try {
    // 模拟另一窗口仍停留在 v1（打开对话框时的快照），此时最新已是 v3
    await saveReadingVersioned({
      batchId: 'b-001', date: '2024-09-22', gravity: 1.005, tempC: 24, brix: 1, baseVersion: 1
    })
  } catch (error) {
    if (isVersionConflict(error)) conflict = error.conflict
    else throw error
  }
  check('捕获版本冲突', conflict !== null)
  check('冲突版本 v1 → v3', conflict?.baseVersion === 1 && conflict?.currentVersion === 3)
  check('冲突日期列出 2024-09-20', conflict?.readingDates.includes('2024-09-20') === true)
  check('冲突工单列出 op-004 退回', conflict?.operations.some((op) => op.id === 'op-004') === true)

  console.log('E. 复核：容量不足继续排队并给出短差')
  const reviewed = await reviewOperationVersioned('op-004', 3)
  check('复核后仍排队中', reviewed.state === '排队中')
  check('短差 1100 L（2600 - 1500）', reviewed.shortfallL === 1100)

  console.log('F. 倒罐容量评估与保存')
  const verdict = await evaluateTransfer('b-001', 'tk-003')
  check('评估短差 1100 L', verdict.shortfallL === 1100 && !verdict.capacityOk)
  const cleaning = await evaluateTransfer('b-001', 'tk-004')
  check('清洗中罐不可转入', !cleaning.capacityOk && cleaning.reasons.some((r) => r.includes('清洗中')))
  const sameTank = await evaluateTransfer('b-001', 'tk-001')
  check('目标罐不能同源罐', !sameTank.capacityOk && sameTank.reasons.some((r) => r.includes('相同')))
  const queued = await saveOperationVersioned({
    batchId: 'b-001', type: '倒罐', date: '2024-09-29', durationMin: 45, operator: '测试',
    targetTankId: 'tk-003', baseVersion: await getBatchVersion('b-001')
  })
  check('容量不足的安排排队中', queued.state === '排队中' && queued.shortfallL === 1100)

  console.log('G. 完成倒罐：批次改绑目标罐并占住容量')
  const now = Date.now()
  await db.tanks.put({
    id: 'tk-999', code: 'F-99', material: '不锈钢', capacityL: 4000,
    tempControl: '夹套', state: '空闲', revision: 2, createdAt: now, updatedAt: now
  })
  const fit = await saveOperationVersioned({
    batchId: 'b-002', type: '倒罐', date: '2024-09-28', durationMin: 50, operator: '周亦',
    targetTankId: 'tk-999', baseVersion: await getBatchVersion('b-002')
  })
  check('容量足够的安排进计划', fit.state === '计划')
  await completeOperationVersioned(fit.id, await getBatchVersion('b-002'))
  const b002 = await db.batches.get('b-002')
  check('批次已改绑目标罐', b002?.tankId === 'tk-999')
  const cap999 = await tankCapacityInfo('tk-999')
  check('完成倒罐占住容量（剩 2000）', cap999.usedL === 2000 && cap999.remainingL === 2000)
  const tk002 = await db.tanks.get('tk-002')
  check('源罐已释放为空闲', tk002?.state === '空闲')

  console.log('H. 排队等待 → 容量释放后自动恢复计划')
  const wait = await saveOperationVersioned({
    batchId: 'b-001', type: '倒罐', date: '2024-09-30', durationMin: 50, operator: '林沐',
    targetTankId: 'tk-999', baseVersion: await getBatchVersion('b-001')
  })
  check('b-001(2600) 对剩余 2000 排队', wait.state === '排队中' && wait.shortfallL === 600)
  await shipBatch('b-002')
  const promoted = await requeueWaitingOps()
  check('出罐释放容量后 1 条工单转正', promoted === 1)
  check('转正后为计划状态', (await db.operations.get(wait.id))?.state === '计划')

  console.log('I. 工单保存的跨窗口冲突')
  const base = await getBatchVersion('b-001')
  await saveOperationVersioned({
    batchId: 'b-001', type: '压帽', date: '2024-10-01', durationMin: 30, operator: '窗口A',
    targetTankId: '', baseVersion: base
  })
  let opConflict: VersionConflictError['conflict'] | null = null
  try {
    await saveOperationVersioned({
      batchId: 'b-001', type: '淋皮', date: '2024-10-02', durationMin: 20, operator: '窗口B',
      targetTankId: '', baseVersion: base
    })
  } catch (error) {
    if (isVersionConflict(error)) opConflict = error.conflict
    else throw error
  }
  check('窗口B基于旧版本保存被拒', opConflict !== null)
  check('冲突工单列出窗口A的压帽', opConflict?.operations.some((op) => op.label.includes('窗口A')) === true)

  console.log('J. 撤回读数 → 重算并使倒罐待办失效')
  const before = await getBatchVersion('b-001')
  const w = await withdrawReadingVersioned({ id: r1.id, batchId: 'b-001', baseVersion: before })
  check('撤回后不再可转罐（回到主发酵）', w.recalc.transferable === false)
  check('计划中的倒罐工单被退回', w.recalc.invalidated.some((op) => op.id === wait.id))
  const withdrawLogs = await db.changeLogs
    .where('entityId')
    .equals(r1.id)
    .filter((log) => log.action === 'withdraw')
    .count()
  check('撤回日志已记录', withdrawLogs >= 1)

  console.log('K. 统计与日志数量')
  const counts = await countAll()
  check('changeLogs 已入统计', (counts.changeLogs ?? 0) > 0)

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exit(1)
})
