import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WELLNESS_SCHEMA_VERSION = 1;
export const WELLNESS_ALGORITHM_VERSION = 1;
const SECRET_KEY = /(?:access|refresh)[_-]?token|authorization|password|secret|code[_-]?verifier|poll[_-]?token|login[_-]?ticket/i;
const DAY_MS = 86_400_000;
const OFFICIAL_TOOL_GROUPS = {
  hrv: [/hrv/i],
  sleep: [/sleep/i],
  resting_heart_rate: [/resting.*heart|resting.*hr|\brhr\b/i],
  stress: [/stress/i],
  recovery: [/recovery/i],
  daily: [/daily.*health|daily.*activ|wellness/i],
  training_load: [/training.*load/i],
};
const OFFICIAL_TOOL_NAMES = {
  hrv: ['querySleepHrv', 'queryHrvAssessment'],
  sleep: ['querySleepData'],
  resting_heart_rate: ['queryRestingHeartRate'],
  stress: ['queryStressLevel'],
  recovery: ['queryRecoveryStatus'],
  daily: ['queryDailyHealthData'],
  training_load: ['queryTrainingLoadAssessment'],
};

function atomicWrite(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function writeJsonl(path, rows) {
  atomicWrite(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}
function compactError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:code|token|state)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

export function wellnessPaths(paths) {
  const root = join(paths.root, 'wellness');
  return {
    root,
    raw: join(root, 'raw', 'observations.jsonl'),
    daily: join(root, 'derived', 'daily.jsonl'),
    trends: join(root, 'derived', 'trends.json'),
    state: join(root, 'state', 'sync-state.json'),
  };
}

export function officialCacheRoot(options = {}) {
  return resolve(options.cacheRoot || process.env.COROS_MCP_CACHE_ROOT || join(homedir(), '.knowledge-assistant', 'config', 'coros-mcp'));
}

function ensureSecureCacheRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
}

function helperPath(options = {}) {
  if (options.helperPath) return resolve(options.helperPath);
  if (process.env.COROS_MCP_CLI) return resolve(process.env.COROS_MCP_CLI);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'coros-mcp');
}

export function runOfficialHelper(command, commandArgs = [], options = {}) {
  const cacheRoot = officialCacheRoot(options);
  ensureSecureCacheRoot(cacheRoot);
  const executable = helperPath(options);
  if (!existsSync(executable)) throw new Error('official coros-mcp helper is not installed');
  const result = spawnSync(executable, ['--cache-root', cacheRoot, command, ...commandArgs], {
    encoding: 'utf8', timeout: options.timeoutMs || 120_000,
    env: { ...process.env, MCP_CACHE_ROOT: cacheRoot },
  });
  if (result.error) throw new Error(`official coros-mcp failed: ${compactError(result.error)}`);
  if (result.status !== 0) throw new Error(`official coros-mcp failed: ${compactError(result.stderr || result.stdout)}`);
  return result.stdout.trim();
}

export function officialOauth(action, options = {}) {
  if (!['login-start', 'login-finish', 'login-status'].includes(action)) throw new Error('unsupported OAuth action');
  if (action === 'login-status') {
    try {
      const tools = createOfficialProvider(options).listTools(false);
      return { ok: true, action, authorized: true, refresh_capable: true, tool_count: tools.length };
    } catch (error) {
      return { ok: false, action, authorized: false, refresh_capable: false, error: compactError(error) };
    }
  }
  const stdout = runOfficialHelper(action, [], options);
  const url = stdout.match(/https:\/\/[^\s]+/)?.[0] || null;
  return { ok: true, action, authorization_required: action === 'login-start', authorization_url: url, message: stdout.replace(url || /$^/, url ? '[authorization_url]' : '') };
}

function parseHelperJson(stdout) {
  try { return JSON.parse(stdout); }
  catch { throw new Error('official coros-mcp returned non-JSON tool output'); }
}

