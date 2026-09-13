// POST /api/agent-run            — start a real autonomous engineering run on a project
// GET  /api/agent-run?projectId=  — list past runs for a project
// GET  /api/agent-run?id=         — get one run's full report
// POST /api/agent-run?id=&action=rollback — restore that run's pre-run checkpoint
//
// This is the thin production wiring around api/_agent-engine.js: it is the ONLY
// place in the codebase that connects the (DB-free, framework-free) orchestration
// engine to Mongo, to the real model (providerChat), and to whichever
// SandboxProvider is actually configured (NOT_CONFIGURED by default — see
// api/providers/sandbox.js). The engine itself has no idea Mongo exists.
import mongoose from 'mongoose';
import { db, WorkspaceFile, AgentRun, json, body, providerChat, canAccessProject } from './_lib.js';
import { requireUser } from './auth.js';
import { runAgentLoop, rollbackToCheckpoint, makeDefaultPlanner, makeDefaultFixer } from './_agent-engine.js';
import { getSandboxProvider } from './providers/sandbox.js';

// Adapter over WorkspaceFile — the same collection the chat tools in _tools.js
// already read/write, scoped to {ownerId, projectId} exactly like every other query
// in this codebase, so an agent run can never touch another user's or another
// project's files even though the engine itself has no concept of ownership.
function mongoWorkspaceAdapter(ownerId, projectId) {
  return {
    async listFiles() {
      return WorkspaceFile.find({ ownerId, projectId }).select('name').lean();
    },
    async readFile(name) {
      const f = await WorkspaceFile.findOne({ ownerId, projectId, name }).lean();
      return f ? f.content : null;
    },
    async writeFile(name, content) {
      const prev = await WorkspaceFile.findOne({ ownerId, projectId, name }).lean();
      await WorkspaceFile.findOneAndUpdate(
        { ownerId, projectId, name },
        { ownerId, projectId, name, mime: prev?.mime || 'text/plain', content, size: content.length, createdAt: prev?.createdAt || new Date() },
        { upsert: true }
      );
    },
    async deleteFile(name) {
      const res = await WorkspaceFile.findOneAndDelete({ ownerId, projectId, name }).lean();
      return !!res;
    }
  };
}

async function startRun(actor, projectId, goal) {
  const access = await canAccessProject(actor, projectId, 'editor'); // running the agent modifies files — editor+ only
  if (!access.ok) throw Object.assign(new Error('مالكش صلاحية تشغيل الـ Agent على المشروع ده'), { status: 403 });

  const adapter = mongoWorkspaceAdapter(actor.id, projectId);
  const sandboxProvider = getSandboxProvider();
  const planner = makeDefaultPlanner(providerChat);
  const fixer = makeDefaultFixer(providerChat);

  // AgentRun doc is created up front (status QUEUED) and updated as REAL events
  // arrive from onEvent — never written once at the end pretending to be a live
  // trace. If the process dies mid-run, the doc reflects exactly how far it got.
  const runDoc = await AgentRun.create({ ownerId: actor.id, projectId, goal, status: 'QUEUED' });

  const { report, checkpoint } = await runAgentLoop({
    goal, adapter, sandboxProvider, planner, fixer,
    onEvent: (evt) => {
      runDoc.transitions.push({ state: evt.state, at: evt.at, detail: evt });
      if (['QUEUED', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'FIXING', 'REVIEWING', 'COMPLETED', 'FAILED'].includes(evt.state)) {
        runDoc.status = evt.state;
      }
    }
  });

  runDoc.plan = report.plan;
  runDoc.diffs = report.diffs;
  runDoc.attempts = report.attempts;
  runDoc.testResult = report.testResult;
  runDoc.securityFindings = report.securityFindings;
  runDoc.error = report.error;
  runDoc.status = report.status;
  runDoc.checkpointId = checkpoint.id;
  runDoc.checkpointFiles = checkpoint.files;
  runDoc.completedAt = new Date();
  await runDoc.save();

  return runDoc;
}

export default async function handler(req, res) {
  try {
    const actor = await requireUser(req);
    await db();

    if (req.method === 'POST') {
      const id = req.query?.id;
      const b = await body(req);

      if (id && b.action === 'rollback') {
        if (!mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
        const run = await AgentRun.findOne({ _id: id, ownerId: actor.id }).lean();
        if (!run) return json(res, 404, { error: 'الـ run غير موجود' });
        const access = await canAccessProject(actor, run.projectId, 'editor');
        if (!access.ok) return json(res, 403, { error: 'مالكش صلاحية' });
        const adapter = mongoWorkspaceAdapter(actor.id, run.projectId);
        const result = await rollbackToCheckpoint(adapter, { files: run.checkpointFiles });
        return json(res, 200, { ok: true, ...result });
      }

      const projectId = String(b.projectId || '');
      const goal = String(b.goal || '').trim().slice(0, 2000);
      if (!projectId || !mongoose.isValidObjectId(projectId)) return json(res, 400, { error: 'projectId صالح مطلوب' });
      if (!goal) return json(res, 400, { error: 'اكتب هدف الـ Agent (مثلاً: \"Fix the login bug\")' });

      const runDoc = await startRun(actor, projectId, goal);
      return json(res, 200, {
        id: String(runDoc._id), status: runDoc.status, plan: runDoc.plan, diffs: runDoc.diffs,
        attempts: runDoc.attempts, testResult: runDoc.testResult, securityFindings: runDoc.securityFindings,
        error: runDoc.error, transitions: runDoc.transitions
      });
    }

    if (req.method === 'GET') {
      const id = req.query?.id;
      if (id) {
        if (!mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
        const run = await AgentRun.findOne({ _id: id, ownerId: actor.id }).lean();
        if (!run) return json(res, 404, { error: 'الـ run غير موجود' });
        return json(res, 200, run);
      }
      const projectId = req.query?.projectId ? String(req.query.projectId) : null;
      const filter = { ownerId: actor.id };
      if (projectId) filter.projectId = projectId;
      const runs = await AgentRun.find(filter).select('-checkpointFiles').sort({ startedAt: -1 }).limit(50).lean();
      return json(res, 200, { items: runs });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'تعذر تشغيل الـ Agent' });
  }
}
