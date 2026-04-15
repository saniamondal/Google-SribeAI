require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const AWS = require("aws-sdk");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");

// Groq client — used for Whisper transcription
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());

// ── AWS S3 ──────────────────────────────────────────────
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();

const BASE = `https://${process.env.RECALL_REGION || "us-east-1"}.recall.ai/api/v1`;
const RECALL_HEADERS = { Authorization: `Token ${process.env.RECALL_API_KEY}` };

// ─────────────────────────────────────────────────────────
// Map Recall.ai status → { frontend step, user message }
// ─────────────────────────────────────────────────────────
function mapStatus(status) {
  switch (status) {
    case "ready":
      return { step: "joining", msg: "🤖 Bot is ready — attempting to join the call…" };
    case "joining_call":
      return { step: "joining", msg: "🔗 Bot is joining the meeting…" };
    case "in_waiting_room":
      return { step: "joining", msg: "⏳ Bot is in the waiting room — please admit it!" };
    case "in_call_not_recording":
      return { step: "recording", msg: "📞 Bot joined the call — starting recording…" };
    case "recording_permission_allowed":
      return { step: "recording", msg: "✅ Recording permission granted!" };
    case "recording_permission_denied":
      return { step: "recording", msg: "❌ Recording permission denied by host." };
    case "in_call_recording":
      return { step: "recording", msg: "🔴 Bot is actively recording the meeting…" };
    case "recording_done":
      return { step: "processing", msg: "💾 Recording finished — processing audio…" };
    case "call_ended":
      return { step: "processing", msg: "📵 Call ended — waiting for recording upload…" };
    case "done":
      return { step: "processing", msg: "✅ Recall processing complete. Fetching audio…" };
    case "analysis_done":
      return { step: "processing", msg: "🔍 Analysis done. Fetching audio…" };
    default:
      return { step: "joining", msg: `ℹ️ Bot status: ${status}` };
  }
}

const TERMINAL_OK = new Set([
  "done", "call_ended", "recording_done", "analysis_done", "media_expired",
]);
const TERMINAL_FAIL = new Set([
  "fatal", "error", "recording_permission_denied", "bot_kicked", "rejected",
  "failed", "timeout", "invalid_meeting_url", "meeting_not_found",
]);

// Safely extract the latest status code from Recall bot data
function extractRecallStatus(data) {
  // Prefer status_changes array (most detailed)
  const changes = data?.status_changes || [];
  if (changes.length > 0) {
    const latest = changes[changes.length - 1];
    return latest?.code || latest?.status || "unknown";
  }
  // Fall back to top-level status field
  if (data?.status) return data.status;
  return "unknown";
}

// ── RECALL helpers ───────────────────────────────────────
async function createBot(meetLink) {
  const res = await axios.post(
    `${BASE}/bot/`,
    { meeting_url: meetLink, bot_name: "AI Scribe" },
    { headers: RECALL_HEADERS }
  );
  return res.data;
}

async function getBot(botId) {
  const res = await axios.get(`${BASE}/bot/${botId}/`, { headers: RECALL_HEADERS });
  return res.data;
}

// ── WHISPER via Groq ─────────────────────────────────────
async function transcribe(audioUrl) {
  console.log("Downloading audio from:", audioUrl);

  const isPresignedS3 = audioUrl.includes("AWSAccessKeyId") || audioUrl.includes("X-Amz-Signature");
  const downloadHeaders = isPresignedS3 ? {} : RECALL_HEADERS;

  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: downloadHeaders,
    timeout: 300000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const audioBuffer = Buffer.from(audioRes.data);
  const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`Downloaded: ${sizeMB} MB`);

  if (audioBuffer.length < 1000) {
    throw new Error("Download returned non-audio data: " + audioBuffer.toString("utf8").slice(0, 200));
  }

  const tmpPath = path.resolve("./recording_tmp.mp4");
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    console.log("Sending to Groq Whisper...");
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: "whisper-large-v3",
      response_format: "text",
      language: "en",
    });

    const text = typeof transcription === "string"
      ? transcription
      : transcription?.text || "";

    console.log(`Transcript done — ${text.length} characters`);
    return text;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    console.log("Temp file deleted.");
  }
}

