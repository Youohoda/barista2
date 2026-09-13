# Barista AI V14

UI polish release based on V13.

- Model picker is anchored to the model button and opens above the composer, never from the `+` menu.
- `+` and model picker close each other when opened.
- Send button is circular with hover/press animation.
- Owner Control button is hidden unless the authenticated account matches `BARISTA_OWNER_EMAIL` (default owner email is the configured Barista owner).
- Owner API remains server-side protected by Clerk token verification; non-owner requests receive 403.
- Owner can grant a plan to the owner account or any other target email.
- No API keys or secrets are included in the project files.
