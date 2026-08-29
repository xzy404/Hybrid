import {
  ContestModel,
  Context,
  db,
  DocumentModel,
  Handler,
  HackFailedError,
  ObjectId,
  param,
  PERM,
  PermissionError,
  ProblemModel,
  RecordModel,
  SettingModel,
  STATUS,
  StorageModel,
  Types,
  ValidationError,
  nanoid,
} from 'hydrooj';
import * as yaml from 'js-yaml';

/**
 * Hydro 5.0.4 专用赛制插件。
 *
 * 团队题使用统一题池：所有队伍看到同样的 5 个 PID，Hack 目标按队伍成员区分。
 * 管理员只配置个人题和 5 个团队题；队伍成员、名称和邀请码由选手自行管理。
 *
 * 重要约定：
 * - 比赛 pids 与配置中的 personalPid / teamPids 一律使用「数字 docId」。
 *   Hydro 核心用 `tdoc.pids.includes(pdoc.docId)`（数字严格比较）判断题目是否属于比赛，
 *   用 `{ docId: { $in: pids } }`（BSON 类型严格匹配）查询题目；
 *   写入字符串会导致 "Contest not found" 和题目列表为空。
 * - 团队题不做任何克隆/复制，所有队伍共享同一组题目。
 */
const RULE = 'hybrid_lock_hack';
const HACK_COLLECTION = 'hybrid_lock_hack.event';
const ROOM_COLLECTION = 'hybrid_lock_hack.room';
const DURATION_HOURS = 3;
const TEAM_MAX_MEMBERS = 3;
const TEAM_FREEZE_MS = 5 * 60 * 1000;
const TEAM_PROBLEM_COUNT = 5;
const SCORE_PER_PROBLEM = 100;

type TeamConfig = {
  id: string;
  name: string;
  members: number[];
  owner?: number;
  inviteCode?: string;
  /** 统一题池下所有队伍相同的 5 个题目 docId（数字）。 */
  pids: number[];
};

type SolutionConfig = {
  /** 对应 teamPids 的下标（0~4）。 */
  slot: number;
  lang: string;
  code: string;
};

type HybridConfig = {
  /** 所有参赛者共用的个人题 docId（数字）。 */
  personalPid: number;
  /** 所有队伍共用的 5 道团队题 docId（数字）。 */
  teamPids: number[];
  /** 由选手在比赛页面动态维护；管理员配置时可以为空。 */
  teams?: TeamConfig[];
  /** 每道团队题的正解（管理员在 manage 页粘贴代码 + 语言），用于 hack 比对。 */
  solutions?: SolutionConfig[];
};

type HackEvent = {
  _id?: ObjectId;
  domainId: string;
  tid: ObjectId;
  rid: ObjectId;
  hackerUid: number;
  attackerTeamId: string;
  targetTeamId: string;
  slot: number;
  targetRid: ObjectId;
  createdAt: Date;
  resolvedAt?: Date;
  result: 'pending' | 'success' | 'failure' | 'error';
  /** 错误 Hack 的额外次数消耗：有余量时为 1，否则为 0。 */
  extraCost: number;
  /** 错误 Hack 的额外扣分：次数不足时为 5，否则为 0。 */
  shortagePenalty: number;
  /** 正解评测 rid（pretest，用管理员 uid 提交，避免正解代码泄露给选手）。 */
  solRid: ObjectId;
  /** 被 hack 代码评测 rid（pretest，用 hack 方 uid 提交）。 */
  victimRid: ObjectId;
  /** hack 输入在 storage 中的 key（submission/ 前缀）。 */
  hackInputKey: string;
  /** 正解在 hack 输入下的标准输出。 */
  solOutput?: string;
  /** 被 hack 代码在 hack 输入下的输出。 */
  victimOutput?: string;
  /** 正解评测是否完成。 */
  solDone?: boolean;
  /** 被 hack 代码评测是否完成。 */
  victimDone?: boolean;
  /** 正解评测状态码。 */
  solStatus?: number;
  /** 被 hack 代码评测状态码。 */
  victimStatus?: number;
  /** 正解评测状态的文本（用于「系统错误」时展示）。 */
  solStatusText?: string;
  /** 正解评测未 AC 时的错误详情（编译/运行错误信息）。 */
  solError?: string;
  /** 是否已进入最终判定（用于并发互斥，避免重复判定）。 */
  finalized?: boolean;
};

function isHybrid(tdoc: any) {
  return tdoc?.rule === RULE || tdoc?.rule === 'Hybrid';
}

/**
 * 把配置里的 pid 规范化为数字 docId。
 * JSON 里可能写的是数字或数字字符串，两者都接受；其它格式一律拒绝。
 */
function toPid(value: any): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError('pids');
  return n;
}

/**
 * 解析管理员填写的题目标识：
 * - 数字或纯数字字符串（如 15）视为题目序号（数字 docId）；
 * - 其它字符串（如 "C1000"）视为题目编号，通过 ProblemModel.get 查找并转换为数字 docId。
 * 内部存储仍统一使用数字 docId，保证与 Hydro 核心的类型严格比较兼容。
 */
async function resolvePid(domainId: string, value: any): Promise<number> {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const s = String(value ?? '').trim();
  if (!s) throw new ValidationError('pids');
  if (/^\d+$/.test(s)) return toPid(s);
  const pdoc = await ProblemModel.get(domainId, s, ['docId', 'pid'] as any).catch(() => null);
  if (!pdoc) throw new ValidationError(`pids:${s}`);
  return Number(pdoc.docId);
}

/** 把数字 docId 还原为管理员可读的题目编号（如 C1000），供管理页展示。 */
async function pidLabel(domainId: string, pid: number) {
  const pdoc = await ProblemModel.get(domainId, pid, ['docId', 'pid'] as any).catch(() => null);
  return pdoc?.pid || pid;
}

function configOf(tdoc: any): HybridConfig {
  const raw = tdoc?.hybridLockHack;
  if (!raw || typeof raw !== 'object') throw new ValidationError('hybridLockHack');
  let personalPid = raw.personalPid;
  if ((personalPid === undefined || personalPid === null || personalPid === '') && raw.personal) {
    const legacy = Object.values(raw.personal)[0];
    if (legacy !== undefined) personalPid = legacy;
  }
  let teamPids = raw.teamPids;
  if (!Array.isArray(teamPids) && Array.isArray(raw.teams?.[0]?.pids)) teamPids = raw.teams[0].pids;
  const pool = (teamPids || []).map(toPid);
  return {
    personalPid: (personalPid === undefined || personalPid === null || personalPid === '') ? 0 : toPid(personalPid),
    teamPids: pool,
    // 队伍一律使用统一题池；历史遗留的每队独立 pids（克隆副本）在这里被规范化掉。
    teams: (raw.teams || []).map((team: any) => ({ ...team, pids: pool })),
    solutions: (raw.solutions || []).map((solution: any) => ({
      slot: Number(solution.slot),
      lang: String(solution.lang || ''),
      code: String(solution.code || ''),
    })).filter((solution: SolutionConfig) => Number.isInteger(solution.slot) && solution.slot >= 0 && solution.lang && solution.code),
  } as HybridConfig;
}