// ── LLM via Groq — LLaMA 3.3 70B ───────────────────────
async function summarize(text) {
  const truncated = text.length > 12000
    ? text.slice(0, 12000) + "\n\n[transcript truncated for length]"
    : text;

  console.log("Sending to Groq LLaMA 3.3 70B for summarization...");

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are an expert meeting analyst. You return only valid JSON with no markdown, no code fences, no extra text.",
        },
        {
          role: "user",
          content: `Analyze this meeting transcript and return ONLY a raw JSON object (no markdown, no code blocks) with this exact structure:

{
  "title": "Short descriptive meeting title (5-7 words)",
  "participants": ["Name1", "Name2"],
  "overview": "2-3 sentence professional summary of the meeting.",
  "bulletPoints": ["Key discussion point 1", "Key discussion point 2"],
  "actionItems": [
    { "task": "Task description", "owner": "Person or Team", "deadline": "deadline or null" }
  ],
  "questions": ["Important question or insight raised"]
}

Rules:
- participants: only real names spoken; empty array [] if none identifiable
- bulletPoints: 4-8 most important points discussed
- actionItems: only concrete follow-up tasks; empty array [] if none
- questions: 3-5 key questions raised or notable insights; empty array [] if none
- All values must be plain text, no markdown symbols

Transcript:
${truncated}`,
        },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    });
  } catch (err) {
    const detail = err.error?.message || err.message;
    throw new Error(`Groq API error: ${detail}`);
  }

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from Groq LLaMA 3.3 70B");
  }

  // Strip markdown code fences that some models add despite the instruction
  let raw = content.trim();
  raw = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Find the first '{' in case the model added any preamble text
  const jsonStart = raw.indexOf("{");
  if (jsonStart > 0) raw = raw.slice(jsonStart);

  // Parse into an object — if this fails we fall back to a safe structure
  try {
    const parsed = JSON.parse(raw);
    console.log("✅ JSON parsed successfully — keys:", Object.keys(parsed));
    return parsed;
  } catch (parseErr) {
    console.error("⚠️  JSON parse failed. Raw output (first 500 chars):", raw.substring(0, 500));
    // Return a degraded but usable object so the meeting isn't completely empty
    return {
      title:        "Meeting Recording",
      participants: [],
      overview:     raw,   // put the raw text in overview so nothing is lost
      bulletPoints: [],
      actionItems:  [],
      questions:    [],
    };
  }
}

// ── S3 ───────────────────────────────────────────────────
// uid is the Firebase user UID — meetings are stored under users/<uid>/
async function uploadToS3(data, uid) {
  try {
    const prefix = uid ? `users/${uid}/` : "shared/";
    // Embed a sanitized title slug in the key for sidebar display
    const slug = (data.title || "meeting")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
    const key = `${prefix}meeting-${Date.now()}-${slug}.json`;
    await s3.upload({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    }).promise();
    console.log("S3 uploaded:", key);
    return key;
  } catch (e) {
    console.log("S3 skipped:", e.message);
    return null;
  }
}

// ── SSE helper ───────────────────────────────────────────
function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const activeBots = new Map();

