// routes/notion.js
import { Router } from "express";
import fetch from "node-fetch";

const router = Router();

router.get("/notion-callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("<script>window.close();</script>");
  }

  try {
    const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(
          process.env.NOTION_CLIENT_ID + ":" + process.env.NOTION_CLIENT_SECRET
        ).toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri:
          process.env.NOTION_REDIRECT_URI ||
          "https://your-app.up.railway.app/notion-callback"
      })
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok || !data.access_token) {
      console.error("Notion token exchange failed:", data);
      return res.send(`
        <script>
          window.opener && window.opener.postMessage({
            type: 'STUDYNEST_NOTION_TOKEN',
            error: 'Token exchange failed'
          }, '*');
          window.close();
        </script>
      `);
    }

    // Sanitize values
    const access_token = String(data.access_token || "").replace(/'/g, "\\'");
    const workspace = String(data.workspace_name || "Your Workspace").replace(/'/g, "\\'");

    res.send(`
      <script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'STUDYNEST_NOTION_TOKEN',
            token: '${access_token}',
            workspace: '${workspace}'
          }, '*');
        }
        window.close();
      </script>
    `);
  } catch (err) {
    console.error("Notion callback error:", err);
    res.send(`
      <script>
        window.opener && window.opener.postMessage({
          type: 'STUDYNEST_NOTION_TOKEN',
          error: 'Server error'
        }, '*');
        window.close();
      </script>
    `);
  }
});

export default router;

