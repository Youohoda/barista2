# Barista AI — V9 UI rebuild

نسخة جديدة مبنية على Barista-AI-V8-Replit-Style مع إعادة ترتيب كاملة للواجهة، دعم أفضل للموبايل والكمبيوتر، وإصلاح تدفق Clerk.

## Vercel Environment Variables

ضع القيم من عندك في Vercel → Settings → Environment Variables:

- GROQ_API_KEY_1
- GROQ_API_KEY_2
- GROQ_API_KEY_3
- OPENROUTER_API_KEY_1
- OPENROUTER_API_KEY_2
- OPENROUTER_API_KEY_3
- COHERE_API_KEY_1
- COHERE_API_KEY_2
- MONGODB_URI
- CLERK_PUBLISHABLE_KEY
- CLERK_SECRET_KEY
- BARISTA_OWNER_EMAIL (اختياري، الافتراضي هو بريد المالك المحدد في المشروع)

لا يوجد ملف `.env` داخل هذه النسخة.

## Vercel

المشروع يستخدم `api/*.js` كـ Serverless Functions تلقائيًا. تم تبسيط `vercel.json` حتى لا يظهر خطأ unmatched function pattern.

## أهم التغييرات

- Responsive حقيقي للموبايل والكمبيوتر.
- Sidebar على الكمبيوتر وDrawer على الموبايل.
- قائمة + تفتح أولًا بدل فتح مدير الملفات مباشرة.
- رفع الصور من + مع إرسالها لموديل الرؤية عبر OpenRouter.
- دعم ملفات النصوص والكود داخل المحادثة.
- RTL/LTR تلقائي للرسائل والكود.
- Premium وكود التفعيل داخل لوحة Premium فقط.
- Account panel مع عداد الاستخدام وزر تصفير العداد.
- Owner Control منفصل للمستخدمين والأكواد وتصفير الاستخدام.
- ClerkJS محمّل بالطريقة الرسمية الحالية من Clerk.
- Barista Fast يبدأ بـ Groq لسرعة أفضل ثم fallback.
- لا توجد مفاتيح API داخل الملفات.
