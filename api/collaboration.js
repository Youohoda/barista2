// Collaboration — real Members/Roles/Permissions/Activity log, no fake realtime.
// This is the part of the brief's "Collaboration" item buildable without a
// WebSocket/Pusher/Ably server: who can see/touch a project, and an audit trail of
// what happened to it. True live presence/sync needs a realtime provider — see
// api/providers/realtime.js, which is a real adapter interface, not wired to
// anything, so it never claims to be live when it isn't.
//
// IMPORTANT SCOPE NOTE (kept honest on purpose): adding a member here makes them
// show up with a role and lets them use THIS endpoint's own checks. It does NOT
// yet change api/chat.js, api/file-workspace.js, or api/memory.js, which still only
// check strict Project.ownerId === actor.id (pre-V28 behavior, unchanged so nothing
// that currently works breaks). Until those are migrated to canAccessProject(),
// a shared editor/viewer can see the project in listings and manage tasks, but
// cannot yet chat inside it or touch its files — that migration is listed as
// remaining work in the final report, not silently done.
import mongoose from 'mongoose';
import { db, Project, ProjectMember, ActivityLog, User, json, body, logActivity, canAccessProject, withLogging } from './_lib.js';
import { requireUser } from './auth.js';

async function handlerImpl(req, res) {
  try {
    const actor = await requireUser(req);
    req.ownerId = actor.id;
    await db();
    const projectId = req.query?.projectId ? String(req.query.projectId) : null;
    if (!projectId || !mongoose.isValidObjectId(projectId)) return json(res, 400, { error: 'projectId مطلوب' });

    if (req.method === 'GET') {
      const access = await canAccessProject(actor, projectId, 'viewer');
      if (!access.ok) return json(res, 404, { error: 'المشروع غير موجود أو مالكش وصول' });
      const [members, activity] = await Promise.all([
        ProjectMember.find({ projectId }).lean(),
        ActivityLog.find({ projectId }).sort({ createdAt: -1 }).limit(100).lean()
      ]);
      return json(res, 200, {
        role: access.role,
        members: members.map(m => ({ id: String(m._id), userId: m.userId, email: m.email, role: m.role, createdAt: m.createdAt })),
        activity: activity.map(a => ({ id: String(a._id), actorId: a.actorId, action: a.action, detail: a.detail, createdAt: a.createdAt }))
      });
    }

    if (req.method === 'POST') {
      // Only the real owner may add members — an editor/viewer role can never
      // escalate itself or invite others, by design.
      const project = await Project.findOne({ _id: projectId, ownerId: actor.id }).lean();
      if (!project) return json(res, 403, { error: 'بس مالك المشروع يقدر يضيف أعضاء' });
      const b = await body(req);
      const email = String(b.email || '').trim().toLowerCase();
      const role = ['editor', 'viewer'].includes(b.role) ? b.role : 'viewer';
      if (!email) return json(res, 400, { error: 'اكتب إيميل العضو' });
      // The member must already have a Barista account (clerkId resolved via email) —
      // no invite-by-email-to-a-stranger flow exists (would need an email provider,
      // which is a real infrastructure decision, not built silently here).
      const targetUser = await User.findOne({ email }).lean();
      if (!targetUser?.clerkId) return json(res, 404, { error: 'مفيش حساب Barista بالإيميل ده. لازم يكون عمل حساب أولًا.' });
      const member = await ProjectMember.findOneAndUpdate(
        { projectId, userId: targetUser.clerkId },
        { projectId, userId: targetUser.clerkId, email, role, invitedBy: actor.id },
        { upsert: true, new: true }
      );
      await logActivity(projectId, actor.id, 'member.added', `${email} (${role})`);
      return json(res, 200, { id: String(member._id), userId: member.userId, email: member.email, role: member.role });
    }

    if (req.method === 'PATCH') {
      const project = await Project.findOne({ _id: projectId, ownerId: actor.id }).lean();
      if (!project) return json(res, 403, { error: 'بس مالك المشروع يقدر يغيّر الأدوار' });
      const b = await body(req);
      const memberId = String(b.memberId || '');
      if (!memberId || !mongoose.isValidObjectId(memberId)) return json(res, 400, { error: 'memberId غير صالح' });
      const role = ['editor', 'viewer'].includes(b.role) ? b.role : null;
      if (!role) return json(res, 400, { error: 'role غير صالح' });
      const doc = await ProjectMember.findOneAndUpdate({ _id: memberId, projectId }, { role }, { new: true }).lean();
      if (!doc) return json(res, 404, { error: 'العضو غير موجود' });
      await logActivity(projectId, actor.id, 'member.role_changed', `${doc.email} → ${role}`);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      const project = await Project.findOne({ _id: projectId, ownerId: actor.id }).lean();
      if (!project) return json(res, 403, { error: 'بس مالك المشروع يقدر يشيل أعضاء' });
      const memberId = req.query?.memberId;
      if (!memberId || !mongoose.isValidObjectId(memberId)) return json(res, 400, { error: 'memberId غير صالح' });
      const doc = await ProjectMember.findOneAndDelete({ _id: memberId, projectId }).lean();
      if (!doc) return json(res, 404, { error: 'العضو غير موجود' });
      await logActivity(projectId, actor.id, 'member.removed', doc.email);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'خطأ في التعاون' });
  }
}

export default withLogging('/api/collaboration', handlerImpl);