/** 按槽位取正解；未配置返回 null。 */
function solutionOf(config: HybridConfig, slot: number): SolutionConfig | null {
  return (config.solutions || []).find((solution) => solution.slot === slot) || null;
}

/**
 * 归一化程序输出：统一换行、去除每行行尾空白、去除末尾空行。
 * 与 Hydro default checker 的 BZ 模式语义一致（忽略行尾空格与末尾空行）。
 */
function normalizeOutput(output: string): string {
  return String(output ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** 从 pretest（run judge）评测记录中提取程序输出（stdout，可能末尾附带 stderr）。 */
function recordOutput(rdoc: any): string {
  return (rdoc?.testCases || []).map((c: any) => c?.message || '').join('\n');
}

/** 把评测状态码转成人类可读文本，用于 hack「系统错误」时展示正解未 AC 的具体原因。 */
function statusText(status: number | undefined | null): string {
  const map: Record<number, string> = {
    0: '等待中', 1: 'Accepted', 2: 'Wrong Answer', 3: '超时 (TLE)', 4: '超内存 (MLE)',
    5: '输出超限 (OLE)', 6: '运行错误 (RE)', 7: '编译失败 (CE)', 8: '系统错误 (SE)',
    20: '评测中', 21: '编译中',
  };
  return status === undefined || status === null ? '未知' : (map[status] || `状态码 ${status}`);
}

/** 从评测记录里提取错误详情：优先编译错误，其次评测信息，最后测试点输出/报错。 */
function recordError(rdoc: any): string {
  if (!rdoc) return '评测记录不存在（可能被删除）';
  return [
    (rdoc.compilerTexts || []).join('\n'),
    (rdoc.judgeTexts || []).join('\n'),
    (rdoc.testCases || []).map((c: any) => c?.message || '').join('\n'),
  ].filter((s) => s && s.trim()).join('\n').substring(0, 2000);
}

function teamPidsOf(config: HybridConfig) {
  return (config.teamPids || []).map(toPid);
}

function allPids(config: HybridConfig) {
  return Array.from(new Set([config.personalPid, ...teamPidsOf(config)].filter((pid) => pid > 0)));
}

function teamOf(config: HybridConfig, uid: number) {
  return (config.teams || []).find((team) => team.members.includes(uid)) || null;
}

function isContestAdmin(that: any, tdoc: any) {
  return that.user.own(tdoc) || that.user.hasPerm(PERM.PERM_EDIT_CONTEST);
}

function statusHybrid(tsdoc: any) {
  return tsdoc?.hybridLockHack || {};
}

function isLocked(tsdoc: any) {
  return !!statusHybrid(tsdoc).lockedAt;
}

function personalPid(config: HybridConfig, _uid: number) {
  return Number(config.personalPid || 0);
}

function slotOf(team: TeamConfig | null, pid: any) {
  return team ? team.pids.findIndex((item) => String(item) === String(pid)) : -1;
}

function teamMutationOpen(tdoc: any) {
  return new Date(tdoc.beginAt).getTime() - Date.now() > TEAM_FREEZE_MS;
}

function teamCreateOpen(tdoc: any) {
  // 赛前仍遵守五分钟冻结；比赛开始后，未组队报名者可以创建单人队伍。
  return !ContestModel.isDone(tdoc) && (!ContestModel.isNotStarted(tdoc) || teamMutationOpen(tdoc));
}

const INVITE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function nextTeamId(teams: TeamConfig[]) {
  const used = new Set(teams.map((team) => String(team.id)));
  for (let n = 1; n <= 999; n++) {
    const id = String(n).padStart(3, '0');
    if (!used.has(id)) return id;
  }
  throw new ValidationError('No team id available.');
}

function randomLetters(length: number) {
  if (length < 2) throw new ValidationError('invite');
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const chars = [upper[Math.floor(Math.random() * upper.length)], lower[Math.floor(Math.random() * lower.length)]];
  while (chars.length < length) chars.push(INVITE_LETTERS[Math.floor(Math.random() * INVITE_LETTERS.length)]);
  return chars.sort(() => Math.random() - 0.5).join('');
}

function newInviteCode(teamId: string, teams: TeamConfig[]) {
  const used = new Set(teams.map((team) => team.inviteCode));
  for (let i = 0; i < 20; i++) {
    const code = `${teamId}${randomLetters(6)}`;
    if (!used.has(code)) return code;
  }
  throw new ValidationError('Unable to generate a unique invite code.');
}

function currentTeams(config: HybridConfig) {
  const pool = teamPidsOf(config);
  return (config.teams || []).map((team) => ({ ...team, pids: pool }));
}

async function persistTeams(domainId: string, tid: ObjectId, config: HybridConfig, teams: TeamConfig[]) {
  const pool = teamPidsOf(config);
  const next = { ...config, teams: teams.map((team) => ({ ...team, pids: pool })) };
  validateConfig(next);
  await DocumentModel.set(domainId, DocumentModel.TYPE_CONTEST, tid, { hybridLockHack: next } as any);
  return next;
}

function isNormalRecord(record: any) {
  return !record?.files?.hack;
}

function recordTime(record: any) {
  return record?._id?.getTimestamp?.() || new Date(0);
}

function equalId(a: any, b: any) {
  return a?.toString?.() === b?.toString?.();
}

function objectId(raw: any) {
  if (raw instanceof ObjectId) return raw;
  if (!raw || !ObjectId.isValid(String(raw))) throw new ValidationError('ObjectId');
  return new ObjectId(String(raw));
}

function handlerDomainId(that: any) {
  return typeof that.args?.domainId === 'string' ? that.args.domainId : that.domain?._id;
}

function handlerTid(that: any) {
  return that.args?.tid || that.request?.query?.tid;
}

function validateConfig(config: HybridConfig) {
  if (!config || typeof config !== 'object') throw new ValidationError('hybridLockHack');
  config.personalPid = toPid(config.personalPid);
  if (!Array.isArray(config.teamPids) || config.teamPids.length !== TEAM_PROBLEM_COUNT) throw new ValidationError('hybridLockHack');
  config.teamPids = config.teamPids.map(toPid);
  const memberSeen = new Set<number>();
  const pids = new Set<number>([config.personalPid]);
  for (const pid of config.teamPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pids.has(pid)) throw new ValidationError('teams.pids');
    pids.add(pid);
  }
  for (const team of config.teams || []) {
    if (!team || !/^[A-Za-z0-9_-]{1,32}$/.test(team.id || '') || !team.name
      || !Array.isArray(team.members) || team.members.length > TEAM_MAX_MEMBERS) throw new ValidationError('teams');
    for (const uid of team.members) {
      if (!Number.isSafeInteger(uid) || memberSeen.has(uid)) throw new ValidationError('teams.members');
      memberSeen.add(uid);
    }
    if (Array.isArray(team.pids) && team.pids.length) team.pids = team.pids.map(toPid);
  }
}

async function getContestOrThrow(domainId: string, tid: ObjectId | string) {
  const contestId = tid instanceof ObjectId ? tid : objectId(String(tid));
  const tdoc = await ContestModel.get(domainId, contestId);
  if (!isHybrid(tdoc)) throw new ValidationError('rule');
  return tdoc as any;
}

async function attendeeStatus(domainId: string, tid: ObjectId, uid: number) {
  return await ContestModel.getStatus(domainId, tid, uid) as any;
}

function isRegistered(tsdoc: any) {
  return !!tsdoc && (tsdoc.attend !== false || !!tsdoc.attendAt || !!tsdoc.registeredAt);
}

async function lockState(domainId: string, tid: ObjectId, uid: number) {
  return statusHybrid(await attendeeStatus(domainId, tid, uid));
}

function checkVisible(config: HybridConfig, uid: number, pid: any, locked: boolean) {
  if (String(personalPid(config, uid)) === String(pid)) return true;
  // 按赛制：锁定个人题之前，团队题对所有人（含未组队用户）不可见。
  if (!locked) return false;
  const team = teamOf(config, uid);
  if (!team) return false;
  return team.pids.some((item) => String(item) === String(pid));
}

async function latestAccepted(domainId: string, tid: ObjectId, pids: number[], members: number[]) {
  return await RecordModel.getMulti(domainId, {
    contest: tid,
    pid: { $in: pids.map(Number) },
    uid: { $in: members },
    status: STATUS.STATUS_ACCEPTED,
    'files.hack': { $exists: false },
  }).sort({ _id: -1 }).limit(1).next();
}

async function personalScore(domainId: string, tid: ObjectId, uid: number, pid: number) {
  if (!pid) return 0;
  const records = await RecordModel.getMulti(domainId, {
    contest: tid, uid, pid: Number(pid), 'files.hack': { $exists: false },
  }).project({ score: 1 }).toArray();
  return Math.min(SCORE_PER_PROBLEM, Math.max(0, ...records.map((record: any) => Number(record.score || 0))));
}

async function slotScore(domainId: string, tid: ObjectId, team: TeamConfig, slot: number) {
  const pid = Number(team.pids[slot]);
  const accepted = await latestAccepted(domainId, tid, [pid], team.members);
  const events = db.collection<HackEvent>(HACK_COLLECTION);
  const failed = await events.find({
    domainId, tid, attackerTeamId: team.id, slot, result: 'failure',
  }).toArray();
  const bonus = await events.countDocuments({
    domainId, tid, attackerTeamId: team.id, slot, result: 'success',
  }) * 10;
  const failedPenalty = failed.reduce((sum, event) => sum + 10 + Number(event.shortagePenalty || 0), 0);
  if (!accepted) return { pid, base: 0, hackedPenalty: 0, failedPenalty, bonus, score: Math.max(0, bonus - failedPenalty), rid: null };

  const received = await events.countDocuments({
    domainId,
    tid,
    targetTeamId: team.id,
    slot,
    result: 'success',
    createdAt: { $gt: recordTime(accepted) },
  });
  const hackedPenalty = received * 10;
  const base = Math.max(0, SCORE_PER_PROBLEM - hackedPenalty);
  return {
    pid,
    base,
    hackedPenalty,
    failedPenalty,
    bonus,
    score: Math.max(0, base - failedPenalty + bonus),
    rid: accepted._id,
  };
}

async function teamScore(domainId: string, tid: ObjectId, config: HybridConfig, team: TeamConfig) {
  const members = await Promise.all(team.members.map(async (uid) => ({
    uid,
    score: await personalScore(domainId, tid, uid, personalPid(config, uid)),
  })));
  const slots = await Promise.all(Array.from({ length: TEAM_PROBLEM_COUNT }, (_, slot) => slotScore(domainId, tid, team, slot)));
  return {
    id: team.id,
    name: team.name,
    members,
    slots,
    personalTotal: members.reduce((sum, member) => sum + member.score, 0),
    teamTotal: slots.reduce((sum, item) => sum + item.score, 0),
    total: members.reduce((sum, member) => sum + member.score, 0) + slots.reduce((sum, item) => sum + item.score, 0),
  };
}

async function allTeamScores(domainId: string, tid: ObjectId, config: HybridConfig) {
  const scores = await Promise.all(currentTeams(config).map((team) => teamScore(domainId, tid, config, team)));
  return scores.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

async function outgoingCost(domainId: string, tid: ObjectId, uid: number, slot: number) {
  const events = await db.collection<HackEvent>(HACK_COLLECTION).find({
    domainId, tid, hackerUid: uid, slot,
  }).toArray();
  return events.reduce((sum, event) => sum + 1 + Number(event.extraCost || 0), 0);
}

async function opponentSubmitCount(domainId: string, tid: ObjectId, team: TeamConfig, slot: number) {
  return await RecordModel.getMulti(domainId, {
    contest: tid,
    pid: Number(team.pids[slot]),
    uid: { $in: team.members },
    'files.hack': { $exists: false },
  }).count();
}

async function assertCanSubmit(domainId: string, tid: ObjectId, uid: number, pid: number) {
  const tdoc = await getContestOrThrow(domainId, tid);
  const config = configOf(tdoc);
  const tsdoc = await attendeeStatus(domainId, tid, uid);
  const state = statusHybrid(tsdoc);
  if (String(personalPid(config, uid)) === String(pid)) {
    if (!teamOf(config, uid) || state.lockedAt) throw new PermissionError(PERM.PERM_SUBMIT_PROBLEM);
    return;
  }
  const team = teamOf(config, uid);
  const slot = slotOf(team, pid);
  if (!state.lockedAt || !team || slot < 0) throw new PermissionError(PERM.PERM_SUBMIT_PROBLEM);
  const events = db.collection<HackEvent>(HACK_COLLECTION);
  const [hasHacked, teamWasHacked] = await Promise.all([
    events.countDocuments({ domainId, tid, hackerUid: uid, slot }),
    events.countDocuments({ domainId, tid, targetTeamId: team.id, slot, result: 'success' }),
  ]);
  if (hasHacked && teamWasHacked) throw new PermissionError(PERM.PERM_SUBMIT_PROBLEM);
}

async function assertCanHack(that: any, domainId: string, tid: ObjectId, targetRid: ObjectId) {
  const tdoc = await getContestOrThrow(domainId, tid);
  const config = configOf(tdoc);
  const uid = that.user._id;
  const ownStatus = await attendeeStatus(domainId, tid, uid);
  const ownTeam = teamOf(config, uid);
  if (!isRegistered(ownStatus) || !ownTeam || !isLocked(ownStatus)) throw new HackFailedError('Register and lock your personal problem before hacking.');

  const target = await RecordModel.get(domainId, targetRid);
  if (!target || !equalId(target.contest, tid) || target.status !== STATUS.STATUS_ACCEPTED || !isNormalRecord(target)) {
    throw new HackFailedError('Target must be the latest accepted contest submission.');
  }
  const targetTeam = teamOf(config, target.uid);
  if (!targetTeam || targetTeam.id === ownTeam.id) throw new HackFailedError('You cannot hack your own team.');
  const slot = slotOf(targetTeam, target.pid);
  if (slot < 0 || slotOf(ownTeam, that.pdoc.docId) !== slot) throw new HackFailedError('Target does not match this team-problem slot.');

  const latest = await latestAccepted(domainId, tid, [Number(target.pid)], targetTeam.members);
  if (!latest || !equalId(latest._id, targetRid)) throw new HackFailedError('Only the opponent\'s latest accepted code can be hacked.');
  const currentOwn = await slotScore(domainId, tid, ownTeam, slot);
  const currentTarget = await slotScore(domainId, tid, targetTeam, slot);
  if (currentOwn.base <= 0) throw new HackFailedError('Your team must currently pass this problem before hacking.');
  if (currentTarget.base <= 0) throw new HackFailedError('The target team must have a positive score on this problem.');

  const budget = 1 + await opponentSubmitCount(domainId, tid, targetTeam, slot);
  const used = await outgoingCost(domainId, tid, uid, slot);
  if (used >= budget) throw new HackFailedError(`Hack quota exhausted (${used}/${budget}).`);
  if (!solutionOf(config, slot)) throw new HackFailedError('This problem has no solution configured yet. Ask the administrator to configure it in /hybrid/manage.');
  return { tdoc, config, ownTeam, targetTeam, target, slot, budget, used };
}

async function applySuccessfulHack(event: HackEvent) {
  const target = await RecordModel.get(event.domainId, event.targetRid);
  if (!target) throw new Error('hack target record no longer exists');
  const pdoc = await ProblemModel.get(event.domainId, target.pid, undefined, true) as any;
  if (!pdoc || typeof pdoc.config !== 'string') throw new Error('target problem config is not available');
  const config = yaml.load(pdoc.config) as any;
  if (!Array.isArray(config?.subtasks) || !config.subtasks.length) throw new Error('target problem must use subtasks');
  const input = await StorageModel.get(`submission/${event.hackInputKey}`);
  if (!input) throw new Error('hack input file is unavailable');
  const hackSubtask = config.subtasks.at(-1);
  hackSubtask.cases ||= [];
  const base = `hybrid-hack-${event.rid.toString()}-${hackSubtask.cases.length + 1}`;
  const inputName = `${base}.in`;
  const outputName = `${base}.out`;
  // 标准答案使用正解在该 hack 输入下的输出，而非空输出。
  hackSubtask.cases.push({ input: inputName, output: outputName });
  await Promise.all([
    ProblemModel.addTestdata(event.domainId, target.pid, inputName, input),
    ProblemModel.addTestdata(event.domainId, target.pid, outputName, Buffer.from(event.solOutput || '')),
    ProblemModel.addTestdata(event.domainId, target.pid, 'config.yaml', Buffer.from(yaml.dump(config))),
  ]);
  const accepted = await RecordModel.getMulti(event.domainId, {
    contest: event.tid,
    pid: Number(target.pid),
    uid: { $in: (await getContestOrThrow(event.domainId, event.tid) as any).hybridLockHack.teams
      .find((team: TeamConfig) => team.id === event.targetTeamId).members },
    status: STATUS.STATUS_ACCEPTED,
    'files.hack': { $exists: false },
  }).project({ _id: 1 }).toArray();
  if (accepted.length) {
    const priority = await RecordModel.submissionPriority(event.hackerUid, -5000 - accepted.length * 5 - 50);
    await RecordModel.judge(event.domainId, accepted.map((record: any) => record._id), priority, {}, { hackRejudge: inputName });
  }
}

/**
 * 两个 pretest 评测都完成后做最终判定：
 * - 正解评测非 AC：正解本身有问题，判 error。
 * - 被 hack 代码非 AC（RE/TLE/MLE）：视为 hack 成功。
 * - 都 AC：归一化比对输出，相同则 hack 失败，不同则 hack 成功。
 */
async function finalizeHack(event: HackEvent) {
  const events = db.collection<HackEvent>(HACK_COLLECTION);
  const [sol, victim] = await Promise.all([
    RecordModel.get(event.domainId, event.solRid),
    RecordModel.get(event.domainId, event.victimRid),
  ]);
  if (!sol || sol.status !== STATUS.STATUS_ACCEPTED) {
    await events.updateOne({ _id: event._id, result: 'pending' }, {
      $set: {
        result: 'error',
        resolvedAt: new Date(),
        solStatus: sol?.status ?? null,
        victimStatus: victim?.status ?? null,
        solStatusText: statusText(sol?.status),
        solError: recordError(sol),
      },
    });
    return;
  }
  const solOutput = normalizeOutput(recordOutput(sol));
  const victimOutput = normalizeOutput(recordOutput(victim));
  const victimAccepted = victim?.status === STATUS.STATUS_ACCEPTED;
  const hacked = !victimAccepted || solOutput !== victimOutput;
  if (hacked) {
    const claimed = await events.findOneAndUpdate(
      { _id: event._id, result: 'pending' },
      { $set: { result: 'success', resolvedAt: new Date(), solOutput } },
      { returnDocument: 'after' },
    );
    if (claimed) await applySuccessfulHack(claimed as HackEvent);
    return;
  }
  const currentBudget = 1 + await opponentSubmitCount(event.domainId, event.tid,
    configOf(await getContestOrThrow(event.domainId, event.tid)).teams.find((team) => team.id === event.targetTeamId)!, event.slot);
  const spentBefore = await outgoingCost(event.domainId, event.tid, event.hackerUid, event.slot) - 1;
  const extraCost = spentBefore + 1 < currentBudget ? 1 : 0;
  const shortagePenalty = extraCost ? 0 : 5;
  await events.updateOne({ _id: event._id, result: 'pending' }, { $set: { result: 'failure', resolvedAt: new Date(), extraCost, shortagePenalty } });
}

async function onHackPretestDone(domainId: string, rid: ObjectId) {
  const events = db.collection<HackEvent>(HACK_COLLECTION);
  const event = await events.findOne({
    domainId,
    result: 'pending',
    $or: [{ solRid: rid }, { victimRid: rid }],
  });
  if (!event) return;
  const isSol = equalId(rid, event.solRid);
  const doneField = isSol ? 'solDone' : 'victimDone';
  const updated = await events.findOneAndUpdate(
    { _id: event._id, [doneField]: { $ne: true } },
    { $set: { [doneField]: true } },
    { returnDocument: 'after' },
  );
  if (!updated) return;
  const fresh = await events.findOne({ _id: event._id });
  if (fresh?.solDone && fresh?.victimDone && fresh.result === 'pending') {
    await finalizeHack(fresh as HackEvent);
  }
}

class HybridDashboardHandler extends Handler {
  @param('tid', Types.ObjectId)
  async get(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    if (!isRegistered(tsdoc) && !isContestAdmin(this, tdoc)) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    this.response.template = 'hybrid_dashboard.html';
    // 尚未通过 /hybrid/manage 配置时给出友好提示，而不是抛 ValidationError。
    if (!(tdoc as any).hybridLockHack) {
      this.response.body = { tdoc, notConfigured: true, isAdmin: isContestAdmin(this, tdoc) };
      return;
    }
    const config = configOf(tdoc);
    const team = teamOf(config, this.user._id);
    const lockedUsers = Object.fromEntries(await Promise.all((team?.members || []).map(async (uid) => [uid, isLocked(await attendeeStatus(domainId, tid, uid))])));
    const teamScores = await allTeamScores(domainId, tid, config);
    const myTeamScore = teamScores.find((score) => score.id === team?.id) || null;
    this.response.body = {
      tdoc,
      config,
      team,
      uid: this.user._id,
      tsdoc,
      locked: isLocked(tsdoc),
      lockedUsers,
      personalPid: personalPid(config, this.user._id),
      teamScores,
      myTeamScore,
      teamProblemCount: TEAM_PROBLEM_COUNT,
      teams: config.teams || [],
      teamMutationOpen: teamMutationOpen(tdoc),
      teamCreateOpen: teamCreateOpen(tdoc),
      isAdmin: isContestAdmin(this, tdoc),
    };
  }
}

class HybridTeamCreateHandler extends Handler {
  @param('tid', Types.ObjectId)
  @param('name', Types.Content)
  async post(domainId: string, tid: ObjectId, name: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!teamCreateOpen(tdoc)) throw new ValidationError('Team creation is closed.');
    const config = configOf(tdoc);
    if (teamOf(config, this.user._id)) throw new ValidationError('You are already in a team.');
    name = String(name || '').trim();
    if (!name || name.length > 32) throw new ValidationError('team.name');
    const teams = currentTeams(config);
    const teamId = nextTeamId(teams);
    // 统一题池：新队伍直接共用管理员配置的 5 道团队题，不再复制题目。
    const team: TeamConfig = { id: teamId, name, owner: this.user._id, inviteCode: newInviteCode(teamId, teams), members: [this.user._id], pids: teamPidsOf(config) };
    await persistTeams(domainId, tid, config, [...teams, team]);
    this.response.redirect = this.url('hybrid_dashboard', { tid });
  }
}

class HybridTeamJoinHandler extends Handler {
  @param('tid', Types.ObjectId)
  @param('invite', Types.Content)
  async post(domainId: string, tid: ObjectId, invite: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!teamMutationOpen(tdoc)) throw new ValidationError('Team changes close 5 minutes before the contest starts.');
    const config = configOf(tdoc);
    if (teamOf(config, this.user._id)) throw new ValidationError('You are already in a team.');
    const team = currentTeams(config).find((item: any) => item.inviteCode === String(invite || '').trim());
    if (!team) throw new ValidationError('invite');
    if (team.members.length >= TEAM_MAX_MEMBERS) throw new ValidationError('Team is full.');
    team.members = [...team.members, this.user._id];
    await persistTeams(domainId, tid, config, currentTeams(config).map((item) => item.id === team.id ? team : item));
    this.response.redirect = this.url('hybrid_dashboard', { tid });
  }
}

