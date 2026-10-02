/**
 * 乐观锁冲突弹窗：列出冲突日期与受影响倒罐工单。
 * 两个窗口同时保存时，被拒绝的一方调用本函数，提示用户刷新基线后再改。
 */
import { ElMessageBox } from 'element-plus'
import { VersionConflictError } from './conflict'
import type { ConflictDetail } from '@/types/versioning'

export interface ConflictLabels {
  /** 批次 id → 可读标签 */
  batchLabel: (batchId: string) => string
  /** 罐 id → 罐号 */
  tankCode: (tankId: string) => string
}

function readingConflictHtml(detail: Extract<ConflictDetail, { kind: 'reading' }>, labels: ConflictLabels): string {
  const dates = detail.changedDates.length > 0 ? detail.changedDates.join('、') : '（无具体日期记录）'
  const ops =
    detail.affectedOperations.length > 0
      ? detail.affectedOperations
          .map((op) => `<li>${op.date} 倒罐 → 罐 ${labels.tankCode(op.targetTankId)}</li>`)
          .join('')
      : '<li>暂无受影响的未完成倒罐工单</li>'
  return `
    <div class="conflict-box">
      <p>批次：${labels.batchLabel(detail.batchId)}</p>
      <p>你的窗口基于读数版本 <b>v${detail.expectedVersion}</b>，当前最新版本已为 <b>v${detail.currentVersion}</b>。</p>
      <p class="conflict-box__label">被另一窗口改动 / 撤回的冲突日期：</p>
      <p><b>${dates}</b></p>
      <p class="conflict-box__label">依据失效、已退回「待复核」的倒罐工单：</p>
      <ul>${ops}</ul>
      <p class="conflict-box__hint">本次保存未写入。请刷新读数趋势后，基于最新版本重新修改。</p>
    </div>
  `
}

function operationConflictHtml(detail: Extract<ConflictDetail, { kind: 'operation' }>, labels: ConflictLabels): string {
  return `
    <div class="conflict-box">
      <p>工单日期：<b>${detail.date}</b>，目标罐：${labels.tankCode(detail.targetTankId)}</p>
      <p>该工单已被另一窗口保存更新，你的窗口持有的是旧版本。</p>
      <p class="conflict-box__hint">本次保存未写入。请关闭工单、刷新列表后重新编辑。</p>
    </div>
  `
}

/** 弹出冲突详情；非冲突错误返回 false，由调用方按普通错误提示 */
export async function showConflictIfAny(err: unknown, labels: ConflictLabels): Promise<boolean> {
  if (!VersionConflictError.is(err)) return false
  const { detail } = err
  const html = detail.kind === 'reading' ? readingConflictHtml(detail, labels) : operationConflictHtml(detail, labels)
  await ElMessageBox.alert(html, '保存冲突：检测到更新的版本', {
    dangerouslyUseHTMLString: true,
    confirmButtonText: '我知道了，刷新后重做',
    type: 'warning',
    customClass: 'version-conflict-box'
  }).catch(() => undefined)
  return true
}
