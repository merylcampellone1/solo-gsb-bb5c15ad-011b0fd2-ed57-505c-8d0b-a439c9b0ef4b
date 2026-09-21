import express from 'express';
import path from 'node:path';
import { openDb } from './db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
} from './service';
import { toCsv, toMarkdown } from './exporter';
import { seedDemo } from './demo';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'review.db');

const db = openDb(DB_PATH);
const app = express();

app.use(express.json({ limit: '20mb' }));

const VALID_STATUS = new Set(['open', 'resolved', 'pending_review']);

function badRequest(res: express.Response, message: string) {
  return res.status(400).json({ error: message });
}

function notFound(res: express.Response, message = '资源不存在') {
  return res.status(404).json({ error: message });
}

// ---------- 健康检查 ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- 项目 ----------
app.get('/api/projects', (_req, res) => {
  const projects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id)    AS version_count,
              (SELECT COUNT(*) FROM comparisons c WHERE c.project_id = p.id) AS comparison_count
         FROM projects p
        ORDER BY p.id DESC`
    )
    .all();
  res.json({ projects });
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return badRequest(res, '项目名称必填');
  if (name.length > 100) return badRequest(res, '项目名称过长');
  const id = createProject(db, name);
  res.status(201).json({ id, name });
});

app.get('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return notFound(res, '项目不存在');

  const versions = db
    .prepare('SELECT id, label, seq, created_at FROM versions WHERE project_id = ? ORDER BY seq')
    .all(id);
  const comparisons = db
    .prepare(
      `SELECT c.id, c.created_at,
              ov.label AS old_label, nv.label AS new_label,
              (SELECT COUNT(*) FROM fragments f WHERE f.comparison_id = c.id)  AS fragment_count,
              (SELECT COUNT(*) FROM annotations a WHERE a.comparison_id = c.id) AS annotation_count,
              (SELECT COUNT(*) FROM annotations a WHERE a.comparison_id = c.id AND a.status <> 'resolved') AS open_count
         FROM comparisons c
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.project_id = ?
        ORDER BY c.id`
    )
    .all(id);
  res.json({ project, versions, comparisons });
});

app.delete('/api/projects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return notFound(res, '项目不存在');
  res.status(204).end();
});

// ---------- 版本导入（自动比对 + 批注迁移） ----------
app.post('/api/projects/:id/versions', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return notFound(res, '项目不存在');

  const label = String(req.body?.label ?? '').trim();
  const content = String(req.body?.content ?? '');
  if (!label) return badRequest(res, '版本标签必填');
  if (!content.trim()) return badRequest(res, '版本内容必填');

  const result = importVersion(db, projectId, label, content);
  res.status(201).json(result);
});

// ---------- 比对结果 ----------
app.get('/api/comparisons/:id', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');
  res.json(detail);
});

/** 批注筛选：?status=open|resolved|pending_review & author=xxx */
app.get('/api/comparisons/:id/annotations', (req, res) => {
  const comparisonId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM comparisons WHERE id = ?').get(comparisonId);
  if (!exists) return notFound(res, '比对不存在');

  const conds = ['a.comparison_id = ?'];
  const params: unknown[] = [comparisonId];
  const { status, author } = req.query;
  if (typeof status === 'string' && status) {
    if (!VALID_STATUS.has(status)) return badRequest(res, '非法的批注状态');
    conds.push('a.status = ?');
    params.push(status);
  }
  if (typeof author === 'string' && author) {
    conds.push('a.author = ?');
    params.push(author);
  }
  const annotations = db
    .prepare(
      `SELECT a.*, f.ord AS fragment_ord, f.type AS fragment_type
         FROM annotations a
         LEFT JOIN fragments f ON f.id = a.fragment_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.id`
    )
    .all(...params);
  res.json({ annotations });
});

// ---------- 批注 ----------
app.post('/api/fragments/:id/annotations', (req, res) => {
  const author = String(req.body?.author ?? '').trim();
  const content = String(req.body?.content ?? '').trim();
  if (!author) return badRequest(res, '作者必填');
  if (!content) return badRequest(res, '批注内容必填');
  const id = addAnnotation(db, Number(req.params.id), author, content);
  if (id == null) return notFound(res, '片段不存在');
  const annotation = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id);
  res.status(201).json({ annotation });
});

app.patch('/api/annotations/:id', (req, res) => {
  const id = Number(req.params.id);
  const ann = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
    | { id: number; status: string; content: string }
    | undefined;
  if (!ann) return notFound(res, '批注不存在');

  const { status, content } = req.body ?? {};
  if (status === undefined && content === undefined) {
    return badRequest(res, '至少提供 status 或 content 之一');
  }
  if (status !== undefined && !VALID_STATUS.has(status)) {
    return badRequest(res, '非法的批注状态（open / resolved / pending_review）');
  }
  if (content !== undefined && !String(content).trim()) {
    return badRequest(res, '批注内容不能为空');
  }
  db.prepare(
    `UPDATE annotations
        SET status = ?, content = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?`
  ).run(
    status ?? ann.status,
    content !== undefined ? String(content).trim() : ann.content,
    id
  );
  res.json({ annotation: db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) });
});

app.delete('/api/annotations/:id', (req, res) => {
  const info = db.prepare('DELETE FROM annotations WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return notFound(res, '批注不存在');
  res.status(204).end();
});

// ---------- 导出 ----------
app.get('/api/comparisons/:id/export', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');

  const format = String(req.query.format ?? 'json').toLowerCase();
  const { comparison } = detail;
  const filename = `审阅报告-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
  const disposition = (ext: string) =>
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.${ext}`;

  if (format === 'json') {
    res.setHeader('Content-Disposition', disposition('json'));
    return res.json(detail);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('csv'));
    return res.send(toCsv(detail));
  }
  if (format === 'md' || format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('md'));
    return res.send(toMarkdown(detail));
  }
  return badRequest(res, 'format 需为 json / csv / md');
});

// ---------- 示例数据 ----------
app.post('/api/demo', (_req, res) => {
  const result = seedDemo(db);
  res.status(201).json(result);
});

// ---------- 前端静态资源 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// API 404 与统一错误处理
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  }
);

app.listen(PORT, () => {
  console.log(`条文变更审阅台已启动：http://localhost:${PORT}`);
  console.log(`数据库文件：${DB_PATH}`);
});
