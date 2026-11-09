export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx' | 'add' | 'del'; oldNo: number | null; newNo: number | null; text: string };

/** Parses GitLab-style hunks (`@@ -a,b +c,d @@` …) into rows with old/new line numbers. */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      // git numbers an empty side from the line before it.
      if (oldNo === 0) oldNo = 1;
      if (newNo === 0) newNo = 1;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('\\')) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text });
    else if (mark === '-') rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text });
    else rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
  }
  return rows;
}
