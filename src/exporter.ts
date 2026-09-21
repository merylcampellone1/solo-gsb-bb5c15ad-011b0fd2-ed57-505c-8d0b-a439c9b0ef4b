import type { ComparisonDetail } from './service';

const TYPE_LABEL: Record<string, string> = { added: '新增', removed: '删除', changed: '修改' };
const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  resolved: '已解决',
  pending_review: '待复核',
};

export function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** 导出 CSV（带 BOM，方便 Excel 直接打开中文） */
export function toCsv(detail: ComparisonDetail): string {
  const header = [
    '片段序号',
    '片段类型',
    '旧文本',
    '新文本',
    '批注作者',
    '批注内容',
    '批注状态',
    '迁移相似度',
    '批注更新时间',
  ];
  const rows: string[] = [header.map(csvCell).join(',')];

  const pushRow = (
    ord: number | string,
    type: string,
    oldText: string | null,
    newText: string | null,
    a?: { author: string; content: string; status: string; similarity: number | null; updated_at: string }
  ) => {
    rows.push(
      [
        ord,
        type,
        oldText ?? '',
        newText ?? '',
        a?.author ?? '',
        a?.content ?? '',
        a ? statusLabel(a.status) : '',
        a?.similarity != null ? a.similarity.toFixed(3) : '',
        a?.updated_at ?? '',
      ]
        .map(csvCell)
        .join(',')
    );
  };

  for (const f of detail.fragments) {
    if (f.annotations.length === 0) {
      pushRow(f.ord, typeLabel(f.type), f.old_text, f.new_text);
    } else {
      for (const a of f.annotations) {
        pushRow(f.ord, typeLabel(f.type), f.old_text, f.new_text, a);
      }
    }
  }
  for (const a of detail.unanchored) {
    pushRow('-', '待复核（未匹配片段）', a.anchor_text, '', a);
  }

  return '﻿' + rows.join('\r\n');
}

/** 导出 Markdown 审阅报告 */
export function toMarkdown(detail: ComparisonDetail): string {
  const { comparison, fragments, unanchored, stats } = detail;
  const lines: string[] = [];
  lines.push(`# 审阅报告：${comparison.project_name}`);
  lines.push('');
  lines.push(`- 版本对比：\`${comparison.old_label}\` → \`${comparison.new_label}\``);
  lines.push(`- 比对时间：${comparison.created_at}`);
  lines.push(
    `- 差异统计：新增 ${stats.added} · 删除 ${stats.removed} · 修改 ${stats.changed}`
  );
  lines.push(
    `- 批注统计：待处理 ${stats.annotations.open} · 已解决 ${stats.annotations.resolved} · 待复核 ${stats.annotations.pending_review}（共 ${stats.annotations.total} 条）`
  );
  lines.push('');
  lines.push('---');

  const renderAnnotation = (a: {
    author: string;
    content: string;
    status: string;
    similarity: number | null;
    migrated_from: number | null;
  }) => {
    const mig =
      a.migrated_from != null
        ? `（迁移自上一轮${a.similarity != null ? `，相似度 ${(a.similarity * 100).toFixed(0)}%` : ''}）`
        : '';
    lines.push(`> 【${statusLabel(a.status)}】**${a.author}**${mig}：${a.content}`);
  };

  for (const f of fragments) {
    lines.push('');
    lines.push(`## 片段 #${f.ord}（${typeLabel(f.type)}）`);
    lines.push('');
    if (f.old_text != null) {
      lines.push('**旧文本**');
      lines.push('');
      lines.push('```');
      lines.push(f.old_text);
      lines.push('```');
    }
    if (f.new_text != null) {
      lines.push('**新文本**');
      lines.push('');
      lines.push('```');
      lines.push(f.new_text);
      lines.push('```');
    }
    if (f.annotations.length > 0) {
      lines.push('');
      lines.push('**批注**');
      lines.push('');
      for (const a of f.annotations) renderAnnotation(a);
    }
  }

  if (unanchored.length > 0) {
    lines.push('');
    lines.push('## 待复核（未匹配到新片段的批注）');
    lines.push('');
    for (const a of unanchored) {
      lines.push(`- 锚点文本：${a.anchor_text ?? '(空)'}`);
      lines.push(`  - 【${statusLabel(a.status)}】**${a.author}**：${a.content}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
