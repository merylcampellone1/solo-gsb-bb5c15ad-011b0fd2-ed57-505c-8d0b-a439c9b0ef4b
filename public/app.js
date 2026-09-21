'use strict';

/* ================= 基础工具 ================= */

const STATUS_LABEL = { open: '待处理', resolved: '已解决', pending_review: '待复核' };
const TYPE_LABEL = { added: '新增', removed: '删除', changed: '修改' };
const DECISION_LABEL = { accepted: '接受变更', rejected: '拒绝变更', deferred: '暂缓' };

const app = document.getElementById('app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    let payload = null;
    try {
      const j = await res.json();
      payload = j;
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    const err = new Error(msg);
    err.payload = payload;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer = null;
function toast(msg, isErr = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isErr ? 'toast err show' : 'toast show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

const lastAuthor = {
  get: () => localStorage.getItem('review-author') || '',
  set: (v) => localStorage.setItem('review-author', v),
};

/* ================= 视图：项目列表 ================= */

async function renderProjects() {
  const { projects } = await api('GET', '/api/projects');
  app.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h2>审阅项目</h2>
        <button class="btn" data-action="load-demo">⚡ 载入示例数据</button>
      </div>
      <form id="create-project-form" class="inline-form">
        <input name="name" required maxlength="100" placeholder="新项目名称，如：《数据安全管理办法》">
        <button class="btn primary" type="submit">新建项目</button>
      </form>
      ${projects.length === 0
        ? '<p class="empty">还没有项目。新建一个项目，或点击「载入示例数据」快速体验完整流程。</p>'
        : `<div class="cards">${projects.map((p) => `
            <a class="card" href="#/projects/${p.id}">
              <div class="card-title">${esc(p.name)}</div>
              <div class="card-meta">${p.version_count} 个版本 · ${p.comparison_count} 轮比对</div>
              <div class="card-meta dim">创建于 ${esc(p.created_at)}</div>
            </a>`).join('')}</div>`}
    </section>`;
}

/* ================= 视图：项目详情 ================= */

async function renderProject(id) {
  const { project, versions, comparisons } = await api('GET', `/api/projects/${id}`);
  app.innerHTML = `
    <nav class="crumbs"><a href="#/">全部项目</a> / ${esc(project.name)}</nav>
    <section class="panel">
      <div class="panel-head">
        <h2>${esc(project.name)}</h2>
        <button class="btn danger" data-action="delete-project" data-id="${project.id}">删除项目</button>
      </div>

      <h3>导入新版本</h3>
      <form id="import-form" data-project="${project.id}" class="import-form">
        <input name="label" required maxlength="100" placeholder="版本标签，如：v2.0 送审稿">
        <textarea name="content" required rows="9"
          placeholder="粘贴规范全文。段落之间用空行分隔；若无空行，则每行视为一条。"></textarea>
        <button class="btn primary" type="submit">导入并与上一版本比对</button>
        <p class="hint">首个版本仅存档；从第二个版本起自动生成差异比对，并迁移上一轮未解决的批注。</p>
      </form>

      <h3>版本记录</h3>
      ${versions.length === 0 ? '<p class="empty">尚未导入任何版本。</p>' : `
        <ol class="version-list">
          ${versions.map((v) => `<li><span class="tag">v${v.seq}</span> ${esc(v.label)}
            <span class="dim">${esc(v.created_at)}</span></li>`).join('')}
        </ol>`}

      <h3>比对记录</h3>
      ${comparisons.length === 0 ? '<p class="empty">导入两个以上版本后，这里会列出差异比对。</p>' : `
        <div class="cards">${comparisons.map((c) => `
          <a class="card" href="#/comparisons/${c.id}">
            <div class="card-title">${esc(c.old_label)} → ${esc(c.new_label)}
              ${c.sealed
                ? '<span class="badge sealed">已封存</span>'
                : '<span class="badge draft">草稿</span>'}</div>
            <div class="card-meta">${c.fragment_count} 处差异 · ${c.annotation_count} 条批注
              ${c.open_count > 0 ? ` · <b class="warn">${c.open_count} 条待办</b>` : ''}</div>
            <div class="card-meta dim">${c.sealed
              ? `封存人 ${esc(c.sealed_by ?? '')} · ${esc(c.sealed_at ?? '')}`
              : esc(c.created_at)}</div>
          </a>`).join('')}</div>`}
    </section>`;
}

/* ================= 视图：比对详情 ================= */

const cmp = { id: null, data: null, status: 'all', author: 'all', onlyAnnotated: false, sealBlockers: null };

async function renderComparison(id) {
  const data = await api('GET', `/api/comparisons/${id}`);
  if (cmp.id !== id) {
    cmp.status = 'all';
    cmp.author = 'all';
    cmp.onlyAnnotated = false;
  }
  cmp.id = id;
  cmp.data = data;
  cmp.sealBlockers = null;
  drawComparison();
}

function allAnnotations() {
  const anns = [];
  for (const f of cmp.data.fragments) anns.push(...f.annotations);
  anns.push(...cmp.data.unanchored);
  return anns;
}

function visibleAnnotations(anns) {
  return anns.filter(
    (a) =>
      (cmp.status === 'all' || a.status === cmp.status) &&
      (cmp.author === 'all' || a.author === cmp.author)
  );
}

function annHtml(a, sealed) {
  const migrated = a.migrated_from != null
    ? `<span class="migrated" title="从上一轮比对自动迁移">⤳ 迁移${a.similarity != null ? ` · 相似度 ${(a.similarity * 100).toFixed(0)}%` : ''}</span>`
    : '';
  return `
    <div class="ann st-${a.status}">
      <div class="ann-head">
        <b>${esc(a.author)}</b>
        <span class="badge st-${a.status}">${STATUS_LABEL[a.status]}</span>
        ${migrated}
        <span class="dim">${esc(a.updated_at)}</span>
      </div>
      <div class="ann-body">${esc(a.content)}</div>
      ${sealed ? '' : `
      <div class="ann-actions">
        <select class="ann-status" data-id="${a.id}" title="更新状态">
          ${Object.entries(STATUS_LABEL).map(([v, l]) =>
            `<option value="${v}" ${v === a.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn small danger" data-action="delete-annotation" data-id="${a.id}">删除</button>
      </div>`}
    </div>`;
}

function decisionHtml(f, sealed) {
  if (sealed) {
    return `
      <div class="decision-view">
        结论：<span class="badge dc-${f.decision}">${DECISION_LABEL[f.decision]}</span>
        ${f.decision === 'deferred' ? `<span class="dim">暂缓理由：${esc(f.defer_reason ?? '')}</span>` : ''}
      </div>`;
  }
  const current = f.decision ? `（当前：${DECISION_LABEL[f.decision]}）` : '（未作结论）';
  return `
    <div class="decision-bar" data-fragment="${f.id}">
      <span class="decision-title">审阅结论${current}：</span>
      ${Object.entries(DECISION_LABEL).map(([v, l]) => `
        <label class="dc-opt">
          <input type="radio" name="dc-${f.id}" value="${v}" ${f.decision === v ? 'checked' : ''}> ${l}
        </label>`).join('')}
      <input type="text" class="defer-input" maxlength="500" placeholder="暂缓理由（选择暂缓时必填）"
        value="${esc(f.defer_reason ?? '')}" ${f.decision === 'deferred' ? '' : 'hidden'}>
      <button class="btn small primary" data-action="save-decision" data-id="${f.id}">保存结论</button>
    </div>`;
}

function fragHtml(f, sealed) {
  const anns = visibleAnnotations(f.annotations);
  const pos = [
    f.old_start != null ? `旧¶${f.old_start}` : null,
    f.new_start != null ? `新¶${f.new_start}` : null,
  ].filter(Boolean).join(' → ');
  return `
    <div class="fragment ft-${f.type}">
      <div class="frag-head">
        <span class="badge ft-${f.type}">${TYPE_LABEL[f.type]}</span>
        <span class="dim">片段 #${f.ord}${pos ? ` · ${pos}` : ''} · ${f.annotations.length} 条批注</span>
        ${f.decision ? `<span class="badge dc-${f.decision}">${DECISION_LABEL[f.decision]}</span>` : ''}
      </div>
      ${f.old_text != null ? `<pre class="frag-text old">${esc(f.old_text)}</pre>` : ''}
      ${f.new_text != null ? `<pre class="frag-text new">${esc(f.new_text)}</pre>` : ''}
      ${decisionHtml(f, sealed)}
      <div class="anns">${anns.map((a) => annHtml(a, sealed)).join('')}</div>
      ${sealed ? '' : `
      <form class="ann-form" data-fragment="${f.id}">
        <input name="author" required maxlength="50" placeholder="作者" value="${esc(lastAuthor.get())}">
        <input name="content" required maxlength="2000" placeholder="写下审阅意见…">
        <button class="btn small primary" type="submit">批注</button>
      </form>`}
    </div>`;
}

function sealSectionHtml(comparison, stats) {
  if (comparison.sealed) {
    return `
      <div class="seal-banner">
        🔒 本比对已封存 · 封存人：<b>${esc(comparison.sealed_by ?? '')}</b> · 封存时间：${esc(comparison.sealed_at ?? '')}
        <span class="dim">（片段结论与批注均已锁定，不可再修改）</span>
      </div>`;
  }
  const ready =
    stats.undecided === 0 &&
    stats.annotations.open === 0 &&
    stats.annotations.pending_review === 0;
  return `
    <div class="seal-panel">
      <div class="seal-status">
        ${ready ? '✅ 已满足封存条件' : '⏳ 尚不能封存'}：
        未作结论片段 <b>${stats.undecided}</b> ·
        未解决批注 <b>${stats.annotations.open}</b> ·
        待复核批注 <b>${stats.annotations.pending_review}</b>
      </div>
      ${cmp.sealBlockers ? `
        <div class="blocker-box">
          <b>⚠ 封存被服务端拒绝，阻塞项：</b>
          <ul>${cmp.sealBlockers.map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul>
        </div>` : ''}
      <div class="seal-form">
        <input id="seal-by" maxlength="50" placeholder="封存人姓名" value="${esc(lastAuthor.get())}">
        <button class="btn primary" data-action="seal-comparison">🔒 封存本轮比对</button>
      </div>
      <p class="hint">封存条件：全部片段已有结论（接受 / 拒绝 / 暂缓），且不存在未解决或待复核批注。封存后结论与批注均不可再修改。</p>
    </div>`;
}

function drawComparison() {
  const { comparison, fragments, unanchored, stats } = cmp.data;
  const sealed = !!comparison.sealed;
  const authors = [...new Set(allAnnotations().map((a) => a.author))].sort();
  const filtering = cmp.status !== 'all' || cmp.author !== 'all';

  const shownFragments = fragments.filter((f) => {
    if (filtering) return visibleAnnotations(f.annotations).length > 0;
    if (cmp.onlyAnnotated) return f.annotations.length > 0;
    return true;
  });
  const shownUnanchored = visibleAnnotations(unanchored);

  app.innerHTML = `
    <nav class="crumbs">
      <a href="#/">全部项目</a> / <a href="#/projects/${comparison.project_id}">${esc(comparison.project_name)}</a>
      / ${esc(comparison.old_label)} → ${esc(comparison.new_label)}
    </nav>
    <section class="panel">
      <div class="panel-head wrap">
        <h2>${esc(comparison.old_label)} → ${esc(comparison.new_label)}
          ${sealed ? '<span class="badge sealed">已封存</span>' : '<span class="badge draft">草稿</span>'}</h2>
        <div class="export-bar">
          导出：
          <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=json">JSON</a>
          <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=csv">CSV</a>
          <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=md">Markdown</a>
        </div>
      </div>

      <div class="stats">
        <span class="chip ft-added">新增 ${stats.added}</span>
        <span class="chip ft-removed">删除 ${stats.removed}</span>
        <span class="chip ft-changed">修改 ${stats.changed}</span>
        <span class="chip dc-undecided">未作结论 ${stats.undecided}</span>
        <span class="chip st-open">待处理 ${stats.annotations.open}</span>
        <span class="chip st-resolved">已解决 ${stats.annotations.resolved}</span>
        <span class="chip st-pending_review">待复核 ${stats.annotations.pending_review}</span>
      </div>

      ${sealSectionHtml(comparison, stats)}

      <div class="filter-bar">
        <label>状态
          <select id="filter-status">
            <option value="all">全部</option>
            ${Object.entries(STATUS_LABEL).map(([v, l]) =>
              `<option value="${v}" ${cmp.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>作者
          <select id="filter-author">
            <option value="all">全部</option>
            ${authors.map((a) =>
              `<option value="${esc(a)}" ${cmp.author === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" id="filter-annotated" ${cmp.onlyAnnotated ? 'checked' : ''}>
          只显示含批注的片段
        </label>
        <span class="dim">显示 ${shownFragments.length} / ${fragments.length} 个片段</span>
      </div>

      ${shownUnanchored.length > 0 ? `
        <div class="pending-box">
          <h3>⚠ 待复核：以下批注未能锚定到新片段（${shownUnanchored.length}）</h3>
          ${shownUnanchored.map((a) => `
            <div class="pending-item">
              <div class="anchor-text">锚点文本：${esc(a.anchor_text ?? '（空）')}</div>
              ${annHtml(a, sealed)}
            </div>`).join('')}
        </div>` : ''}

      ${shownFragments.length === 0
        ? '<p class="empty">没有符合筛选条件的差异片段。</p>'
        : shownFragments.map((f) => fragHtml(f, sealed)).join('')}
    </section>`;
}

/* ================= 事件处理 ================= */

document.addEventListener('submit', async (e) => {
  const form = e.target;
  try {
    if (form.id === 'create-project-form') {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const { id } = await api('POST', '/api/projects', { name });
      location.hash = `#/projects/${id}`;
    } else if (form.id === 'import-form') {
      e.preventDefault();
      const projectId = form.dataset.project;
      const label = form.elements.label.value.trim();
      const content = form.elements.content.value;
      const r = await api('POST', `/api/projects/${projectId}/versions`, { label, content });
      if (r.comparisonId) {
        const mig = r.migration;
        toast(
          `比对完成：${r.fragmentCount} 处差异` +
            (mig ? `；批注迁移 ${mig.migrated} 条、待复核 ${mig.pending} 条` : '')
        );
        location.hash = `#/comparisons/${r.comparisonId}`;
      } else {
        toast('首个版本已存档，再导入一个版本即可比对');
        await renderProject(projectId);
      }
    } else if (form.classList.contains('ann-form')) {
      e.preventDefault();
      const author = form.elements.author.value.trim();
      const content = form.elements.content.value.trim();
      lastAuthor.set(author);
      await api('POST', `/api/fragments/${form.dataset.fragment}/annotations`, { author, content });
      await renderComparison(cmp.id);
      toast('批注已添加');
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  try {
    if (action === 'load-demo') {
      btn.disabled = true;
      const r = await api('POST', '/api/demo');
      const mig = r.migration;
      toast(
        '示例数据已载入' +
          (mig ? `：批注迁移 ${mig.migrated} 条、待复核 ${mig.pending} 条` : '')
      );
      location.hash = `#/comparisons/${r.comparisons[r.comparisons.length - 1]}`;
    } else if (action === 'delete-project') {
      if (!confirm('确定删除该项目及其全部版本、比对与批注？')) return;
      await api('DELETE', `/api/projects/${btn.dataset.id}`);
      location.hash = '#/';
    } else if (action === 'delete-annotation') {
      if (!confirm('确定删除这条批注？')) return;
      await api('DELETE', `/api/annotations/${btn.dataset.id}`);
      await renderComparison(cmp.id);
      toast('批注已删除');
    } else if (action === 'save-decision') {
      const bar = btn.closest('.decision-bar');
      const checked = bar.querySelector('input[type="radio"]:checked');
      if (!checked) {
        toast('请先选择结论：接受变更 / 拒绝变更 / 暂缓', true);
        return;
      }
      const deferReason = bar.querySelector('.defer-input').value.trim();
      await api('PATCH', `/api/fragments/${btn.dataset.id}/decision`, {
        decision: checked.value,
        deferReason,
      });
      await renderComparison(cmp.id);
      toast('片段结论已保存');
    } else if (action === 'seal-comparison') {
      const sealedBy = document.getElementById('seal-by').value.trim();
      if (!sealedBy) {
        toast('请填写封存人姓名', true);
        return;
      }
      if (!confirm('封存后将禁止修改片段结论与批注，确定封存本轮比对？')) return;
      lastAuthor.set(sealedBy);
      try {
        await api('POST', `/api/comparisons/${cmp.id}/seal`, { sealedBy });
        await renderComparison(cmp.id);
        toast('本轮比对已封存');
      } catch (sealErr) {
        cmp.sealBlockers = sealErr.payload?.blockers ?? null;
        drawComparison();
        throw sealErr;
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.classList.contains('ann-status')) {
      await api('PATCH', `/api/annotations/${t.dataset.id}`, { status: t.value });
      await renderComparison(cmp.id);
      toast('状态已更新');
    } else if (t.matches('input[type="radio"][name^="dc-"]')) {
      // 选择「暂缓」时展开理由输入框，其余结论隐藏
      const bar = t.closest('.decision-bar');
      const input = bar.querySelector('.defer-input');
      input.hidden = t.value !== 'deferred';
      if (t.value === 'deferred') input.focus();
    } else if (t.id === 'filter-status') {
      cmp.status = t.value;
      drawComparison();
    } else if (t.id === 'filter-author') {
      cmp.author = t.value;
      drawComparison();
    } else if (t.id === 'filter-annotated') {
      cmp.onlyAnnotated = t.checked;
      drawComparison();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

/* ================= 路由 ================= */

async function route() {
  const hash = location.hash || '#/';
  const mProject = hash.match(/^#\/projects\/(\d+)$/);
  const mCompare = hash.match(/^#\/comparisons\/(\d+)$/);
  try {
    if (mCompare) await renderComparison(Number(mCompare[1]));
    else if (mProject) await renderProject(Number(mProject[1]));
    else await renderProjects();
  } catch (err) {
    app.innerHTML = `<section class="panel"><p class="error">${esc(err.message)}</p>
      <p><a href="#/">返回首页</a></p></section>`;
  }
}

window.addEventListener('hashchange', route);
route();
