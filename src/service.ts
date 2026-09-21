import type { DB } from './db';
import { splitParagraphs, buildFragments } from './diff';
import { migrateAnnotations, type MigrationResult } from './migrate';

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

/** 在差异片段上创建批注，锚点取片段当前（新）文本 */
export function addAnnotation(db: DB, fragmentId: number, author: string, content: string): number | null {
  const frag = db
    .prepare('SELECT id, comparison_id, old_text, new_text FROM fragments WHERE id = ?')
    .get(fragmentId) as
    | { id: number; comparison_id: number; old_text: string | null; new_text: string | null }
    | undefined;
  if (!frag) return null;
  const anchor = frag.new_text ?? frag.old_text ?? '';
  const info = db
    .prepare(
      `INSERT INTO annotations (comparison_id, fragment_id, author, content, status, anchor_text)
       VALUES (?, ?, ?, ?, 'open', ?)`
    )
    .run(frag.comparison_id, fragmentId, author, content, anchor);
  return Number(info.lastInsertRowid);
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
}

export interface ComparisonDetail {
  comparison: {
    id: number;
    project_id: number;
    project_name: string;
    old_label: string;
    new_label: string;
    created_at: string;
  };
  fragments: Array<FragmentRow & { annotations: AnnotationRow[] }>;
  /** 无法锚定到任何片段的批注（待复核） */
  unanchored: AnnotationRow[];
  stats: {
    added: number;
    removed: number;
    changed: number;
    annotations: { open: number; resolved: number; pending_review: number; total: number };
  };
}

export function getComparisonDetail(db: DB, comparisonId: number): ComparisonDetail | null {
  const comparison = db
    .prepare(
      `SELECT c.id, c.project_id, c.created_at,
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
    annotations: { open: 0, resolved: 0, pending_review: 0, total: annotations.length },
  };
  for (const f of fragments) stats[f.type]++;
  for (const a of annotations) stats.annotations[a.status]++;

  return {
    comparison,
    fragments: fragments.map((f) => ({ ...f, annotations: byFragment.get(f.id) ?? [] })),
    unanchored,
    stats,
  };
}
