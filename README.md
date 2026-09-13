# Barista AI

Barista AI is a Vercel-ready AI chat application with Clerk authentication, MongoDB persistence, Premium plans, activation codes, image/file attachments, multiple AI providers, and an owner-only control panel.

## Vercel Environment Variables

Keep secrets only in Vercel Environment Variables. The frontend reads the Clerk publishable key through `/api/config`; the Clerk secret key and provider keys stay server-side.

Required variables used by this build:
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

Optional: BARISTA_OWNER_EMAIL (defaults server-side to the configured owner email for this project).

## Owner

The owner-only secret command is `youo88`. The backend verifies the signed-in Clerk email before allowing the owner panel. Premium redemption code `y7` remains a separate user activation code.
