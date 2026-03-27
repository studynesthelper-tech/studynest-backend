# StudyNest Server — Deployment Guide

## What this is
A proxy server that sits between your Chrome extension and AI providers.
- Users register/login to YOUR server
- YOUR server holds the API keys — never exposed to users
- Free tier: 20 questions/week per user
- Premium: unlimited (you can add Stripe later)

---

## Deploy in 5 minutes (Railway — recommended, free tier available)

### 1. Push to GitHub
```bash
cd studynest-server
git init
git add .
git commit -m "StudyNest server"
git remote add origin https://github.com/YOUR_USERNAME/studynest-server.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select your repo
3. Go to Variables tab and add:

```
JWT_SECRET=make_this_long_and_random_eg_studynest_2026_xk9q2m4p7r
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...        (optional)
DEEPSEEK_API_KEY=sk-...      (optional)
```

4. Railway auto-deploys. You'll get a URL like:
   `https://studynest-server-production.up.railway.app`

### 3. Update the extension
Open `sidepanel/scripts/chat.js` and change line 4:
```js
const SERVER_URL = "https://studynest-server-production.up.railway.app";
```

That's it! Reload the extension and test.

---

## Alternative: Render.com (also free)
1. Go to https://render.com → New Web Service → Connect GitHub repo
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Add the same environment variables
5. Free tier spins down after 15min inactivity (first request is slow — upgrade to $7/mo to avoid this)

---

## Alternative: Run locally for testing
```bash
cd studynest-server
cp .env.example .env
# Edit .env and add your keys
npm install
npm start
# Server runs on http://localhost:3000
# In chat.js: SERVER_URL = "http://localhost:3000"
```

---

## File structure
```
studynest-server/
├── server.js          ← Entry point
├── package.json
├── .env.example       ← Copy to .env with your keys
├── railway.toml       ← Railway deploy config
├── routes/
│   ├── auth.js        ← /auth/register, /auth/login, /auth/refresh
│   ├── ai.js          ← /ai/chat (streaming SSE, quota enforced)
│   └── user.js        ← /user/me (get usage)
├── middleware/
│   └── auth.js        ← JWT verification
└── db/
    └── users.js       ← Simple JSON file store (swap for Postgres later)
```

---

## How quota works
- New users get **20 free questions/week**
- Quota resets every 7 days automatically
- When quota hits 0 → server returns 429 → extension shows upgrade message
- To give a user premium: edit `db/users.json` and set `"plan": "premium"`
- Later: add Stripe webhook to auto-upgrade on payment

---

## Scaling up
The JSON file store works fine for hundreds of users.
For thousands of concurrent users, swap `db/users.js` for:
- **Postgres on Railway** (add a Postgres plugin, costs ~$5/mo)
- **MongoDB Atlas** (free tier: 500MB)
- **Supabase** (free tier: 500MB Postgres)

The rest of the code stays identical — just replace the 4 functions in `db/users.js`.

