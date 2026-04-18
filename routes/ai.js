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
// ✨ FIXED ENDPOINT: POST /ai/study-plan
// ═══════════════════════════════════════════════════════════════════════════
// Generates AI-powered study plans using OpenAI
// Body: { subject, examDate, dailyHours, level }
// Returns: { success: true, plan: [...], metadata: {...} }
// 
// 🔧 FIXES APPLIED:
// 1. Increased max_tokens from 3000 to 8000 (prevents truncation)
// 2. Added completion reason check to detect truncation
// 3. Better JSON cleanup and validation
// 4. More detailed error messages for debugging
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
    
    // 🔧 FIX: Simplified prompt for better reliability
    const prompt = `Create a ${daysUntilExam}-day study plan for ${subject}${levelText}.

Study time: ${dailyHours} hours/day
Start date: ${today.toISOString().split('T')[0]}
Exam date: ${examDate}

Rules:
- Generate EXACTLY ${daysUntilExam} days
- Each day: 3-5 specific tasks
- Tasks must fit in ${dailyHours} hours
- Progress: basics → intermediate → advanced → review
- Last 2-3 days: practice tests and revision

Return ONLY a JSON array (no markdown, no explanations):
[
  {"date": "YYYY-MM-DD", "tasks": ["task1", "task2", "task3"]},
  {"date": "YYYY-MM-DD", "tasks": ["task1", "task2", "task3"]}
]

Generate all ${daysUntilExam} days now.`;

    // ── Call OpenAI API ──────────────────────────────────────
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "none") {
      return res.status(500).json({
        error: 'OpenAI not configured',
        details: 'Server is missing OpenAI API key'
      });
    }

    console.log(`📝 Generating study plan: ${subject}, ${daysUntilExam} days, ${dailyHours}h/day`);

    // 🔧 FIX #1: Increased max_tokens from 3000 to 8000
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a study planning assistant. You ONLY respond with valid JSON arrays. Never include explanations, markdown backticks, or any text outside the JSON structure. Always complete the entire JSON array."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 8000  // 🔧 INCREASED from 3000
    });

    // 🔧 FIX #2: Check if response was truncated
    const finishReason = completion.choices[0].finish_reason;
    if (finishReason === 'length') {
      console.error('⚠️ Response was truncated due to max_tokens limit');
      return res.status(500).json({
        error: 'Study plan too long',
        details: 'The study plan was truncated. Try reducing the number of days or daily hours.'
      });
    }

    let responseText = completion.choices[0].message.content.trim();
    
    console.log('📄 Raw response length:', responseText.length);
    console.log('📄 First 200 chars:', responseText.substring(0, 200));
    console.log('📄 Last 200 chars:', responseText.substring(responseText.length - 200));

    // 🔧 FIX #3: More aggressive JSON cleanup
    responseText = responseText
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .replace(/^[^[\{]*/g, '')  // Remove everything before first [ or {
      .replace(/[^}\]]*$/g, '')  // Remove everything after last } or ]
      .trim();

    // 🔧 FIX #4: Validate JSON structure before parsing
    if (!responseText.startsWith('[')) {
      console.error('❌ Response does not start with [');
      console.error('📄 Cleaned response:', responseText.substring(0, 500));
      return res.status(500).json({
        error: 'Invalid AI response format',
        details: 'AI did not return a JSON array. Please try again.'
      });
    }

    if (!responseText.endsWith(']')) {
      console.error('❌ Response does not end with ]');
      console.error('📄 Response ends with:', responseText.substring(responseText.length - 100));
      return res.status(500).json({
        error: 'Incomplete AI response',
        details: 'The study plan was cut off. Please try again with fewer days.'
      });
    }

    // ── Parse JSON ───────────────────────────────────────────
    let studyPlan;
    try {
      studyPlan = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ JSON parse error:', parseError.message);
      console.error('📄 Failed to parse:', responseText.substring(0, 500));
      console.error('📄 Parse error at position:', parseError.message.match(/position (\d+)/)?.[1]);
      
      return res.status(500).json({ 
        error: 'AI response parsing failed',
        details: `JSON parse error: ${parseError.message}. Please try again.`,
        debug: {
          responseLength: responseText.length,
          startsWithBracket: responseText.startsWith('['),
          endsWithBracket: responseText.endsWith(']'),
          firstChars: responseText.substring(0, 50),
          lastChars: responseText.substring(responseText.length - 50)
        }
      });
    }

    // ── Validate response structure ──────────────────────────
    if (!Array.isArray(studyPlan)) {
      console.error('❌ Study plan is not an array:', typeof studyPlan);
      return res.status(500).json({ 
        error: 'Invalid study plan format',
        details: 'Expected an array of days, got: ' + typeof studyPlan
      });
    }

    if (studyPlan.length === 0) {
      console.error('❌ Study plan is empty');
      return res.status(500).json({
        error: 'Empty study plan',
        details: 'AI returned no days. Please try again.'
      });
    }

    // 🔧 FIX #5: Validate each day has required fields
    const validPlan = studyPlan.filter(day => {
      return day && typeof day === 'object' && Array.isArray(day.tasks);
    });

    if (validPlan.length === 0) {
      console.error('❌ No valid days in study plan');
      return res.status(500).json({
        error: 'Invalid study plan structure',
        details: 'No valid days found in the plan. Please try again.'
      });
    }

    // ── Ensure dates are correct (starting from today) ───────
    const planWithDates = validPlan.map((day, index) => {
      const dayDate = new Date(today);
      dayDate.setDate(today.getDate() + index);
      
      return {
        date: dayDate.toISOString().split('T')[0],
        tasks: day.tasks.filter(task => typeof task === 'string' && task.trim().length > 0)
      };
    });

    // Filter out any days with no tasks
    const finalPlan = planWithDates.filter(day => day.tasks.length > 0);

    if (finalPlan.length === 0) {
      console.error('❌ No days with valid tasks');
      return res.status(500).json({
        error: 'No valid tasks generated',
        details: 'AI did not generate valid tasks. Please try again.'
      });
    }

    // ── Success response ─────────────────────────────────────
    console.log(`✅ Study plan generated successfully: ${subject}, ${finalPlan.length}/${daysUntilExam} days`);
    
    res.json({
      success: true,
      plan: finalPlan,
      metadata: {
        subject,
        examDate,
        dailyHours,
        level: level || 'not specified',
        totalDays: finalPlan.length,
        requestedDays: daysUntilExam,
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