class HybridTeamRenameHandler extends Handler {
  @param('tid', Types.ObjectId)
  @param('name', Types.Content)
  async post(domainId: string, tid: ObjectId, name: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!teamMutationOpen(tdoc)) throw new ValidationError('Team changes close 5 minutes before the contest starts.');
    const config = configOf(tdoc);
    const team = teamOf(config, this.user._id);
    name = String(name || '').trim();
    if (!team || team.members[0] !== this.user._id || !name || name.length > 32) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const teams = currentTeams(config).map((item) => item.id === team.id ? { ...item, name } : item);
    await persistTeams(domainId, tid, config, teams);
    this.response.redirect = this.url('hybrid_dashboard', { tid });
  }
}

class HybridTeamLeaveHandler extends Handler {
  @param('tid', Types.ObjectId)
  async post(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!teamMutationOpen(tdoc)) throw new ValidationError('Team changes close 5 minutes before the contest starts.');
    const config = configOf(tdoc);
    const team = teamOf(config, this.user._id);
    if (!team) throw new ValidationError('You are not in a team.');
    const members = team.members.filter((uid) => uid !== this.user._id);
    const teams = currentTeams(config).map((item) => item.id === team.id ? { ...item, members, owner: (item as any).owner === this.user._id ? members[0] : (item as any).owner } : item).filter((item) => item.members.length);
    await persistTeams(domainId, tid, config, teams);
    this.response.redirect = this.url('hybrid_dashboard', { tid });
  }
}

