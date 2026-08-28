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
  PRIV,
  ProblemModel,
  RecordModel,
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
 * 此插件刻意把每支队伍的 5 道团队题配置为独立题目副本。这样成功 Hack 时，
 * 只会把数据加入被 Hack 队伍的副本并重测其提交，不会污染其他队伍的数据。
 */
const RULE = 'hybrid_lock_hack';
const HACK_COLLECTION = 'hybrid_lock_hack.event';
const ROOM_COLLECTION = 'hybrid_lock_hack.room';
const DURATION_HOURS = 3;
const TEAM_PROBLEM_COUNT = 5;
const SCORE_PER_PROBLEM = 100;

type TeamConfig = {
  id: string;
  name: string;
  members: number[];
  /** 每队 5 个题目副本，slot 0..4 一一对应。 */
  pids: number[];
};

type HybridConfig = {
  /** uid -> 个人题 pid。允许多人指向同一个个人题 pid。 */
  personal: Record<string, number>;
  teams: TeamConfig[];
};

type HackEvent = {
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
  result: 'pending' | 'success' | 'failure';
  /** 错误 Hack 的额外次数消耗：有余量时为 1，否则为 0。 */
  extraCost: number;
  /** 错误 Hack 的额外扣分：次数不足时为 5，否则为 0。 */
  shortagePenalty: number;
};

function isHybrid(tdoc: any) {
  return tdoc?.rule === RULE;
}

function configOf(tdoc: any): HybridConfig {
  const config = tdoc?.hybridLockHack;
  if (!config || typeof config !== 'object') throw new ValidationError('hybridLockHack');
  return config as HybridConfig;
}

function allPids(config: HybridConfig) {
  return Array.from(new Set([
    ...Object.values(config.personal).map(Number),
    ...config.teams.flatMap((team) => team.pids.map(Number)),
  ]));
}

function teamOf(config: HybridConfig, uid: number) {
  return config.teams.find((team) => team.members.includes(uid)) || null;
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

function personalPid(config: HybridConfig, uid: number) {
  return Number(config.personal[String(uid)] || 0);
}

function slotOf(team: TeamConfig | null, pid: number) {
  return team ? team.pids.findIndex((item) => Number(item) === Number(pid)) : -1;
}

function ownTeamProblem(config: HybridConfig, uid: number, pid: number) {
  return slotOf(teamOf(config, uid), pid) >= 0;
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

function validateConfig(config: HybridConfig) {
  if (!config || typeof config !== 'object' || !config.personal || !Array.isArray(config.teams)) {
    throw new ValidationError('hybridLockHack');
  }
  const memberSeen = new Set<number>();
  const pids = new Set<number>();
  for (const [uid, pid] of Object.entries(config.personal)) {
    if (!Number.isSafeInteger(+uid) || !Number.isSafeInteger(+pid) || +pid <= 0) throw new ValidationError('personal');
    pids.add(+pid);
  }
  for (const team of config.teams) {
    if (!team || !/^[A-Za-z0-9_-]{1,32}$/.test(team.id || '') || !team.name
      || !Array.isArray(team.members) || !Array.isArray(team.pids) || team.pids.length !== TEAM_PROBLEM_COUNT) {
      throw new ValidationError('teams');
    }
    for (const uid of team.members) {
      if (!Number.isSafeInteger(uid) || memberSeen.has(uid) || !personalPid(config, uid)) throw new ValidationError('teams.members');
      memberSeen.add(uid);
    }
    for (const pid of team.pids) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pids.has(pid)) throw new ValidationError('teams.pids');
      pids.add(pid);
    }
  }
  if (!config.teams.length || !memberSeen.size) throw new ValidationError('teams');
}

async function getContestOrThrow(domainId: string, tid: ObjectId) {
  const tdoc = await ContestModel.get(domainId, tid);
  if (!isHybrid(tdoc)) throw new ValidationError('rule');
  return tdoc as any;
}

async function attendeeStatus(domainId: string, tid: ObjectId, uid: number) {
  return await ContestModel.getStatus(domainId, tid, uid) as any;
}