export function createOfficialProvider(options = {}) {
  return {
    listTools(refresh = false) {
      return parseHelperJson(runOfficialHelper('list-tools', refresh ? ['--refresh'] : [], options));
    },
    callTool(name, args) {
      const result = parseHelperJson(runOfficialHelper('call-tool', ['--tool', name, '--arguments-json', JSON.stringify(args)], options));
      if (result?.isError) throw new Error(`official tool ${name} failed`);
      return result;
    },
  };
}

function toolText(tool) {
  return `${tool?.name || ''} ${tool?.description || ''}`;
}

export function selectWellnessTools(tools) {
  const selected = [];
  const used = new Set();
  for (const [kind, patterns] of Object.entries(OFFICIAL_TOOL_GROUPS)) {
    const preferred = OFFICIAL_TOOL_NAMES[kind] || [];
    const tool = tools.find((candidate) => !used.has(candidate.name) && preferred.includes(candidate.name))
      || tools.find((candidate) => !used.has(candidate.name) && patterns.some((pattern) => pattern.test(toolText(candidate))));
    if (tool && !used.has(tool.name)) {
      selected.push({ kind, tool });
      used.add(tool.name);
    }
  }
  return selected;
}

function compactDay(day) { return day.replaceAll('-', ''); }

export function argumentsForTool(tool, startDate, endDate) {
  const properties = tool?.inputSchema?.properties || {};
  const args = {};
  const days = Math.max(1, Math.floor((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / DAY_MS) + 1);
  const candidates = [
    [['startDate'], compactDay(startDate)],
    [['endDate'], compactDay(endDate)],
    [['start_date', 'fromDate', 'beginDate'], startDate],
    [['end_date', 'toDate', 'untilDate'], endDate],
    [['startDay', 'start_day', 'beginDay'], compactDay(startDate)],
    [['endDay', 'end_day'], compactDay(endDate)],
    [['days', 'recentDays'], days],
    [['weeks'], Math.max(1, Math.ceil(days / 7))],
  ];
  for (const [names, value] of candidates) {
    const name = names.find((key) => Object.hasOwn(properties, key));
    if (name) {
      const declaredMaximum = Number(properties[name]?.maximum);
      const describedMaximum = Number(String(properties[name]?.description || '').match(/maximum\s+(\d+)/i)?.[1]);
      const maximum = Number.isFinite(declaredMaximum) && declaredMaximum > 0 ? declaredMaximum
        : Number.isFinite(describedMaximum) && describedMaximum > 0 ? describedMaximum : null;
      args[name] = maximum && typeof value === 'number' ? Math.min(value, maximum) : value;
    }
  }
  return args;
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, scrub(item)]));
}

function unwrapMcpResult(result) {
  if (result?.structuredContent) return result.structuredContent;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : parsed;
    } catch { return text; }
  }
  return result;
}

function normalizeDate(value) {
  if (typeof value === 'number' && value >= 20_000_000 && value <= 30_000_000) value = String(value);
  if (typeof value !== 'string') return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return null;
}

function dateFromRecord(record) {
  for (const key of ['date', 'day', 'calendarDate', 'calendar_date', 'sleepDate', 'sleep_date', 'recordDate', 'record_date']) {
    const day = normalizeDate(record?.[key]);
    if (day) return day;
  }
  return null;
}

function objectsWithDates(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (!Array.isArray(value) && dateFromRecord(value)) output.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) objectsWithDates(child, output, seen);
  return output;
}