class HybridTeamKickHandler extends Handler {
  @param('tid', Types.ObjectId)
  @param('uid', Types.Int)
  async post(domainId: string, tid: ObjectId, uid: number) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!teamMutationOpen(tdoc)) throw new ValidationError('Team changes close 5 minutes before the contest starts.');
    const config = configOf(tdoc);
    const team = teamOf(config, this.user._id);
    if (!team || team.members[0] !== this.user._id || !team.members.includes(uid) || uid === this.user._id) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const teams = currentTeams(config).map((item) => item.id === team.id ? { ...item, members: item.members.filter((id) => id !== uid) } : item);
    await persistTeams(domainId, tid, config, teams);
    this.response.redirect = this.url('hybrid_dashboard', { tid });
  }
}

class HybridLockHandler extends Handler {
  @param('tid', Types.ObjectId)
  async post(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    if (!isRegistered(tsdoc) || !ContestModel.isOngoing(tdoc, tsdoc)) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    if (!teamOf(configOf(tdoc), this.user._id)) throw new ValidationError('Join a team before locking your personal problem.');
    if (isLocked(tsdoc)) throw new ValidationError('already_locked');
    await ContestModel.setStatus(domainId, tid, this.user._id, { 'hybridLockHack.lockedAt': new Date() });
    this.response.redirect = this.url('hybrid_dashboard', { tid });
  }
}