// ── /start (SSE stream) ───────────────────────────────────
app.get("/start", async (req, res) => {
  const meetLink = req.query.meetLink;
  const uid      = req.query.uid || null;  // Firebase UID for per-user S3 scoping
  if (!meetLink) return res.status(400).json({ error: "meetLink required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => sseWrite(res, event, data);

  send("status", { step: "joining", message: "🤖 Creating Recall.ai bot…" });

  let botId;
  try {
    const bot = await createBot(meetLink);
    botId = bot.id;
    activeBots.set(meetLink, botId);
    send("status", { step: "joining", message: `✅ Bot created (ID: ${botId}) — joining meeting now…` });
  } catch (err) {
    const errData = err.response?.data;
    send("error", { message: `Failed to create bot: ${JSON.stringify(errData) || err.message}` });
    return res.end();
  }

  let recordingUrl = null;
  let lastStatus = null;
  let waitingRoomCount = 0;

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    let data;
    try {
      data = await getBot(botId);
    } catch (e) {
      send("status", { step: "joining", message: `⚠️ Poll failed: ${e.message} — retrying…` });
      continue;
    }

    if (i === 0) console.log("=== BOT DATA (first poll) ===\n", JSON.stringify(data, null, 2));

    const recallStatus = extractRecallStatus(data);

    if (recallStatus !== lastStatus) {
      lastStatus = recallStatus;
      console.log(`[${i + 1}] Status → ${recallStatus}`);
    }

    const { step, msg } = mapStatus(recallStatus);
    send("status", { step, message: msg });

    // Also check top-level fatal/error flags Recall sometimes puts outside status_changes
    if (data?.error || data?.fatal) {
      const errMsg = data.error?.message || data.fatal?.message || JSON.stringify(data.error || data.fatal);
      send("error", { message: `Bot encountered a fatal error: ${errMsg}` });
      activeBots.delete(meetLink);
      return res.end();
    }

    if (recallStatus === "in_waiting_room") {
      waitingRoomCount++;
      if (waitingRoomCount >= 9) {
        send("error", { message: "Bot was not admitted from the waiting room after 45 seconds." });
        activeBots.delete(meetLink);
        return res.end();
      }
    } else {
      waitingRoomCount = 0;
    }

    if (TERMINAL_FAIL.has(recallStatus)) {
      send("error", { message: `Bot failed: ${recallStatus}. ${latest?.message || ""}` });
      activeBots.delete(meetLink);
      return res.end();
    }

    if (TERMINAL_OK.has(recallStatus)) {
      send("status", { step: "processing", message: "🎙 Meeting ended — waiting 15s for recording…" });
      await new Promise((r) => setTimeout(r, 15000));
      const freshData = await getBot(botId);
      const recordings = freshData?.recordings || [];
      if (recordings.length > 0) {
        recordingUrl =
          recordings[0].media_shortcuts?.audio_mixed?.data?.download_url ||
          recordings[0].media_shortcuts?.video_mixed?.data?.download_url ||
          recordings[0].download_url ||
          recordings[0].url;
      }
      break;
    }

    if (typeof data?.status === "string" && (data.status === "call_ended" || data.status === "done")) {
      send("status", { step: "processing", message: `📵 Call ended. Waiting for recording…` });
      await new Promise((r) => setTimeout(r, 15000));
      const freshData = await getBot(botId);
      const recordings = freshData?.recordings || [];
      if (recordings.length > 0) {
        recordingUrl =
          recordings[0].media_shortcuts?.audio_mixed?.data?.download_url ||
          recordings[0].media_shortcuts?.video_mixed?.data?.download_url ||
          recordings[0].download_url ||
          recordings[0].url;
      }
      break;
    }
  }

  if (!recordingUrl) {
    send("error", { message: "No recording URL found. Check your Recall.ai dashboard." });
    activeBots.delete(meetLink);
    return res.end();
  }

  // ── Step 3: Transcribe ────────────────────────────────
  send("status", { step: "transcribing", message: "🔊 Audio found. Sending to Whisper…" });
  let transcript;
  try {
    transcript = await transcribe(recordingUrl);
    send("status", { step: "transcribing", message: `✅ Transcript ready (${transcript.length} chars)…` });
    send("transcript", { text: transcript });
  } catch (err) {
    send("error", { message: `Whisper transcription failed: ${err.message}` });
    activeBots.delete(meetLink);
    return res.end();
  }

  // ── Step 4: Summarize ─────────────────────────────────
  send("status", { step: "summarizing", message: "✨ Analyzing and structuring meeting data…" });
  let meetingData;
  try {
    meetingData = await summarize(transcript);
  } catch (err) {
    console.error("Summarization error:", err.message);
    send("error", { message: `Summarization failed: ${err.message}` });
    activeBots.delete(meetLink);
    return res.end();
  }

  // ── Step 5: S3 ────────────────────────────────────────
  const fullData = { ...meetingData, transcript };
  const s3Key = await uploadToS3(fullData, uid);

  activeBots.delete(meetLink);
  send("done", { meetingData: fullData, s3Key });
  res.end();
});

app.get("/bot/:id", async (req, res) => {
  try {
    res.json(await getBot(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── List meetings from S3 — scoped to the requesting user's UID ──
app.get("/meetings", async (req, res) => {
  const uid = req.query.uid || null;
  const prefix = uid ? `users/${uid}/` : "shared/";
  try {
    const listData = await s3.listObjectsV2({
      Bucket: process.env.AWS_BUCKET_NAME,
      Prefix: prefix,
    }).promise();
    const files = (listData.Contents || [])
      .filter(obj => obj.Key.endsWith(".txt") || obj.Key.endsWith(".json"))
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

    // Fetch titles in parallel from each meeting's JSON
    const meetings = await Promise.all(
      files.map(async (obj) => {
        try {
          const file = await s3.getObject({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: obj.Key,
          }).promise();
          const parsed = JSON.parse(file.Body.toString("utf8"));
          return { key: obj.Key, date: obj.LastModified, title: parsed.title || null };
        } catch {
          return { key: obj.Key, date: obj.LastModified, title: null };
        }
      })
    );
    res.json(meetings);
  } catch (e) {
    console.error("S3 list error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Rename a meeting (update title in S3 JSON) ────────────
app.patch("/meeting", async (req, res) => {
  const { key, title } = req.body;
  if (!key || !title) return res.status(400).json({ error: "key and title required" });
  try {
    const file = await s3.getObject({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    }).promise();
    const meeting = JSON.parse(file.Body.toString("utf8"));
    meeting.title = title;
    await s3.putObject({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(meeting),
      ContentType: "application/json",
    }).promise();
    console.log("Meeting renamed:", key, "→", title);
    res.json({ ok: true });
  } catch (e) {
    console.error("Rename error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get a specific meeting from S3 ────────────────────────
app.get("/meeting", async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "key query param required" });
  try {
    const data = await s3.getObject({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    }).promise();
    const text = data.Body.toString("utf8");

    // New format: JSON
    try {
      return res.json(JSON.parse(text));
    } catch {
      // Legacy .txt format fallback
      const summaryMatch    = text.match(/=== SUMMARY ===\n([\s\S]*?)(?:\n\n=== TRANSCRIPT ===|$)/);
      const transcriptMatch = text.match(/=== TRANSCRIPT ===\n([\s\S]*)/);
      const rawSummary = summaryMatch ? summaryMatch[1].trim() : text.trim();
      return res.json({
        title: "Meeting Recording",
        participants: [],
        overview: rawSummary,
        bulletPoints: [],
        actionItems: [],
        questions: [],
        transcript: transcriptMatch ? transcriptMatch[1].trim() : "",
      });
    }
  } catch (e) {
    console.error("S3 get error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} in use. Run: lsof -ti :${PORT} | xargs kill -9`);
    process.exit(1);
  } else throw err;
});