async function lockState(domainId: string, tid: ObjectId, uid: number) {
  return statusHybrid(await attendeeStatus(domainId, tid, uid));
}

function checkVisible(config: HybridConfig, uid: number, pid: number, locked: boolean) {
  if (personalPid(config, uid) === pid) return true;
  return locked && ownTeamProblem(config, uid, pid);
}

async function latestAccepted(domainId: string, tid: ObjectId, pids: number[], members: number[]) {
  return await RecordModel.getMulti(domainId, {
    contest: tid,
    pid: { $in: pids },
    uid: { $in: members },
    status: STATUS.STATUS_ACCEPTED,
    'files.hack': { $exists: false },
  }).sort({ _id: -1 }).limit(1).next();
}

async function personalScore(domainId: string, tid: ObjectId, uid: number, pid: number) {
  if (!pid) return 0;
  const records = await RecordModel.getMulti(domainId, {
    contest: tid, uid, pid, 'files.hack': { $exists: false },
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
  const scores = await Promise.all(config.teams.map((team) => teamScore(domainId, tid, config, team)));
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
  if (personalPid(config, uid) === pid) {
    if (state.lockedAt) throw new PermissionError(PERM.PERM_SUBMIT_PROBLEM);
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
  if (!ownStatus?.attend || !ownTeam || !isLocked(ownStatus)) throw new HackFailedError('Lock your personal problem before hacking.');

  const target = await RecordModel.get(domainId, targetRid);
  if (!target || !equalId(target.contest, tid) || target.status !== STATUS.STATUS_ACCEPTED || !isNormalRecord(target)) {
    throw new HackFailedError('Target must be the latest accepted contest submission.');
  }
  const targetTeam = teamOf(config, target.uid);
  if (!targetTeam || targetTeam.id === ownTeam.id) throw new HackFailedError('You cannot hack your own team.');
  const slot = slotOf(targetTeam, target.pid);
  if (slot < 0 || slotOf(ownTeam, that.pdoc.docId) !== slot) throw new HackFailedError('Target does not match this team-problem slot.');

  const latest = await latestAccepted(domainId, tid, [target.pid], targetTeam.members);
  if (!latest || !equalId(latest._id, targetRid)) throw new HackFailedError('Only the opponent\'s latest accepted code can be hacked.');
  const currentOwn = await slotScore(domainId, tid, ownTeam, slot);
  const currentTarget = await slotScore(domainId, tid, targetTeam, slot);
  if (currentOwn.base <= 0) throw new HackFailedError('Your team must currently pass this problem before hacking.');
  if (currentTarget.base <= 0) throw new HackFailedError('The target team must have a positive score on this problem.');

  const budget = 1 + await opponentSubmitCount(domainId, tid, targetTeam, slot);
  const used = await outgoingCost(domainId, tid, uid, slot);
  if (used >= budget) throw new HackFailedError(`Hack quota exhausted (${used}/${budget}).`);
  return { tdoc, config, ownTeam, targetTeam, target, slot, budget, used };
}

async function applySuccessfulHack(event: HackEvent) {
  const target = await RecordModel.get(event.domainId, event.targetRid);
  if (!target) throw new Error('hack target record no longer exists');
  const pdoc = await ProblemModel.get(event.domainId, target.pid, undefined, true) as any;
  if (!pdoc || typeof pdoc.config !== 'string') throw new Error('target problem config is not available');
  const config = yaml.load(pdoc.config) as any;
  if (!Array.isArray(config?.subtasks) || !config.subtasks.length) throw new Error('target problem must use subtasks');
  const input = await StorageModel.get(`submission/${(await RecordModel.get(event.domainId, event.rid) as any).files.hack.split('#')[0]}`);
  if (!input) throw new Error('hack input file is unavailable');
  const hackSubtask = config.subtasks.at(-1);
  hackSubtask.cases ||= [];
  const inputName = `hybrid-hack-${event.rid.toString()}-${hackSubtask.cases.length + 1}.in`;
  hackSubtask.cases.push({ input: inputName, output: '/dev/null' });
  await Promise.all([
    ProblemModel.addTestdata(event.domainId, target.pid, inputName, input),
    ProblemModel.addTestdata(event.domainId, target.pid, 'config.yaml', Buffer.from(yaml.dump(config))),
  ]);
  const accepted = await RecordModel.getMulti(event.domainId, {
    contest: event.tid,
    pid: target.pid,
    uid: { $in: (await getContestOrThrow(event.domainId, event.tid) as any).hybridLockHack.teams
      .find((team: TeamConfig) => team.id === event.targetTeamId).members },
    status: STATUS.STATUS_ACCEPTED,
    'files.hack': { $exists: false },
  }).project({ _id: 1 }).toArray();
  if (accepted.length) {
    const priority = await RecordModel.submissionPriority(event.hackerUid, -5000 - accepted.length * 5 - 50);
    await RecordModel.judge(event.domainId, accepted.map((record: any) => record._id), priority, {}, { hybridHackRejudge: inputName });
  }
}

class HybridDashboardHandler extends Handler {
  @param('tid', Types.ObjectId)
  async get(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const config = configOf(tdoc);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    if (!tsdoc?.attend) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const team = teamOf(config, this.user._id);
    if (!team && !isContestAdmin(this, tdoc)) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const lockedUsers = Object.fromEntries(await Promise.all((team?.members || []).map(async (uid) => [uid, isLocked(await attendeeStatus(domainId, tid, uid))])));
    this.response.template = 'hybrid_dashboard.html';
    this.response.body = {
      tdoc,
      config,
      team,
      tsdoc,
      locked: isLocked(tsdoc),
      lockedUsers,
      personalPid: personalPid(config, this.user._id),
      teamScores: await allTeamScores(domainId, tid, config),
      isAdmin: isContestAdmin(this, tdoc),
    };
  }
}

class HybridLockHandler extends Handler {
  @param('tid', Types.ObjectId)
  async post(domainId: string, tid: ObjectId) {
    const tdoc = await getContestOrThrow(domainId, tid);
    const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
    if (!tsdoc?.attend || !ContestModel.isOngoing(tdoc, tsdoc)) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
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
    this.response.body = { tdoc, configJson: JSON.stringify((tdoc as any).hybridLockHack || { personal: {}, teams: [] }, null, 2) };
  }

  @param('tid', Types.ObjectId)
  @param('config', Types.Content)
  async post(domainId: string, tid: ObjectId, raw: string) {
    const tdoc = await getContestOrThrow(domainId, tid);
    if (!isContestAdmin(this, tdoc)) throw new PermissionError(PERM.PERM_EDIT_CONTEST);
    if (tdoc.beginAt <= new Date()) throw new ValidationError('The hybrid configuration is immutable after the contest begins.');
    let config: HybridConfig;
    try { config = JSON.parse(raw); } catch { throw new ValidationError('config'); }
    validateConfig(config);
    const pids = allPids(config);
    await ContestModel.edit(domainId, tid, {
      pids,
      duration: DURATION_HOURS,
      endAt: new Date(tdoc.beginAt.getTime() + DURATION_HOURS * 3600 * 1000),
      score: Object.fromEntries(pids.map((pid) => [pid, SCORE_PER_PROBLEM])),
    } as any);
    await DocumentModel.set(domainId, DocumentModel.TYPE_CONTEST, tid, { hybridLockHack: config } as any);
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
    if (!tsdoc?.attend || !team || !isLocked(tsdoc)) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
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
    if (!tsdoc?.attend || !team || !isLocked(tsdoc) || !content || content.length > 2000) throw new ValidationError('content');
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
    if (!tsdoc?.attend || !team || !isLocked(tsdoc) || slot < 0 || slot >= TEAM_PROBLEM_COUNT) throw new PermissionError(PERM.PERM_VIEW_CONTEST);
    const candidates = [] as any[];
    for (const targetTeam of config.teams) {
      if (targetTeam.id === team.id) continue;
      const target = await latestAccepted(domainId, tid, [Number(targetTeam.pids[slot])], targetTeam.members);
      const targetState = await slotScore(domainId, tid, targetTeam, slot);
      if (target && targetState.base > 0) candidates.push({ team: targetTeam, rid: target._id, pid: target.pid, score: targetState.score });
    }
    const quota = 1 + Math.max(0, ...await Promise.all(config.teams.filter((item) => item.id !== team.id)
      .map((item) => opponentSubmitCount(domainId, tid, item, slot))));
    this.response.template = 'hybrid_hack_list.html';
    this.response.body = { tdoc, team, slot, candidates, quota, used: await outgoingCost(domainId, tid, this.user._id, slot) };
  }
}

function patchCoreHandlers(ctx: Context) {
  // 这些深层模块路径在 Hydro 5.0.4 中存在。插件启动时断言其接口，升级 Hydro 后会尽早失败而非静默放行。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const problems = require('hydrooj/src/handler/problem');
  const detailPrepare = problems.ProblemDetailHandler.prototype._prepare;
  problems.ProblemDetailHandler.prototype._prepare = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = this.args.domainId;
    const pid = this.args.pid;
    const tid = this.args.tid ? objectId(this.args.tid) : undefined;
    if (tid) {
      const tdoc = await ContestModel.get(domainId, tid);
      if (isHybrid(tdoc) && !isContestAdmin(this, tdoc)) {
        const config = configOf(tdoc);
        const tsdoc = await attendeeStatus(domainId, tid, this.user._id);
        const query = this.request.query || {};
        const isHackProbe = this.request.path.includes('/hack/') && query.hybridHack === '1';
        if (!checkVisible(config, this.user._id, Number(pid), isLocked(tsdoc)) && !isHackProbe) {
          throw new PermissionError(PERM.PERM_VIEW_PROBLEM);
        }
      }
    }
    return await detailPrepare.call(this, rawArgs);
  };

  const submitPrepare = problems.ProblemSubmitHandler.prototype.prepare;
  problems.ProblemSubmitHandler.prototype.prepare = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = this.args.domainId;
    const tid = this.args.tid ? objectId(this.args.tid) : undefined;
    if (tid && isHybrid(this.tdoc)) await assertCanSubmit(domainId, tid, this.user._id, this.pdoc.docId);
    return await submitPrepare.call(this, rawArgs);
  };

  const hackPrepare = problems.ProblemHackHandler.prototype.prepare;
  problems.ProblemHackHandler.prototype.prepare = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = this.args.domainId;
    const rid = objectId(this.args.rid);
    const tid = this.args.tid ? objectId(this.args.tid) : undefined;
    if (!tid || !isHybrid(this.tdoc)) return await hackPrepare.call(this, rawArgs);
    if ((this.request.query || {}).hybridHack !== '1') throw new HackFailedError('Use the hybrid contest hack panel.');
    const check = await assertCanHack(this, domainId, tid, rid);
    this.hybridHackCheck = check;
    this.rdoc = check.target;
  };

  const hackPost = problems.ProblemHackHandler.prototype.post;
  problems.ProblemHackHandler.prototype.post = async function (args: any) {
    const rawArgs = args && typeof args === 'object' ? args : this.args;
    const domainId = this.args.domainId;
    const input = rawArgs.input || '';
    const autoOrganizeInput = !!rawArgs.autoOrganizeInput;
    const tid = this.args.tid ? objectId(this.args.tid) : undefined;
    if (!tid || !isHybrid(this.tdoc)) return await hackPost.call(this, rawArgs);
    const check = await assertCanHack(this, domainId, tid, this.rdoc._id);
    let hackInput = input.trim();
    if (!hackInput) throw new ValidationError('input');
    if (autoOrganizeInput) hackInput = hackInput.replace(/\s+\n/g, '\n').replace(/\s+ /g, ' ');
    await this.limitRate('add_record', 60, 10, '{{user}}');
    const key = `${this.user._id}/${nanoid()}`;
    await StorageModel.put(`submission/${key}`, Buffer.from(hackInput), this.user._id);
    const rid = await RecordModel.add(domainId, this.pdoc.docId, this.user._id, this.rdoc.lang, this.rdoc.code, true, {
      contest: tid,
      type: 'hack',
      hackTarget: this.rdoc._id,
      files: { hack: `${key}#input.txt` },
    });
    await db.collection<HackEvent>(HACK_COLLECTION).insertOne({
      domainId,
      tid,
      rid,
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
    this.response.body = { rid };
    this.response.redirect = this.url('record_detail', { rid });
  };

  const problemListGet = require('hydrooj/src/handler/contest').ContestProblemListHandler.prototype.get;
  require('hydrooj/src/handler/contest').ContestProblemListHandler.prototype.get = async function (domainId: string, tid: ObjectId) {
    await problemListGet.call(this, domainId, tid);
    if (!isHybrid(this.tdoc) || isContestAdmin(this, this.tdoc)) return;
    const config = configOf(this.tdoc);
    const visible = this.tdoc.pids.filter((pid: number) => checkVisible(config, this.user._id, pid, isLocked(this.tsdoc)));
    this.response.body.tdoc = { ...this.tdoc, pids: visible };
    this.response.body.pdict = Object.fromEntries(Object.entries(this.response.body.pdict || {}).filter(([pid]) => visible.includes(+pid)));
    this.response.body.psdict = Object.fromEntries(Object.entries(this.response.body.psdict || {}).filter(([pid]) => visible.includes(+pid)));
  };
}

export function apply(ctx: Context) {
  const base = ContestModel.RULES.oi;
  ContestModel.RULES[RULE] = ContestModel.buildContestRule({
    TEXT: 'Hybrid Lock + Team Hack',
    check: () => {},
    // 常规个人榜不会泄露其它队伍的记录；本插件提供独立的 team leaderboard。
    showScoreboard: () => false,
    showSelfRecord: () => true,
    showRecord: () => false,
    stat(tdoc: any, journal: any[]) {
      return base.stat.call(base, tdoc, journal) as any;
    },
  } as any, base);

  patchCoreHandlers(ctx);
  ctx.Route('hybrid_dashboard', '/contest/:tid/hybrid', HybridDashboardHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_lock', '/contest/:tid/hybrid/lock', HybridLockHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_manage', '/contest/:tid/hybrid/manage', HybridManageHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_room', '/contest/:tid/hybrid/room', HybridRoomHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('hybrid_hack_list', '/contest/:tid/hybrid/hack/:slot', HybridHackListHandler, PERM.PERM_VIEW_CONTEST);

  ctx.on('record/judge', async (rdoc: any) => {
    const events = db.collection<HackEvent>(HACK_COLLECTION);
    const event = await events.findOne({ domainId: rdoc.domainId, rid: rdoc._id, result: 'pending' });
    if (!event) return;
    if (rdoc.status === STATUS.STATUS_HACK_SUCCESSFUL) {
      const claimed = await events.findOneAndUpdate({ _id: event._id, result: 'pending' }, { $set: { result: 'success', resolvedAt: new Date() } }, { returnDocument: 'after' });
      if (claimed) await applySuccessfulHack(claimed as HackEvent);
      return;
    }
    if (rdoc.status === STATUS.STATUS_HACK_UNSUCCESSFUL) {
      const currentBudget = 1 + await opponentSubmitCount(rdoc.domainId, event.tid,
        configOf(await getContestOrThrow(rdoc.domainId, event.tid)).teams.find((team) => team.id === event.targetTeamId)!, event.slot);
      const spentBefore = await outgoingCost(rdoc.domainId, event.tid, event.hackerUid, event.slot) - 1;
      const extraCost = spentBefore + 1 < currentBudget ? 1 : 0;
      const shortagePenalty = extraCost ? 0 : 5;
      await events.updateOne({ _id: event._id, result: 'pending' }, { $set: { result: 'failure', resolvedAt: new Date(), extraCost, shortagePenalty } });
    }
  });
}