class HybridManageHandler extends Handler {
  @param('tid', Types.ObjectId)
  async get(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!isContestAdmin(this, tdoc)) throw new PermissionError(PERM.PERM_EDIT_CONTEST);
    this.response.template = 'hybrid_manage.html';
    const configured = !!(tdoc as any).hybridLockHack;
    const config = configured ? configOf(tdoc) : { personalPid: 0, teamPids: [], teams: [] } as HybridConfig;
    const teams = currentTeams(config);
    const teamScores = configured ? await allTeamScores(domainId, tid, config) : [];
    const hackEvents = await db.collection(HACK_COLLECTION).find({ domainId, tid }).sort({ createdAt: -1 }).limit(200).toArray();
    // 展示配置时把数字 docId 还原为题目编号（如 C1000），管理员看到/填写的都是编号。
    let personalLabel: any = '';
    let teamLabels: any[] = [];
    if (configured) {
      personalLabel = config.personalPid ? await pidLabel(domainId, config.personalPid) : '';
      teamLabels = await Promise.all(teamPidsOf(config).map((pid) => pidLabel(domainId, pid)));
    }
    // 语言列表（供正解配置选择）。
    const langs = Object.entries(SettingModel.langs).map(([id, cfg]: [string, any]) => ({ id, display: cfg.display || id }));
    this.response.body = {
      tdoc,
      configured,
      configJson: JSON.stringify({
        personalPid: personalLabel,
        teamPids: teamLabels,
      }, null, 2),
      teams,
      teamScores,
      hackEvents,
      teamMutationOpen: teamMutationOpen(tdoc),
      solutions: (config.solutions || []).map((solution) => ({ slot: solution.slot, lang: solution.lang, code: solution.code })),
      solutionBySlot: Array.from({ length: TEAM_PROBLEM_COUNT }, (_, i) => {
        const solution = (config.solutions || []).find((item) => item.slot === i);
        return solution ? { lang: solution.lang, code: solution.code } : { lang: '', code: '' };
      }),
      langs,
      teamProblemCount: TEAM_PROBLEM_COUNT,
    };
  }

  @param('tid', Types.ObjectId)
  @param('config', Types.Content)
  @param('solutions', Types.Content, true)
  async post(domainId: string, tid: ObjectId, raw: string, solutionsRaw?: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!isContestAdmin(this, tdoc)) throw new PermissionError(PERM.PERM_EDIT_CONTEST);
    if (tdoc.beginAt <= new Date()) throw new ValidationError('The hybrid configuration is immutable after the contest begins.');
    let config: HybridConfig;
    try { config = JSON.parse(raw); } catch { throw new ValidationError('config'); }
    const existing = (tdoc as any).hybridLockHack ? configOf(tdoc) : { personalPid: 0, teamPids: [], teams: [] } as HybridConfig;
    // 规范化：支持填写题目编号（如 C1000）或数字序号，统一解析为数字 docId；既有队伍统一改用新的团队题池。
    config.personalPid = await resolvePid(domainId, config.personalPid);
    config.teamPids = await Promise.all((Array.isArray(config.teamPids) ? config.teamPids : [])
      .map((item) => resolvePid(domainId, item)));
    config.teams = (existing.teams || []).map((team) => ({ ...team, pids: teamPidsOf(config) }));
    // 解析正解配置（JSON 数组：[{slot, lang, code}, ...]）。
    if (solutionsRaw) {
      let parsed: any[];
      try { parsed = JSON.parse(solutionsRaw); } catch { throw new ValidationError('solutions'); }
      config.solutions = (Array.isArray(parsed) ? parsed : []).map((item: any) => ({
        slot: Number(item.slot),
        lang: String(item.lang || '').trim(),
        code: String(item.code || ''),
      })).filter((item: SolutionConfig) => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < TEAM_PROBLEM_COUNT && item.lang && item.code);
    }
    validateConfig(config);
    const pids = allPids(config);
    // 校验题目确实存在，避免把无效 pid 写进比赛（否则题目页会报 Contest not found）。
    for (const pid of pids) {
      const pdoc = await ProblemModel.get(domainId, pid);
      if (!pdoc) throw new ValidationError(`pids:${pid}`);
    }
    await DocumentModel.set(domainId, DocumentModel.TYPE_CONTEST, tid, { hybridLockHack: config } as any);
    // 重写 tdoc.pids：顺带清除历史版本写入的字符串 pid 等脏数据。
    await ContestModel.edit(domainId, tid, {
      pids,
      duration: DURATION_HOURS,
      endAt: new Date(tdoc.beginAt.getTime() + DURATION_HOURS * 3600 * 1000),
      score: Object.fromEntries(pids.map((pid) => [pid, SCORE_PER_PROBLEM])),
    } as any);
    this.response.redirect = this.url('hybrid_manage', { tid });
  }
}

