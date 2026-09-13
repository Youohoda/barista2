// Data Analyst core — pure functions, no I/O, so they can be unit-tested directly
// (see test/data-analyst.test.js) without a DB or model call. Deliberately plain
// JS/CSV stats rather than shelling out to Python: this stack has no sandbox to run
// Python safely (see api/providers/sandbox.js), and the brief explicitly forbids
// running it straight on the production host.

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

function isNumeric(v) { return v !== '' && v !== null && v !== undefined && !isNaN(Number(v)); }
function mean(nums) { return nums.reduce((a, b) => a + b, 0) / (nums.length || 1); }
function median(nums) { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function stddev(nums, avg) { return Math.sqrt(mean(nums.map(n => (n - avg) ** 2))); }

// Pearson correlation between two equal-length numeric arrays.
function correlation(a, b) {
  const n = a.length; if (n < 2) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  const denom = Math.sqrt(da * db);
  return denom ? num / denom : null;
}

export function computeStats(csvText, { maxRows = 50000 } = {}) {
  const rows = parseCSV(csvText);
  if (!rows.length) return { error: 'ملف فاضي أو مش CSV صالح.' };
  const headers = rows[0].map(h => String(h).trim() || 'column');
  const data = rows.slice(1, 1 + maxRows);
  const columns = headers.map((name, i) => {
    const raw = data.map(r => (r[i] ?? '').trim());
    const missing = raw.filter(v => v === '').length;
    const present = raw.filter(v => v !== '');
    const numericValues = present.filter(isNumeric).map(Number);
    const isNumericColumn = present.length > 0 && numericValues.length / present.length > 0.9;
    const col = { name, count: raw.length, missing, distinct: new Set(present).size };
    if (isNumericColumn && numericValues.length) {
      const avg = mean(numericValues), sd = stddev(numericValues, avg);
      const sorted = [...numericValues].sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)], q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      const outliers = numericValues.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
      col.type = 'numeric';
      col.min = Math.min(...numericValues); col.max = Math.max(...numericValues);
      col.mean = avg; col.median = median(numericValues); col.stddev = sd;
      col.outlierCount = outliers.length;
      col._numericValues = numericValues; // used for correlation below, stripped before return
    } else {
      col.type = 'categorical';
      const freq = {};
      for (const v of present) freq[v] = (freq[v] || 0) + 1;
      col.topValues = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
    }
    return col;
  });

  const numericCols = columns.filter(c => c.type === 'numeric');
  const correlations = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const r = correlation(numericCols[i]._numericValues, numericCols[j]._numericValues);
      if (r !== null) correlations.push({ a: numericCols[i].name, b: numericCols[j].name, r: Math.round(r * 1000) / 1000 });
    }
  }
  for (const c of columns) delete c._numericValues;

  return { rowCount: data.length, columnCount: headers.length, columns, correlations, truncated: rows.length - 1 > maxRows };
}
