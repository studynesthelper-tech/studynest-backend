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

// ═══════════════════════════════════════════════════════════════════════════
// ✨ NEW ENDPOINT: POST /ai/study-plan
// ═══════════════════════════════════════════════════════════════════════════
// Generates AI-powered study plans using OpenAI
// Body: { subject, examDate, dailyHours, level }
// Returns: { success: true, plan: [...], metadata: {...} }
// ═══════════════════════════════════════════════════════════════════════════

router.post("/study-plan", async (req, res) => {
  try {
    const { subject, examDate, dailyHours, level } = req.body;

    // ── Validation ───────────────────────────────────────────
    if (!subject || !examDate || !dailyHours) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'Please provide: subject, examDate, dailyHours'
      });
    }

    // ── Calculate days until exam ────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exam = new Date(examDate);
    exam.setHours(0, 0, 0, 0);
    
    const daysUntilExam = Math.max(1, Math.ceil((exam - today) / (1000 * 60 * 60 * 24)));

    if (daysUntilExam > 365) {
      return res.status(400).json({
        error: 'Invalid exam date',
        details: 'Exam date must be within 1 year'
      });
    }

    // ── Build AI prompt ──────────────────────────────────────
    const levelText = level ? ` (current level: ${level})` : '';
    const prompt = `You are a study planning expert. Create a detailed, personalized study plan for a student.

📚 Subject: ${subject}${levelText}
📅 Days until exam: ${daysUntilExam}
⏱ Daily study time: ${dailyHours} hours

Create a study plan that:
• Covers all ${daysUntilExam} days from today until the exam
• Each day has 3-5 specific, actionable tasks
• Tasks fit within ${dailyHours} hours of daily study
• Plan builds progressively: basics → intermediate → advanced → review
• Final 2-3 days focus on practice tests and revision
• Tasks are concrete and specific to ${subject}

CRITICAL: Respond ONLY with a valid JSON array. No explanations, no markdown backticks, no text before or after.

Example format:
[
  {
    "date": "2026-04-19",
    "tasks": [
      "Review chapter 1: Introduction to ${subject}",
      "Complete practice problems 1-10",
      "Create flashcards for key terms"
    ]
  },
  {
    "date": "2026-04-20",
    "tasks": [
      "Study chapter 2: Advanced concepts",
      "Watch video lecture on topic X",
      "Practice essay writing (30 min)"
    ]
  }
]

Generate exactly ${daysUntilExam} days starting from today. Return ONLY the JSON array.`;

    // ── Call OpenAI API ──────────────────────────────────────
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "none") {
      return res.status(500).json({
        error: 'OpenAI not configured',
        details: 'Server is missing OpenAI API key'
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a study planning assistant. You ONLY respond with valid JSON arrays. Never include explanations, markdown, or any text outside the JSON structure."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    let responseText = completion.choices[0].message.content.trim();
    
    // ── Clean up response (remove markdown if AI adds it) ────
    responseText = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/^```/g, '')
      .replace(/```$/g, '')
      .trim();

    // ── Parse JSON ───────────────────────────────────────────
    let studyPlan;
    try {
      studyPlan = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ JSON parse error:', parseError);
      console.error('📄 Raw response:', responseText.substring(0, 500));
      return res.status(500).json({ 
        error: 'AI response parsing failed',
        details: 'The AI returned an invalid format. Please try again.'
      });
    }

    // ── Validate response structure ──────────────────────────
    if (!Array.isArray(studyPlan)) {
      return res.status(500).json({ 
        error: 'Invalid study plan format',
        details: 'Expected an array of days'
      });
    }

    if (studyPlan.length === 0) {
      return res.status(500).json({
        error: 'Empty study plan',
        details: 'AI returned no days. Please try again.'
      });
    }

    // ── Ensure dates are correct (starting from today) ───────
    const planWithDates = studyPlan.map((day, index) => {
      const dayDate = new Date(today);
      dayDate.setDate(today.getDate() + index);
      
      return {
        date: dayDate.toISOString().split('T')[0],
        tasks: Array.isArray(day.tasks) ? day.tasks : []
      };
    });

    // ── Success response ─────────────────────────────────────
    console.log(`✅ Study plan generated: ${subject}, ${planWithDates.length} days`);
    
    res.json({
      success: true,
      plan: planWithDates,
      metadata: {
        subject,
        examDate,
        dailyHours,
        level: level || 'not specified',
        totalDays: planWithDates.length,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Study plan generation error:', error);
    
    // ── Handle specific errors ───────────────────────────────
    if (error.status === 401 || error.code === 'invalid_api_key') {
      return res.status(500).json({ 
        error: 'API configuration error',
        details: 'Invalid OpenAI API key'
      });
    }
    
    if (error.status === 429 || error.code === 'rate_limit_exceeded') {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        details: 'Too many requests. Please try again in a moment.'
      });
    }

    if (error.status === 503 || error.code === 'service_unavailable') {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        details: 'OpenAI API is currently unavailable. Please try again later.'
      });
    }

    // ── Generic error ────────────────────────────────────────
    res.status(500).json({ 
      error: 'Failed to generate study plan',
      details: error.message || 'Unknown error occurred'
    });
  }
});
