/**
 * 端到端验证（Node + fake-indexeddb）：
 * 1. 读数按批次+日期唯一，改动产生新版本
 * 2. 撤回后从受影响日期重算停滞 / 超温 / 可转罐
 * 3. 旧窗口基于旧版本保存读数 → 冲突，列出冲突日期与工单
 * 4. 读数改动使已排倒罐工单失效 → 退回复核
 * 5. 倒罐容量校验：不足排队并显示差额，容量释放后自动放行
 * 6. 倒罐完成：批次转罐、容量保留、旧罐释放
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  db,
  initDatabase,
  saveReadingChange,
  withdrawReading,
  saveOperationChange,
  completeOperation,
  reviewOperation,
  listOperations,
  listAuditLogs,
  updateTank,
  updateBatch
} from '../src/utils/db'
import { VersionConflictError } from '../src/utils/conflict'
import { deriveTrend } from '../src/utils/trend'
import { computeTankCapacities } from '../src/utils/capacity'

let passed = 0
function ok(name: string): void {
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
}

async function main(): Promise<void> {
  /* ---------------- 纯函数：趋势与容量 ---------------- */
  {
    const trend = deriveTrend([
      { id: 'a', batchId: 'b', date: '2024-09-20', gravity: 1.09, tempC: 24, brix: 22, version: 1, status: '有效', withdrawReason: '' },
      { id: 'b', date: '2024-09-22', gravity: 1.089, tempC: 24, brix: 22, version: 1, status: '有效', withdrawReason: '' } as never,
      { id: 'c', date: '2024-09-24', gravity: 1.0885, tempC: 31, brix: 22, version: 1, status: '有效', withdrawReason: '' } as never
    ])
    assert.equal(trend.stuckDates.length, 2, '停滞窗口应有两日')
    assert.deepEqual(trend.overTempDates, ['2024-09-24'])
    assert.equal(trend.rackable, false)
    assert.ok(trend.rackableReasons.some((r) => r.includes('比重')))
    assert.ok(trend.rackableReasons.some((r) => r.includes('超温')))
    ok('趋势引擎：停滞 / 超温 / 不可转罐')

    const rackable = deriveTrend([
      { id: 'a', batchId: 'b', date: '2024-09-20', gravity: 1.04, tempC: 24, brix: 10, version: 1, status: '有效', withdrawReason: '' },
      { id: 'b', date: '2024-09-23', gravity: 1.001, tempC: 23, brix: 0, version: 1, status: '有效', withdrawReason: '' } as never
    ])
    assert.equal(rackable.rackable, true, '后发酵、无停滞无超温应可转罐')
    ok('趋势引擎：后段平稳读数满足可转罐')

    const caps = computeTankCapacities({
      tanks: [
        { id: 't1', code: 'T1', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '空闲' },
        { id: 't2', code: 'T2', material: '不锈钢', capacityL: 2500, tempControl: '夹套', state: '在用' }
      ],
      batches: [
        { id: 'b1', parcelId: 'p', tankId: 't2', harvestDate: '2024-09-01', volumeL: 2000, brix: 23, state: '酒精发酵', lastOperationAt: null, readingVersion: 0 }
      ],
      operations: [
        { id: 'o1', batchId: 'b1', type: '倒罐', date: '2024-09-10', seq: 1, state: '已完成', targetTankId: 't2', transferVolumeL: 2000 } as never
      ]
    })
    assert.equal(caps.get('t1')!.occupiedL, 0, '空罐无占用')
    assert.equal(caps.get('t2')!.occupiedL, 2000, '完成倒罐占住目标罐容量')
    assert.equal(caps.get('t2')!.freeL, 500, '目标罐剩余 500L')
    ok('容量引擎：完成倒罐保留目标罐容量')
  }

  /* ---------------- 初始化播种 ---------------- */
  await resetDb()
  await initDatabase()
  const b002 = await db.batches.get('b-002')
  assert.equal(b002.readingVersion, 4)
  const ops = await listOperations()
  const queued = ops.find((o) => o.id === 'op-009')
  assert.equal(queued?.state, '排队')
  assert.equal(queued?.shortfallL, 500, '种子排队单差额 500L')
  ok('播种：批次版本号与排队工单（差 500L）')

  /* ---------------- 读数唯一性 + 版本递增 ---------------- */
  await resetDb()
  await initDatabase()
  // b-002 在 2024-09-15 已有读数
  await assert.rejects(
    () =>
      saveReadingChange({
        batchId: 'b-002',
        date: '2024-09-15',
        gravity: 1.05,
        tempC: 24,
        brix: 12,
        expectedVersion: 4
      }),
    /已有读数/
  )
  ok('读数按批次+日期唯一：重复日期被拒')

  // 旧窗口版本落后 → 冲突
  let conflict: unknown = null
  try {
    await saveReadingChange({
      batchId: 'b-002',
      date: '2024-09-25',
      gravity: 1.004,
      tempC: 22,
      brix: 1,
      expectedVersion: 3
    })
  } catch (err) {
    conflict = err
  }
  assert.ok(conflict instanceof VersionConflictError, '旧版本保存应抛 VersionConflictError')
  const detail = (conflict as VersionConflictError).detail
  assert.equal(detail.kind, 'reading')
  if (detail.kind === 'reading') {
    assert.equal(detail.currentVersion, 4)
    assert.ok(Array.isArray(detail.changedDates), '冲突详情必须带冲突日期字段')
    assert.ok(detail.affectedOperations.length > 0, '应列出受影响倒罐工单')
  }
  ok('乐观锁：旧窗口保存被拒，返回冲突日期与工单')

  /* ---------------- 改动读数 → 版本+1 + 工单失效 + 重算 ---------------- */
  // 先排一张基于 v4 的倒罐计划单：b-002 → tk-003（1500L，空）→ 2000L 会排队
  let order = await saveOperationChange({
    batchId: 'b-002',
    type: '倒罐',
    date: '2024-10-01',
    durationMin: 50,
    operator: '测试员',
    targetTankId: 'tk-003',
    transferVolumeL: 2000,
    expectedReadingVersion: 4
  })
  assert.equal(order.state, '排队')
  assert.equal(order.shortfallL, 500)
  ok('容量不足：倒罐单排队，显示还差 500L')

  // 目标罐扩容（模拟有罐清空）→ 排队单自动放行
  await updateTank('tk-003', { capacityL: 2500 })
  // updateTank 不触发重排；用保存另一普通作业触发 reevaluateQueue
  await saveOperationChange({
    batchId: 'b-001',
    type: '压帽',
    date: '2024-10-01',
    durationMin: 20,
    operator: '触发重排',
    targetTankId: '',
    transferVolumeL: 0,
    expectedReadingVersion: 4
  })
  const afterRelease = (await listOperations()).find((o) => o.id === order.id)
  assert.equal(afterRelease?.state, '计划', '容量释放后排队单应自动放行')
  ok('排队放行：容量满足后排队单自动转计划')

  // 改动 9-19 读数（比重抬高到仍可转罐的 1.01，温度超温）→ v5，计划单依据过期 → 待复核
  await saveReadingChange({
    id: 'r-006',
    batchId: 'b-002',
    date: '2024-09-19',
    gravity: 1.01,
    tempC: 31.5,
    brix: 2.6,
    expectedVersion: 4
  })
  const batchAfter = await db.batches.get('b-002')
  assert.equal(batchAfter.readingVersion, 5)
  const invalidated = (await listOperations()).find((o) => o.id === order.id)
  assert.equal(invalidated?.state, '待复核')
  assert.ok(invalidated!.staleDates.includes('2024-09-19'))
  ok('读数改动：版本递增，受影响倒罐工单退回复核并记录冲突日期')

  // 待复核工单不能直接完成
  await assert.rejects(() => completeOperation(order.id), /先复核/)
  ok('待复核工单禁止直接完成')

  // 当前因超温不可转罐 → 复核应失败
  await assert.rejects(() => reviewOperation(order.id, '尝试复核'), /不可转罐/)
  ok('趋势不可转罐：复核被阻止并给出原因')

  // 撤回该超温读数 → 趋势恢复可转罐 → 复核通过
  await withdrawReading({ id: 'r-006', reason: '温度笔误', expectedVersion: 5 })
  const bAfterWithdraw = await db.batches.get('b-002')
  assert.equal(bAfterWithdraw.readingVersion, 6)
  const withdrawn = await db.readings.get('r-006')
  assert.equal(withdrawn.status, '已撤回')
  assert.equal(withdrawn.version, 3, '改动后再撤回，行版本继续 +1')
  const reviewed = await reviewOperation(order.id, '读数已撤回，恢复排单')
  assert.equal(reviewed.basisVersion, 6)
  assert.ok(reviewed.state === '计划' || reviewed.state === '排队')
  ok('读数撤回：软删除保留版本，复核后工单依据刷新到最新版本')

  /* ---------------- 同窗口并发：两个保存都声明 v4 ---------------- */
  await resetDb()
  await initDatabase()
  // 第一个窗口成功
  await saveReadingChange({
    batchId: 'b-002',
    date: '2024-09-25',
    gravity: 1.003,
    tempC: 22,
    brix: 0.8,
    expectedVersion: 4
  })
  // 第二个窗口仍持 v4，保存一张倒罐单 → 必须被拒
  await assert.rejects(
    () =>
      saveOperationChange({
        batchId: 'b-002',
        type: '倒罐',
        date: '2024-10-02',
        durationMin: 40,
        operator: '迟来窗口',
        targetTankId: 'tk-005',
        transferVolumeL: 2000,
        expectedReadingVersion: 4
      }),
    (err: unknown) => err instanceof VersionConflictError
  )
  ok('两窗口并发：后保存方基于旧版本被拒，不覆盖新读数')

  /* ---------------- 完成倒罐：转罐 + 保留 + 旧罐释放 + 审计 ---------------- */
  await resetDb()
  await initDatabase()
  // tk-005 容量 3000，b-002 2000L 可入
  const racking = (await listOperations()).find((o) => o.id === 'op-008')!
  assert.equal(racking.state, '计划')
  await completeOperation('op-008')
  const moved = await db.batches.get('b-002')
  assert.equal(moved.tankId, 'tk-005', '完成倒罐后批次转入目标罐')
  const source = await db.tanks.get('tk-002')
  assert.equal(source.state, '空闲', '旧罐释放为空闲')
  const caps2 = computeTankCapacities({
    tanks: await db.tanks.toArray(),
    batches: await db.batches.toArray(),
    operations: await db.operations.toArray()
  })
  assert.equal(caps2.get('tk-005')!.occupiedL, 2000, '目标罐保留 2000L')
  const logs = await listAuditLogs()
  assert.ok(logs.some((l) => l.action === '工单完成' && l.message.includes('F-05')))
  ok('倒罐完成：批次转罐、目标罐容量保留、旧罐释放、流水可追溯')

  /* ---------------- 审计流水完整性 ---------------- */
  const allLogs = await listAuditLogs()
  assert.ok(allLogs.length >= 3, '播种 + 操作后应有审计流水')
  for (const log of allLogs) {
    assert.ok(typeof log.beforeJson === 'string' && typeof log.afterJson === 'string')
  }
  ok('审计流水含前后快照，可追溯')

  console.log(`\n全部 ${passed} 项验证通过`)
  await updateBatch // 引用避免未使用告警
}

main()
  .then(() => db.close())
  .catch((err) => {
    console.error('验证失败：', err)
    process.exit(1)
  })
