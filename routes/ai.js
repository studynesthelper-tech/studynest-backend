// routes/ai.js  — StudyNest AI proxy
import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI    from "openai";
import { requireAuth } from "../middleware/auth.js";
import { getUsageInfo, updateUser, FREE_QUESTIONS_PER_WEEK } from "../db/users.js";

export const router = Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai    = new OpenAI   ({ apiKey: process.env.OPENAI_API_KEY || "none" });

const SYSTEM_PROMPT = `You are StudyNest AI, a friendly and expert study assistant.
You help students learn by explaining concepts clearly, summarizing content, generating flashcards, creating quizzes, and simplifying complex topics.
When generating flashcards, always format them as a JSON array inside a \`\`\`flashcards\`\`\` code block like this:
\`\`\`flashcards
[{"front":"Question?","back":"Answer."},...]
\`\`\`
Be concise but thorough. Use markdown formatting. Be encouraging and supportive.`;

const MODELS = {
  claude:   { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  chatgpt:  { provider: "openai",    id: "gpt-4o-mini" },  // cheaper for free tier
  deepseek: { provider: "deepseek",  id: "deepseek-chat" },
};

// ── POST /ai/chat ────────────────────────────────────────────
// Body: { messages: [...], model: "claude"|"chatgpt"|"deepseek" }
// Streams SSE: data: {"chunk":"..."}\n\n
//              data: {"done":true,"usage":{...}}\n\n
router.post("/chat", requireAuth, async (req, res) => {
  try {
    const user  = req.user;
    const usage = getUsageInfo(user);

    // ── Quota check ──────────────────────────────────────────
    if (!usage.is_premium && usage.free_questions_remaining <= 0) {
      return res.status(429).json({
        error: "quota_exceeded",
        message: `You've used all your free questions this week. Upgrade to premium for unlimited access.`,
        usage,
      });
    }

    const { messages = [], model: modelKey = "claude" } = req.body;
    const modelCfg = MODELS[modelKey] || MODELS.claude;

    // ── SSE headers ──────────────────────────────────────────
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // ── Call provider ────────────────────────────────────────
    let fullText = "";

    if (modelCfg.provider === "anthropic") {
      const stream = await anthropic.messages.stream({
        model:      modelCfg.id,
        max_tokens: 2048,
        system:     SYSTEM_PROMPT,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
      });

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
          fullText += chunk.delta.text;
          send({ chunk: chunk.delta.text });
        }
      }

    } else if (modelCfg.provider === "openai") {
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "none") {
        return res.write(`data: ${JSON.stringify({ error: "OpenAI not configured on server" })}\n\n`) && res.end();
      }
      const stream = await openai.chat.completions.create({
        model:      modelCfg.id,
        max_tokens: 2048,
        stream:     true,
        messages:   [{ role: "system", content: SYSTEM_PROMPT }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      });

      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content || "";
        if (text) { fullText += text; send({ chunk: text }); }
      }

    } else if (modelCfg.provider === "deepseek") {
      if (!process.env.DEEPSEEK_API_KEY) {
        return res.write(`data: ${JSON.stringify({ error: "DeepSeek not configured on server" })}\n\n`) && res.end();
      }
      // DeepSeek is OpenAI-compatible
      const dsClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1" });
      const stream = await dsClient.chat.completions.create({
        model:      modelCfg.id,
        max_tokens: 2048,
        stream:     true,
        messages:   [{ role: "system", content: SYSTEM_PROMPT }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      });

      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content || "";
        if (text) { fullText += text; send({ chunk: text }); }
      }
    }

    // ── Deduct quota ─────────────────────────────────────────
    const newFree = usage.is_premium
      ? usage.free_questions_remaining
      : Math.max(0, usage.free_questions_remaining - 1);

    updateUser(user.id, {
      freeQuestions:   newFree,
      totalQuestions:  (user.totalQuestions || 0) + 1,
    });

    const updatedUsage = getUsageInfo({ ...user, freeQuestions: newFree });
    send({ done: true, usage: updatedUsage });
    res.end();

  } catch (err) {
    console.error("AI route error:", err);
    try {
      res.write(`data: ${JSON.stringify({ error: err.message || "Server error" })}\n\n`);
      res.end();
    } catch {}
  }
});

