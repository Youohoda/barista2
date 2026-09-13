import mongoose from 'mongoose';
import { db, Project, Chat, WorkspaceFile, Memory, json, body } from './_lib.js';
import { requireUser } from './auth.js';
import { detectProject } from './_project-detect.js';

// Every query below filters by {_id, ownerId} together — a project id alone is
// never enough to read or touch it, so one user can never reach another's project,
// files, chats, or memory even if they somehow learned the raw id.
export default async function handler(req, res) {
  try {
    const actor = await requireUser(req);
    await db();

    if (req.method === 'GET') {
      // Default view hides archived projects (they're not deleted, just parked out of
      // the switcher); pass ?archived=true to see only archived ones, ?archived=all for everything.
      const archivedParam = req.query?.archived;
      const filter = { ownerId: actor.id };
      if (archivedParam === 'true') filter.archived = true;
      else if (archivedParam !== 'all') filter.archived = { $ne: true };
      const projects = await Project.find(filter).sort({ updatedAt: -1 }).lean();
      const withCounts = await Promise.all(projects.map(async p => ({
        id: String(p._id), name: p.name, instructions: p.instructions, archived: !!p.archived,
        detected: p.detected || null,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
        chatCount: await Chat.countDocuments({ ownerId: actor.id, projectId: String(p._id) }),
        fileCount: await WorkspaceFile.countDocuments({ ownerId: actor.id, projectId: String(p._id) })
      })));
      return json(res, 200, { items: withCounts });
    }

    if (req.method === 'POST') {
      const b = await body(req);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return json(res, 400, { error: 'اسم المشروع مطلوب' });
      const instructions = String(b.instructions || '').trim().slice(0, 2000);
      const doc = await Project.create({ ownerId: actor.id, name, instructions });
      return json(res, 200, { id: String(doc._id), name: doc.name, instructions: doc.instructions, createdAt: doc.createdAt });
    }

    if (req.method === 'PATCH') {
      const id = req.query?.id;
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      const b = await body(req);

      // action=detect runs the Universal Project Detection Engine (api/_project-detect.js)
      // against this project's own uploaded files and stores the real result — it never
      // touches name/instructions/archived, so it's safe to call independently of a
      // normal edit. Ownership is still checked below via the same {_id, ownerId} filter
      // every other branch here uses, so this can't be pointed at another user's project.
      if (b.action === 'detect') {
        const owned = await Project.findOne({ _id: id, ownerId: actor.id }).lean();
        if (!owned) return json(res, 404, { error: 'المشروع غير موجود' });
        const files = await WorkspaceFile.find({ ownerId: actor.id, projectId: id }).select('name content').lean();
        const detected = detectProject(files);
        const doc = await Project.findOneAndUpdate(
          { _id: id, ownerId: actor.id },
          { detected, updatedAt: new Date() },
          { new: true }
        ).lean();
        return json(res, 200, { id: String(doc._id), detected: doc.detected, filesScanned: files.length });
      }

      const update = { updatedAt: new Date() };
      if (typeof b.name === 'string' && b.name.trim()) update.name = b.name.trim().slice(0, 80);
      if (typeof b.instructions === 'string') update.instructions = b.instructions.trim().slice(0, 2000);
      if (typeof b.archived === 'boolean') update.archived = b.archived;
      const doc = await Project.findOneAndUpdate({ _id: id, ownerId: actor.id }, update, { new: true }).lean();
      if (!doc) return json(res, 404, { error: 'المشروع غير موجود' });
      return json(res, 200, { id: String(doc._id), name: doc.name, instructions: doc.instructions, archived: !!doc.archived, detected: doc.detected || null });
    }

    // Deleting a project deletes its own chats/files/memory too — a project's data
    // is scoped to it (see brief: "لا تختلط بيانات Projects"), so nothing should be
    // left orphaned pointing at a projectId that no longer exists.
    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id || !mongoose.isValidObjectId(id)) return json(res, 400, { error: 'id غير صالح' });
      const owned = await Project.findOne({ _id: id, ownerId: actor.id }).lean();
      if (!owned) return json(res, 404, { error: 'المشروع غير موجود' });
      await Promise.all([
        Project.deleteOne({ _id: id, ownerId: actor.id }),
        Chat.deleteMany({ ownerId: actor.id, projectId: id }),
        WorkspaceFile.deleteMany({ ownerId: actor.id, projectId: id }),
        Memory.deleteMany({ ownerId: actor.id, projectId: id })
      ]);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في المشاريع' });
  }
}