class HybridManageInviteHandler extends Handler {
  @param('tid', Types.ObjectId)
  @param('teamId', Types.String)
  @param('invite', Types.String)
  async post(domainId: string, tid: ObjectId, teamId: string, invite: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!isContestAdmin(this, tdoc)) throw new PermissionError(PERM.PERM_EDIT_CONTEST);
    if (!teamMutationOpen(tdoc)) throw new ValidationError('Team changes close 5 minutes before the contest starts.');
    if (!/^\d{3}[A-Za-z]{6}$/.test(invite)) throw new ValidationError('invite');
    const config = configOf(tdoc);
    const teams = currentTeams(config);
    if (teams.some((team) => team.id !== teamId && team.inviteCode === invite)) throw new ValidationError('invite already used');
    const target = teams.find((team) => team.id === teamId);
    if (!target) throw new ValidationError('teamId');
    target.inviteCode = invite;
    await persistTeams(domainId, tid, config, teams);
    this.response.redirect = this.url('hybrid_manage', { tid });
  }
}

class HybridRoomHandler extends Handler {
  @param('tid', Types.ObjectId)
  async get(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const config = configOf(tdoc);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    const team = teamOf(config, this.user._id);
    if (!isRegistered(tsdoc) || !team || !isLocked(tsdoc)) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const messages = await db.collection(ROOM_COLLECTION).find({ domainId, tid, teamId: team.id }).sort({ createdAt: -1 }).limit(100).toArray();
    this.response.template = 'hybrid_room.html';
    this.response.body = { tdoc, team, messages: messages.reverse() };
  }