function numeric(record, names) {
  for (const name of names) {
    const raw = record?.[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function metricFields(record, kind) {
  const output = {};
  const definitions = {
    hrv_ms: ['hrv', 'hrvMs', 'hrv_ms', 'avgHrv', 'averageHrv', 'sleepHrv', 'rmssd'],
    hrv_baseline_ms: ['hrvBaseline', 'hrv_baseline_ms'],
    resting_hr_bpm: ['restingHeartRate', 'resting_heart_rate', 'restingHr', 'resting_hr_bpm', 'rhr'],
    stress: ['stress', 'stressLevel', 'avgStress', 'averageStress'],
    recovery: ['recovery', 'recoveryStatus', 'recovery_score', 'recoveryScore'],
    sleep_minutes: ['sleepMinutes', 'sleep_minutes', 'totalSleepMinutes', 'total_duration_minutes', 'sleepDurationMinutes'],
    sleep_score: ['sleepScore', 'sleep_score', 'qualityScore', 'quality_score'],
    awake_minutes: ['awakeMinutes', 'awake_minutes'],
    avg_hr_bpm: ['avgHeartRate', 'averageHeartRate', 'avg_hr', 'avgHr'],
    steps: ['steps', 'stepCount', 'step_count'],
    calories_kcal: ['calories', 'caloriesKcal', 'calories_kcal'],
    training_load: ['trainingLoad', 'training_load', 'weeklyTrainingLoad'],
    short_term_training_load: ['shortTermLoad', 'short_term_load', 'short_term_training_load'],
    long_term_training_load: ['longTermLoad', 'long_term_load', 'long_term_training_load'],
    training_load_ratio: ['loadRatio', 'load_ratio', 'training_load_ratio'],
  };
  for (const [field, aliases] of Object.entries(definitions)) {
    const value = numeric(record, aliases);
    if (value !== null) output[field] = value;
  }
  if (kind === 'hrv' && output.hrv_ms === undefined) {
    const value = numeric(record, ['value', 'score']);
    if (value !== null) output.hrv_ms = value;
  }
  if (kind === 'resting_heart_rate' && output.resting_hr_bpm === undefined) {
    const value = numeric(record, ['value']);
    if (value !== null) output.resting_hr_bpm = value;
  }
  if (kind === 'stress' && output.stress === undefined) {
    const value = numeric(record, ['value', 'score']);
    if (value !== null) output.stress = value;
  }
  return output;
}

function valueAfterColon(line) {
  const value = line.split(':').slice(1).join(':');
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function durationMinutes(line) {
  const value = line.split(':').slice(1).join(':');
  const hours = Number(value.match(/(\d+(?:\.\d+)?)\s*h/i)?.[1] || 0);
  const minutes = Number(value.match(/(\d+(?:\.\d+)?)\s*m(?:in)?\b/i)?.[1] || 0);
  if (hours || minutes) return hours * 60 + minutes;
  const plain = value.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|min)\b/i);
  return plain ? Number(plain[1]) : null;
}

function textRecords(text, kind, fallbackDate) {
  const byDate = new Map();
  let currentDate = null;
  const row = () => {
    const date = currentDate || fallbackDate;
    if (!date) return null;
    if (!byDate.has(date)) byDate.set(date, { date });
    return byDate.get(date);
  };
  for (const sourceLine of String(text).split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line) continue;
    const date = line.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
    if (date) currentDate = date;
    const target = row();
    if (!target) continue;
    if (kind === 'hrv') {
      if (/^HRV Avg:/i.test(line)) target.hrv_ms = valueAfterColon(line);
      else if (/^Baseline:/i.test(line)) target.hrv_baseline_ms = valueAfterColon(line);
    } else if (kind === 'sleep') {
      if (/^Sleep Score:/i.test(line)) target.sleep_score = valueAfterColon(line);
      else if (/^Main Sleep:/i.test(line)) target.sleep_minutes = durationMinutes(line);
      else if (/^Awake Time:/i.test(line)) target.awake_minutes = durationMinutes(line);
    } else if (kind === 'resting_heart_rate') {
      if (date && line.includes(':')) target.resting_hr_bpm = valueAfterColon(line);
    } else if (kind === 'stress' || kind === 'daily') {
      if (/^(Average )?Stress:/i.test(line)) target.stress = valueAfterColon(line);
      else if (/^Steps:/i.test(line)) target.steps = valueAfterColon(line);
      else if (/^Total:/i.test(line) && kind === 'daily') target.sleep_minutes = durationMinutes(line);
    } else if (kind === 'recovery') {
      if (/^Recovery:/i.test(line)) target.recovery = valueAfterColon(line);
    } else if (kind === 'training_load') {
      if (/^Short-Term Load:/i.test(line)) target.short_term_training_load = valueAfterColon(line);
      else if (/^Long-Term Load:/i.test(line)) target.long_term_training_load = valueAfterColon(line);
      else if (/^Load Ratio:/i.test(line)) target.training_load_ratio = valueAfterColon(line);
    }
  }
  return [...byDate.values()].filter((record) => Object.keys(record).length > 1);
}

export function normalizeObservations(observations) {
  const byDate = new Map();
  for (const observation of observations) {
    const payload = unwrapMcpResult(observation.payload);
    const records = typeof payload === 'string'
      ? textRecords(payload, observation.kind, observation.range?.end_date)
      : objectsWithDates(payload);
    for (const record of records) {
      const date = dateFromRecord(record);
      const metrics = metricFields(record, observation.kind);
      if (!date || !Object.keys(metrics).length) continue;
      const prior = byDate.get(date) || { schema_version: WELLNESS_SCHEMA_VERSION, algorithm_version: WELLNESS_ALGORITHM_VERSION, date, sources: [] };
      Object.assign(prior, metrics);
      if (!prior.sources.includes(observation.tool)) prior.sources.push(observation.tool);
      byDate.set(date, prior);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function mergeByKey(existing, incoming, key) {
  const rows = new Map(existing.map((row) => [row[key], row]));
  for (const row of incoming) {
    const prior = rows.get(row[key]);
    if (prior && prior.kind === row.kind && JSON.stringify(prior.payload) === JSON.stringify(row.payload)) continue;
    rows.set(row[key], { ...(prior || {}), ...row });
  }
  return [...rows.values()].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function trainingLoads(activityRows) {
  const byDate = new Map();
  for (const activity of activityRows) {
    if (!activity.date || !Number.isFinite(activity.training_load)) continue;
    byDate.set(activity.date, (byDate.get(activity.date) || 0) + activity.training_load);
  }
  return byDate;
}

export function rebuildWellness(paths) {
  const wp = wellnessPaths(paths);
  const observations = readJsonl(wp.raw);
  const daily = normalizeObservations(observations);
  const activityRows = readJsonl(paths.activitiesJsonl);
  const loads = trainingLoads(activityRows);
  for (const row of daily) row.local_activity_training_load = loads.get(row.date) ?? null;
  writeJsonl(wp.daily, daily);
  const recent = daily.slice(-28);
  const metricNames = ['hrv_ms', 'sleep_minutes', 'sleep_score', 'resting_hr_bpm', 'stress', 'recovery', 'training_load', 'local_activity_training_load'];
  const metrics = {};
  for (const metric of metricNames) {
    const values = recent.map((row) => row[metric]);
    metrics[metric] = { count: values.filter(Number.isFinite).length, mean: mean(values), median: median(values) };
  }
  const trends = {
    schema_version: WELLNESS_SCHEMA_VERSION,
    algorithm_version: WELLNESS_ALGORITHM_VERSION,
    data_through: daily.at(-1)?.date || null,
    recent_days: recent.length,
    metrics,
  };
  atomicWrite(wp.trends, stableJson(trends));
  return { observation_count: observations.length, daily_count: daily.length, data_through: trends.data_through };
}

function localToday(now = new Date(), timeZone = process.env.COROS_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function syncWellness(paths, options = {}) {
  const wp = wellnessPaths(paths);
  mkdirSync(join(wp.root, 'raw'), { recursive: true, mode: 0o700 });
  const previous = readJson(wp.state, {});
  const today = options.endDate || localToday(options.now, options.timeZone);
  const start = options.startDate || (previous.data_through ? shiftDate(previous.data_through, -2) : shiftDate(today, -27));
  const provider = options.provider || createOfficialProvider(options);
  const result = { remote: { status: 'not_attempted', error: null }, start_date: start, end_date: today, tools_called: [], missing_categories: [], observations_new: 0, daily_changed: false, data_through: previous.data_through || null };
  try {
    const tools = await provider.listTools(options.refreshTools);
    const selected = selectWellnessTools(tools);
    if (!selected.length) throw new Error('official COROS MCP exposed no supported wellness tools');
    result.missing_categories = ['hrv', 'sleep', 'resting_heart_rate', 'stress', 'recovery']
      .filter((kind) => !selected.some((entry) => entry.kind === kind));
    const existing = readJsonl(wp.raw);
    const incoming = [];
    for (const { kind, tool } of selected) {
      const args = argumentsForTool(tool, start, today);
      const payload = scrub(await provider.callTool(tool.name, args));
      incoming.push({ key: `${tool.name}:${start}:${today}`, schema_version: WELLNESS_SCHEMA_VERSION, fetched_at: new Date().toISOString(), range: { start_date: start, end_date: today }, kind, tool: tool.name, payload });
      result.tools_called.push(tool.name);
    }
    const merged = mergeByKey(existing, incoming, 'key');
    result.observations_new = merged.length - existing.length;
    writeJsonl(wp.raw, merged);
    const before = existsSync(wp.daily) ? readFileSync(wp.daily, 'utf8') : '';
    const rebuilt = rebuildWellness(paths);
    const after = readFileSync(wp.daily, 'utf8');
    result.daily_changed = before !== after;
    result.data_through = rebuilt.data_through;
    result.remote.status = result.missing_categories.length || !rebuilt.daily_count ? 'partial' : 'ok';
    if (result.remote.status === 'partial') result.remote.error = result.missing_categories.length
      ? `official tool coverage missing: ${result.missing_categories.join(', ')}`
      : 'official responses were cached but contained no normalizable daily records';
  } catch (error) {
    result.remote.status = 'failed';
    result.remote.error = compactError(error);
  }
  atomicWrite(wp.state, stableJson({
    schema_version: WELLNESS_SCHEMA_VERSION,
    algorithm_version: WELLNESS_ALGORITHM_VERSION,
    last_attempt_at: new Date().toISOString(),
    last_success_at: ['ok', 'partial'].includes(result.remote.status) ? new Date().toISOString() : previous.last_success_at || null,
    data_through: result.data_through,
  }));
  return result;
}

export function wellnessTrend(paths, { days = 28 } = {}) {
  const wp = wellnessPaths(paths);
  const daily = readJsonl(wp.daily);
  const selected = daily.slice(-Math.max(1, Number(days) || 28));
  const state = readJson(wp.state, {});
  return {
    ok: selected.length > 0,
    source: 'local_cache',
    data_through: selected.at(-1)?.date || state.data_through || null,
    days: selected.length,
    latest: selected.at(-1) || null,
    trends: readJson(wp.trends, null),
  };
}

export function validateWellness(paths) {
  const wp = wellnessPaths(paths);
  const observations = readJsonl(wp.raw);
  const daily = readJsonl(wp.daily);
  const state = readJson(wp.state, null);
  const secretHits = [];
  const hasSensitiveKey = (value) => {
    if (Array.isArray(value)) return value.some(hasSensitiveKey);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || hasSensitiveKey(child));
  };
  for (const [name, value] of [['raw', observations], ['daily', daily], ['state', state]]) {
    if (hasSensitiveKey(value)) secretHits.push(name);
  }
  const duplicateDates = daily.length - new Set(daily.map((row) => row.date)).size;
  return {
    schema_version: WELLNESS_SCHEMA_VERSION,
    algorithm_version: WELLNESS_ALGORITHM_VERSION,
    observation_count: observations.length,
    daily_count: daily.length,
    data_through: daily.at(-1)?.date || state?.data_through || null,
    duplicate_dates: duplicateDates,
    sensitive_key_hits: secretHits,
    valid: duplicateDates === 0 && secretHits.length === 0,
  };
}
