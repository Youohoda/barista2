// Modular Tool System — every tool Barista can call is defined once here: its
// OpenAI-format schema (for providerChat's `tools` param), which model modes are
// allowed to use it, and its execution handler. Adding a new tool means adding one
// entry to TOOLS below — nothing else in chat.js has to change. This is the
// "Barista Core → tools" architecture from the brief, sized to what this stack
// (Vercel serverless + Mongo, no execution sandbox) can actually run for real.
import { createPatch } from 'diff';
import { WorkspaceFile, webSearch, Task, logActivity } from './_lib.js';
import { computeStats } from './_data-analyst.js';

const MAX_WRITE_CHARS = 400_000;

export const TOOLS = {
  web_search: {
    modes: ['barista-just', 'barista-code', 'barista-reasoning'],
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'ابحث في الإنترنت عن معلومات حديثة، أخبار، أسعار، أو أي حقيقة ممكن تكون اتغيرت أو مش متأكد منها. استخدمه فقط لما الإجابة محتاجة فعلاً معلومة حالية.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'كلمات البحث بالظبط' } }, required: ['query'] }
      }
    },
    async run(actor, args, ctx) {
      const found = await webSearch(args.query || ctx.message, 5);
      ctx.sources.push(...found);
      return found.length ? found.map(f => `${f.title}\n${f.url}\n${f.snippet}`).join('\n\n') : 'لا نتائج.';
    }
  },

  list_project_files: {
    modes: ['barista-code'],
    schema: { type: 'function', function: { name: 'list_project_files', description: 'اعرض أسماء كل الملفات المرفوعة في الـ Workspace (أو المشروع الحالي لو محدد) بتاع المستخدم.', parameters: { type: 'object', properties: {} } } },
    async run(actor, args, ctx) {
      const files = await WorkspaceFile.find({ ownerId: actor.id, projectId: ctx.projectId || null }).select('name size').lean();
      return files.length ? files.map(f => `${f.name} (${f.size} حرف)`).join('\n') : 'مفيش ملفات مرفوعة في الـ Workspace.';
    }
  },

  read_project_file: {
    modes: ['barista-code'],
    schema: { type: 'function', function: { name: 'read_project_file', description: 'اقرأ محتوى ملف معين من الـ Workspace بالاسم بالظبط زي ما ظهر في list_project_files.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    async run(actor, args, ctx) {
      const f = await WorkspaceFile.findOne({ ownerId: actor.id, projectId: ctx.projectId || null, name: args.name }).lean();
      return f ? f.content.slice(0, 60000) : `الملف "${args.name}" مش موجود في الـ Workspace.`;
    }
  },

  search_project_files: {
    modes: ['barista-code'],
    schema: { type: 'function', function: { name: 'search_project_files', description: 'دوّر على نص معين جوه كل ملفات الـ Workspace الحالية (زي grep) عشان تلاقي فين موجود قبل ما تعدّل.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    async run(actor, args, ctx) {
      const q = String(args.query || '').toLowerCase();
      if (!q) return 'اكتب نص للبحث عنه.';
      const files = await WorkspaceFile.find({ ownerId: actor.id, projectId: ctx.projectId || null }).select('name content').lean();
      const hits = [];
      for (const f of files) {
        const idx = f.content.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        const lineNo = f.content.slice(0, idx).split('\n').length;
        hits.push(`${f.name}:${lineNo}: ...${f.content.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' ')}...`);
      }
      return hits.length ? hits.slice(0, 20).join('\n') : `مفيش نتائج لـ "${args.query}".`;
    }
  },

  write_project_file: {
    modes: ['barista-code'],
    schema: { type: 'function', function: { name: 'write_project_file', description: 'احفظ نسخة كاملة (جديدة أو معدّلة) من ملف في الـ Workspace. ابعت المحتوى الكامل للملف، مش diff يدوي — الـ diff بيتولّد تلقائيًا.', parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] } } },
    async run(actor, args, ctx) {
      const newContent = String(args.content || '').slice(0, MAX_WRITE_CHARS);
      const prev = await WorkspaceFile.findOne({ ownerId: actor.id, projectId: ctx.projectId || null, name: args.name }).lean();
      await WorkspaceFile.findOneAndUpdate(
        { ownerId: actor.id, projectId: ctx.projectId || null, name: args.name },
        { ownerId: actor.id, projectId: ctx.projectId || null, name: args.name, mime: prev?.mime || 'text/plain', content: newContent, size: newContent.length, createdAt: new Date() },
        { upsert: true }
      );
      if (prev?.content) {
        const patch = createPatch(args.name, prev.content, newContent, 'قبل', 'بعد');
        ctx.diffs.push({ name: args.name, patch, created: false, action: 'edit' });
        return `تم الحفظ. ملخص الفرق عن النسخة القديمة:\n${patch.slice(0, 3000)}`;
      }
      ctx.diffs.push({ name: args.name, patch: null, created: true, action: 'create' });
      return `تم إنشاء الملف "${args.name}" وحفظه في الـ Workspace.`;
    }
  },

  delete_project_file: {
    modes: ['barista-code'],
    schema: { type: 'function', function: { name: 'delete_project_file', description: 'احذف ملف من الـ Workspace نهائيًا. استخدمها فقط لو المستخدم طلب صراحة حذف الملف ده — عملية لا رجعة فيها.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    async run(actor, args, ctx) {
      const existed = await WorkspaceFile.findOneAndDelete({ ownerId: actor.id, projectId: ctx.projectId || null, name: args.name }).lean();
      if (!existed) return `الملف "${args.name}" مش موجود أصلًا.`;
      ctx.diffs.push({ name: args.name, patch: null, created: false, action: 'delete' });
      return `تم حذف "${args.name}".`;
    }
  },

  analyze_data_file: {
    modes: ['barista-code'],
    schema: {
      type: 'function',
      function: {
        name: 'analyze_data_file',
        description: 'حلّل ملف CSV موجود فعليًا في الـ Workspace: أعمدة، إحصائيات، outliers، وارتباطات بين الأعمدة الرقمية. استخدمها بس لملفات بيانات جدولية حقيقية.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
      }
    },
    async run(actor, args, ctx) {
      const f = await WorkspaceFile.findOne({ ownerId: actor.id, projectId: ctx.projectId || null, name: args.name }).lean();
      if (!f) return `الملف "${args.name}" مش موجود في الـ Workspace.`;
      const stats = computeStats(f.content);
      if (stats.error) return stats.error;
      const cols = stats.columns.map(c => c.type === 'numeric'
        ? `${c.name}: numeric, min=${c.min}, max=${c.max}, mean=${c.mean.toFixed(2)}, median=${c.median}, outliers=${c.outlierCount}, missing=${c.missing}`
        : `${c.name}: categorical, distinct=${c.distinct}, top=${c.topValues.map(t => `${t.value}(${t.count})`).join(', ')}, missing=${c.missing}`
      ).join('\n');
      const corr = stats.correlations.length ? '\nارتباطات: ' + stats.correlations.map(c => `${c.a}~${c.b}=${c.r}`).join(', ') : '';
      return `صفوف: ${stats.rowCount}, أعمدة: ${stats.columnCount}\n${cols}${corr}`;
    }
  },

  create_task: {
    modes: ['barista-code', 'barista-just'],
    schema: {
      type: 'function',
      function: {
        name: 'create_task',
        description: 'أضف مهمة حقيقية لقائمة الـ Tasks بتاعة المستخدم (مش وصف في الرد بس) — استخدمها لما تبني خطة عمل فعلية للمستخدم يتابعها.',
        parameters: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['title'] }
      }
    },
    async run(actor, args, ctx) {
      const last = await Task.findOne({ ownerId: actor.id, projectId: ctx.projectId || null }).sort({ order: -1 }).lean();
      const doc = await Task.create({
        ownerId: actor.id, projectId: ctx.projectId || null, chatId: ctx.chatId || null,
        title: String(args.title || '').slice(0, 300),
        priority: ['low', 'normal', 'high'].includes(args.priority) ? args.priority : 'normal',
        order: (last?.order ?? -1) + 1
      });
      await logActivity(ctx.projectId, actor.id, 'task.created', doc.title);
      ctx.tasksTouched = (ctx.tasksTouched || 0) + 1;
      return `تم إضافة المهمة: "${doc.title}" (id: ${doc._id}).`;
    }
  },

  update_task: {
    modes: ['barista-code', 'barista-just'],
    schema: {
      type: 'function',
      function: {
        name: 'update_task',
        description: 'حدّث حالة مهمة موجودة فعليًا (مثلًا اعتبرها منتهية بعد ما تنفذها). لازم تبعت id المهمة اللي رجع من create_task أو list_tasks.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, done: { type: 'boolean' }, title: { type: 'string' } }, required: ['id'] }
      }
    },
    async run(actor, args, ctx) {
      const update = { updatedAt: new Date() };
      if (typeof args.done === 'boolean') update.done = args.done;
      if (typeof args.title === 'string' && args.title.trim()) update.title = args.title.trim().slice(0, 300);
      const doc = await Task.findOneAndUpdate({ _id: args.id, ownerId: actor.id }, update, { new: true }).lean();
      if (!doc) return `مهمة بالـ id ده مش موجودة.`;
      await logActivity(ctx.projectId, actor.id, doc.done ? 'task.completed' : 'task.updated', doc.title);
      return `تم تحديث المهمة "${doc.title}".`;
    }
  },

  list_tasks: {
    modes: ['barista-code', 'barista-just'],
    schema: { type: 'function', function: { name: 'list_tasks', description: 'اعرض المهام الحالية (المفتوحة والمنتهية) في هذا المشروع/المحادثة.', parameters: { type: 'object', properties: {} } } },
    async run(actor, args, ctx) {
      const items = await Task.find({ ownerId: actor.id, projectId: ctx.projectId || null }).sort({ order: 1 }).limit(100).lean();
      return items.length ? items.map(t => `[${t.done ? 'x' : ' '}] (${t._id}) ${t.title}`).join('\n') : 'مفيش مهام حاليًا.';
    }
  },

  rename_project_file: {
    modes: ['barista-code'],
    schema: { type: 'function', function: { name: 'rename_project_file', description: 'غيّر اسم ملف موجود في الـ Workspace من غير ما تغيّر محتواه.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
    async run(actor, args, ctx) {
      const f = await WorkspaceFile.findOne({ ownerId: actor.id, projectId: ctx.projectId || null, name: args.from });
      if (!f) return `الملف "${args.from}" مش موجود.`;
      const clash = await WorkspaceFile.findOne({ ownerId: actor.id, projectId: ctx.projectId || null, name: args.to }).lean();
      if (clash) return `فيه ملف بالاسم "${args.to}" بالفعل — احذفه الأول أو اختار اسم تاني.`;
      f.name = args.to; await f.save();
      ctx.diffs.push({ name: `${args.from} → ${args.to}`, patch: null, created: false, action: 'rename' });
      return `تم تغيير الاسم من "${args.from}" إلى "${args.to}".`;
    }
  }
};

export function toolsFor(mode) {
  return Object.values(TOOLS).filter(t => t.modes.includes(mode)).map(t => t.schema);
}

export async function runTool(actor, name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return `أداة غير معروفة: ${name}`;
  if (ctx.mode && !tool.modes.includes(ctx.mode)) return `الأداة "${name}" مش متاحة في الوضع ده.`;
  return tool.run(actor, args || {}, ctx);
}
