require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const AWS = require("aws-sdk");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

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

// ── WHISPER via Groq (with chunking for large files) ─────
const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // 24 MB safety margin (Groq limit: 25 MB)
const CHUNK_DURATION_SECS = 600;             // 10 minutes per audio chunk

async function transcribe(audioUrl, onProgress) {
  console.log("Downloading audio from:", audioUrl);

  const isPresignedS3 =
    audioUrl.includes("AWSAccessKeyId") || audioUrl.includes("X-Amz-Signature");
  const downloadHeaders = isPresignedS3 ? {} : RECALL_HEADERS;

  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: downloadHeaders,
    timeout: 600000,          // 10 min timeout for large downloads
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const audioBuffer = Buffer.from(audioRes.data);
  const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`Downloaded: ${sizeMB} MB`);

  if (audioBuffer.length < 1000) {
    throw new Error(
      "Download returned non-audio data: " +
        audioBuffer.toString("utf8").slice(0, 200)
    );
  }

  const tmpDir = path.resolve("./tmp_audio_chunks");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, "recording_full.mp4");
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    // ── Small file → single Whisper call ──────────────────
    if (audioBuffer.length <= WHISPER_MAX_BYTES) {
      console.log("File under 24 MB — single Whisper call…");
      if (onProgress) onProgress("Transcribing audio…");
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: "whisper-large-v3",
        response_format: "text",
        language: "en",
      });
      const text =
        typeof transcription === "string"
          ? transcription
          : transcription?.text || "";
      console.log(`Transcript done — ${text.length} characters`);
      return text;
    }

    // ── Large file → split with ffmpeg, transcribe each chunk ─
    console.log(
      `File is ${sizeMB} MB (exceeds 24 MB) — splitting into ${CHUNK_DURATION_SECS}s chunks…`
    );
    if (onProgress) onProgress(`Audio is ${sizeMB} MB — splitting into chunks…`);

    const chunkPattern = path.join(tmpDir, "chunk_%03d.mp4");
    execSync(
      `"${ffmpegPath}" -i "${tmpPath}" -f segment -segment_time ${CHUNK_DURATION_SECS} -c copy -reset_timestamps 1 -v error "${chunkPattern}"`,
      { stdio: "pipe", timeout: 120000 }
    );

    const chunkFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp4"))
      .sort();

    console.log(`Created ${chunkFiles.length} audio chunks`);

    const transcripts = [];
    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkPath = path.join(tmpDir, chunkFiles[i]);
      const chunkSizeMB = (fs.statSync(chunkPath).size / 1024 / 1024).toFixed(2);
      console.log(
        `Transcribing chunk ${i + 1}/${chunkFiles.length} (${chunkSizeMB} MB)…`
      );
      if (onProgress)
        onProgress(
          `Transcribing audio chunk ${i + 1} of ${chunkFiles.length} (${chunkSizeMB} MB)…`
        );

      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(chunkPath),
        model: "whisper-large-v3",
        response_format: "text",
        language: "en",
      });

      const text =
        typeof transcription === "string"
          ? transcription
          : transcription?.text || "";
      transcripts.push(text);
      console.log(`  ✓ chunk ${i + 1} — ${text.length} chars`);
    }

    const fullTranscript = transcripts.join("\n\n");
    console.log(
      `Full transcript assembled — ${fullTranscript.length} chars from ${chunkFiles.length} chunks`
    );
    return fullTranscript;
  } finally {
    // Clean up temp directory
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
      console.log("Temp audio files cleaned up.");
    } catch (e) {
      console.warn("Cleanup warning:", e.message);
    }
  }
}

// ── LLM via Groq — LLaMA 3.3 70B ───────────────────────
// llama-3.3-70b-versatile on Groq has a 128 K-token context window.
// ~4 chars ≈ 1 token → allow up to ~120 K chars before chunking.
const MAX_DIRECT_CHARS  = 120000;
const SUMMARY_CHUNK_CHARS = 60000; // ~15 K tokens per chunk

