import type { DB } from './db';
import { splitParagraphs, buildFragments } from './diff';
import { migrateAnnotations, type MigrationResult } from './migrate';

/** 业务错误：携带 HTTP 状态码与附加信息（如封存阻塞项），由路由层统一转换 */
export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function createProject(db: DB, name: string): number {
  const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

export interface ImportResult {
  versionId: number;
  seq: number;
  comparisonId: number | null;
  fragmentCount: number;
  migration: MigrationResult | null;
}

/**
 * 导入一个版本：若已存在上一版本，则自动生成比对（差异片段），
 * 并把上一轮比对中未解决的批注迁移到本次比对。
 */
export function importVersion(db: DB, projectId: number, label: string, content: string): ImportResult {
  const tx = db.transaction((): ImportResult => {
    const prev = db
      .prepare('SELECT id, seq, content FROM versions WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
      .get(projectId) as { id: number; seq: number; content: string } | undefined;

    const seq = prev ? prev.seq + 1 : 1;
    const versionId = Number(
      db
        .prepare('INSERT INTO versions (project_id, label, content, seq) VALUES (?, ?, ?, ?)')
        .run(projectId, label, content, seq).lastInsertRowid
    );

    if (!prev) {
      return { versionId, seq, comparisonId: null, fragmentCount: 0, migration: null };
    }

    const prevComparison = db
      .prepare('SELECT id FROM comparisons WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId) as { id: number } | undefined;

    const comparisonId = Number(
      db
        .prepare('INSERT INTO comparisons (project_id, old_version_id, new_version_id) VALUES (?, ?, ?)')
        .run(projectId, prev.id, versionId).lastInsertRowid
    );

    const fragments = buildFragments(splitParagraphs(prev.content), splitParagraphs(content));
    const insertFragment = db.prepare(
      `INSERT INTO fragments (comparison_id, ord, type, old_text, new_text, old_start, new_start, anchor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of fragments) {
      insertFragment.run(
        comparisonId,
        f.ord,
        f.type,
        f.oldText,
        f.newText,
        f.oldStart,
        f.newStart,
        f.newText ?? f.oldText ?? ''
      );
    }

    const migration = prevComparison ? migrateAnnotations(db, prevComparison.id, comparisonId) : null;
    return { versionId, seq, comparisonId, fragmentCount: fragments.length, migration };
  });
  return tx();
}

/** 在差异片段上创建批注，锚点取片段当前（新）文本；已封存的比对禁止新增 */
export function addAnnotation(db: DB, fragmentId: number, author: string, content: string): number | null {
  const frag = db
    .prepare(
      `SELECT f.id, f.comparison_id, f.old_text, f.new_text, c.sealed
         FROM fragments f
         JOIN comparisons c ON c.id = f.comparison_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as
    | { id: number; comparison_id: number; old_text: string | null; new_text: string | null; sealed: number }
    | undefined;
  if (!frag) return null;
  if (frag.sealed) throw new ServiceError(409, '比对已封存，禁止新增批注');
  const anchor = frag.new_text ?? frag.old_text ?? '';
  const info = db
    .prepare(
      `INSERT INTO annotations (comparison_id, fragment_id, author, content, status, anchor_text)
       VALUES (?, ?, ?, ?, 'open', ?)`
    )
    .run(frag.comparison_id, fragmentId, author, content, anchor);
  return Number(info.lastInsertRowid);
}

/** 比对已封存时抛出 409，用于所有批注 / 结论写操作的前置校验 */
export function assertComparisonEditable(db: DB, comparisonId: number): void {
  const row = db.prepare('SELECT sealed FROM comparisons WHERE id = ?').get(comparisonId) as
    | { sealed: number }
    | undefined;
  if (row?.sealed) throw new ServiceError(409, '比对已封存，禁止修改');
}

/** 更新批注状态 / 内容；已封存的比对禁止修改 */
export function updateAnnotation(
  db: DB,
  id: number,
  patch: { status?: string; content?: string }
): AnnotationRow {
  const ann = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
    | AnnotationRow
    | undefined;
  if (!ann) throw new ServiceError(404, '批注不存在');
  assertComparisonEditable(db, ann.comparison_id);
  db.prepare(
    `UPDATE annotations
        SET status = ?, content = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?`
  ).run(patch.status ?? ann.status, patch.content ?? ann.content, id);
  return db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow;
}

/** 删除批注；已封存的比对禁止删除 */
export function deleteAnnotation(db: DB, id: number): void {
  const ann = db.prepare('SELECT comparison_id FROM annotations WHERE id = ?').get(id) as
    | { comparison_id: number }
    | undefined;
  if (!ann) throw new ServiceError(404, '批注不存在');
  assertComparisonEditable(db, ann.comparison_id);
  db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
}

export interface AnnotationRow {
  id: number;
  comparison_id: number;
  fragment_id: number | null;
  author: string;
  content: string;
  status: 'open' | 'resolved' | 'pending_review';
  anchor_text: string | null;
  similarity: number | null;
  migrated_from: number | null;
  created_at: string;
  updated_at: string;
}

export type FragmentDecision = 'accepted' | 'rejected' | 'deferred';

export const VALID_DECISIONS = new Set<FragmentDecision>(['accepted', 'rejected', 'deferred']);

export interface FragmentRow {
  id: number;
  comparison_id: number;
  ord: number;
  type: 'added' | 'removed' | 'changed';
  old_text: string | null;
  new_text: string | null;
  old_start: number | null;
  new_start: number | null;
  anchor: string | null;
  decision: FragmentDecision | null;
  defer_reason: string | null;
}

export interface ComparisonDetail {
  comparison: {
    id: number;
    project_id: number;
    project_name: string;
    old_label: string;
    new_label: string;
    sealed: number;
    sealed_by: string | null;
    sealed_at: string | null;
    created_at: string;
  };
  fragments: Array<FragmentRow & { annotations: AnnotationRow[] }>;
  /** 无法锚定到任何片段的批注（待复核） */
  unanchored: AnnotationRow[];
  stats: {
    added: number;
    removed: number;
    changed: number;
    /** 尚未作出结论（接受 / 拒绝 / 暂缓）的片段数 */
    undecided: number;
    annotations: { open: number; resolved: number; pending_review: number; total: number };
  };
}

export function getComparisonDetail(db: DB, comparisonId: number): ComparisonDetail | null {
  const comparison = db
    .prepare(
      `SELECT c.id, c.project_id, c.created_at, c.sealed, c.sealed_by, c.sealed_at,
              p.name AS project_name,
              ov.label AS old_label,
              nv.label AS new_label
         FROM comparisons c
         JOIN projects p ON p.id = c.project_id
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.id = ?`
    )
    .get(comparisonId) as ComparisonDetail['comparison'] | undefined;
  if (!comparison) return null;

  const fragments = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as FragmentRow[];
  const annotations = db
    .prepare('SELECT * FROM annotations WHERE comparison_id = ? ORDER BY id')
    .all(comparisonId) as AnnotationRow[];

  const byFragment = new Map<number, AnnotationRow[]>();
  const unanchored: AnnotationRow[] = [];
  for (const a of annotations) {
    if (a.fragment_id == null) {
      unanchored.push(a);
    } else {
      const list = byFragment.get(a.fragment_id) ?? [];
      list.push(a);
      byFragment.set(a.fragment_id, list);
    }
  }

  const stats: ComparisonDetail['stats'] = {
    added: 0,
    removed: 0,
    changed: 0,
    undecided: 0,
    annotations: { open: 0, resolved: 0, pending_review: 0, total: annotations.length },
  };
  for (const f of fragments) {
    stats[f.type]++;
    if (f.decision == null) stats.undecided++;
  }
  for (const a of annotations) stats.annotations[a.status]++;

  return {
    comparison,
    fragments: fragments.map((f) => ({ ...f, annotations: byFragment.get(f.id) ?? [] })),
    unanchored,
    stats,
  };
}

// ---------- 片段结论与审阅封存 ----------

/**
 * 设置差异片段的审阅结论（接受变更 / 拒绝变更 / 暂缓）。
 * 选择「暂缓」时必须填写理由；其余结论会清空已填的暂缓理由。
 * 已封存的比对禁止修改结论。
 */
export function setFragmentDecision(
  db: DB,
  fragmentId: number,
  decision: string,
  deferReason?: string
): FragmentRow {
  const frag = db
    .prepare(
      `SELECT f.id, f.comparison_id, c.sealed
         FROM fragments f
         JOIN comparisons c ON c.id = f.comparison_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as { id: number; comparison_id: number; sealed: number } | undefined;
  if (!frag) throw new ServiceError(404, '片段不存在');
  if (frag.sealed) throw new ServiceError(409, '比对已封存，片段结论不可修改');
  if (!VALID_DECISIONS.has(decision as FragmentDecision)) {
    throw new ServiceError(400, '非法的片段结论（accepted / rejected / deferred）');
  }
  const reason = String(deferReason ?? '').trim();
  if (decision === 'deferred' && !reason) {
    throw new ServiceError(400, '选择「暂缓」时必须填写理由');
  }
  db.prepare('UPDATE fragments SET decision = ?, defer_reason = ? WHERE id = ?').run(
    decision,
    decision === 'deferred' ? reason : null,
    fragmentId
  );
  return db.prepare('SELECT * FROM fragments WHERE id = ?').get(fragmentId) as FragmentRow;
}

export interface SealBlocker {
  type: 'undecided_fragments' | 'open_annotations' | 'pending_review_annotations';
  count: number;
  message: string;
  /** 未作结论的片段序号（type = undecided_fragments 时提供） */
  fragment_ords?: number[];
  /** 阻塞的批注明细（批注类阻塞时提供） */
  annotations?: Array<{ id: number; author: string; status: string }>;
}

/** 汇总封存的阻塞项：未作结论的片段、未解决（待处理）与待复核的批注 */
export function collectSealBlockers(db: DB, comparisonId: number): SealBlocker[] {
  const undecided = db
    .prepare('SELECT ord FROM fragments WHERE comparison_id = ? AND decision IS NULL ORDER BY ord')
    .all(comparisonId) as Array<{ ord: number }>;
  const blocking = db
    .prepare(
      `SELECT id, author, status FROM annotations
        WHERE comparison_id = ? AND status IN ('open', 'pending_review')
        ORDER BY id`
    )
    .all(comparisonId) as Array<{ id: number; author: string; status: string }>;

  const blockers: SealBlocker[] = [];
  if (undecided.length > 0) {
    const ords = undecided.map((f) => f.ord);
    blockers.push({
      type: 'undecided_fragments',
      count: ords.length,
      fragment_ords: ords,
      message: `${ords.length} 个差异片段尚未作出结论（片段 ${ords.map((o) => `#${o}`).join('、')}）`,
    });
  }
  const open = blocking.filter((a) => a.status === 'open');
  if (open.length > 0) {
    blockers.push({
      type: 'open_annotations',
      count: open.length,
      annotations: open,
      message: `${open.length} 条批注仍未解决（待处理）`,
    });
  }
  const pending = blocking.filter((a) => a.status === 'pending_review');
  if (pending.length > 0) {
    blockers.push({
      type: 'pending_review_annotations',
      count: pending.length,
      annotations: pending,
      message: `${pending.length} 条批注待复核`,
    });
  }
  return blockers;
}

/**
 * 封存比对：在事务内再次校验「全部片段已有结论且无未解决 / 待复核批注」，
 * 不满足时抛出 409 并携带具体阻塞项；满足时记录封存人与封存时间。
 */
export function sealComparison(
  db: DB,
  comparisonId: number,
  sealedBy: string
): { id: number; sealed_by: string; sealed_at: string } {
  const tx = db.transaction(() => {
    const cmp = db.prepare('SELECT id, sealed FROM comparisons WHERE id = ?').get(comparisonId) as
      | { id: number; sealed: number }
      | undefined;
    if (!cmp) throw new ServiceError(404, '比对不存在');
    if (cmp.sealed) throw new ServiceError(409, '该比对已封存，不能重复封存');

    const blockers = collectSealBlockers(db, comparisonId);
    if (blockers.length > 0) {
      throw new ServiceError(409, '存在阻塞项，无法封存', { blockers });
    }
    db.prepare(
      `UPDATE comparisons
          SET sealed = 1, sealed_by = ?, sealed_at = datetime('now', 'localtime')
        WHERE id = ?`
    ).run(sealedBy, comparisonId);
  });
  tx();
  return db
    .prepare('SELECT id, sealed_by, sealed_at FROM comparisons WHERE id = ?')
    .get(comparisonId) as { id: number; sealed_by: string; sealed_at: string };
}