  @param('tid', Types.ObjectId)
  @param('content', Types.String)
  async post(domainId: string, tid: ObjectId, content: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const config = configOf(tdoc);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    const team = teamOf(config, this.user._id);
    content = (content || '').trim();
    if (!isRegistered(tsdoc) || !team || !isLocked(tsdoc) || !content || content.length > 2000) throw new ValidationError('content');
    await db.collection(ROOM_COLLECTION).insertOne({ domainId, tid, teamId: team.id, uid: this.user._id, uname: this.user.uname, content, createdAt: new Date() });
    this.response.redirect = this.url('hybrid_room', { tid });
  }
}

class HybridHackListHandler extends Handler {
  @param('tid', Types.ObjectId)
  @param('slot', Types.Int)
  async get(domainId: string, tid: ObjectId, slot: number) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const config = configOf(tdoc);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    const team = teamOf(config, this.user._id);
    if (!isRegistered(tsdoc) || !team || !isLocked(tsdoc) || slot < 0 || slot >= TEAM_PROBLEM_COUNT) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const candidates = [] as any[];
    for (const targetTeam of currentTeams(config)) {
      if (targetTeam.id === team.id) continue;
      const target = await latestAccepted(domainId, tid, [Number(targetTeam.pids[slot])], targetTeam.members);
      const targetState = await slotScore(domainId, tid, targetTeam, slot);
      if (target && targetState.base > 0) candidates.push({ team: targetTeam, rid: target._id, pid: target.pid, score: targetState.score });
    }
    const quota = 1 + Math.max(0, ...await Promise.all(currentTeams(config).filter((item) => item.id !== team.id)
      .map((item) => opponentSubmitCount(domainId, tid, item, slot))));
    const myHacks = await db.collection<HackEvent>(HACK_COLLECTION).find({ domainId, tid, hackerUid: this.user._id, slot }).sort({ createdAt: -1 }).limit(50).toArray();
    this.response.template = 'hybrid_hack_list.html';
    this.response.body = { tdoc, team, slot, candidates, quota, used: await outgoingCost(domainId, tid, this.user._id, slot), myHacks };
  }
}

function patchCoreHandlers(ctx: Context) {
  // 这些深层模块路径在 Hydro 5.0.4 中存在。插件启动时断言其接口，升级 Hydro 后会尽早失败而非静默放行。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const problems = require('hydrooj/src/handler/problem');
  const detailPrepare = problems.ProblemDetailHandler.prototype._prepare;
  problems.ProblemDetailHandler.prototype._prepare = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = handlerDomainId(this);
    const pid = this.args.pid;
    const rawTid = handlerTid(this);
    const tid = rawTid ? objectId(rawTid) : undefined;
    if (tid) {
      const tdoc = await ContestModel.get(domainId, tid);
      if (isHybrid(tdoc)) {
        this.tdoc = tdoc;
        this.tsdoc = await attendeeStatus(domainId, tid, this.user._id);
      }
      if (isHybrid(tdoc) && !isContestAdmin(this, tdoc)) {
        const config = configOf(tdoc);
        const tsdoc = this.tsdoc;
        const query = this.request.query || {};
        const isHackProbe = this.request.path.includes('/hack/') && query.hybridHack === '1';
        // 路由里的 pid 可能是数字 docId（/p/1）或字符串题目编号（/p/C1000）。
        // 配置里存的是数字 docId，必须先解析成 docId 再比较，否则访问 /p/C1000
        // 时字符串编号永远匹配不上，导致无权限看题 / 交题。
        const pidDoc = await ProblemModel.get(domainId, pid, ['docId'] as any).catch(() => null);
        // 题目不存在时交给核心 _prepare 抛 ProblemNotFoundError，而不是在这里误报无权限。
        if (pidDoc && !checkVisible(config, this.user._id, Number(pidDoc.docId), isLocked(tsdoc)) && !isHackProbe) {
          throw new PermissionError(PERM.PERM_VIEW_PROBLEM);
        }
      }
    }
    return await detailPrepare.call(this, { ...rawArgs, domainId, pid: String(pid), ...(tid ? { tid } : {}) });
  };

  const submitPrepare = problems.ProblemSubmitHandler.prototype.prepare;
  problems.ProblemSubmitHandler.prototype.prepare = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = handlerDomainId(this);
    const rawTid = handlerTid(this);
    const tid = rawTid ? objectId(rawTid) : undefined;
    if (tid && isHybrid(this.tdoc)) await assertCanSubmit(domainId, tid, this.user._id, this.pdoc.docId);
    return await submitPrepare.call(this, { ...rawArgs, domainId, ...(tid ? { tid } : {}) });
  };

  const hackPrepare = problems.ProblemHackHandler.prototype.prepare;
  problems.ProblemHackHandler.prototype.prepare = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = handlerDomainId(this);
    const rid = objectId(this.args.rid || this.request?.query?.rid);
    const rawTid = handlerTid(this);
    const tid = rawTid ? objectId(rawTid) : undefined;
    if (!tid || !isHybrid(this.tdoc)) return await hackPrepare.call(this, { ...rawArgs, ...(tid ? { tid } : {}) });
    if ((this.request.query || {}).hybridHack !== '1') throw new HackFailedError('Use the hybrid contest hack panel.');
    const check = await assertCanHack(this, domainId, tid, rid);
    this.hybridHackCheck = check;
    this.rdoc = check.target;
  };

  const hackPost = problems.ProblemHackHandler.prototype.post;
  problems.ProblemHackHandler.prototype.post = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = handlerDomainId(this);
    const input = rawArgs.input || '';
    const autoOrganizeInput = !!rawArgs.autoOrganizeInput;
    const rawTid = handlerTid(this);
    const tid = rawTid ? objectId(rawTid) : undefined;
    if (!tid || !isHybrid(this.tdoc)) return await hackPost.call(this, { ...rawArgs, ...(tid ? { tid } : {}) });
    const check = await assertCanHack(this, domainId, tid, this.rdoc._id);
    let hackInput = input.trim();
    if (!hackInput) throw new ValidationError('input');
    if (autoOrganizeInput) hackInput = hackInput.replace(/\s+\n/g, '\n').replace(/\s+ /g, ' ');
    await this.limitRate('add_record', 60, 10, '{{user}}');
    // 保存 hack 输入。
    const key = `${this.user._id}/${nanoid()}`;
    await StorageModel.put(`submission/${key}`, Buffer.from(hackInput), this.user._id);
    const solution = solutionOf(check.config, check.slot);
    // 正解评测：用管理员 uid 提交，避免正解代码泄露给 hack 方。
    const solRid = await RecordModel.add(domainId, this.pdoc.docId, this.tdoc.owner, solution!.lang, solution!.code, true, {
      type: 'pretest',
      input: [hackInput],
    });
    // 被 hack 代码评测：用 hack 方 uid 提交（被 hack 代码本就是对方最新 AC 提交）。
    const victimRid = await RecordModel.add(domainId, this.pdoc.docId, this.user._id, this.rdoc.lang, this.rdoc.code, true, {
      type: 'pretest',
      input: [hackInput],
    });
    await db.collection<HackEvent>(HACK_COLLECTION).insertOne({
      domainId,
      tid,
      rid: solRid,
      solRid,
      victimRid,
      hackInputKey: key,
      hackerUid: this.user._id,
      attackerTeamId: check.ownTeam.id,
      targetTeamId: check.targetTeam.id,
      slot: check.slot,
      targetRid: this.rdoc._id,
      createdAt: new Date(),
      result: 'pending',
      extraCost: 0,
      shortagePenalty: 0,
    });
    this.response.body = { rid: solRid };
    this.response.redirect = this.url('hybrid_hack_list', { tid, slot: check.slot });
  };

  const problemListGet = require('hydrooj/src/handler/contest').ContestProblemListHandler.prototype.get;
  require('hydrooj/src/handler/contest').ContestProblemListHandler.prototype.get = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = handlerDomainId(this);
    const rawTid = handlerTid(this);
    const tid = rawTid ? objectId(rawTid) : undefined;
    if (tid) {
      const tdoc = await ContestModel.get(domainId, tid);
      if (isHybrid(tdoc)) {
        this.tdoc = tdoc;
        this.tsdoc = await attendeeStatus(domainId, tid, this.user._id);
      }
    }
    await problemListGet.call(this, { ...rawArgs, domainId, tid });
    if (!isHybrid(this.tdoc) || isContestAdmin(this, this.tdoc)) return;
    const config = configOf(this.tdoc);
    const visible = (this.tdoc.pids || []).filter((pid: any) => checkVisible(config, this.user._id, pid, isLocked(this.tsdoc)));
    const visibleStr = visible.map(String);
    this.response.body.tdoc = { ...this.tdoc, pids: visible };
    this.response.body.pdict = Object.fromEntries(Object.entries(this.response.body.pdict || {}).filter(([pid]) => visibleStr.includes(String(pid))));
    this.response.body.psdict = Object.fromEntries(Object.entries(this.response.body.psdict || {}).filter(([pid]) => visibleStr.includes(String(pid))));
  };
}

