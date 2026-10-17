/* 小账本 · 数据安全模块（v1.4）
 * 独立文件，只负责三件事：
 *   1) Markdown 全量导出（账单 + 投资 + 保险）
 *   2) 导出提醒（每周 / 每月，打开 App 时横幅提示）
 *   3) 危险操作第二道确认（清空 / 导入 / 从电脑恢复）
 *
 * 依赖 index.html 暴露的全局：data, save, renderAll, toast, download, today,
 * fmt, fmtNum, fmtSigned, cat, acc, accountBalance, investCost, investMarketValue,
 * investFloatPnl, investRealized, investTotalPnl, investRate, policyPaidTotal,
 * policyPayText, policyStatus, INVEST_TYPES, FLOW_TYPES, POLICY_TYPES。
 *
 * 本文件不修改收支 / 投资 / 保险的任何业务逻辑；以后新增模块也照这个方式：
 * 新建独立 js 文件 + 在 index.html 末尾加一行 script 引用。
 */
(function () {
  'use strict';

  const LAST_EXPORT_KEY = 'xiaozhangben.lastExportAt';
  const SNOOZE_KEY = 'xiaozhangben.exportSnoozeUntil';
  const DAY = 86400000;

  const pad2 = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function read(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function stats() {
    const tx = (data.transactions || []).length;
    const inv = (data.investments || []).length;
    const pol = (data.policies || []).length;
    return { tx: tx, inv: inv, pol: pol, total: tx + inv + pol };
  }

  function firstRecordDate() {
    const dates = [];
    (data.transactions || []).forEach(t => { if (t.date) dates.push(t.date); });
    (data.investments || []).forEach(it => { if (it.startDate) dates.push(it.startDate); else if (it.updated) dates.push(it.updated); });
    (data.policies || []).forEach(p => { if (p.startDate) dates.push(p.startDate); });
    if (!dates.length) return '';
    return dates.sort()[0];
  }

  function reminderMode() {
    return data.settings && data.settings.exportReminder || 'weekly';
  }
  function reminderDays() {
    return reminderMode() === 'monthly' ? 30 : 7;
  }

  /* ================= 导出提醒 ================= */
  function dueInfo() {
    if (reminderMode() === 'off') return null;
    const s = stats();
    if (!s.total) return null;
    if ((Number(read(SNOOZE_KEY)) || 0) > Date.now()) return null;

    const last = read(LAST_EXPORT_KEY);
    let ref = last ? new Date(last).getTime() : NaN;
    if (!isFinite(ref)) {
      const first = firstRecordDate();
      ref = first ? new Date(first + 'T00:00:00').getTime() : Date.now();
    }
    const days = Math.floor((Date.now() - ref) / DAY);
    if (days < reminderDays()) return null;
    return { days: days, last: last, count: s };
  }

  function hideBanner() {
    const b = document.getElementById('exportBanner');
    if (b) b.classList.add('hidden');
  }

  function checkReminder() {
    renderStatus();
    const b = document.getElementById('exportBanner');
    if (!b) return;
    const info = dueInfo();
    if (!info) { b.classList.add('hidden'); return; }

    b.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'grow';
    span.textContent = info.last
      ? `距上次导出已 ${info.days} 天。导出一份备份存到电脑，换手机 / 清缓存也不怕。`
      : `已有 ${info.count.total} 条记录，还没导出过备份。导出一份存到电脑吧。`;

    const yes = document.createElement('button');
    yes.textContent = '导出';
    yes.addEventListener('click', () => {
      exportJson();
      recordExport();
    });

    const later = document.createElement('button');
    later.className = 'ghost2';
    later.textContent = '明天再说';
    later.addEventListener('click', () => {
      write(SNOOZE_KEY, String(Date.now() + DAY));
      b.classList.add('hidden');
    });

    b.append(span, yes, later);
    b.classList.remove('hidden');
  }

  function agoText(iso) {
    if (!iso) return '还没有';
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return '还没有';
    const days = Math.floor((Date.now() - t) / DAY);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    return days + ' 天前';
  }

  function renderStatus() {
    const el = document.getElementById('exportStatus');
    if (el) {
      const label = { weekly: '每周提醒', monthly: '每月提醒', off: '提醒已关闭' }[reminderMode()] || '每周提醒';
      el.textContent = `上次导出：${agoText(read(LAST_EXPORT_KEY))} · ${label}`;
    }
    const seg = document.getElementById('exportReminderSeg');
    if (seg) {
      Array.from(seg.querySelectorAll('[data-reminder]')).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.reminder === reminderMode());
      });
    }
  }

  function recordExport() {
    write(LAST_EXPORT_KEY, new Date().toISOString());
    write(SNOOZE_KEY, '');
    renderStatus();
    hideBanner();
  }

  function setReminder(mode) {
    if (['weekly', 'monthly', 'off'].indexOf(mode) === -1) return;
    if (!data.settings) data.settings = {};
    data.settings.exportReminder = mode;
    save();
    renderStatus();
    checkReminder();
  }

  /* ================= Markdown 全量导出 ================= */
  const mdCell = v => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const mdRow = arr => '| ' + arr.map(mdCell).join(' | ') + ' |';
  const mdHead = arr => mdRow(arr) + '\n' + mdRow(arr.map(() => '---'));

  function txTypeText(t) {
    return t.type === 'expense' ? '支出' : t.type === 'income' ? '收入' : '转账';
  }

  function buildMarkdown() {
    const now = new Date();
    const tx = (data.transactions || []).slice().sort((a, b) =>
      (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const inv = data.investments || [];
    const pol = data.policies || [];
    const lines = [];

    lines.push(`# 小账本备份 ${dateStr(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
    lines.push('');
    lines.push('> 由小账本 v1.4 导出。数据只存本机，这份文件请自己保存到电脑。');
    lines.push('');
    lines.push(`- 收支账单：${tx.length} 笔`);
    lines.push(`- 投资项目：${inv.length} 个`);
    lines.push(`- 保险保单：${pol.length} 张`);
    lines.push('');

    /* ---- 收支 ---- */
    lines.push('## 一、收支账单');
    lines.push('');
    if (!tx.length) {
      lines.push('（暂无记录）');
    } else {
      lines.push(mdHead(['日期', '时间', '类型', '分类', '备注', '金额', '账户']));
      tx.forEach(t => {
        let name = txTypeText(t);
        let category = name;
        if (t.type !== 'transfer') {
          const c = cat(t.categoryId);
          category = c ? c.name : '未分类';
        }
        let account = '';
        const a = acc(t.accountId);
        if (a) account = a.name;
        if (t.type === 'transfer') {
          const to = acc(t.toAccountId);
          account += ' → ' + (to ? to.name : '');
        }
        lines.push(mdRow([t.date, t.time || '', name, category, t.note || '', '¥' + fmtNum(t.amount), account]));
      });
    }
    lines.push('');
    lines.push('### 账户余额');
    lines.push('');
    (data.accounts || []).forEach(a => {
      lines.push(`- ${a.name}：${fmt(accountBalance(a.id))}`);
    });
    lines.push('');

    /* ---- 投资 ---- */
    lines.push('## 二、投资台账');
    lines.push('');
    if (!inv.length) {
      lines.push('（暂无记录）');
      lines.push('');
    }
    inv.forEach(it => {
      const type = (INVEST_TYPES[it.type] || INVEST_TYPES.other);
      lines.push(`### ${it.name}（${type.label}${it.code ? ' · ' + it.code : ''}）`);
      lines.push('');
      lines.push(`- 本金 / 成本：${fmt(investCost(it))}`);
      lines.push(`- 当前市值：${fmt(investMarketValue(it))}`);
      lines.push(`- 浮动盈亏：${fmtSigned(investFloatPnl(it))}`);
      lines.push(`- 已实现收益：${fmtSigned(investRealized(it))}`);
      lines.push(`- 合计盈亏：${fmtSigned(investTotalPnl(it))}`);
      lines.push(`- 收益率：${investRate(it).toFixed(2)}%`);
      if (it.startDate) lines.push(`- 起始日期：${it.startDate}`);
      if (Number(it.stopProfit) > 0) lines.push(`- 止盈线：+${it.stopProfit}%`);
      if (Number(it.stopLoss) > 0) lines.push(`- 止损线：${it.stopLoss}%`);
      if (it.note) lines.push(`- 备注：${it.note}`);
      lines.push('');

      const flows = it.flows || [];
      if (flows.length) {
        lines.push('#### 资金流水');
        lines.push('');
        lines.push(mdHead(['日期', '类型', '金额', '份额', '价格', '备注']));
        flows.forEach(f => {
          const ft = FLOW_TYPES[f.kind] || { label: f.kind || '' };
          lines.push(mdRow([
            f.date || '', ft.label, f.amount == null ? '' : '¥' + fmtNum(f.amount),
            f.shares == null ? '' : f.shares,
            f.price == null ? '' : fmtNum(f.price), f.note || ''
          ]));
        });
        lines.push('');
      }

      const vals = it.valuations || [];
      if (vals.length) {
        lines.push('#### 估值记录');
        lines.push('');
        lines.push(mdHead(['日期', '价格', '市值', '备注']));
        vals.forEach(v => {
          lines.push(mdRow([
            v.date || '', v.price == null ? '' : fmtNum(v.price),
            v.value == null ? '' : '¥' + fmtNum(v.value), v.note || ''
          ]));
        });
        lines.push('');
      }
    });

    /* ---- 保险 ---- */
    lines.push('## 三、保险台账');
    lines.push('');
    if (!pol.length) {
      lines.push('（暂无记录）');
      lines.push('');
    }
    pol.forEach(p => {
      const type = (POLICY_TYPES[p.type] || POLICY_TYPES.other);
      const status = policyStatus(p);
      lines.push(`### ${p.name}（${type.label}）`);
      lines.push('');
      lines.push(`- 状态：${status.text}`);
      lines.push(`- 保险公司：${p.company || '—'}`);
      lines.push(`- 被保险人：${p.insured || '—'}`);
      lines.push(`- 投保人：${p.applicant || '—'}`);
      lines.push(`- 保单号：${p.policyNo || '—'}`);
      lines.push(`- 受益人：${p.beneficiary || '—'}`);
      lines.push(`- 总保额：${fmt(p.coverage)}`);
      lines.push(`- 每期保费：${policyPayText(p)}`);
      lines.push(`- 缴费年限：${p.payYears || '—'}`);
      lines.push(`- 保障期间：${p.startDate || '—'} → ${p.endDate || '终身 / 长期'}`);
      lines.push(`- 下次缴费：${p.nextPayDate || '—'}`);
      lines.push(`- 免赔额：${Number(p.deductible) > 0 ? fmt(p.deductible) : '—'}`);
      lines.push(`- 现金价值：${Number(p.cashValue) > 0 ? fmt(p.cashValue) : '—'}`);
      lines.push(`- 已缴保费合计：${fmt(policyPaidTotal(p))}`);
      if (p.exclusions) lines.push(`- 免责 / 特别约定：${p.exclusions}`);
      if (p.note) lines.push(`- 备注：${p.note}`);
      lines.push('');

      const items = p.coverageItems || [];
      if (items.length) {
        lines.push('#### 分项保额');
        lines.push('');
        lines.push(mdHead(['项目', '保额']));
        items.forEach(x => lines.push(mdRow([x.name || '', x.amount > 0 ? '¥' + fmtNum(x.amount) : '未填金额'])));
        lines.push('');
      }

      const pay = p.paymentHistory || [];
      if (pay.length) {
        lines.push('#### 缴费记录');
        lines.push('');
        lines.push(mdHead(['日期', '金额', '备注']));
        pay.forEach(h => lines.push(mdRow([h.date || '', '¥' + fmtNum(h.amount), h.note || ''])));
        lines.push('');
      }

      const claims = p.claims || [];
      if (claims.length) {
        lines.push('#### 理赔记录');
        lines.push('');
        lines.push(mdHead(['日期', '金额', '原因', '状态', '备注']));
        const claimStatus = { pending: '待申请', review: '审核中', paid: '已赔付', rejected: '拒赔' };
        claims.forEach(c => {
          lines.push(mdRow([
            c.date || '', c.amount == null ? '' : '¥' + fmtNum(c.amount),
            c.reason || '', claimStatus[c.status] || c.status || '', c.note || ''
          ]));
        });
        lines.push('');
      }
    });

    /* ---- 设置 ---- */
    lines.push('## 四、设置');
    lines.push('');
    const budget = Number((data.budgets || {})[dateStr(now).slice(0, 7)]) || 0;
    lines.push(`- 本月预算：${budget > 0 ? fmt(budget) : '未设置'}`);
    lines.push(`- 导出提醒：${{ weekly: '每周', monthly: '每月', off: '关闭' }[reminderMode()] || '每周'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('这份 Markdown 是给你自己看的备份；要完整恢复数据，请用「导出备份（JSON）」。');
    lines.push('');

    return lines.join('\n');
  }

  function exportMarkdown() {
    download(`小账本全量备份_${dateStr(new Date())}.md`, buildMarkdown(), 'text/markdown;charset=utf-8');
    recordExport();
    toast('已导出 Markdown');
  }

  /* ================= 危险操作第二道确认 ================= */
  function confirmClear() {
    const s = stats();
    if (!s.total) return true;
    const typed = prompt(
      `最后确认：请输入「清空」两个字。\n` +
      `将删除 ${s.tx} 笔账单、${s.inv} 个投资项目、${s.pol} 张保单，无法撤销。\n` +
      `建议先点「导出备份（JSON）」。`
    );
    if (typed == null) return false;
    if (typed.trim() !== '清空') { toast('输入不对，已取消'); return false; }
    return true;
  }

  function confirmImport() {
    const s = stats();
    if (!s.total) return true;
    return confirm(
      `第二道确认：当前有 ${s.tx} 笔账单、${s.inv} 个投资项目、${s.pol} 张保单。\n` +
      `导入会全部覆盖，且不能撤销。继续？`
    );
  }

  function confirmRestore() {
    const s = stats();
    if (!s.total) return true;
    return confirm(
      `第二道确认：从电脑备份恢复会覆盖当前 ${s.tx} 笔账单、${s.inv} 个项目、${s.pol} 张保单。\n` +
      `不能撤销。继续？`
    );
  }

  function confirmImportant(kind, name) {
    const label = name ? `「${name}」` : '';
    return confirm(`第二道确认：删除${kind}${label}后不能撤销，确定吗？`);
  }

  /* ================= 绑定 ================= */
  function bind() {
    const md = document.getElementById('exportMd');
    if (md) md.addEventListener('click', exportMarkdown);

    ['exportJson', 'exportCsv'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', recordExport);
    });

    const seg = document.getElementById('exportReminderSeg');
    if (seg) {
      seg.addEventListener('click', e => {
        const btn = e.target.closest('[data-reminder]');
        if (btn) setReminder(btn.dataset.reminder);
      });
    }

    renderStatus();
    checkReminder();

    /* App 开着时每小时检查一次；从后台切回来也检查 */
    setInterval(checkReminder, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkReminder();
    });
  }

  /* 供 index.html 调用 + 测试用 */
  window.XZBDataSafety = {
    confirmClear: confirmClear,
    confirmImport: confirmImport,
    confirmRestore: confirmRestore,
    confirmImportant: confirmImportant,
    checkReminder: checkReminder,
    renderStatus: renderStatus,
    buildMarkdown: buildMarkdown,
    exportMarkdown: exportMarkdown,
    recordExport: recordExport
  };

  bind();
})();