// Extract the outermost JSON object from a string that may have preamble/suffix text
function extractJSON(raw) {
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Generate a partial plain-text summary for one chunk of a long transcript.
 */
async function summarizeChunk(chunkText, idx, total) {
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content:
          "You are an expert meeting analyst and note-taker. Your job is to produce a thorough, " +
          "faithful summary of the meeting transcript chunk provided. Capture EVERY meaningful topic, " +
          "decision, action item, question, and insight. Introduce each speaker by full name on first " +
          "mention, then use pronouns naturally. Reproduce all names, institutions, numbers, dates, " +
          "and statistics exactly as spoken. Correct filler words (um, uh, repeated words) silently " +
          "without changing meaning. Do NOT invent or infer anything not clearly stated. " +
          "Output plain text only — no JSON, no markdown fences, no bullet points. Write in flowing prose paragraphs.",
      },
      {
        role: "user",
        content:
          `This is section ${idx} of ${total} of a longer meeting transcript. ` +
          `Summarize it thoroughly. Cover ALL topics discussed, decisions made, tasks assigned, ` +
          `questions raised, and notable insights. Be comprehensive — do not omit details.\n\n${chunkText}`,
      },
    ],
    max_tokens: 8192,
    temperature: 0.1,
  });

  return completion?.choices?.[0]?.message?.content || "";
}

/**
 * Generate the final structured JSON summary.
 * @param {string}  text          – full transcript OR merged partial summaries
 * @param {boolean} isFromChunks  – true when input is merged partial summaries
 */
async function generateFinalSummary(text, isFromChunks = false) {
  const systemPrompt = isFromChunks
    ? "You are an expert meeting summarizer and analyst. You are given partial summaries of " +
      "different sections of a long meeting. Merge them into a single cohesive, comprehensive analysis. " +
      "Write in clear, professional English. Reproduce all names, institutions, numbers, and statistics exactly. " +
      "Do NOT invent or infer anything not present in the summaries. " +
      "Respond with ONLY a single valid JSON object — no markdown, no code fences, no explanation before or after."
    : "You are an expert meeting summarizer and analyst. " +
      "Your job is to produce a thorough, faithful, and well-structured analysis of the meeting transcript. " +
      "Write in clear, professional English. Introduce each speaker by full name on first mention, then use pronouns naturally. " +
      "Reproduce all names, institutions, numbers, dates, and statistics exactly as spoken. " +
      "Correct filler words (um, uh, repeated words) silently without changing meaning. " +
      "Do NOT invent or infer anything not clearly stated in the transcript. " +
      "Respond with ONLY a single valid JSON object — no markdown, no code fences, no explanation before or after.";

  const userLabel = isFromChunks
    ? "Merge these partial meeting summaries into a single JSON analysis"
    : "Analyze the meeting transcript below and return ONLY a raw JSON object";

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
`${userLabel} with this EXACT structure. Do NOT wrap it in markdown or add any text outside the JSON.

{
  "title": "Concise descriptive meeting title (3-7 words, e.g. 'Q1 Budget Review Discussion' or 'Introduction — John Smith')",
  "participants": ["Full Name 1", "Full Name 2"],
  "overview": "A comprehensive, flowing summary of the entire meeting written as 2-3 rich paragraphs. Each paragraph should be 4-6 sentences minimum depending on the transcript length. Cover all major themes, context, decisions, outcomes, and the overall arc of the discussion. This must read like a professional meeting brief that someone who missed the meeting can rely on to be fully informed.",
  "bulletPoints": [
    "Key discussion point written as a full 1-3 sentence explanation with context, not a short fragment. Attribute to the speaker who raised it.",
    "Another important topic covered in the meeting, explained thoroughly with specifics mentioned during the discussion."
  ],
  "actionItems": [
    { "task": "Specific, concrete follow-up task described clearly", "owner": "Person or Team responsible", "deadline": "Mentioned deadline or TBD" }
  ],
  "questions": [
    "Important question, concern, or unresolved issue raised during the meeting, stated clearly with context"
  ]
}

QUALITY RULES — follow these strictly:

OVERVIEW section:
- Write exactly 100-150 words depending on the transcript length that is, if transcript is long then summary should also be.This overview must contain all the key discussion points and insights that were discussed in the meeting. (strictly enforced, count before submitting)
- 1-3 dense paragraphs (3-5 sentences per paragraph), no bullet points
- You must read the full transcript before writing this — do not skim
- Pack in everything: who attended, all topics discussed, every decision made, and the outcome
- Every sentence must carry new information — no filler, no repetition
- Introduce speakers by full name on first mention
- Think of it as a telegram — maximum information, minimum words

KEY POINTS (bulletPoints):
- Extract ALL significant discussion topics — aim for 3-8 points depending on the transcript length for a normal meeting
- Each point must be 1-3 full sentences explaining the topic with specifics (names, numbers, dates mentioned)
- Attribute each point to the speaker(s) who raised or discussed it
- NEVER leave this empty if the transcript has any substantive content
- Do NOT write short fragments like "Budget discussed" — write "Sarah presented the Q1 budget figures showing a 12% increase over projections, and the team discussed reallocation of funds to the marketing department."

ACTION ITEMS (actionItems):
- Include every concrete task, follow-up, or commitment mentioned
- Be specific about what needs to be done, not vague
- [] only if genuinely no tasks were mentioned

QUESTIONS (questions):
- Capture 3-8 important questions, concerns, open issues, or unresolved topics raised
- Include the context of why the question matters
- [] only if genuinely none were raised

GENERAL RULES:
- participants: only include real names explicitly spoken in the ${isFromChunks ? "summaries" : "transcript"}; [] if none identifiable
- All string values must be plain text — absolutely no markdown, no bullet symbols, no asterisks, no formatting
- Reproduce names, institutions, numbers, and statistics exactly as stated — do not paraphrase proper nouns
- Be thorough and detailed — a longer, richer summary is always preferred over a brief one

${isFromChunks ? "Partial summaries" : "Transcript"}:
${text}`,
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });
  } catch (err) {
    const detail = err.error?.message || err.message;
    throw new Error(`Groq API error: ${detail}`);
  }

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from Groq LLaMA 3.3 70B");
  }

  console.log("Groq raw response (first 300 chars):", content.slice(0, 300));

  // Strip markdown code fences
  let raw = content.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Extract the outermost {...} block (handles preamble/suffix text)
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    console.error("⚠️  No JSON object found in response. Raw:", raw.substring(0, 500));
    return {
      title: "Meeting Recording",
      participants: [],
      overview: raw || "Summary could not be generated.",
      bulletPoints: [],
      actionItems: [],
      questions: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    console.log("✅ JSON parsed successfully — keys:", Object.keys(parsed));
    parsed.bulletPoints = parsed.bulletPoints || [];
    parsed.actionItems  = parsed.actionItems  || [];
    parsed.questions    = parsed.questions    || [];
    parsed.participants = parsed.participants  || [];
    return parsed;
  } catch (parseErr) {
    console.error("⚠️  JSON parse failed. Extracted string (first 500 chars):", jsonStr.substring(0, 500));
    return {
      title:        "Meeting Recording",
      participants: [],
      overview:     "The meeting was recorded but the summary could not be fully parsed.",
      bulletPoints: [],
      actionItems:  [],
      questions:    [],
    };
  }
}