export function apply(ctx: Context) {
  const base = ContestModel.RULES.oi;
  ContestModel.RULES[RULE] = ContestModel.buildContestRule({
    TEXT: 'Hybrid',
    check: () => {},
    // 常规个人榜不会泄露其它队伍的记录；本插件提供独立的 team leaderboard。
    showScoreboard: () => true,
    showSelfRecord: () => true,
    showRecord: () => false,
    async scoreboard(config: any, _, tdoc: any) {
      const scores = await allTeamScores(tdoc.domainId, tdoc.docId, configOf(tdoc));
      const teamHeaders = Array.from({ length: TEAM_PROBLEM_COUNT }, (_, i) => ({ type: 'string', value: `团队${i + 1}` }));
      const rows = [[
        { type: 'string', value: '排名' },
        { type: 'string', value: '队伍' },
        { type: 'string', value: '个人题' },
        ...teamHeaders,
        { type: 'string', value: '团队总分' },
        { type: 'string', value: '总分' },
      ], ...scores.map((score, index) => [
        { type: 'rank', value: String(index + 1) },
        { type: 'string', value: score.name },
        { type: 'string', value: String(score.personalTotal) },
        ...score.slots.map((slot: any) => ({ type: 'string', value: String(slot.score) })),
        { type: 'string', value: String(score.teamTotal) },
        { type: 'string', value: String(score.total) },
      ])];
      return [rows, {}];
    },
    stat(tdoc: any, journal: any[]) {
      return base.stat.call(base, tdoc, journal) as any;
    },
    applyProjection(tdoc: any, rdoc: any, user: any) {
      // 比赛进行中，提交者本人仍可查看自己记录的状态、分数和测试点结果。
      if (rdoc?.uid === user?._id) return rdoc;
      return base.applyProjection.call(base, tdoc, rdoc, user);
    },
  } as any, base);

  patchCoreHandlers(ctx);
  ctx.Route('hybrid_dashboard', '/contest/:tid/hybrid', HybridDashboardHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_lock', '/contest/:tid/hybrid/lock', HybridLockHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_team_create', '/contest/:tid/hybrid/team/create', HybridTeamCreateHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_team_join', '/contest/:tid/hybrid/team/join', HybridTeamJoinHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_team_rename', '/contest/:tid/hybrid/team/rename', HybridTeamRenameHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_team_leave', '/contest/:tid/hybrid/team/leave', HybridTeamLeaveHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_team_kick', '/contest/:tid/hybrid/team/kick', HybridTeamKickHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_manage', '/contest/:tid/hybrid/manage', HybridManageHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_manage_invite', '/contest/:tid/hybrid/manage/invite', HybridManageInviteHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_room', '/contest/:tid/hybrid/room', HybridRoomHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_hack_list', '/contest/:tid/hybrid/hack/:slot', HybridHackListHandler, PERM.PERM_VIEW_CONTEST);

  // pretest 评测（正解/被 hack 代码）完成时走 record/change 而非 record/judge，
  // 因为 pretest 记录的 contest 是 RECORD_PRETEST，postJudge 会直接 return。
  ctx.on('record/change', async (rdoc: any, $set: any, $push: any, body: any) => {
    if (!body || body.key !== 'end') return;
    await onHackPretestDone(rdoc.domainId, rdoc._id);
  });
}
