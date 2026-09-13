# Barista AI — V28 (Brain + Router + Agent Mode + Projects + Memory متقدمة + Automations)

نفس الواجهة الأساسية (تصميم/ألوان)، مع إضافة نص واحد للموديلات (`Barista Brain`). الباقي كله backend حقيقي جديد فوق V27. **مفيش feature اتحذفت، كل الـ API القديمة شغالة زي ما هي بالظبط لو مبعتلهاش `projectId`.**

## اللي اتضاف فعليًا في V28

### 1. Barista Brain + Smart Model Router (`api/_router.js`)
- موديل جديد `barista-auto` ("Barista Brain" في الواجهة). المستخدم يبعت رسالة عادية، والراوتر بيصنّفها بـ regex heuristics (كود / تحليل عميق / صورة / بساطة) ويختار أفضل موديل من الموجودين فعليًا (`barista-fast/just/code/reasoning/image`) **من غير استدعاء موديل إضافي** — Cost Optimization حقيقي، مش استدعاء مضاعف.
- الرد بيرجع `routedTo` يوضح لأي موديل اتوجه الطلب، والـ weight (الرصيد اليومي) بيتحسب على الموديل الفعلي اللي اشتغل، مش على `barista-auto` نفسه.
- `getProviderHealth()`: بيقرأ إحصائيات حقيقية (نجاح/فشل/latency) اتسجلت فعليًا من كل استدعاء providerChat (مفيش أرقام وهمية) — مستخدمة في `/api/health` الجديد.

### 2. Modular Tool System (`api/_tools.js`)
- كل الأدوات (`web_search`, `list/read/write/delete/rename/search_project_files`) بقت مسجلة في registry واحد بدل ما تكون متوزعة جوه `chat.js`. إضافة أداة جديدة = entry واحدة هنا، مفيش تعديل تاني مطلوب.
- أدوات جديدة حقيقية: `delete_project_file`, `rename_project_file`, `search_project_files` (grep نصي جوه كل ملفات الـ Workspace).

### 3. Agent Mode حقيقي لـ Barista Code (`api/chat.js`)
- لما `barista-code` يشتغل جوه Project (مش أي سؤال برمجي عام)، بيحصل فعليًا:
  `planTasks` (استدعاء خفيف بـ barista-fast يقسّم الطلب لخطوات) → تنفيذ الخطوات بالأدوات الحقيقية (حتى 8 جولات tool-calls بدل 4) → `selfReviewCode` بيتأكد إن كل خطوة في الخطة اتنفذت فعليًا في الرد، مش بس إن الكود سليم.
- الرد بيتضاف له checklist فعلي (`- [x] ...`) بالخطوات اللي اتنفذت، مش وصف عام.
- **مفيش execution/tests حقيقية هنا** — دي بتحتاج Sandbox منفصل (بند 5 تحت "اللي لسه محتاج قرار infrastructure").

### 4. Project System (`api/projects.js`, schemas في `_lib.js`)
- CRUD كامل: `GET/POST/PATCH/DELETE /api/projects`. كل Project له `instructions` ثابتة بتتحقن تلقائيًا في الـ system prompt لأي محادثة أو ملف مربوط بيه.
- عزل حقيقي: `Chat`, `WorkspaceFile`, `Memory` كلهم عندهم `projectId` اختياري (`null` = زي الأول بالظبط، مفيش كسر). كل query في الكود بيفلتر بـ `{ownerId, projectId}` مع بعض — مفيش تسريب بين مشاريع أو مستخدمين.
- حذف Project بيحذف معاه chats/files/memory بتاعته فقط (مش بتاعة مشاريع تانية).
- **الواجهة (`index.html`) لسه معملهاش UI لاختيار/إنشاء Project** — الـ API جاهز وشغال، لكن الربط بزرار في الواجهة مؤجل عمدًا (شرح السبب في "Limitations").

### 5. Advanced Memory (`api/_lib.js`, `api/memory.js`, `api/chat.js`)
- `Memory` بقى فيه `category` (preference/personal/project/decision/instruction/temporary)، `importance` (1-5)، `projectId` اختياري، و`expiresAt` لـ temporary facts (TTL index — Mongo بتمسحها لوحدها، مش الكود).
- Dedup فعلي: قبل أي حفظ (يدوي أو تلقائي)، بيدور على حقيقة مشابهة موجودة بالفعل (regex على أول 40 حرف) ولو لقى، مبيكررش.
- الاسترجاع بقى بـ `importance` أولًا بعد كده الأحدث، وبيفلتر حسب الـ project الحالي (حقائق عامة + حقائق المشروع ده بس، مش كل المشاريع).
- `GET /api/memory?category=decision` بقى متاح للفلترة.

### 6. Automations Engine (`api/automations.js`, `api/cron-automations.js`, `vercel.json`)
- CRUD كامل لـ automations (`prompt`, `hour` UTC, `daysOfWeek`, موديل). التنفيذ الفعلي بيحصل عبر **Vercel Cron حقيقي** (`vercel.json` → `/api/cron-automations` كل ساعة)، مش scheduler وهمي.
- كل تنفيذ بيتسجل في `AutomationRun` (نجاح/فشل + النتيجة)، قابل للعرض عبر `GET /api/automations`.
- محمي بـ `CRON_SECRET` اختياري عشان محدش يقدر يستدعي الـ endpoint من بره ويستهلك رصيد المستخدمين.

### 7. Monitoring حقيقي (`api/health.js`)
- بيختبر اتصال الداتابيز فعليًا، وبيرجّع إحصائيات providers الحقيقية من `ProviderStat`، وبيوضح لو `BRAVE_API_KEY`/`CRON_SECRET` متظبطين — مفيش "🟢 Operational" وهمي لحاجة متتفحصش.

## متغيرات بيئة جديدة
- `CRON_SECRET` (اختياري لكن موصى بيه) — يحمي `/api/cron-automations` من الاستدعاء من بره. لو مش متظبط، الـ endpoint بيشتغل بدون تحقق (يفضل يتضبط قبل production).
- باقي المتغيرات القديمة زي ما هي (`MONGODB_URI`, `CLERK_SECRET_KEY`, `GROQ_API_KEY_1`, `OPENROUTER_API_KEY_1`, `BRAVE_API_KEY`, إلخ).

## اللي لسه محتاج قرار Infrastructure (مش اتعمل هنا، ومش مزيف)
راجع تقرير التسليم النهائي في المحادثة — Sandbox تنفيذ كود، Browser Agent حي، Voice، Admin Dashboard، Collaboration متعددة المستخدمين، وربط الواجهة بالـ Projects/Automations، كلها مش موجودة في النسخة دي لأسباب حقيقية (بنية Vercel serverless الحالية، أو حجم شغل UI منفصل) — موضحة بالتفصيل في التقرير.
