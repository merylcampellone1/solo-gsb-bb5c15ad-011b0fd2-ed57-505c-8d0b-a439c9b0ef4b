import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import {
  createProject,
  importVersion,
  addAnnotation,
  updateAnnotation,
  deleteAnnotation,
  getComparisonDetail,
  setFragmentDecision,
  sealComparison,
  collectSealBlockers,
  ServiceError,
  type FragmentRow,
} from '../service';
import { toCsv, toMarkdown } from '../exporter';

const V1 = '第一条 总则。\n\n第二条 应当在四十八小时内报告。';
const V2 = '第一条 总则。\n\n第二条 应当在二十四小时内报告。';

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '封存测试');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  return { db, pid, cid: r2.comparisonId! };
}

function fragments(db: ReturnType<typeof openDb>, cid: number): FragmentRow[] {
  return db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(cid) as FragmentRow[];
}

function expectServiceError(fn: () => unknown, status: number): ServiceError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, `应抛出 ServiceError，实际：${err}`);
    assert.equal(err.status, status);
    return err;
  }
  assert.fail(`应抛出 ServiceError(${status})，但未抛出任何异常`);
}

test('片段结论：接受 / 拒绝可保存，暂缓必须填写理由，非法结论被拒绝', () => {
  const { db, cid } = setup();
  const [frag] = fragments(db, cid);

  const accepted = setFragmentDecision(db, frag.id, 'accepted');
  assert.equal(accepted.decision, 'accepted');
  assert.equal(accepted.defer_reason, null);

  expectServiceError(() => setFragmentDecision(db, frag.id, 'deferred'), 400);
  expectServiceError(() => setFragmentDecision(db, frag.id, 'deferred', '   '), 400);
  expectServiceError(() => setFragmentDecision(db, frag.id, 'maybe'), 400);

  const deferred = setFragmentDecision(db, frag.id, 'deferred', '需等待上位法修订后再定');
  assert.equal(deferred.decision, 'deferred');
  assert.equal(deferred.defer_reason, '需等待上位法修订后再定');

  // 从暂缓改为接受后，暂缓理由应被清空
  const backToAccepted = setFragmentDecision(db, frag.id, 'accepted');
  assert.equal(backToAccepted.defer_reason, null);

  expectServiceError(() => setFragmentDecision(db, 99999, 'accepted'), 404);
});

test('未作结论的片段与未解决 / 待复核批注都会阻塞封存，并返回具体阻塞项', () => {
  const { db, cid } = setup();
  const [frag] = fragments(db, cid);
  const annId = addAnnotation(db, frag.id, '王法务', '时限压缩需确认')!;

  // 片段未作结论 + 存在待处理批注 → 两类阻塞项
  let err = expectServiceError(() => sealComparison(db, cid, '赵审定'), 409);
  let blockers = err.extra!.blockers as ReturnType<typeof collectSealBlockers>;
  assert.deepEqual(
    blockers.map((b) => b.type).sort(),
    ['open_annotations', 'undecided_fragments']
  );
  const undecided = blockers.find((b) => b.type === 'undecided_fragments')!;
  assert.deepEqual(undecided.fragment_ords, [frag.ord ?? 1].map(Number));
  assert.ok(undecided.message.includes(`#${frag.ord}`));

  // 片段给出结论后，仍被待处理批注阻塞
  setFragmentDecision(db, frag.id, 'accepted');
  err = expectServiceError(() => sealComparison(db, cid, '赵审定'), 409);
  blockers = err.extra!.blockers as ReturnType<typeof collectSealBlockers>;
  assert.deepEqual(blockers.map((b) => b.type), ['open_annotations']);
  assert.equal(blockers[0].annotations![0].id, annId);

  // 批注改为待复核 → 仍阻塞，类型变为 pending_review_annotations
  updateAnnotation(db, annId, { status: 'pending_review' });
  err = expectServiceError(() => sealComparison(db, cid, '赵审定'), 409);
  blockers = err.extra!.blockers as ReturnType<typeof collectSealBlockers>;
  assert.deepEqual(blockers.map((b) => b.type), ['pending_review_annotations']);

  // 解决批注后封存成功
  updateAnnotation(db, annId, { status: 'resolved' });
  const sealed = sealComparison(db, cid, '赵审定');
  assert.equal(sealed.sealed_by, '赵审定');
  assert.ok(sealed.sealed_at);

  const detail = getComparisonDetail(db, cid)!;
  assert.equal(detail.comparison.sealed, 1);
  assert.equal(detail.comparison.sealed_by, '赵审定');
  assert.equal(detail.stats.undecided, 0);

  // 重复封存被拒绝
  expectServiceError(() => sealComparison(db, cid, '赵审定'), 409);
});

test('封存后禁止修改片段结论，也禁止新增、编辑、删除批注', () => {
  const { db, cid } = setup();
  const [frag] = fragments(db, cid);
  const annId = addAnnotation(db, frag.id, '王法务', '待确认')!;
  setFragmentDecision(db, frag.id, 'deferred', '暂缓观察');
  updateAnnotation(db, annId, { status: 'resolved' });
  sealComparison(db, cid, '赵审定');

  expectServiceError(() => setFragmentDecision(db, frag.id, 'accepted'), 409);
  expectServiceError(() => addAnnotation(db, frag.id, '李合规', '新批注'), 409);
  expectServiceError(() => updateAnnotation(db, annId, { status: 'open' }), 409);
  expectServiceError(() => updateAnnotation(db, annId, { content: '改写' }), 409);
  expectServiceError(() => deleteAnnotation(db, annId), 409);

  // 数据保持封存时状态
  const detail = getComparisonDetail(db, cid)!;
  assert.equal(detail.fragments[0].decision, 'deferred');
  assert.equal(detail.fragments[0].defer_reason, '暂缓观察');
  assert.equal(detail.stats.annotations.total, 1);
  assert.equal(detail.stats.annotations.resolved, 1);
});

test('导出包含片段结论、暂缓理由、封存人与封存时间', () => {
  const { db, cid } = setup();
  const [frag] = fragments(db, cid);
  setFragmentDecision(db, frag.id, 'deferred', '需法务出具意见');
  sealComparison(db, cid, '赵审定');

  const detail = getComparisonDetail(db, cid)!;
  const md = toMarkdown(detail);
  assert.ok(md.includes('封存人：赵审定'));
  assert.ok(md.includes('**结论**：暂缓——理由：需法务出具意见'));

  const csv = toCsv(detail);
  assert.ok(csv.includes('暂缓'));
  assert.ok(csv.includes('需法务出具意见'));
  assert.ok(csv.includes('赵审定'));
  assert.ok(csv.includes('封存人'));

  // JSON 导出直接复用 detail 结构
  assert.equal(detail.fragments[0].decision, 'deferred');
  assert.equal(detail.comparison.sealed_by, '赵审定');
});