async function summarize(text, onProgress) {
  // Short enough → send the full transcript directly (well within 128K context)
  if (text.length <= MAX_DIRECT_CHARS) {
    console.log(
      `Transcript (${text.length} chars) fits in context — direct summarization…`
    );
    if (onProgress) onProgress("Generating meeting summary…");
    return await generateFinalSummary(text, false);
  }

  // Very long → chunk, summarize each section, then merge
  console.log(
    `Transcript (${text.length} chars) exceeds ${MAX_DIRECT_CHARS} — chunked summarization…`
  );

  const chunks = [];
  for (let i = 0; i < text.length; i += SUMMARY_CHUNK_CHARS) {
    chunks.push(text.slice(i, Math.min(i + SUMMARY_CHUNK_CHARS, text.length)));
  }
  console.log(`Split transcript into ${chunks.length} chunks for summarization`);

  const partialSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Summarizing chunk ${i + 1}/${chunks.length}…`);
    if (onProgress)
      onProgress(`Analyzing section ${i + 1} of ${chunks.length}…`);
    const partial = await summarizeChunk(chunks[i], i + 1, chunks.length);
    partialSummaries.push(partial);
    console.log(`  ✓ chunk ${i + 1} summary — ${partial.length} chars`);
  }

  const merged = partialSummaries.join("\n\n--- Next section ---\n\n");
  console.log(
    `Merging ${partialSummaries.length} partial summaries (${merged.length} chars)…`
  );
  if (onProgress) onProgress("Merging all sections into final summary…");
  return await generateFinalSummary(merged, true);
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
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch(e) { clearInterval(keepAlive); } }, 20000);
  req.on("close", () => clearInterval(keepAlive));
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
    clearInterval(keepAlive);
    return res.end();
  }

  let recordingUrl = null;
  let lastStatus = null;
  let lastSentStep = null;
  let waitingRoomCount = 0;

  for (let i = 0; i < 360; i++) {
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

    // Only send a status update when the status actually changes
    if (recallStatus !== lastStatus) {
      lastStatus = recallStatus;
      lastSentStep = recallStatus;
      console.log(`[${i + 1}] Status → ${recallStatus}`);
      const { step, msg } = mapStatus(recallStatus);
      send("status", { step, message: msg });
    }

    // Also check top-level fatal/error flags Recall sometimes puts outside status_changes
    if (data?.error || data?.fatal) {
      const errMsg = data.error?.message || data.fatal?.message || JSON.stringify(data.error || data.fatal);
      send("error", { message: `Bot encountered a fatal error: ${errMsg}` });
      activeBots.delete(meetLink);
      clearInterval(keepAlive);
      return res.end();
    }

    if (recallStatus === "in_waiting_room") {
      waitingRoomCount++;
      if (waitingRoomCount >= 9) {
        send("error", { message: "Bot was not admitted from the waiting room after 45 seconds." });
        activeBots.delete(meetLink);
        clearInterval(keepAlive);
        return res.end();
      }
    } else {
      waitingRoomCount = 0;
    }

    if (TERMINAL_FAIL.has(recallStatus)) {
      send("error", { message: `Bot failed: ${recallStatus}. ${latest?.message || ""}` });
      activeBots.delete(meetLink);
      clearInterval(keepAlive);
      return res.end();
    }

    if (TERMINAL_OK.has(recallStatus) ||
        (typeof data?.status === "string" && (data.status === "call_ended" || data.status === "done"))) {
      // Meeting ended — try up to 3 times to fetch the recording URL
      const MAX_RECORDING_RETRIES = 3;
      const RETRY_DELAY_MS = 30000; // 30 seconds between attempts
      for (let attempt = 1; attempt <= MAX_RECORDING_RETRIES; attempt++) {
        send("status", {
          step: "processing",
          message: `🎙 Meeting ended — fetching recording (attempt ${attempt}/${MAX_RECORDING_RETRIES}), waiting 30s…`,
        });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        try {
          const freshData = await getBot(botId);
          const recordings = freshData?.recordings || [];
          if (recordings.length > 0) {
            recordingUrl =
              recordings[0].media_shortcuts?.audio_mixed?.data?.download_url ||
              recordings[0].media_shortcuts?.video_mixed?.data?.download_url ||
              recordings[0].download_url ||
              recordings[0].url;
          }
        } catch (e) {
          console.warn(`Recording fetch attempt ${attempt} failed:`, e.message);
        }
        if (recordingUrl) {
          send("status", { step: "processing", message: `✅ Recording found on attempt ${attempt}!` });
          break;
        }
        if (attempt < MAX_RECORDING_RETRIES) {
          send("status", {
            step: "processing",
            message: `⚠️ No recording yet — will retry (${MAX_RECORDING_RETRIES - attempt} attempt(s) left)…`,
          });
        }
      }
      break;
    }
  }

  // If all retries failed, give a clear error
  if (!recordingUrl) {
    send("error", { message: "No recording URL found after 3 attempts. The recording may still be processing — check your Recall.ai dashboard." });
    activeBots.delete(meetLink);
    clearInterval(keepAlive);
    return res.end();
  }

  // ── Step 3: Transcribe ────────────────────────────────
  send("status", { step: "transcribing", message: "🔊 Audio found. Sending to Whisper…" });
  let transcript;
  try {
    transcript = await transcribe(recordingUrl, (msg) =>
      send("status", { step: "transcribing", message: "🔊 " + msg })
    );
    send("status", { step: "transcribing", message: `✅ Transcript ready (${transcript.length} chars)…` });
    send("transcript", { text: transcript });
  } catch (err) {
    send("error", { message: `Whisper transcription failed: ${err.message}` });
    activeBots.delete(meetLink);
    clearInterval(keepAlive);
    return res.end();
  }

  // ── Step 4: Summarize ─────────────────────────────────
  send("status", { step: "summarizing", message: "✨ Analyzing and structuring meeting data…" });
  let meetingData;
  try {
    meetingData = await summarize(transcript, (msg) =>
      send("status", { step: "summarizing", message: "✨ " + msg })
    );
  } catch (err) {
    console.error("Summarization error:", err.message);
    send("error", { message: `Summarization failed: ${err.message}` });
    activeBots.delete(meetLink);
    clearInterval(keepAlive);
    return res.end();
  }

  // ── Step 5: S3 ────────────────────────────────────────
  const fullData = { ...meetingData, transcript };
  const s3Key = await uploadToS3(fullData, uid);

  activeBots.delete(meetLink);
  clearInterval(keepAlive);
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