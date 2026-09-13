# Barista AI v4

Vercel-ready Barista AI with Clerk authentication, MongoDB accounts, Premium plans, redeem codes, and the private Owner "السري" control system.

## Environment Variables — Vercel

### Authentication
- `CLERK_PUBLISHABLE_KEY` — Clerk publishable key.
- `CLERK_SECRET_KEY` — Clerk secret key.
- `BARISTA_OWNER_EMAIL` — owner email that is allowed to use `youo88` and the Owner Control panel.

### Database
- `MONGODB_URI` — MongoDB Atlas connection string.

### AI providers
- `GROQ_API_KEY_1` through `GROQ_API_KEY_5`
- `OPENROUTER_API_KEY_1` through `OPENROUTER_API_KEY_5`
- `COHERE_API_KEY_1` through `COHERE_API_KEY_5`
- `GROQ_MODEL` (optional)
- `OPENROUTER_MODEL` (optional)
- `COHERE_MODEL` (optional)
- `BARISTA_APP_URL` (optional)
- `BARISTA_NAME` (optional)

## Clerk setup

Create a Clerk application and enable the sign-in methods you want, including Google, Email, and X/Twitter if you want all three. Clerk's prebuilt JavaScript SignIn component renders the enabled social connections from the Clerk Dashboard.

## Premium plans

- GPT — $3/month
- Go — $7/month
- Plus — $15/month
- God — $30/month

Current activation is code-based. Payment checkout can be connected later without changing the account/entitlement structure.

## Redeem codes

- `Youseef.123` → randomly assigns GPT or Go for 1 month
- `Youseef.1203` → randomly assigns GPT or Go for 1 year
- `0110` → Plus for 1 month
- `01107` → Plus for 1 year
- `youohoda` → God for 1 month
- `youohodaf` → God for 1 year
- `y7` → God forever

Each code can be redeemed once per account.

## Owner secret system

The owner account must match `BARISTA_OWNER_EMAIL`. If that authenticated owner sends the exact message `youo88`, Barista opens the private Owner Control panel. The backend checks the verified Clerk identity; the UI alone cannot unlock it.

Owner controls include viewing accounts, granting GPT/Go/Plus/God for month/year/forever, removing Premium, and resetting a user's daily limit.

## Notes

No `.env` or `.env.example` is included. Put all secrets in Vercel Environment Variables.
