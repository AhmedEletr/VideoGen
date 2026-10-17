import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import readline from 'readline';

// LLM SDK
import { Groq } from 'groq-sdk';

// Neural TTS Libraries
import { EdgeTTS } from '@andresaya/edge-tts';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// Headless Browser & Screen Recording
import puppeteer from 'puppeteer';
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder';

// Video & Audio Processing
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Pollinations AI Configuration
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

// Strict Duration Target: 3 mins (180s) to 3.5 mins (210s). Locked target: 195s (3m 15s)
const TARGET_MIN_SECONDS = 180;
const TARGET_MAX_SECONDS = 210;
const TARGET_TOTAL_SECONDS = 195;

// Supported Languages Configuration
const SUPPORTED_LANGUAGES = {
  en: {
    code: 'en',
    name: 'English',
    voice: 'en-US-ChristopherNeural',
    dir: 'ltr',
    font: "'Nunito', sans-serif",
    badge: 'ENGLISH MASTERCLASS'
  },
  de: {
    code: 'de',
    name: 'German',
    voice: 'de-DE-ConradNeural',
    dir: 'ltr',
    font: "'Nunito', sans-serif",
    badge: 'EXECUTIVE MASTERCLASS'
  },
  gr: {
    code: 'de',
    name: 'German',
    voice: 'de-DE-ConradNeural',
    dir: 'ltr',
    font: "'Nunito', sans-serif",
    badge: 'EXECUTIVE MASTERCLASS'
  },
  fr: {
    code: 'fr',
    name: 'French',
    voice: 'fr-FR-HenriNeural',
    dir: 'ltr',
    font: "'Nunito', sans-serif",
    badge: 'MASTERCLASS EXÉCUTIF'
  },
  ar: {
    code: 'ar',
    name: 'Arabic',
    voice: 'ar-EG-ShakirNeural',
    dir: 'rtl',
    font: "'Cairo', 'Tajawal', sans-serif",
    badge: 'ماستر كلاس تنفيذي'
  },
  jp: {
    code: 'jp',
    name: 'Japanese',
    voice: 'ja-JP-KeitaNeural',
    dir: 'rtl', // Assigned to Arabic RTL template layout as requested
    font: "'Cairo', 'Tajawal', sans-serif",
    badge: 'エグゼクティブ・マスタークラス'
  },
  ja: {
    code: 'jp',
    name: 'Japanese',
    voice: 'ja-JP-KeitaNeural',
    dir: 'rtl',
    font: "'Cairo', 'Tajawal', sans-serif",
    badge: 'エグゼクティブ・マスタークラス'
  }
};

// Video Specifications (30 FPS, 1080p Full HD)
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const FPS = 30;

// Directories
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_DIR = path.join(__dirname, '.temp');
const FINAL_OUTPUT_VIDEO = path.join(__dirname, 'output.mp4');
const PRESENTATION_HTML = path.join(__dirname, 'video.html');

// Configure static FFmpeg / FFprobe
const resolvedFfmpeg = typeof ffmpegStatic === 'string' ? ffmpegStatic : (ffmpegStatic?.path || ffmpegStatic?.default);
const resolvedFfprobe = typeof ffprobeStatic === 'string' ? ffprobeStatic : (ffprobeStatic?.path || ffprobeStatic?.default);

if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg);
if (resolvedFfprobe) ffmpeg.setFfprobePath(resolvedFfprobe);

// ============================================================================
// 2. LIVE TERMINAL TIMER & PROGRESS BAR
// ============================================================================
class ProgressTracker {
  constructor() {
    this.startTime = Date.now();
    this.currentPercent = 0;
    this.statusMessage = 'Initializing...';
    this.intervalId = null;
  }

  start() {
    this.intervalId = setInterval(() => this.render(), 250);
  }

  update(percent, message) {
    this.currentPercent = Math.min(100, Math.max(0, percent));
    if (message) this.statusMessage = message;
    this.render();
  }

  log(msg) {
    process.stdout.write('\r\x1b[K');
    console.log(msg);
    this.render();
  }

  render() {
    const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
    const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');
    const barWidth = 24;
    const filled = Math.round((this.currentPercent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled));

    const line = `⏳ [${m}:${s}] [${bar}] ${String(this.currentPercent).padStart(3, ' ')}% • ${this.statusMessage}`;
    process.stdout.write(`\r\x1b[K${line}`);
  }

  finish() {
    if (this.intervalId) clearInterval(this.intervalId);
    process.stdout.write('\r\x1b[K');
    const totalSec = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m > 0 ? `${m}m ` : ''}${s}s`;
  }
}

const tracker = new ProgressTracker();

// ============================================================================
// 3. HELPER UTILITIES & USER PROMPT
// ============================================================================
function initDirectories() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function getUserInput() {
  const args = process.argv.slice(2);
  let topic = "";
  let langCode = "en";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang' && args[i + 1]) {
      langCode = args[i + 1].toLowerCase();
      args.splice(i, 2);
      break;
    }
  }
  topic = args.join(' ').trim();

  if (topic && SUPPORTED_LANGUAGES[langCode]) {
    return { topic, lang: SUPPORTED_LANGUAGES[langCode] };
  }

  if (!process.stdin.isTTY) {
    return {
      topic: topic || "The Evolution of Artificial Intelligence: From Turing Machines to Autonomous Agents",
      lang: SUPPORTED_LANGUAGES[langCode] || SUPPORTED_LANGUAGES.en
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n💡 Enter presentation topic [Default: The Evolution of Artificial Intelligence]: ', (topicAnswer) => {
      rl.question('🌐 Choose language [en, ar, fr, de, jp] (Default: en): ', (langAnswer) => {
        rl.close();
        const cleanedLang = (langAnswer.trim().toLowerCase() || 'en');
        const resolvedLang = SUPPORTED_LANGUAGES[cleanedLang] || SUPPORTED_LANGUAGES.en;
        const resolvedTopic = topicAnswer.trim() || "The Evolution of Artificial Intelligence: From Turing Machines to Autonomous Agents";
        resolve({ topic: resolvedTopic, lang: resolvedLang });
      });
    });
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata?.format?.duration;
      resolve(typeof duration === 'number' ? duration : parseFloat(duration) || 13.0);
    });
  });
}

function padAudioWithSilence(inputPath, outputPath, padSeconds = 1.0) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(`apad=pad_dur=${Math.max(0.1, padSeconds).toFixed(3)}`)
      .outputOptions(['-c:a libmp3lame', '-b:a 192k'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

function applyTempo(inputPath, outputPath, tempo) {
  const filters = [];
  let t = tempo;
  while (t > 2.0) {
    filters.push('atempo=2.0');
    t = t / 2.0;
  }
  while (t < 0.5) {
    filters.push('atempo=0.5');
    t = t / 0.5;
  }
  filters.push(`atempo=${Math.max(0.5, Math.min(2.0, t)).toFixed(4)}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filters.join(','))
      .outputOptions(['-c:a libmp3lame', '-b:a 192k'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

function concatenateAudioFiles(audioFilePaths, outputPath) {
  return new Promise((resolve, reject) => {
    const concatListPath = path.join(TEMP_DIR, 'audio_concat_manifest.txt');
    const manifestContent = audioFilePaths
      .map(file => `file '${path.resolve(file).replace(/\\/g, '/')}'`)
      .join('\n');

    fs.writeFileSync(concatListPath, manifestContent, 'utf-8');

    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:a libmp3lame', '-b:a 192k'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

function multiplexVideoAndAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-r 30',
        '-crf 18',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 192k',
        '-shortest'
      ])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

function cleanUnicodeAndSymbols(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Replaced Base64 with direct file URL to prevent heavy file bloat
function getFileDirectUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return pathToFileURL(path.resolve(filePath)).href;
}

// ============================================================================
// 4. POLLINATIONS AI IMAGE GENERATOR
// ============================================================================
async function generatePollinationsImage(prompt, filename) {
  const outputPath = path.join(TEMP_DIR, filename);
  const cleanPrompt = (prompt || "futuristic high tech laboratory, 8k realistic cinematic lighting").trim().slice(0, 140);
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&nologo=true`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` },
      signal: AbortSignal.timeout(28000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

    const arrayBuffer = await response.arrayBuffer();
    await fs.promises.writeFile(outputPath, Buffer.from(arrayBuffer));
    return outputPath;
  } catch (err) {
    tracker.log(`  ⚠️ Pollinations API fallback for [${filename}]: ${err.message}`);
    return createSvgFallbackImage(outputPath, cleanPrompt);
  }
}

function createSvgFallbackImage(outputPath, prompt) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0F172A"/>
        <stop offset="50%" stop-color="#1E293B"/>
        <stop offset="100%" stop-color="#0F2847"/>
      </linearGradient>
    </defs>
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <circle cx="512" cy="512" r="260" fill="#2563EB" opacity="0.15"/>
    <circle cx="512" cy="512" r="160" fill="#10B981" opacity="0.2"/>
    <rect x="262" y="472" width="500" height="80" rx="14" fill="#1E293B" opacity="0.8"/>
    <text x="512" y="522" font-family="'Nunito', Arial, sans-serif" font-size="28" font-weight="bold" fill="#F8FAFC" text-anchor="middle">
      ${cleanUnicodeAndSymbols(prompt.slice(0, 36))}
    </text>
  </svg>`;
  fs.writeFileSync(outputPath, Buffer.from(svg));
  return outputPath;
}

// ============================================================================
// 4b. SELF-HEALING JSON PARSER (LLM OUTPUT EXTRACTION -> REPAIR -> VALIDATE)
// ============================================================================
// --- JSON REPAIR HELPERS START ---
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const JSON_LITERAL_FIXES = {
  undefined: 'null', NaN: 'null', None: 'null', Infinity: 'null',
  True: 'true', False: 'false'
};

function stripCodeFencesAndPreamble(text) {
  if (typeof text !== 'string') return '';
  let s = text.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\u2060]/g, '');
  s = s.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const start = s.indexOf('{');
  return start === -1 ? '' : s.slice(start);
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text), error: null };
  } catch (err) {
    return { ok: false, value: null, error: err.message };
  }
}

function nextMeaningfulChar(str, index) {
  for (let i = index; i < str.length; i++) {
    const c = str[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    return c;
  }
  return '';
}

function previousMeaningfulChar(str) {
  for (let i = str.length - 1; i >= 0; i--) {
    const c = str[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    return c;
  }
  return '';
}

function closesForStack(stack) {
  return stack.slice().reverse().map(open => (open === '{' ? '}' : ']')).join('');
}

function scanOpenStack(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return stack;
}
/**
 * Character-level JSON healer. Fixes the classic LLM mistakes:
 * unescaped inner double quotes, raw newlines/tabs inside strings, illegal
 * escape sequences (\'), single-quoted strings, unquoted keys, JS literals
 * (undefined/NaN/True/False), trailing commas, comments, stray/missing
 * brackets and truncated tails.
 */
function repairLooseJson(input) {
  const s = stripCodeFencesAndPreamble(input);
  if (!s) return '';

  let out = '';
  const stack = [];
  let inString = false;
  let escaped = false;
  let quoteChar = '"';
  let rootClosed = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // -------------------- inside a string --------------------
    if (inString) {
      if (escaped) {
        if ('"\\/bfnrtu'.includes(ch)) out += '\\' + ch;  // keep legal JSON escapes
        else if (ch === "'") out += "'";                  // drop illegal \' escape
        else out += ch;                                   // drop illegal \x style escape
        escaped = false;
        continue;
      }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch < ' ') continue;                             // strip remaining raw control chars
      if (ch === quoteChar) {
        const next = nextMeaningfulChar(s, i + 1);
        if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false;
          out += '"';
          continue;
        }
        out += (quoteChar === '"' ? '\\"' : "'");         // stray inner quote -> escape it
        continue;
      }
      if (ch === '"') { out += '\\"'; continue; }         // double quote inside a single-quoted string
      out += ch;
      continue;
    }

    // -------------------- outside any string --------------------
    if (ch === '"' || ch === "'") {
      const prev = previousMeaningfulChar(out);
      if (prev === '"' || prev === '}' || prev === ']' || /[0-9]/.test(prev)) out += ','; // missing comma
      quoteChar = ch;
      inString = true;
      out += '"';
      continue;
    }

    if (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {   // strip comments
      if (s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; }
      else { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; }
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const wordMatch = s.slice(i).match(/^[A-Za-z0-9_$]+/);
      const word = wordMatch ? wordMatch[0] : ch;
      const prev = previousMeaningfulChar(out);
      if (Object.prototype.hasOwnProperty.call(JSON_LITERAL_FIXES, word) && (prev === ':' || prev === ',' || prev === '[')) {
        out += JSON_LITERAL_FIXES[word];
        i += word.length - 1;
        continue;
      }
      if (prev === '{' || prev === ',') {                 // unquoted key -> quote it
        out += '"' + word + '"';
        i += word.length - 1;
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === ',') {
      const next = nextMeaningfulChar(s, i + 1);
      if (next === '' || next === '}' || next === ']') continue;    // trailing comma
      out += ',';
      continue;
    }

    if (ch === '{' || ch === '[') {
      const prev = previousMeaningfulChar(out);
      if (prev === '}' || prev === ']' || prev === '"' || /[0-9]/.test(prev)) out += ','; // missing comma
      stack.push(ch);
      out += ch;
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (stack.length === 0) continue;                   // stray closer
      stack.pop();
      out += ch;
      if (stack.length === 0) { rootClosed = true; break; }  // ignore trailing commentary
      continue;
    }

    out += ch;
  }

  if (!rootClosed) {                                      // truncated tail -> close it cleanly
    if (inString) out += '"';
    out = out.replace(/,\s*$/, '').replace(/:\s*$/, 'null');
    out += closesForStack(stack);
  }
  return { text: out, truncated: !rootClosed };
}

function parseLooseJson(input) {
  const { text: repaired, truncated } = repairLooseJson(input);
  if (!repaired) {
    return { ok: false, value: null, error: 'No JSON object found in the model response.', repaired: '', truncated: true };
  }

  const direct = tryParseJson(repaired);
  if (direct.ok) return { ...direct, repaired, truncated };

  // Deeper truncation recovery: walk back to the last completed container
  const closers = [];
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '}' || repaired[i] === ']') closers.push(i);
  }
  for (let k = closers.length - 1; k >= 0; k--) {
    const slice = repaired.slice(0, closers[k] + 1).replace(/,\s*$/, '');
    const candidate = slice + closesForStack(scanOpenStack(slice));
    const attempt = tryParseJson(candidate);
    if (attempt.ok) return { ...attempt, repaired: candidate, truncated: true };
  }

  return { ok: false, value: null, error: direct.error, repaired, truncated };
}
// --- JSON REPAIR HELPERS END ---

// ============================================================================
// 5. STEP 1: STRONG MODEL PROMPT FOR ALL SLIDES & DATA
// ============================================================================
async function generatePresentationContent(topic, lang) {
  tracker.update(8, `Requesting ${lang.name} curriculum from model (${GROQ_MODEL})...`);
  const groq = new Groq({ apiKey: GROQ_API_KEY });

  const systemPrompt = `You are a world-class executive presentation architect and computational researcher.
Generate a structured, deeply comprehensive 15-SLIDE presentation about: "${topic}".

LANGUAGE REQUIREMENTS:
- Primary Language: Write ALL presentation text, headings, bodies, descriptions, and narrations in ${lang.name.toUpperCase()} (${lang.code}).
- If Arabic (ar), write in fluent, authoritative, standard academic Arabic (فصحى معاصرة رصينة).
- NUMBERS RULE: ALWAYS use standard Western Latin numerals (1, 2, 3, 4, 5, 6, 7, 8, 9, 0) even in Arabic or Japanese text. NEVER output Eastern Arabic numerals (like ١, ٢, ٣).
- CHARTS RULE: For all chartLabels and chart syntax, ONLY use English ASCII characters (e.g., '1B', '7B', '70B', 'Inference (40%)', 'Vector RAG (25%)', 'Safety (20%)', '2022', '2023', etc.) to ensure 100% stable QuickChart rendering.

NARRATION REQUIREMENTS:
- Target video duration is strictly ~195 seconds (3m 15s).
- Exactly 15 slides.
- EACH slide's "narration" MUST contain between 30 and 42 spoken words in ${lang.name} (~11 to 13 seconds of measured speech).

SLIDE ARCHITECTURE SPECIFICATION (JSON Output):
Return ONLY a valid JSON object matching this schema:
{
  "topic": "${topic}",
  "shortTitle": "4-word summary in ${lang.name}",
  "slides": [
    {
      "slideNumber": 1,
      "type": "cover",
      "mainTitle": "Grand title in ${lang.name}",
      "subtitle": "Subtitle in ${lang.name}",
      "pill1": "Badge 1", "pill2": "Badge 2", "pill3": "Badge 3",
      "narration": "Spoken script in ${lang.name} (30-40 words)"
    },
    {
      "slideNumber": 2,
      "type": "pillars_grid",
      "tag": "MODULE 01",
      "heading": "Heading in ${lang.name}",
      "pillars": [
        { "num": "01", "icon": "bx-cube", "title": "...", "desc": "...", "keyMetric": "..." },
        { "num": "02", "icon": "bx-chip", "title": "...", "desc": "...", "keyMetric": "..." },
        { "num": "03", "icon": "bx-layer", "title": "...", "desc": "...", "keyMetric": "..." },
        { "num": "04", "icon": "bx-robot", "title": "...", "desc": "...", "keyMetric": "..." }
      ],
      "narration": "..."
    },
    {
      "slideNumber": 3,
      "type": "comparison_table",
      "tag": "MODULE 02",
      "heading": "Heading in ${lang.name}",
      "tableHeaders": ["Header1", "Header2", "Header3", "Header4"],
      "tableRows": [
        ["Dim 1", "Trad 1", "Adv 1", "Benchmark 1"],
        ["Dim 2", "Trad 2", "Adv 2", "Benchmark 2"],
        ["Dim 3", "Trad 3", "Adv 3", "Benchmark 3"],
        ["Dim 4", "Trad 4", "Adv 4", "Benchmark 4"],
        ["Dim 5", "Trad 5", "Adv 5", "Benchmark 5"],
        ["Dim 6", "Trad 6", "Adv 6", "Benchmark 6"]
      ],
      "narration": "..."
    },
    {
      "slideNumber": 4,
      "type": "image_cards",
      "tag": "MODULE 03",
      "heading": "Heading in ${lang.name}",
      "cards": [
        { "badge": "EPOCH 01", "title": "...", "description": "...", "spec1": "...", "spec2": "...", "imagePrompt": "English image prompt (under 12 words)" },
        { "badge": "EPOCH 02", "title": "...", "description": "...", "spec1": "...", "spec2": "...", "imagePrompt": "English image prompt" },
        { "badge": "EPOCH 03", "title": "...", "description": "...", "spec1": "...", "spec2": "...", "imagePrompt": "English image prompt" }
      ],
      "narration": "..."
    },
    {
      "slideNumber": 5,
      "type": "bar_chart",
      "tag": "MODULE 04",
      "heading": "Heading in ${lang.name}",
      "chartTitle": "Title in ${lang.name}",
      "takeaways": ["Point 1", "Point 2", "Point 3"],
      "metaCallout": "Meta text",
      "chartLabels": ["1B", "7B", "14B", "70B", "120B", "405B", "1T+"],
      "narration": "..."
    },
    {
      "slideNumber": 6,
      "type": "deep_dive",
      "tag": "MODULE 05",
      "heading": "Heading in ${lang.name}",
      "card1Title": "Title 1", "card1Desc": "Detailed paragraph 1", "card1Pills": ["Pill 1", "Pill 2", "Pill 3"], "image1Prompt": "English prompt",
      "card2Title": "Title 2", "card2Desc": "Detailed paragraph 2", "card2Pills": ["Pill 1", "Pill 2", "Pill 3"], "image2Prompt": "English prompt",
      "narration": "..."
    },
    {
      "slideNumber": 7,
      "type": "timeline",
      "tag": "MODULE 06",
      "heading": "Heading in ${lang.name}",
      "timelineSteps": [
        { "step": "PHASE 01", "title": "...", "desc": "...", "metaSpec": "...", "icon": "bx-data" },
        { "step": "PHASE 02", "title": "...", "desc": "...", "metaSpec": "...", "icon": "bx-code" },
        { "step": "PHASE 03", "title": "...", "desc": "...", "metaSpec": "...", "icon": "bx-git-merge" },
        { "step": "PHASE 04", "title": "...", "desc": "...", "metaSpec": "...", "icon": "bx-rocket" }
      ],
      "narration": "..."
    },
    {
      "slideNumber": 8,
      "type": "doughnut_chart",
      "tag": "MODULE 07",
      "heading": "Heading in ${lang.name}",
      "chartTitle": "Title in ${lang.name}",
      "insights": [
        { "title": "Allocation 1", "desc": "Desc 1" },
        { "title": "Allocation 2", "desc": "Desc 2" },
        { "title": "Allocation 3", "desc": "Desc 3" }
      ],
      "metaCallout": "Meta text",
      "chartLabels": ["Inference (40%)", "Vector RAG (25%)", "Safety (20%)", "Fine-Tuning (15%)"],
      "chartValues": [40, 25, 20, 15],
      "narration": "..."
    },
    {
      "slideNumber": 9,
      "type": "big_stat",
      "tag": "MODULE 08",
      "heading": "Heading in ${lang.name}",
      "statNumber": "99.4%",
      "statLabel": "Deterministic Rating",
      "description": "Comprehensive description",
      "supportingPoints": [
        { "title": "Point 1", "desc": "Desc 1", "icon": "bx-check-shield" },
        { "title": "Point 2", "desc": "Desc 2", "icon": "bx-lock-alt" },
        { "title": "Point 3", "desc": "Desc 3", "icon": "bx-sync" }
      ],
      "narration": "..."
    },
    {
      "slideNumber": 10,
      "type": "line_chart",
      "tag": "MODULE 09",
      "heading": "Heading in ${lang.name}",
      "chartTitle": "Adoption Velocity",
      "takeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"],
      "metaCallout": "Meta text",
      "chartLabels": ["2022 (Chat)", "2023 (RAG)", "2024 (Tools)", "2025 (Swarm)", "2026 (Auto)"],
      "narration": "..."
    },
    {
      "slideNumber": 11,
      "type": "mindmap",
      "tag": "MODULE 10",
      "heading": "Heading in ${lang.name}",
      "centerNode": "Agent Runtime",
      "centerSubtitle": "6-Vector Engine",
      "branches": [
        { "num": "VECTOR 01", "icon": "bx-list-check", "title": "...", "detail": "...", "submeta": "..." },
        { "num": "VECTOR 02", "icon": "bx-server", "title": "...", "detail": "...", "submeta": "..." },
        { "num": "VECTOR 03", "icon": "bx-wrench", "title": "...", "detail": "...", "submeta": "..." },
        { "num": "VECTOR 04", "icon": "bx-analyse", "title": "...", "detail": "...", "submeta": "..." },
        { "num": "VECTOR 05", "icon": "bx-shield-quarter", "title": "...", "detail": "...", "submeta": "..." },
        { "num": "VECTOR 06", "icon": "bx-refresh", "title": "...", "detail": "...", "submeta": "..." }
      ],
      "narration": "..."
    },
    {
      "slideNumber": 12,
      "type": "case_study",
      "tag": "MODULE 11",
      "heading": "Heading in ${lang.name}",
      "metricTag": "+410% NET EFFICIENCY",
      "casePill": "ENTERPRISE REAL-WORLD CASE",
      "caseTitle": "Title in ${lang.name}",
      "caseSummary": "In-depth case summary paragraph",
      "stat1Val": "99.98%", "stat1Lbl": "Accuracy Agreement",
      "stat2Val": "8 min", "stat2Lbl": "Cycle Time",
      "stat3Val": "0.02%", "stat3Lbl": "False Positives",
      "caseImagePrompt": "English image prompt",
      "narration": "..."
    },
    {
      "slideNumber": 13,
      "type": "tradeoffs_matrix",
      "tag": "MODULE 12",
      "heading": "Heading in ${lang.name}",
      "strengthsTitle": "Core Advantages",
      "strengths": ["Advantage 1", "Advantage 2", "Advantage 3"],
      "strengthsImagePrompt": "English image prompt",
      "challengesTitle": "Operational Hazards",
      "challenges": ["Hazard 1", "Hazard 2", "Hazard 3"],
      "challengesImagePrompt": "English image prompt",
      "narration": "..."
    },
    {
      "slideNumber": 14,
      "type": "checklist_framework",
      "tag": "MODULE 13",
      "heading": "Heading in ${lang.name}",
      "checklist": [
        { "phase": "GATE 01 • READINESS", "task": "...", "desc": "...", "deliverable": "..." },
        { "phase": "GATE 02 • SHADOW RUN", "task": "...", "desc": "...", "deliverable": "..." },
        { "phase": "GATE 03 • CANARY ROLLOUT", "task": "...", "desc": "...", "deliverable": "..." },
        { "phase": "GATE 04 • GOVERNANCE", "task": "...", "desc": "...", "deliverable": "..." }
      ],
      "narration": "..."
    },
    {
      "slideNumber": 15,
      "type": "quote_summary",
      "tag": "MODULE 14",
      "heading": "Heading in ${lang.name}",
      "quote": "Authentic inspirational quote from computing history",
      "quoteAuthor": "Edsger W. Dijkstra",
      "authorTitle": "Turing Award Laureate & Computing Pioneer",
      "card1Title": "Key Takeaway 1", "card1Desc": "Takeaway desc 1",
      "card2Title": "Key Takeaway 2", "card2Desc": "Takeaway desc 2",
      "callout": "CURRICULUM FINISHED • READY FOR PRACTICAL LABS",
      "narration": "..."
    }
  ]
}
Return pure JSON with zero markdown quotes or commentary.`;

  const userPrompt = `Generate the complete 15-slide educational presentation JSON in ${lang.name} for: "${topic}". Always use Western Latin numerals (1, 2, 3...) and English-only chart syntax.`;

  const MAX_ATTEMPTS = 3;
  const EXPECTED_SLIDES = 15;
  let lastErrorMessage = 'Invalid JSON returned by the model';
  let bestPartialDeck = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      tracker.update(8, `Retrying ${lang.name} curriculum generation (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    }

    let rawContent = '';
    let finishReason = '';
    try {
      const completion = await requestPresentationCompletion(groq, systemPrompt, userPrompt, attempt);
      rawContent = completion.choices[0]?.message?.content || '';
      finishReason = completion.choices[0]?.finish_reason || '';
    } catch (apiError) {
      const apiMessage = apiError?.message || String(apiError);
      if (/api key|unauthorized|invalid_api_key|401|403/i.test(apiMessage)) throw apiError;
      lastErrorMessage = apiMessage;
      const retryHint = /try again in ([\d.]+)s/i.exec(apiMessage);
      const waitMs = retryHint ? Math.min(65000, Math.ceil(parseFloat(retryHint[1]) * 1000) + 1500) : 1500 * attempt;
      tracker.log(`  ⚠️ Groq request failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${apiMessage.slice(0, 180)}`);
      if (waitMs > 4000) tracker.log(`  ⏳ Waiting ${(waitMs / 1000).toFixed(0)}s for the rate-limit window...`);
      await sleep(waitMs);
      continue;
    }

    if (!rawContent.trim()) {
      lastErrorMessage = "Groq API returned an empty response.";
      tracker.log(`  ⚠️ Empty response (attempt ${attempt}/${MAX_ATTEMPTS}).`);
      await sleep(1000);
      continue;
    }

    const parseResult = parseLooseJson(rawContent);
    const data = parseResult.value;
    const slideCount = Array.isArray(data?.slides) ? data.slides.length : 0;
    const looksIncomplete = finishReason === 'length' || parseResult.truncated === true;

    if (parseResult.ok && slideCount > 0) {
      if (slideCount >= EXPECTED_SLIDES || !looksIncomplete) {
        if (attempt > 1) tracker.log('  ✅ Recovered valid slide JSON on retry.');
        return finalizePresentationData(data, topic);
      }

      if (!bestPartialDeck || slideCount > bestPartialDeck.slides.length) bestPartialDeck = data;
      lastErrorMessage = `Truncated model response (${slideCount}/${EXPECTED_SLIDES} slides, finish_reason="${finishReason || 'unknown'}")`;
      tracker.log(`  ⚠️ ${lastErrorMessage} — retrying for a complete deck...`);
      await sleep(4000);
      continue;
    }

    lastErrorMessage = parseResult.error || 'Unrecoverable JSON structure';
    const dumpPath = path.join(TEMP_DIR, `failed_json_attempt_${attempt}.txt`);
    try { fs.writeFileSync(dumpPath, rawContent, 'utf-8'); } catch (writeErr) { /* non-fatal */ }
    tracker.log(`  ⚠️ Invalid JSON (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastErrorMessage}`);
    tracker.log(`  📄 Raw model response saved to: ${dumpPath}`);
    await sleep(1200);
  }

  if (bestPartialDeck) {
    tracker.log(`  ⚠️ Using the best recovered deck (${bestPartialDeck.slides.length} slides) after ${MAX_ATTEMPTS} attempts.`);
    return finalizePresentationData(bestPartialDeck, topic);
  }

  throw new Error(`Failed to parse model response after ${MAX_ATTEMPTS} attempts: ${lastErrorMessage}`);
}

// Groq JSON mode (guarantees syntactically valid JSON when supported) with graceful fallback
async function requestPresentationCompletion(groq, systemPrompt, userPrompt, attempt) {
  const messageList = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
  // The account tier caps output tokens per minute, so walk the budget down if Groq rejects it
  const budgets = [8000, 5000, 2500];

  for (let i = 0; i < budgets.length; i++) {
    const payload = {
      model: GROQ_MODEL,
      messages: messageList,
      temperature: attempt === 1 ? 0.25 : 0.15,
      max_tokens: budgets[i]
    };

    try {
      return await groq.chat.completions.create({ ...payload, response_format: { type: "json_object" } });
    } catch (err) {
      const message = err?.message || String(err);

      if (/response_format|json_object|json mode/i.test(message)) {
        tracker.log('  ℹ️ JSON mode unsupported by this model — using self-healing parser fallback.');
        return await groq.chat.completions.create(payload);
      }

      const budgetRejected = /Request too large|output tokens per minute|reduce the length|tokens_limit_reached/i.test(message);
      if (budgetRejected && i < budgets.length - 1) {
        tracker.log(`  ⚠️ Output budget of ${budgets[i]} tokens rejected by the rate limit — retrying with ${budgets[i + 1]}.`);
        continue;
      }

      throw err;
    }
  }
}

function finalizePresentationData(data, topic) {
  if (!data.topic) data.topic = topic;
  if (!data.shortTitle) {
    const words = String(topic).split(/\s+/).filter(Boolean);
    data.shortTitle = words.slice(0, 4).join(' ') || 'Curriculum Overview';
  }
  data.slides = (data.slides || []).filter(slide => slide && typeof slide === 'object');
  if (data.slides.length < 15) {
    tracker.log(`  ⚠️ Model returned ${data.slides.length} slides (expected 15) — continuing with available slides.`);
  }
  return data;
}

// ============================================================================
// 6. STEP 2: GENERATE IMAGES WITH POLLINATIONS AI (NO BASE64)
// ============================================================================
async function generateAllDeckImages(slides, topic) {
  tracker.update(20, 'Generating visual assets via Pollinations AI...');

  // Slide 4: 3 Tall Image Cards
  const cardsSlide = slides.find(s => s.type === 'image_cards');
  if (cardsSlide && Array.isArray(cardsSlide.cards)) {
    for (let i = 0; i < cardsSlide.cards.length; i++) {
      tracker.update(22 + i * 2, `Generating Image Card ${i + 1}/3...`);
      const card = cardsSlide.cards[i];
      const p = card.imagePrompt || `${card.title || 'computing infrastructure'}, photorealistic 8k`;
      const file = await generatePollinationsImage(p, `card_image_${i}.png`);
      card.imageLocalUrl = getFileDirectUrl(file);
    }
  }

  // Slide 6: Deep Dive (2 Images)
  const diveSlide = slides.find(s => s.type === 'deep_dive');
  if (diveSlide) {
    tracker.update(28, 'Generating Deep Dive Visuals (1/2)...');
    const p1 = diveSlide.image1Prompt || "neural vector representation, hyperrealistic 8k";
    const f1 = await generatePollinationsImage(p1, 'deep_dive_1.png');
    diveSlide.image1LocalUrl = getFileDirectUrl(f1);

    tracker.update(30, 'Generating Deep Dive Visuals (2/2)...');
    const p2 = diveSlide.image2Prompt || "cybersecurity holographic shield protection network 8k";
    const f2 = await generatePollinationsImage(p2, 'deep_dive_2.png');
    diveSlide.image2LocalUrl = getFileDirectUrl(f2);
  }

  // Slide 12: Case Study
  const caseSlide = slides.find(s => s.type === 'case_study');
  if (caseSlide) {
    tracker.update(34, 'Generating Real-World Case Study Visual...');
    const pCase = caseSlide.caseImagePrompt || "clinical medical AI diagnostic analysis 8k";
    const fCase = await generatePollinationsImage(pCase, 'case_study.png');
    caseSlide.caseImageLocalUrl = getFileDirectUrl(fCase);
  }

  // Slide 13: Tradeoffs Matrix (2 Images)
  const tradeSlide = slides.find(s => s.type === 'tradeoffs_matrix');
  if (tradeSlide) {
    tracker.update(36, 'Generating Tradeoffs Visuals (Strengths)...');
    const pS = tradeSlide.strengthsImagePrompt || "code matrix security cyber network 8k";
    const fS = await generatePollinationsImage(pS, 'tradeoff_strengths.png');
    tradeSlide.strengthsImageLocalUrl = getFileDirectUrl(fS);

    tracker.update(38, 'Generating Tradeoffs Visuals (Challenges)...');
    const pC = tradeSlide.challengesImagePrompt || "server room hardware thermal overload 8k";
    const fC = await generatePollinationsImage(pC, 'tradeoff_challenges.png');
    tradeSlide.challengesImageLocalUrl = getFileDirectUrl(fC);
  }
}

// ============================================================================
// 7. STEP 3: HTML TEMPLATE ENGINE (RTL & LTR SUPPORT)
// ============================================================================
function buildPresentationHTML(data, lang) {
  // Use RTL Arabic template for ar, jp, ja; LTR for en, de, fr
  const isRTL = (lang.code === 'ar' || lang.code === 'jp' || lang.code === 'ja');
  const dir = isRTL ? 'rtl' : 'ltr';

  const slidesHtml = data.slides.map((slide, index) => {
    let innerContent = '';
    const safeTag = cleanUnicodeAndSymbols(slide.tag || `MODULE 0${index + 1}`);
    const safeHeading = cleanUnicodeAndSymbols(slide.heading || '');

    switch (slide.type) {
      case 'cover':
        innerContent = `
          <div class="cover-simple-container">
            <div class="cover-text-side">
              <h1 class="cover-main-title anim-item" style="--d:0.06s">
                ${cleanUnicodeAndSymbols(slide.mainTitle || data.topic)}
              </h1>
              <p class="cover-sub-title anim-item" style="--d:0.12s">
                ${cleanUnicodeAndSymbols(slide.subtitle || (isRTL ? 'هنا يبدأ مسارك التعليمي التفاعلي لاستكشاف الحوسبة الإدراكية' : 'Here is where your presentation begins'))}
              </p>

              <div class="cover-pills-row anim-item" style="--d:0.18s">
                <span class="cover-pill-tag"><i class="bx bx-book-open"></i> ${cleanUnicodeAndSymbols(slide.pill1 || (isRTL ? 'المناهج المعرفية المتقدمة' : 'Language & Vocabulary'))}</span>
                <span class="cover-pill-tag"><i class="bx bx-time-five"></i> ${cleanUnicodeAndSymbols(slide.pill2 || (isRTL ? '15 وحدة استراتيجية' : '15 Interactive Slides'))}</span>
                <span class="cover-pill-tag"><i class="bx bx-user-check"></i> ${cleanUnicodeAndSymbols(slide.pill3 || (isRTL ? 'اعتماد أكاديمي معتمد' : 'Primary Curriculum'))}</span>
              </div>
            </div>

            <div class="cover-image-side anim-item" style="--d:0.10s">
              <img class="cover-clean-img" src="https://i.ibb.co/LTZ9jr7/image.png" alt="Keynote Visual" />
            </div>
          </div>
        `;
        break;

      case 'pillars_grid':
        const pillars = slide.pillars || [
          { num: "01", icon: "bx-cube", title: "Foundations", desc: "Core conceptual structures.", keyMetric: "High Precision" },
          { num: "02", icon: "bx-chip", title: "Integration", desc: "Seamless interoperability.", keyMetric: "Scalable Logic" },
          { num: "03", icon: "bx-layer", title: "Optimization", desc: "Maximizing throughput.", keyMetric: "Zero Latency" },
          { num: "04", icon: "bx-robot", title: "Synthesis", desc: "Unified autonomous loop.", keyMetric: "Self-Healing" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-book-open"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="slide-center-container">
            <div class="four-grid-centered">
              ${pillars.map((p, idx) => `
                <div class="grid-card-enhanced anim-item" style="--d:${0.12 + idx * 0.06}s">
                  <div class="card-accent-strip"></div>
                  <div class="grid-card-top">
                    <span class="grid-num">0${idx + 1}</span>
                    <div class="grid-icon-square"><i class="bx ${p.icon || 'bx-cube'}"></i></div>
                  </div>
                  <h3 class="grid-card-title">${cleanUnicodeAndSymbols(p.title)}</h3>
                  <p class="grid-card-desc">${cleanUnicodeAndSymbols(p.desc)}</p>
                  <div class="grid-metric-badge">
                    <i class="bx bx-calendar"></i> ${cleanUnicodeAndSymbols(p.keyMetric || 'Standard Benchmark')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        break;

      case 'comparison_table':
        const headers = slide.tableHeaders || (isRTL 
          ? ["المحور الهيكلي", "النهج التقليدي الموروث", "النموذج الذاتي الحديث", "معيار القياس الحاسم"]
          : ["Dimension", "Traditional Approach", "Modern Autonomous Paradigm", "System Benchmark"]);
        const rows = slide.tableRows || [
          ["Algorithmic Core", "Handcrafted heuristics", "High-dimensional embeddings (1536D to 4096D)", "99.8% Representation"],
          ["Latency & Scaling", "Single-thread sequential cycle", "Distributed Tensor Parallelism with FlashAttention-3", "< 8.5ms TTFT Serving"],
          ["Context Window", "512 - 2,048 tokens via rigid window", "1M to 2M tokens continuous RoPE memory", "Zero Lost-in-the-Middle"],
          ["Reasoning Loops", "Deterministic forward chaining", "ReAct, Tree-of-Thought (ToT) & Reflexion", "87.4% Self-Recovery"],
          ["Safety & Alignment", "Manual regex filters & static lists", "Constitutional AI & Latent Steering Locks", "Zero Threat Escape"],
          ["Live Telemetry", "Post-execution error logs", "Real-time trace spans with auto entropy alerts", "24/7 Sub-Second Audit"]
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-table"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="table-container-full anim-item" style="--d:0.14s">
            <table class="notebook-table-full">
              <thead>
                <tr>
                  ${headers.map(h => `<th>${cleanUnicodeAndSymbols(h)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${rows.slice(0, 6).map((row, rIdx) => `
                  <tr class="anim-item" style="--d:${0.16 + rIdx * 0.04}s">
                    <td>
                      <div class="table-category-cell">
                        <i class="bx bx-code-alt"></i>
                        <span>${cleanUnicodeAndSymbols(row[0] || '')}</span>
                      </div>
                    </td>
                    <td>${cleanUnicodeAndSymbols(row[1] || '')}</td>
                    <td><strong>${cleanUnicodeAndSymbols(row[2] || '')}</strong></td>
                    <td><span class="table-status-pill status-${rIdx % 4}">${cleanUnicodeAndSymbols(row[3] || 'Verified')}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
        break;

      case 'image_cards':
        const cards = slide.cards || [
          { badge: "EPOCH 01", title: "Mainframe Era", description: "Mechanical punch-cards and room-sized vacuum compute engines executing deterministic mathematical proofs.", spec1: "CLOCK: ~100 kHz", spec2: "PARADIGM: Logic", imageLocalUrl: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800&auto=format&fit=crop&q=80" },
          { badge: "EPOCH 02", title: "Tensor Era", description: "AlexNet and Transformer attention unlocked massive multi-billion parameter training runs across GPU clusters.", spec1: "COMPUTE: ~312 TFLOPS", spec2: "PARADIGM: Transformers", imageLocalUrl: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80" },
          { badge: "EPOCH 03", title: "Autonomous Fabric", description: "Multi-agent swarms with external API invocations, persistent vector memory, and reflective feedback loops.", spec1: "COMPUTE: Multi-ExaFLOP", spec2: "PARADIGM: ReAct Swarms", imageLocalUrl: "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=800&auto=format&fit=crop&q=80" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-images"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="image-cards-row-tall">
            ${cards.map((c, cIdx) => `
              <div class="photo-card-tall anim-item" style="--d:${0.14 + cIdx * 0.08}s">
                <div class="photo-frame-tall">
                  <img src="${c.imageLocalUrl || 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80'}" alt="${cleanUnicodeAndSymbols(c.title)}" />
                  <div class="photo-badge-large"><i class="bx bx-history"></i> ${cleanUnicodeAndSymbols(c.badge || `EPOCH 0${cIdx + 1}`)}</div>
                </div>
                <div class="photo-card-body-tall">
                  <h4 class="photo-card-title-tall">${cleanUnicodeAndSymbols(c.title)}</h4>
                  <p class="photo-card-desc-tall">${cleanUnicodeAndSymbols(c.description)}</p>
                  <div class="photo-tech-specs-tall">
                    <span>${cleanUnicodeAndSymbols(c.spec1 || 'CLOCK: High')}</span>
                    <span>${cleanUnicodeAndSymbols(c.spec2 || 'PARADIGM: Modern')}</span>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        `;
        break;

      case 'bar_chart':
        // Strict English-only labels for QuickChart
        const barChartUrl = `https://quickchart.io/chart?w=800&h=520&bkg=white&c={type:'line',data:{labels:['1B','7B','14B','70B','120B','405B','1T+'],datasets:[{label:'Autonomous+Reasoning+(%)',data:[34,52,65,82,89,95,98.6],borderColor:'rgb(37,99,235)',backgroundColor:'rgba(37,99,235,0.12)',fill:true,tension:0.3,borderWidth:4},{label:'Classical+Baseline+(%)',data:[25,32,38,44,50,54,58],borderColor:'rgb(148,163,184)',borderDash:[6,6],fill:false,borderWidth:3}]},options:{plugins:{legend:{position:'top',labels:{font:{size:16,weight:'bold'}}}},scales:{y:{min:20,max:100,ticks:{font:{size:14}},title:{display:true,text:'Benchmark+Accuracy+(%)',font:{size:15,weight:'bold'}}},x:{ticks:{font:{size:14}},title:{display:true,text:'Total+Active+Parameter+Scale',font:{size:15,weight:'bold'}}}}}}`;
        const bTakeaways = slide.takeaways || [
          "Token-to-parameter ratios of 20:1 prove essential for zero-shot downstream task transfer.",
          "Allocating additional test-time compute tokens yields non-linear reasoning improvements.",
          "Deploying secondary verification nodes recovers 88.2% of intermediate hallucinated steps."
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-line-chart"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="chart-layout-direct">
            <img class="direct-chart-img anim-item" style="--d:0.14s" src="${barChartUrl}" alt="Scaling Chart" />
            <div class="chart-sidebar-expanded anim-item" style="--d:0.2s">
              <h3 class="sidebar-title-expanded"><i class="bx bx-line-chart"></i> ${cleanUnicodeAndSymbols(slide.chartTitle || (isRTL ? 'تحليل كفاءة التوسع' : 'Empirical Scaling Analysis'))}</h3>
              ${bTakeaways.map(t => `
                <div class="sidebar-bullet-expanded">
                  <strong><i class="bx bx-check-circle"></i> ${isRTL ? 'معيار التحقق المعملي' : 'Empirical Benchmark'}</strong>
                  <span>${cleanUnicodeAndSymbols(t)}</span>
                </div>
              `).join('')}
              <div class="chart-meta-callout-expanded">
                <i class="bx bx-data"></i> ${cleanUnicodeAndSymbols(slide.metaCallout || (isRTL ? 'تم اختباره عبر 14,200 جلسة تقييمية معيارية.' : 'Sampled across 14,200 continuous production episodes.'))}
              </div>
            </div>
          </div>
        `;
        break;

      case 'deep_dive':
        // High 370px image height with text expanding to the bottom
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-code-block"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="deep-dive-layout-maximized">
            <div class="deep-dive-card-max primary-card anim-item" style="--d:0.14s">
              <div>
                <div class="dive-header-tall">
                  <i class="bx bx-chip"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.card1Title || (isRTL ? 'محرك المتجهات عالي الأبعاد' : 'High-Dimensional Vector Engine'))}</h3>
                </div>
                <div class="dive-image-wrap-max">
                  <img class="dive-fitted-img" src="${slide.image1LocalUrl || 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=800&auto=format&fit=crop&q=80'}" alt="Vector Engine" />
                </div>
                <p class="dive-body-max">${cleanUnicodeAndSymbols(slide.card1Desc || (isRTL ? 'تحويل البيانات غير المنظمة إلى فضاءات هندسية متصلة بدقة 1536 بعداً مع استرجاع دلالي فائق السرعة.' : 'Embeds unstructured enterprise data streams into dense 1536-dimensional continuous geometric spaces for real-time RAG.'))}</p>
              </div>
              <div class="dive-pills-row-max">
                ${(slide.card1Pills || (isRTL ? ["فضاء 1536 بعداً", "استرجاع < 10ms", "تطابق 99.98%"] : ["1536-D Projections", "Sub-10ms HNSW", "99.98% Fidelity"])).map(p => `
                  <span><i class="bx bx-check"></i> ${cleanUnicodeAndSymbols(p)}</span>
                `).join('')}
              </div>
            </div>

            <div class="deep-dive-card-max secondary-card anim-item" style="--d:0.2s">
              <div>
                <div class="dive-header-tall">
                  <i class="bx bx-shield-quarter"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.card2Title || (isRTL ? 'حوكمة الأمان والذكاء الدستوري' : 'Constitutional Guardrails & Safety'))}</h3>
                </div>
                <div class="dive-image-wrap-max">
                  <img class="dive-fitted-img" src="${slide.image2LocalUrl || 'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&auto=format&fit=crop&q=80'}" alt="Cyber Guardrails" />
                </div>
                <p class="dive-body-max">${cleanUnicodeAndSymbols(slide.card2Desc || (isRTL ? 'طبقات تدقيق لحظية متعددة المستويات ترصد مسارات تفكير النموذج وتفرض حواجز حتمية لمنع حقن الأوامر.' : 'Multi-tier verification observers monitor reasoning trajectories at the token level, ensuring deterministic boundary execution.'))}</p>
              </div>
              <div class="dive-pills-row-max">
                ${(slide.card2Pills || (isRTL ? ["حواجز حتمية", "بيئات معزولة", "صفر تسريب"] : ["Deterministic Bounds", "Real-Time Sandbox", "Zero Threat Escape"])).map(p => `
                  <span><i class="bx bx-check"></i> ${cleanUnicodeAndSymbols(p)}</span>
                `).join('')}
              </div>
            </div>
          </div>
        `;
        break;

      case 'timeline':
        const steps = slide.timelineSteps || [
          { step: "PHASE 01", title: isRTL ? "استيعاب المتجهات" : "Vector Ingestion", desc: isRTL ? "فهرسة قواعد البيانات الهيكلية والرسوم المعرفية." : "Catalog enterprise structured databases and semantic graphs.", metaSpec: "SPEC: sub-10ms HNSW", icon: "bx-data" },
          { step: "PHASE 02", title: isRTL ? "جسر بروتوكول MCP" : "MCP Protocol Bridge", desc: isRTL ? "ربط النماذج اللغوية بمنافذ REST الآمنة وقواعد SQL." : "Bind LLMs to secure REST endpoints and sandbox shells.", metaSpec: "SPEC: JSON-RPC Schema", icon: "bx-code" },
          { step: "PHASE 03", title: isRTL ? "أسراب الوكلاء المتعددين" : "Multi-Agent Swarm", desc: isRTL ? "توزيع الأدوار التخصصية مع آليات التدقيق المتبادل." : "Assemble specialized agent roles with reflection loops.", metaSpec: "SPEC: DAG State Graph", icon: "bx-git-merge" },
          { step: "PHASE 04", title: isRTL ? "التشغيل الذاتي الكامل" : "Autonomous Execution", desc: isRTL ? "مسارات إنتاج مستقلة مع رصد الشذوذ والإصلاح المستمر." : "Unattended production workflows with self-healing.", metaSpec: "SPEC: 99.99% SLA Uptime", icon: "bx-rocket" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-git-branch"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="curved-timeline-container anim-item" style="--d:0.14s">
            <svg class="timeline-hybrid-svg" viewBox="0 0 1400 140" preserveAspectRatio="none">
              <defs>
                <linearGradient id="timelineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#2563EB" />
                  <stop offset="50%" stop-color="#06B6D4" />
                  <stop offset="100%" stop-color="#10B981" />
                </linearGradient>
              </defs>
              <path d="M 80 70 L 220 70 C 310 20, 390 120, 480 70 L 640 70 C 720 20, 800 120, 890 70 L 1050 70 C 1140 20, 1220 120, 1310 70" 
                    fill="none" stroke="url(#timelineGrad)" stroke-width="4.5" stroke-dasharray="8 6" />
              <circle cx="160" cy="70" r="7" fill="#2563EB" />
              <circle cx="560" cy="70" r="7" fill="#06B6D4" />
              <circle cx="970" cy="70" r="7" fill="#0EA5E9" />
              <circle cx="1310" cy="70" r="7" fill="#10B981" />
            </svg>

            <div class="timeline-nodes-row">
              ${steps.map((st, sIdx) => `
                <div class="timeline-curved-node anim-item" style="--d:${0.18 + sIdx * 0.08}s">
                  <div class="timeline-badge-square"><i class="bx ${st.icon || 'bx-git-commit'}"></i></div>
                  <div class="timeline-card-square">
                    <span class="timeline-phase-pill">${cleanUnicodeAndSymbols(st.step)}</span>
                    <h4 class="timeline-title">${cleanUnicodeAndSymbols(st.title)}</h4>
                    <p class="timeline-desc">${cleanUnicodeAndSymbols(st.desc)}</p>
                    <div class="timeline-meta-box">${cleanUnicodeAndSymbols(st.metaSpec || 'SPEC: Standard')}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        break;

      case 'doughnut_chart':
        // Strict English-only labels for QuickChart
        const doughnutUrl = `https://quickchart.io/chart?w=650&h=500&bkg=white&c={type:'doughnut',data:{labels:['Model+Inference+(40%)','Vector+DB+%26+RAG+(25%)','Safety+%26+Guardrails+(20%)','Fine-Tuning+%26+Adapters+(15%)'],datasets:[{data:[40,25,20,15],backgroundColor:['rgb(37,99,235)','rgb(6,182,212)','rgb(16,185,129)','rgb(245,158,11)'],borderWidth:3.5}]},options:{plugins:{legend:{position:'bottom',labels:{font:{size:15,weight:'bold'}}}}}}`;
        const insights = slide.insights || [
          { title: isRTL ? "استدلال وتوليد منخفض الكمون" : "40% Inference Latency Clusters", desc: isRTL ? "عناقيد خوادم H100 و B200 بتوازي مصفوفات FP8 لضمان أوقات استجابة سريعة." : "Dedicated FP8 tensor-parallel pods ensuring sub-second response times." },
          { title: isRTL ? "قواعد المتجهات والتخزين الدلالي" : "25% Vector DB & Caching", desc: isRTL ? "بنى الذاكرة المتجهية الموزعة وإعادة التضمين الآني." : "Distributed vector memory layers and enterprise graph synchronization." },
          { title: isRTL ? "الحوكمة والتدقيق وحواجز الأمان" : "20% Governance & Safety", desc: isRTL ? "جلسات الاختبار الأمني العدائي المستمر ومطابقة لوائح الخصوصية." : "Continuous prompt red-teaming and compliance verifications." }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-pie-chart-alt-2"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="chart-layout-direct">
            <img class="direct-chart-img anim-item" style="--d:0.14s" src="${doughnutUrl}" alt="Allocation Chart" />
            <div class="chart-sidebar-expanded anim-item" style="--d:0.2s">
              <h3 class="sidebar-title-expanded"><i class="bx bx-pie-chart-alt"></i> ${cleanUnicodeAndSymbols(slide.chartTitle || (isRTL ? 'تفصيل توزيع الميزانيات الرأسمالية' : 'Capital Allocation Breakdown'))}</h3>
              ${insights.map(ins => `
                <div class="sidebar-bullet-expanded">
                  <strong><i class="bx bx-check-double" style="color: #2563EB"></i> ${cleanUnicodeAndSymbols(ins.title)}</strong>
                  <span>${cleanUnicodeAndSymbols(ins.desc)}</span>
                </div>
              `).join('')}
              <div class="chart-meta-callout-expanded">
                <i class="bx bx-info-circle"></i> ${cleanUnicodeAndSymbols(slide.metaCallout || (isRTL ? 'مجمعة من ميزانيات البنية التحتية لأكبر 120 مؤسسة عالمية.' : 'Aggregated from 120 enterprise AI infrastructure allocations.'))}
              </div>
            </div>
          </div>
        `;
        break;

      case 'big_stat':
        const points = slide.supportingPoints || [
          { title: "SWE-bench Verified", desc: "74.8% end-to-end pull request resolution with zero hallucinated imports.", icon: "bx-check-shield" },
          { title: "Sandboxed State Safety", desc: "Tested across 140 enterprise institutions with zero critical privilege leakages.", icon: "bx-lock-alt" },
          { title: "Auto-Rollback Guarantee", desc: "Sub-50ms automated failure recovery across transactional flows.", icon: "bx-sync" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-award"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="stat-hero-container">
            <div class="stat-number-wrap anim-item" style="--d:0.12s">
              <span class="giant-stat-number">${cleanUnicodeAndSymbols(slide.statNumber || '99.4%')}</span>
              <span class="giant-stat-label">${cleanUnicodeAndSymbols(slide.statLabel || (isRTL ? 'معدل الحتمية التنفيذية في بيئات الإنتاج الفعلية' : 'Production Execution Determinism Rate'))}</span>
            </div>
            <p class="stat-hero-desc anim-item" style="--d:0.18s">${cleanUnicodeAndSymbols(slide.description || (isRTL ? 'ربط النماذج التوليدية الاحتمالية ببوابات التحقق النحوية الصارمة واختبارات التعافي التلقائي.' : 'Coupling generative models with AST validation gates and transactional rollbacks.'))}</p>
            <div class="stat-points-row anim-item" style="--d:0.24s">
              ${points.map(p => `
                <div class="stat-pill-card">
                  <div class="stat-pill-card-title"><i class="bx ${p.icon || 'bx-check-shield'}"></i> ${cleanUnicodeAndSymbols(p.title)}</div>
                  <div>${cleanUnicodeAndSymbols(p.desc)}</div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        break;

      case 'line_chart':
        // Strict English-only labels for QuickChart
        const lineChartUrl = `https://quickchart.io/chart?w=800&h=520&bkg=white&c={type:'bar',data:{labels:['2022+(Chat)','2023+(RAG)','2024+(Tools)','2025+(Swarm)','2026+(Auto)'],datasets:[{type:'line',label:'Task+Complexity+Score',data:[18,36,65,92,142],borderColor:'rgb(239,68,68)',borderWidth:4,fill:false},{label:'Enterprise+Workflows+(Millions)',data:[3,14,42,88,156],backgroundColor:'rgb(37,99,235)',borderRadius:8}]},options:{plugins:{legend:{position:'top',labels:{font:{size:16,weight:'bold'}}}},scales:{y:{ticks:{font:{size:14}}},x:{ticks:{font:{size:14}}}}}}`;
        const lTakeaways = slide.takeaways || [
          "The Shift to Unattended Execution: Organizations transitioned to background agent workers executing multi-hour tasks.",
          "Standardized Tool Calling via MCP eliminated custom wrapper scripts, reducing integration costs by 74%.",
          "Inference token costs collapsed by over 92% per unit of reasoning capacity, democratizing recursive loops."
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-trending-up"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="chart-layout-direct">
            <img class="direct-chart-img anim-item" style="--d:0.14s" src="${lineChartUrl}" alt="Adoption Chart" />
            <div class="chart-sidebar-expanded anim-item" style="--d:0.2s">
              <h3 class="sidebar-title-expanded"><i class="bx bx-rocket"></i> ${cleanUnicodeAndSymbols(slide.chartTitle || (isRTL ? 'محركات ومحفزات التسارع الكبرى' : 'Key Growth Catalysts'))}</h3>
              ${lTakeaways.map(t => `
                <div class="sidebar-bullet-expanded">
                  <strong><i class="bx bx-trending-up"></i> ${isRTL ? 'تحول استراتيجي' : 'Strategic Shift'}</strong>
                  <span>${cleanUnicodeAndSymbols(t)}</span>
                </div>
              `).join('')}
              <div class="chart-meta-callout-expanded">
                <i class="bx bx-time"></i> ${cleanUnicodeAndSymbols(slide.metaCallout || (isRTL ? 'رصد لحظي عبر القياس المتصل في 95 منشأة تقنية.' : 'Longitudinal telemetry monitoring across 95 enterprise partners.'))}
              </div>
            </div>
          </div>
        `;
        break;

      case 'mindmap':
        const branches = (slide.branches && slide.branches.length >= 6) ? slide.branches : [
          { num: "VECTOR 01", icon: "bx-list-check", title: "Hierarchical Planning", detail: "Decomposes goals into acyclic directed graphs (DAG).", submeta: "ReAct / ToT" },
          { num: "VECTOR 02", icon: "bx-server", title: "Episodic Memory", detail: "Maintains working context and queries vector stores.", submeta: "HNSW Retrieval" },
          { num: "VECTOR 03", icon: "bx-wrench", title: "Dynamic Tool Invocation", detail: "Dispatches API payloads and runs sandboxes safely.", submeta: "MCP Protocol" },
          { num: "VECTOR 04", icon: "bx-analyse", title: "Reflective Meta-Critic", detail: "Inspects intermediate outputs and retries alternate paths.", submeta: "Reflexion Loop" },
          { num: "VECTOR 05", icon: "bx-shield-quarter", title: "Boundary Guards", detail: "Enforces RBAC permissions and blocks prompt injection.", submeta: "Latent Clamps" },
          { num: "VECTOR 06", icon: "bx-refresh", title: "Continuous Adaptation", detail: "Converts feedback into fine-grained trajectory updates.", submeta: "RLAIF / DPO" }
        ];

        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-sitemap"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="mindmap-wrapper-relative anim-item" style="--d:0.14s">
            <svg class="mindmap-connectors-svg" viewBox="0 0 1600 480">
              <defs>
                <linearGradient id="lineGradLeft" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#2563EB" stop-opacity="0.3" />
                  <stop offset="100%" stop-color="#2563EB" stop-opacity="0.9" />
                </linearGradient>
                <linearGradient id="lineGradRight" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#10B981" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="#10B981" stop-opacity="0.3" />
                </linearGradient>
              </defs>

              <path d="M 460 70 L 620 70 C 690 70, 680 240, 750 240" fill="none" stroke="url(#lineGradLeft)" stroke-width="3" stroke-dasharray="6 4" />
              <path d="M 460 240 L 750 240" fill="none" stroke="url(#lineGradLeft)" stroke-width="3.5" />
              <path d="M 460 410 L 620 410 C 690 410, 680 240, 750 240" fill="none" stroke="url(#lineGradLeft)" stroke-width="3" stroke-dasharray="6 4" />

              <path d="M 850 240 C 920 240, 910 70, 980 70 L 1140 70" fill="none" stroke="url(#lineGradRight)" stroke-width="3" stroke-dasharray="6 4" />
              <path d="M 850 240 L 1140 240" fill="none" stroke="url(#lineGradRight)" stroke-width="3.5" />
              <path d="M 850 240 C 920 240, 910 410, 980 410 L 1140 410" fill="none" stroke="url(#lineGradRight)" stroke-width="3" stroke-dasharray="6 4" />
            </svg>

            <div class="mindmap-col">
              ${branches.slice(0, 3).map((b, bIdx) => `
                <div class="mindmap-future-card ${isRTL ? 'right-branch' : 'left-branch'} anim-item" style="--d:${0.16 + bIdx * 0.06}s">
                  <div class="branch-card-header">
                    <span class="branch-num">${cleanUnicodeAndSymbols(b.num || `VECTOR 0${bIdx + 1}`)}</span>
                    <i class="bx ${b.icon || 'bx-check'}"></i>
                  </div>
                  <h4 class="branch-title">${cleanUnicodeAndSymbols(b.title)}</h4>
                  <p class="branch-detail">${cleanUnicodeAndSymbols(b.detail)}</p>
                  <span class="branch-submeta">${cleanUnicodeAndSymbols(b.submeta || 'Protocol Standard')}</span>
                </div>
              `).join('')}
            </div>

            <div class="mindmap-center-hub anim-item" style="--d:0.2s">
              <div class="hub-core-box">
                <i class="bx bx-brain"></i>
                <span class="hub-title">${cleanUnicodeAndSymbols(slide.centerNode || (isRTL ? 'بيئة تشغيل الوكيل' : 'Agent Runtime'))}</span>
                <span class="hub-subtitle">${cleanUnicodeAndSymbols(slide.centerSubtitle || (isRTL ? 'المعمارية السداسية' : '6-Vector Engine'))}</span>
              </div>
            </div>

            <div class="mindmap-col">
              ${branches.slice(3, 6).map((b, bIdx) => `
                <div class="mindmap-future-card ${isRTL ? 'left-branch' : 'right-branch'} anim-item" style="--d:${0.16 + bIdx * 0.06}s">
                  <div class="branch-card-header">
                    <span class="branch-num">${cleanUnicodeAndSymbols(b.num || `VECTOR 0${bIdx + 4}`)}</span>
                    <i class="bx ${b.icon || 'bx-check'}"></i>
                  </div>
                  <h4 class="branch-title">${cleanUnicodeAndSymbols(b.title)}</h4>
                  <p class="branch-detail">${cleanUnicodeAndSymbols(b.detail)}</p>
                  <span class="branch-submeta">${cleanUnicodeAndSymbols(b.submeta || 'Protocol Standard')}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        break;

      case 'case_study':
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-briefcase"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="case-study-layout-tall">
            <div class="case-study-photo-box-tall anim-item" style="--d:0.14s">
              <img src="${slide.caseImageLocalUrl || 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=800&auto=format&fit=crop&q=80'}" alt="Clinical Case Study" />
              <div class="case-metric-tag-large"><i class="bx bx-check-circle"></i> ${cleanUnicodeAndSymbols(slide.metricTag || '+410% TRIAGE THROUGHPUT GAIN')}</div>
            </div>
            <div class="case-study-content-tall anim-item" style="--d:0.2s">
              <div class="case-pill-large"><i class="bx bx-plus-medical"></i> ${cleanUnicodeAndSymbols(slide.casePill || (isRTL ? 'التحقق السريري في القطاع الصحي' : 'CLINICAL HEALTHCARE VALIDATION'))}</div>
              <h3 class="case-title-large">${cleanUnicodeAndSymbols(slide.caseTitle || (isRTL ? 'التحليل الإشعاعي الذاتي والتكامل السريري' : 'Autonomous Medical Imaging & EHR Synthesis'))}</h3>
              <p class="case-text-large">${cleanUnicodeAndSymbols(slide.caseSummary || 'A consortium of 18 trauma hospitals deployed specialized multi-agent diagnostic nodes, reducing triage times from 45 minutes to under 8 minutes.')}</p>
              <div class="case-stats-grid-large">
                <div class="stat-mini-card-large">
                  <span class="mini-val-large">${cleanUnicodeAndSymbols(slide.stat1Val || '99.98%')}</span>
                  <span class="mini-lbl-large">${cleanUnicodeAndSymbols(slide.stat1Lbl || (isRTL ? 'معدل التطابق التشخيصي' : 'Diagnostic Agreement'))}</span>
                </div>
                <div class="stat-mini-card-large">
                  <span class="mini-val-large">${cleanUnicodeAndSymbols(slide.stat2Val || '8 min')}</span>
                  <span class="mini-lbl-large">${cleanUnicodeAndSymbols(slide.stat2Lbl || (isRTL ? 'زمن الفرز السريري' : 'Average Triage Time'))}</span>
                </div>
                <div class="stat-mini-card-large">
                  <span class="mini-val-large">${cleanUnicodeAndSymbols(slide.stat3Val || '0.02%')}</span>
                  <span class="mini-lbl-large">${cleanUnicodeAndSymbols(slide.stat3Lbl || (isRTL ? 'نسبة الخطأ الإيجابي' : 'False-Positive Rate'))}</span>
                </div>
              </div>
            </div>
          </div>
        `;
        break;

      case 'tradeoffs_matrix':
        // High 330px image height with text expanding to the bottom
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-git-compare"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="tradeoffs-layout-max">
            <div class="tradeoff-card-max strengths-card anim-item" style="--d:0.14s">
              <div>
                <div class="tradeoff-title-bar">
                  <i class="bx bx-check-shield"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.strengthsTitle || (isRTL ? 'المزايا الاستراتيجية الجوهرية' : 'Core Strategic Advantages'))}</h3>
                </div>
                <div class="tradeoff-img-wrap-max">
                  <img class="tradeoff-fitted-img" src="${slide.strengthsImageLocalUrl || 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=600&auto=format&fit=crop&q=80'}" alt="Strengths" />
                </div>
              </div>
              <ul class="tradeoff-list-max">
                ${(slide.strengths || [
                  "24/7 continuous unattended operation without cognitive fatigue.",
                  "Instantaneous synthesis of petabyte-scale unstructured archives.",
                  "Deterministic consistency across globally distributed clusters."
                ]).map(s => `<li><i class="bx bx-check"></i> ${cleanUnicodeAndSymbols(s)}</li>`).join('')}
              </ul>
            </div>

            <div class="tradeoff-card-max challenges-card anim-item" style="--d:0.2s">
              <div>
                <div class="tradeoff-title-bar">
                  <i class="bx bx-error"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.challengesTitle || (isRTL ? 'المخاطر والاعتبارات التشغيلية' : 'Operational Hazards & Considerations'))}</h3>
                </div>
                <div class="tradeoff-img-wrap-max">
                  <img class="tradeoff-fitted-img" src="${slide.challengesImageLocalUrl || 'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=600&auto=format&fit=crop&q=80'}" alt="Challenges" />
                </div>
              </div>
              <ul class="tradeoff-list-max">
                ${(slide.challenges || [
                  "Risk of hallucinated tool parameters causing unexpected API mutations.",
                  "Compute & energy spikes during recursive multi-agent consensus debates.",
                  "Difficult post-incident interpretability in deep multi-hop reasoning traces."
                ]).map(c => `<li><i class="${isRTL ? 'bx bx-left-arrow-alt' : 'bx bx-right-arrow-alt'}"></i> ${cleanUnicodeAndSymbols(c)}</li>`).join('')}
              </ul>
            </div>
          </div>
        `;
        break;

      case 'checklist_framework':
        // Centered 2x2 layout identical to Slide 2
        const checklist = slide.checklist || [
          { phase: "GATE 01 • READINESS", task: "API Sanitization & Token Scoping", desc: "Convert all legacy enterprise endpoints to read-only views with idempotency keys.", deliverable: "Readiness Matrix" },
          { phase: "GATE 02 • SHADOW RUN", task: "Multi-Agent Shadow Simulation", desc: "Replay 100,000 recorded customer requests in a mock sandbox to verify tool safety.", deliverable: "99.5% Conformance" },
          { phase: "GATE 03 • CANARY ROLLOUT", task: "Graduated Canary Traffic Shift", desc: "Route 5% of non-critical workloads to autonomous agent swarms with instant fallback.", deliverable: "Zero-Downtime Log" },
          { phase: "GATE 04 • GOVERNANCE", task: "Continuous Live Telemetry & Alignment", desc: "Continuous automated regression sweeps and live cost-budget circuit breakers.", deliverable: "24/7 SLA Sync" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-task"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="slide-center-container">
            <div class="four-grid-centered">
              ${checklist.map((item, cIdx) => `
                <div class="gate-card-enhanced anim-item" style="--d:${0.14 + cIdx * 0.06}s">
                  <div class="gate-top-bar">
                    <span class="phase-code-square-large">${cleanUnicodeAndSymbols(item.phase)}</span>
                    <div class="check-box-square-large"><i class="bx bx-check"></i></div>
                  </div>
                  <h4 class="gate-title">${cleanUnicodeAndSymbols(item.task)}</h4>
                  <p class="gate-desc">${cleanUnicodeAndSymbols(item.desc)}</p>
                  <div class="gate-deliverable-tag">
                    <i class="bx bx-file"></i> ${isRTL ? 'المخرجات المعيارية:' : 'Deliverable:'} ${cleanUnicodeAndSymbols(item.deliverable || 'Verified Protocol')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        break;

      case 'quote_summary':
      default:
        const realQuote = slide.quote || "The question of whether a machine can think is no more interesting than the question of whether a submarine can swim.";
        const realAuthor = slide.quoteAuthor || "Edsger W. Dijkstra";
        const authorTitle = slide.authorTitle || "Turing Award Laureate & Computing Pioneer";

        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-flag"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="quote-slide-container-tall">
            <div class="quote-banner-tall anim-item" style="--d:0.14s">
              <i class="bx bxs-quote-left quote-mark-tall"></i>
              <h2 class="quote-text-tall">"${cleanUnicodeAndSymbols(realQuote)}"</h2>
              <div class="quote-author-line">
                <span class="quote-author-name-tall">— ${cleanUnicodeAndSymbols(realAuthor)}</span>
                <span class="quote-author-role-tall">(${cleanUnicodeAndSymbols(authorTitle)})</span>
              </div>
            </div>
            <div class="summary-points-grid-tall">
              <div class="summary-check-card-tall anim-item" style="--d:0.2s">
                <div class="summary-card-header-tall">
                  <i class="bx bx-check-shield"></i>
                  <span>${cleanUnicodeAndSymbols(slide.card1Title || (isRTL ? 'الضرورة الهندسية الحتمية' : 'Engineering Imperative'))}</span>
                </div>
                <p>${cleanUnicodeAndSymbols(slide.card1Desc || (isRTL ? 'الذكاء وحده لا يكفي؛ بيئات العزل الصارمة والرصد اللحظي هي ما يحول النماذج الاحتمالية إلى نظم موثوقة.' : 'Deterministic sandboxes, constitutional locks, and real-time observability turn stochastic models into reliable enterprise systems.'))}</p>
              </div>
            
              <div class="summary-check-card-tall anim-item" style="--d:0.26s">
                <div class="summary-card-header-tall">
                  <i class="bx bx-rocket"></i>
                  <span>${cleanUnicodeAndSymbols(slide.card2Title || (isRTL ? 'آفاق المستقبل المستقل' : 'Autonomous Horizon'))}</span>
                </div>
                <p>${cleanUnicodeAndSymbols(slide.card2Desc || (isRTL ? 'آفاق المستقبل ستكون ملكاً لأسراب الوكلاء ذاتية الشفاء المترابطة عبر بروتوكولات قياسية مفتوحة.' : 'The frontier belongs to self-healing multi-agent swarms governed by standardized communication protocols (MCP).'))}</p>
              </div>
            </div>
            <div class="callout-pill-tall anim-item" style="--d:0.32s">
              <i class="bx bx-check-double"></i> ${cleanUnicodeAndSymbols(slide.callout || (isRTL ? 'اكتملت المحاضرة الأكاديمية • الانتقال لورش العمل التطبيقية' : 'LECTURE COMPLETE • PROCEED TO WORKSHOP LABS'))}
            </div>
          </div>
        `;
        break;
    }

    const initialDisplay = index === 0 ? 'flex' : 'none';
    const initialOpacity = index === 0 ? '1' : '0';
    const initialZ = index === 0 ? '15' : '1';

    return `
    <section class="notebook-slide ${index === 0 ? 'active' : ''}" id="slide-${index}" style="display: ${initialDisplay}; opacity: ${initialOpacity}; z-index: ${initialZ};">
      ${innerContent}
    </section>`;
  }).join('\n');

  // Styles dynamically adjusted for LTR/RTL
  return `<!DOCTYPE html>
<html lang="${lang.code}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <title>${cleanUnicodeAndSymbols(data.topic)} - Masterclass</title>
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&family=Tajawal:wght@500;700;800;900&family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
  
  <link href="https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css" rel="stylesheet">

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --navy: #1E2548;
      --navy-card: #2B3467;
      --navy-light: #475569;
      --coral: #EF4444;
      --yellow: #F59E0B;
      --mint: #10B981;
      --blue: #2563EB;
      --cyan: #06B6D4;
      --paper: #FFFFFF;
      --border-color: #E2E8F0;
      --notebook-line: rgba(203, 213, 225, 0.55);
      --strip-bg: #EBF3FA;
      --strip-dots: #A0C4E2;
      
      --rad-sm: 8px;
      --rad-md: 14px;
      --rad-lg: 20px;
      --rad-frame: 22px;
    }

    body {
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      background: #D9E2EC;
      background-image: radial-gradient(circle at 50% 10%, #E8EEF5 0%, #C9D6E4 100%);
      font-family: ${lang.font};
      color: var(--navy);
      -webkit-font-smoothing: antialiased;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
    }

    #presentation-frame {
      width: 1840px;
      height: 1000px;
      background: var(--paper);
      border-radius: var(--rad-frame);
      box-shadow: 0 35px 80px rgba(30, 41, 59, 0.2), 0 0 0 2px #CBD5E1;
      display: flex;
      flex-direction: ${isRTL ? 'row-reverse' : 'row'};
      position: relative;
      overflow: hidden;
    }

    .binder-strip {
      width: 86px;
      background: var(--strip-bg);
      border-${isRTL ? 'left' : 'right'}: 2px solid #D0E1F0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-around;
      padding: 30px 0;
      z-index: 30;
      position: relative;
    }
    .binder-hole {
      width: 22px;
      height: 22px;
      background: #FFFFFF;
      border-radius: 50%;
      border: 3.5px solid var(--strip-dots);
      box-shadow: inset 0 2px 5px rgba(0,0,0,0.1);
    }

    .ruled-canvas {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      background-color: #FFFFFF;
      background-image: repeating-linear-gradient(
        transparent,
        transparent 43px,
        var(--notebook-line) 43px,
        var(--notebook-line) 44px
      );
      padding: 26px 48px 20px 48px;
      text-align: ${isRTL ? 'right' : 'left'};
    }

    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 25;
      margin-bottom: 14px;
    }
    .topic-pill {
      background: var(--navy);
      color: #FFFFFF;
      font-size: 16px;
      font-weight: 800;
      padding: 9px 24px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      gap: 12px;
      letter-spacing: 0.02em;
      box-shadow: 0 4px 14px rgba(30, 37, 72, 0.18);
    }
    .pulse-dot {
      width: 10px;
      height: 10px;
      background: #38BDF8;
      border-radius: 50%;
      box-shadow: 0 0 12px #38BDF8;
      animation: pulseAnim 2s infinite ease-in-out;
    }
    @keyframes pulseAnim {
      0%, 100% { opacity: 0.6; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.3); }
    }

    .slide-counter-badge {
      font-size: 18px;
      color: var(--navy-light);
      background: #FFFFFF;
      border: 2px solid #CBD5E1;
      padding: 6px 20px;
      border-radius: var(--rad-md);
      font-weight: 800;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
    }
    .slide-counter-badge span {
      color: var(--blue);
      font-size: 22px;
    }

    .slides-deck {
      position: relative;
      flex: 1;
      z-index: 10;
    }
    
    .notebook-slide {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.97) translateY(12px);
      filter: blur(4px);
      transition: all 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .notebook-slide.active {
      display: flex !important;
      opacity: 1 !important;
      pointer-events: auto;
      transform: scale(1) translateY(0);
      filter: blur(0);
      z-index: 15 !important;
    }

    .anim-item {
      opacity: 0;
      transform: translateY(14px);
      transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                  transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .notebook-slide.active .anim-item {
      opacity: 1;
      transform: translateY(0);
      transition-delay: var(--d, 0s);
    }

    .slide-header {
      margin-bottom: 16px;
    }
    .slide-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 800;
      color: var(--blue);
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 5px 14px;
      border-radius: var(--rad-sm);
      margin-bottom: 6px;
      letter-spacing: 0.03em;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
    }
    .slide-heading {
      font-size: 38px;
      font-weight: 900;
      color: var(--navy);
      line-height: 1.22;
      letter-spacing: -0.01em;
    }

    /* Cover Slide */
    .cover-simple-container {
      display: flex;
      height: 100%;
      align-items: center;
      justify-content: space-between;
      position: relative;
      padding: ${isRTL ? '10px 20px 10px 10px' : '10px 10px 10px 20px'};
    }
    .cover-text-side {
      flex: 1.15;
      display: flex;
      flex-direction: column;
      gap: 18px;
      z-index: 2;
      padding-${isRTL ? 'left' : 'right'}: 20px;
    }
    .cover-main-title {
      font-family: ${isRTL ? "'Tajawal', 'Cairo'" : "'Fredoka', 'Nunito'"}, sans-serif;
      font-size: 64px;
      font-weight: 800;
      color: var(--navy);
      line-height: 1.15;
    }
    .cover-sub-title {
      font-size: 26px;
      color: #55627A;
      font-weight: 600;
      line-height: 1.4;
    }
    .cover-pills-row {
      display: flex;
      gap: 14px;
      margin-top: 14px;
    }
    .cover-pill-tag {
      background: #F1F5F9;
      border: 2px solid #CBD5E1;
      padding: 10px 22px;
      border-radius: 999px;
      font-size: 16px;
      font-weight: 800;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .cover-pill-tag i { color: var(--blue); font-size: 20px; }

    .cover-image-side {
      flex: 1;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .cover-clean-img {
      width: 100%;
      max-width: 740px;
      height: auto;
      max-height: 720px;
      object-fit: contain;
      display: block;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
    }

    /* Centered 4-Grid (Slides 2 & 14) */
    .slide-center-container {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      flex: 1;
      width: 100%;
    }
    .four-grid-centered {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 24px;
      width: 100%;
      max-width: 1600px;
      margin: auto 0;
    }
    .grid-card-enhanced, .gate-card-enhanced {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-lg);
      padding: 26px 28px;
      display: flex;
      flex-direction: column;
      position: relative;
      box-shadow: 0 8px 24px rgba(30, 41, 59, 0.05);
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease;
    }
    .grid-card-enhanced:hover, .gate-card-enhanced:hover {
      transform: translateY(-4px);
      box-shadow: 0 14px 30px rgba(37, 99, 235, 0.12);
    }
    .card-accent-strip {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: linear-gradient(90deg, var(--blue), var(--mint));
    }
    .grid-card-top, .gate-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .grid-num, .phase-code-square-large {
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-size: 16px;
      font-weight: 800;
      color: var(--blue);
    }
    .phase-code-square-large {
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 5px 12px;
      border-radius: var(--rad-sm);
    }
    .grid-icon-square, .check-box-square-large {
      width: 48px;
      height: 48px;
      border-radius: var(--rad-md);
      background: #EFF6FF;
      color: var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      border: 1.5px solid #BFDBFE;
    }
    .check-box-square-large {
      width: 36px;
      height: 36px;
      background: #ECFDF5;
      color: var(--mint);
      border-color: #A7F3D0;
      font-size: 24px;
    }
    .grid-card-title, .gate-title {
      font-size: 23px;
      font-weight: 800;
      color: var(--navy);
      margin-bottom: 10px;
    }
    .grid-card-desc, .gate-desc {
      font-size: 16.5px;
      color: #475569;
      line-height: 1.55;
      margin-bottom: 14px;
    }
    .grid-metric-badge, .gate-deliverable-tag {
      margin-top: auto;
      align-self: flex-start;
      background: #F8FAFC;
      color: var(--navy);
      font-size: 14.5px;
      font-weight: 800;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      padding: 8px 16px;
      border-radius: var(--rad-sm);
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1.5px solid #CBD5E1;
    }

    /* Comparison Table */
    .table-container-full {
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #CBD5E1;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(30, 41, 59, 0.06);
      flex: 1;
      display: flex;
      flex-direction: column;
      margin-bottom: 8px;
    }
    .notebook-table-full {
      width: 100%;
      height: 100%;
      border-collapse: collapse;
      text-align: ${isRTL ? 'right' : 'left'};
    }
    .notebook-table-full th {
      background: var(--navy);
      color: #FFFFFF;
      font-size: 18px;
      font-weight: 800;
      padding: 18px 24px;
    }
    .notebook-table-full td {
      padding: 20px 24px;
      font-size: 17px;
      color: #334155;
      border-bottom: 1.5px solid #E2E8F0;
    }
    .notebook-table-full tbody tr:nth-child(even) { background: #F8FAFC; }
    .table-category-cell {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 800;
      color: var(--navy);
      font-size: 18px;
    }
    .table-category-cell i { color: var(--blue); font-size: 22px; }
    .table-status-pill {
      display: inline-block;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 15px;
      font-weight: 800;
      padding: 6px 14px;
      border-radius: var(--rad-sm);
    }
    .status-0 { background: #ECFDF5; color: #059669; border: 1.5px solid #A7F3D0; }
    .status-1 { background: #EFF6FF; color: #0284C7; border: 1.5px solid #BAE6FD; }
    .status-2 { background: #FFFBEB; color: #B45309; border: 1.5px solid #FDE68A; }
    .status-3 { background: #FEF2F2; color: #DC2626; border: 1.5px solid #FECACA; }

    /* Image Cards Tall */
    .image-cards-row-tall {
      display: flex;
      gap: 24px;
      flex: 1;
      height: 100%;
    }
    .photo-card-tall {
      flex: 1;
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #E2E8F0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 22px rgba(30, 41, 59, 0.06);
    }
    .photo-frame-tall {
      height: 310px;
      position: relative;
      background: #0F172A;
      overflow: hidden;
    }
    .photo-frame-tall img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.4s ease;
    }
    .photo-card-tall:hover .photo-frame-tall img { transform: scale(1.05); }
    .photo-badge-large {
      position: absolute;
      top: 14px;
      ${isRTL ? 'right' : 'left'}: 14px;
      background: rgba(15, 23, 42, 0.92);
      color: #fff;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 13px;
      font-weight: 800;
      padding: 6px 14px;
      border-radius: var(--rad-sm);
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .photo-card-body-tall {
      padding: 22px 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 1;
    }
    .photo-card-title-tall { font-size: 24px; font-weight: 800; color: var(--navy); }
    .photo-card-desc-tall { font-size: 17px; color: #475569; line-height: 1.55; }
    .photo-tech-specs-tall {
      margin-top: auto;
      background: #F8FAFC;
      border: 1.5px solid #CBD5E1;
      border-radius: var(--rad-sm);
      padding: 10px 14px;
      font-size: 14px;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-weight: 700;
      color: var(--navy);
      display: flex;
      justify-content: space-between;
    }

    /* Direct Charts */
    .chart-layout-direct {
      display: flex;
      gap: 36px;
      align-items: center;
      flex: 1;
      width: 100%;
    }
    .direct-chart-img {
      flex: 1.45;
      width: 100%;
      height: 520px;
      object-fit: contain;
      border-radius: 20px;
      border: 2.5px solid #CBD5E1;
      background: #FFFFFF;
      box-shadow: 0 12px 30px rgba(30, 41, 59, 0.08);
      display: block;
    }
    .chart-sidebar-expanded {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .sidebar-title-expanded {
      font-size: 26px;
      font-weight: 900;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sidebar-bullet-expanded {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 16px;
      color: #334155;
      line-height: 1.55;
      box-shadow: 0 4px 12px rgba(30, 41, 59, 0.03);
    }
    .sidebar-bullet-expanded strong {
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 18px;
    }
    .sidebar-bullet-expanded strong i { color: var(--mint); font-size: 22px; }
    .chart-meta-callout-expanded {
      background: #F8FAFC;
      border: 2px solid #CBD5E1;
      border-radius: var(--rad-sm);
      padding: 12px 18px;
      font-size: 15px;
      font-weight: 700;
      color: #475569;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* Maximized Deep Dive (Slide 6) */
    .deep-dive-layout-maximized {
      display: flex;
      gap: 28px;
      flex: 1;
      height: 100%;
    }
    .deep-dive-card-max {
      flex: 1;
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2.5px solid #CBD5E1;
      padding: 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 10px 24px rgba(30, 41, 59, 0.05);
      height: 100%;
    }
    .primary-card { border-top: 8px solid var(--blue); }
    .secondary-card { border-top: 8px solid var(--mint); }
    .dive-header-tall {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .dive-header-tall i { font-size: 30px; color: var(--blue); }
    .dive-header-tall h3 { font-size: 24px; font-weight: 900; color: var(--navy); }
    .dive-image-wrap-max {
      width: 100%;
      height: 370px;
      border-radius: var(--rad-md);
      overflow: hidden;
      border: 2px solid #CBD5E1;
      background: #0F172A;
      margin-bottom: 12px;
    }
    .dive-fitted-img { width: 100%; height: 100%; object-fit: cover; }
    .dive-body-max {
      font-size: 17.5px;
      color: #334155;
      line-height: 1.55;
      margin-bottom: 10px;
    }
    .dive-pills-row-max {
      display: flex;
      gap: 12px;
      margin-top: auto;
    }
    .dive-pills-row-max span {
      background: #F1F5F9;
      padding: 8px 16px;
      border-radius: var(--rad-sm);
      font-weight: 800;
      font-size: 14.5px;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1.5px solid #CBD5E1;
    }

    /* Timeline (Slide 7) */
    .curved-timeline-container {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      width: 100%;
    }
    .timeline-hybrid-svg {
      position: absolute;
      top: 50%;
      left: 0;
      width: 100%;
      height: 140px;
      transform: translateY(-50%);
      z-index: 1;
      pointer-events: none;
    }
    .timeline-nodes-row {
      position: relative;
      z-index: 2;
      display: flex;
      justify-content: space-between;
      width: 100%;
      gap: 20px;
    }
    .timeline-curved-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
    }
    .timeline-badge-square {
      width: 58px;
      height: 58px;
      background: var(--blue);
      color: #FFFFFF;
      font-size: 28px;
      border-radius: var(--rad-md);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 3.5px solid #FFFFFF;
      box-shadow: 0 6px 18px rgba(37, 99, 235, 0.35);
      margin-bottom: 16px;
    }
    .timeline-card-square {
      background: #FFFFFF;
      border: 2px solid #CBD5E1;
      border-radius: var(--rad-md);
      padding: 20px;
      text-align: ${isRTL ? 'right' : 'left'};
      width: 100%;
      box-shadow: 0 8px 20px rgba(30, 41, 59, 0.05);
    }
    .timeline-phase-pill {
      display: inline-block;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 13px;
      font-weight: 800;
      color: var(--blue);
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 4px 10px;
      border-radius: var(--rad-sm);
      margin-bottom: 8px;
    }
    .timeline-title { font-size: 20px; font-weight: 800; color: var(--navy); margin-bottom: 8px; }
    .timeline-desc { font-size: 15px; color: #64748B; line-height: 1.45; margin-bottom: 10px; }
    .timeline-meta-box {
      background: #F8FAFC;
      border: 1.5px solid #E2E8F0;
      border-radius: var(--rad-sm);
      padding: 6px 10px;
      font-size: 13px;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-weight: 700;
      color: #334155;
    }

    /* Big Stat (Slide 8) */
    .stat-hero-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      gap: 18px;
    }
    .giant-stat-number {
      font-size: 120px;
      font-weight: 900;
      color: var(--blue);
      line-height: 1;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
    }
    .giant-stat-label {
      font-size: 30px;
      font-weight: 800;
      color: var(--navy);
      margin-top: 6px;
    }
    .stat-hero-desc {
      font-size: 20px;
      color: #475569;
      max-width: 960px;
      line-height: 1.55;
    }
    .stat-points-row { display: flex; gap: 20px; margin-top: 10px; }
    .stat-pill-card {
      background: #FFFFFF;
      border: 2px solid #CBD5E1;
      border-top: 5px solid var(--blue);
      border-radius: var(--rad-md);
      padding: 16px 24px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      font-size: 15.5px;
      color: #334155;
      text-align: ${isRTL ? 'right' : 'left'};
      box-shadow: 0 6px 16px rgba(30, 41, 59, 0.05);
      min-width: 290px;
    }
    .stat-pill-card-title {
      font-weight: 800;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 17px;
    }
    .stat-pill-card-title i { color: var(--blue); font-size: 20px; }

    /* Mindmap (Slide 10) */
    .mindmap-wrapper-relative {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      flex: 1;
      width: 100%;
    }
    .mindmap-connectors-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      pointer-events: none;
    }
    .mindmap-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
      z-index: 2;
    }
    .mindmap-future-card {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 18px 22px;
      box-shadow: 0 6px 16px rgba(30, 41, 59, 0.05);
      position: relative;
    }
    .left-branch { border-${isRTL ? 'left' : 'right'}: 5px solid var(--blue); }
    .right-branch { border-${isRTL ? 'right' : 'left'}: 5px solid var(--mint); }
    .branch-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .branch-num {
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      font-weight: 800;
      color: var(--blue);
    }
    .branch-card-header i { font-size: 22px; color: var(--navy); }
    .branch-title { font-size: 19px; font-weight: 800; color: var(--navy); margin-bottom: 6px; }
    .branch-detail { font-size: 15px; color: #64748B; line-height: 1.4; margin-bottom: 8px; }
    .branch-submeta {
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-size: 12.5px;
      color: #2563EB;
      background: #EFF6FF;
      padding: 4px 10px;
      border-radius: 4px;
      display: inline-block;
      font-weight: 700;
    }
    .mindmap-center-hub {
      width: 270px;
      height: 270px;
      background: var(--navy);
      border-radius: var(--rad-lg);
      border: 5px solid var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.3);
      z-index: 2;
    }
    .hub-core-box {
      text-align: center;
      color: #FFFFFF;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 20px;
    }
    .hub-core-box i { font-size: 56px; color: var(--yellow); }
    .hub-title { font-size: 22px; font-weight: 800; }
    .hub-subtitle {
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-size: 13px;
      color: #38BDF8;
      letter-spacing: 0.05em;
    }

    /* Case Study (Slide 11) */
    .case-study-layout-tall {
      display: flex;
      gap: 36px;
      align-items: center;
      flex: 1;
    }
    .case-study-photo-box-tall {
      flex: 1.15;
      height: 480px;
      position: relative;
      border-radius: var(--rad-lg);
      overflow: hidden;
      border: 2px solid #CBD5E1;
      box-shadow: 0 12px 28px rgba(30, 41, 59, 0.08);
      background: #0F172A;
    }
    .case-study-photo-box-tall img { width: 100%; height: 100%; object-fit: cover; }
    .case-metric-tag-large {
      position: absolute;
      bottom: 16px;
      ${isRTL ? 'right' : 'left'}: 16px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(10px);
      color: #FFFFFF;
      font-size: 16px;
      font-weight: 800;
      padding: 8px 18px;
      border-radius: var(--rad-sm);
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      border: 1.5px solid rgba(255, 255, 255, 0.25);
    }
    .case-metric-tag-large i { color: var(--mint); }
    .case-study-content-tall {
      flex: 1.25;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .case-pill-large {
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 13px;
      font-weight: 800;
      color: var(--blue);
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 6px 14px;
      border-radius: var(--rad-sm);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      align-self: flex-start;
    }
    .case-title-large { font-size: 34px; font-weight: 900; color: var(--navy); }
    .case-text-large { font-size: 17.5px; color: #475569; line-height: 1.6; }
    .case-stats-grid-large {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-top: 6px;
    }
    .stat-mini-card-large {
      background: #F8FAFC;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 16px 18px;
      text-align: center;
    }
    .mini-val-large {
      display: block;
      font-size: 30px;
      font-weight: 900;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      color: var(--blue);
    }
    .mini-lbl-large { font-size: 13px; color: #64748B; font-weight: 800; margin-top: 4px; }

    /* Maximized Tradeoffs Matrix (Slide 13) */
    .tradeoffs-layout-max {
      display: flex;
      gap: 28px;
      flex: 1;
      height: 100%;
    }
    .tradeoff-card-max {
      flex: 1;
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #CBD5E1;
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 8px 20px rgba(30, 41, 59, 0.05);
      height: 100%;
    }
    .tradeoff-title-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .tradeoff-title-bar h3 { font-size: 24px; font-weight: 800; color: var(--navy); }
    .strengths-card { border-top: 8px solid var(--mint); }
    .challenges-card { border-top: 8px solid var(--coral); }
    .strengths-card .tradeoff-title-bar i { font-size: 28px; color: var(--mint); }
    .challenges-card .tradeoff-title-bar i { font-size: 28px; color: var(--coral); }
    .tradeoff-img-wrap-max {
      width: 100%;
      height: 330px;
      border-radius: var(--rad-md);
      overflow: hidden;
      border: 2px solid #CBD5E1;
      background: #0F172A;
      margin-bottom: 12px;
    }
    .tradeoff-list-max {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: auto;
    }
    .tradeoff-list-max li {
      font-size: 17px;
      color: #334155;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      line-height: 1.45;
    }
    .tradeoff-list-max li i { font-size: 22px; flex-shrink: 0; margin-top: 2px; }
    .strengths-card .tradeoff-list-max li i { color: var(--mint); }
    .challenges-card .tradeoff-list-max li i { color: var(--coral); }

    /* Quote & Synthesis (Slide 15) */
    .quote-slide-container-tall {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 24px;
    }
    .quote-banner-tall {
      background: var(--navy);
      color: #FFFFFF;
      padding: 38px 56px;
      border-radius: var(--rad-lg);
      text-align: center;
      position: relative;
      max-width: 1160px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.2);
      border: 2px solid #334155;
    }
    .quote-mark-tall { font-size: 40px; color: var(--yellow); margin-bottom: 6px; }
    .quote-text-tall { font-size: 30px; line-height: 1.45; font-weight: 700; margin-bottom: 14px; }
    .quote-author-name-tall { font-size: 21px; font-weight: 800; color: var(--yellow); }
    .quote-author-role-tall { font-size: 16px; color: #94A3B8; }
    .summary-points-grid-tall { display: flex; gap: 20px; }
    .summary-check-card-tall {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 18px 24px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 16px;
      color: #475569;
      box-shadow: 0 6px 16px rgba(30, 41, 59, 0.04);
      max-width: 550px;
      line-height: 1.5;
    }
    .summary-card-header-tall {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 18px;
      font-weight: 800;
      color: var(--navy);
    }
    .summary-card-header-tall i { color: var(--mint); font-size: 24px; }
    .callout-pill-tall {
      background: var(--blue);
      color: #FFFFFF;
      font-size: 18px;
      font-weight: 800;
      padding: 12px 34px;
      border-radius: var(--rad-md);
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 22px rgba(37, 99, 235, 0.3);
    }

    /* Bottom Bar */
    .bottom-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 25;
      padding-top: 12px;
      border-top: 2px solid #E2E8F0;
    }
    .progress-track {
      flex: 0.72;
      height: 10px;
      background: #E2E8F0;
      border-radius: var(--rad-sm);
      overflow: hidden;
      position: relative;
    }
    #slide-progress-fill {
      width: 0%;
      height: 100%;
      background: linear-gradient(90deg, var(--blue), var(--cyan), var(--mint));
      border-radius: var(--rad-sm);
      transition: width 0.1s linear;
    }
    .astromind-bot-badge-prominent {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #FFFFFF;
      color: #1E293B;
      padding: 8px 22px;
      border-radius: 999px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
      border: 2px solid #CBD5E1;
      font-size: 15px;
      font-weight: 800;
    }
    .astromind-bot-badge-prominent i { font-size: 24px; color: var(--blue); }
    .astromind-bot-badge-prominent span { color: var(--blue); font-weight: 900; }
  </style>
</head>
<body>
  <div id="presentation-frame">
    <div class="binder-strip">
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
    </div>

    <div class="ruled-canvas">
      <div class="top-bar">
        <div class="topic-pill">
          <div class="pulse-dot"></div>
          <span>${cleanUnicodeAndSymbols(data.topic)}</span>
        </div>
        
        <div class="top-right-group">
          <div class="slide-counter-badge">
            ${isRTL ? 'شريحة' : 'SLIDE'} <span id="slide-index-view">01</span> / 15
          </div>
        </div>
      </div>

      <div class="slides-deck">
        ${slidesHtml}
      </div>

      <div class="bottom-bar">
        <div class="progress-track">
          <div id="slide-progress-fill"></div>
        </div>
        
        <div class="astromind-bot-badge-prominent">
          <i class="bx bx-bot"></i>
          <div>${isRTL ? 'تم الإنشاء بواسطة' : 'Generated By'} <span>AstroMind-A1</span></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var currentSlideIndex = 0;
    var totalSlides = 15;
    var currentSlideStart = performance.now();
    var currentSlideDuration = 13000;

    function liveCompositorHeartbeat(timestamp) {
      var elapsed = timestamp - currentSlideStart;
      var fillEl = document.getElementById('slide-progress-fill');
      if (fillEl && currentSlideDuration > 0) {
        var pct = Math.min(100, Math.max(0, (elapsed / currentSlideDuration) * 100));
        fillEl.style.width = pct.toFixed(2) + '%';
      }
      requestAnimationFrame(liveCompositorHeartbeat);
    }
    requestAnimationFrame(liveCompositorHeartbeat);

    window.showSlide = function(index, durationMs) {
      if (index < 0) index = 0;
      if (index >= totalSlides) index = totalSlides - 1;
      
      currentSlideIndex = index;
      currentSlideStart = performance.now();
      currentSlideDuration = durationMs || 13000;

      var allSlides = Array.prototype.slice.call(document.querySelectorAll('.notebook-slide'));
      allSlides.forEach(function(el, idx) {
        if (idx === index) {
          el.style.display = 'flex';
          el.style.visibility = 'visible';
          el.style.zIndex = '15';
          el.style.opacity = '1';
          el.classList.add('active');
        } else {
          el.style.display = 'none';
          el.style.visibility = 'hidden';
          el.style.zIndex = '1';
          el.style.opacity = '0';
          el.classList.remove('active');
        }
      });

      var numEl = document.getElementById('slide-index-view');
      if (numEl) {
        numEl.textContent = (index + 1 < 10 ? '0' : '') + (index + 1);
      }

      document.body.offsetHeight;
    };

    window.nextSlide = function() {
      if (currentSlideIndex < totalSlides - 1) {
        showSlide(currentSlideIndex + 1);
      }
    };

    window.prevSlide = function() {
      if (currentSlideIndex > 0) {
        showSlide(currentSlideIndex - 1);
      }
    };

    window.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          ${isRTL ? 'prevSlide();' : 'nextSlide();'}
          break;

        case 'ArrowLeft':
          e.preventDefault();
          ${isRTL ? 'nextSlide();' : 'prevSlide();'}
          break;

        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'n':
        case 'N':
          e.preventDefault();
          nextSlide();
          break;

        case 'ArrowUp':
        case 'PageUp':
        case 'p':
        case 'P':
          e.preventDefault();
          prevSlide();
          break;

        case 'Home':
          e.preventDefault();
          showSlide(0);
          break;

        case 'End':
          e.preventDefault();
          showSlide(totalSlides - 1);
          break;
      }
    });

    showSlide(0);
  </script>
</body>
</html>`;
}

// ============================================================================
// 8. STEP 4: SPEECH SYNTHESIS & TARGET DURATION CONTROL (180s - 210s)
// ============================================================================
async function synthesizeSpeech(text, outputPath, voice) {
  try {
    const tts = new EdgeTTS();
    await tts.synthesize(text, voice, { rate: '0%', pitch: '0Hz', volume: '100%' });

    if (typeof tts.toBuffer === 'function') {
      const buffer = await tts.toBuffer();
      await fs.promises.writeFile(outputPath, buffer);
      return;
    } else {
      const baseName = outputPath.replace(/\.mp3$/, '');
      await tts.toFile(baseName);
      if (!fs.existsSync(outputPath) && fs.existsSync(`${baseName}.mp3`)) {
        await fs.promises.rename(`${baseName}.mp3`, outputPath);
      }
      return;
    }
  } catch (err1) {
    const tts2 = new MsEdgeTTS();
    await tts2.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const streamRes = tts2.toStream(text);
    const audioStream = streamRes?.audioStream || streamRes;
    const writeStream = fs.createWriteStream(outputPath);
    audioStream.pipe(writeStream);
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      audioStream.on('error', reject);
      writeStream.on('error', reject);
    });
  }
}

async function processAudioTracks(slides, lang) {
  const N = slides.length;
  tracker.update(45, `Synthesizing Audio [${lang.name} Voice: ${lang.voice}]...`);

  const rawPaths = [];
  const rawDurations = [];
  for (let i = 0; i < N; i++) {
    const slide = slides[i];
    const pct = 45 + Math.round(((i + 1) / N) * 22);
    tracker.update(pct, `Synthesizing Slide Audio (${i + 1}/${N})...`);

    const rawFile = path.join(TEMP_DIR, `slide_${i}_raw.mp3`);
    await synthesizeSpeech(slide.narration, rawFile, lang.voice);
    const dur = await getAudioDuration(rawFile);
    rawDurations.push(dur);
    rawPaths.push(rawFile);
  }

  const rawTotal = rawDurations.reduce((a, b) => a + b, 0);

  let speechFactor = 1.0;
  if (rawTotal > (TARGET_TOTAL_SECONDS - N * 0.6)) {
    const targetSpokenTotal = TARGET_TOTAL_SECONDS - (N * 0.8);
    speechFactor = Math.min(1.30, Math.max(0.75, rawTotal / targetSpokenTotal));
  } else if (rawTotal < (TARGET_MIN_SECONDS - N * 2.5)) {
    const targetSpokenTotal = TARGET_MIN_SECONDS - (N * 1.5);
    speechFactor = Math.max(0.85, rawTotal / targetSpokenTotal);
  }

  const finalPaddedAudioPaths = [];
  let effectiveSpokenTotal = 0;
  const tempoPaths = [];

  for (let i = 0; i < N; i++) {
    const tempoFile = path.join(TEMP_DIR, `slide_${i}_tempo.mp3`);
    if (Math.abs(speechFactor - 1.0) > 0.03) {
      await applyTempo(rawPaths[i], tempoFile, speechFactor);
    } else {
      await fs.promises.copyFile(rawPaths[i], tempoFile);
    }
    const dur = await getAudioDuration(tempoFile);
    effectiveSpokenTotal += dur;
    tempoPaths.push({ path: tempoFile, duration: dur });
  }

  const totalPauseBudget = Math.max(N * 0.6, TARGET_TOTAL_SECONDS - effectiveSpokenTotal);
  const pausePerSlide = totalPauseBudget / N;

  for (let i = 0; i < N; i++) {
    const paddedFile = path.join(TEMP_DIR, `slide_${i}_padded.mp3`);
    await padAudioWithSilence(tempoPaths[i].path, paddedFile, pausePerSlide);
    const finalSlideDur = await getAudioDuration(paddedFile);
    
    slides[i].durationSeconds = finalSlideDur;
    slides[i].durationMs = Math.round(finalSlideDur * 1000);
    finalPaddedAudioPaths.push(paddedFile);
  }

  const masterAudioPath = path.join(TEMP_DIR, 'master_soundtrack.mp3');
  tracker.update(72, 'Assembling master audio track...');
  await concatenateAudioFiles(finalPaddedAudioPaths, masterAudioPath);

  const finalDuration = await getAudioDuration(masterAudioPath);
  tracker.log(`   📊 Balanced Audio Duration: ${finalDuration.toFixed(1)}s (Target Range: ${TARGET_MIN_SECONDS}s – ${TARGET_MAX_SECONDS}s)`);

  return masterAudioPath;
}

// ============================================================================
// 9. STEP 5: PUPPETEER 30-FPS DETERMINISTIC RECORDING
// ============================================================================
async function recordSlideshow(htmlPath, slides) {
  tracker.update(75, 'Launching headless browser for 30 FPS recording...');
  const rawVideoPath = path.join(TEMP_DIR, 'raw_screen_recording.mp4');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--run-all-compositor-stages-before-draw',
      '--enable-gpu-rasterization',
      '--force-device-scale-factor=1',
      `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`
    ],
    defaultViewport: {
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      deviceScaleFactor: 1
    }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT });

  const fileUrl = pathToFileURL(path.resolve(htmlPath)).href;
  await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 90000 });

  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.querySelectorAll('img'));
    await Promise.all(images.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }));
  });

  await new Promise(resolve => setTimeout(resolve, 800));

  const recorder = new PuppeteerScreenRecorder(page, {
    followNewTab: false,
    fps: FPS,
    ffmpeg_Path: resolvedFfmpeg || undefined,
    videoFrame: {
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT
    },
    aspectRatio: '16:9',
    recordDurationLimit: 1500
  });

  await recorder.start(rawVideoPath);

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const recPct = 76 + Math.round(((i + 1) / slides.length) * 18);
    tracker.update(recPct, `Recording Slide ${i + 1}/${slides.length} (${(slide.durationMs / 1000).toFixed(1)}s)...`);

    await page.evaluate((index, durationMs) => {
      window.showSlide(index, durationMs);
    }, i, slide.durationMs);

    const startTime = Date.now();
    while (Date.now() - startTime < slide.durationMs) {
      const remaining = slide.durationMs - (Date.now() - startTime);
      await new Promise(r => setTimeout(r, Math.min(250, Math.max(10, remaining))));
    }
  }

  await new Promise(resolve => setTimeout(resolve, 600));
  await recorder.stop();
  await browser.close();

  return rawVideoPath;
}

// ============================================================================
// 10. MAIN ORCHESTRATOR
// ============================================================================
async function main() {
  console.log("\n==========================================================");
  console.log("  🚀 MULTI-LINGUAL 30-FPS MASTERCLASS KEYNOTE GENERATOR");
  console.log("==========================================================");

  try {
    initDirectories();

    const { topic, lang } = await getUserInput();
    tracker.start();
    tracker.log(`📌 Topic: "${topic}"`);
    tracker.log(`🌐 Language: ${lang.name} [${lang.code.toUpperCase()}] • Voice: ${lang.voice}`);

    // Step 1: LLM Content Architecture Generation
    const presentationData = await generatePresentationContent(topic, lang);

    // Step 2: Pollinations AI Visuals
    await generateAllDeckImages(presentationData.slides, topic);

    // Step 3: Neural TTS & Precise 195s Duration Alignment
    const masterAudioPath = await processAudioTracks(presentationData.slides, lang);

    // Step 4: Build Presentation HTML
    tracker.update(73, 'Rendering HTML presentation deck...');
    const htmlContent = buildPresentationHTML(presentationData, lang);
    fs.writeFileSync(PRESENTATION_HTML, htmlContent, 'utf-8');

    // Step 5: Deterministic 30 FPS Headless Recording
    const rawVideoPath = await recordSlideshow(PRESENTATION_HTML, presentationData.slides);

    // Step 6: Multiplexing Video and Audio
    tracker.update(96, 'Multiplexing 30 FPS video and audio with FFmpeg...');
    await multiplexVideoAndAudio(rawVideoPath, masterAudioPath, FINAL_OUTPUT_VIDEO);

    tracker.update(100, 'Render Complete!');
    const totalTime = tracker.finish();

    const finalDur = await getAudioDuration(FINAL_OUTPUT_VIDEO);
    const m = Math.floor(finalDur / 60);
    const s = String(Math.round(finalDur % 60)).padStart(2, '0');
    const targetOk = finalDur >= TARGET_MIN_SECONDS && finalDur <= TARGET_MAX_SECONDS;

    console.log("\n==========================================================");
    console.log("  ✨ PRESENTATION VIDEO GENERATED SUCCESSFULLY! ✨");
    console.log(`  ⏱️  Total Generation Time:       ${totalTime}`);
    console.log(`  🎞️  Final Video Length:          ${m}:${s}  ${targetOk ? '✅ (Target: 3:00 – 3:30)' : '⚠️ outside target'}`);
    console.log(`  🌐 Presentation Language:       ${lang.name} (${lang.code.toUpperCase()})`);
    console.log(`  🎙️  Narrator Voice:              ${lang.voice}`);
    console.log(`  📁 Final MP4 Video (30 FPS):    ${FINAL_OUTPUT_VIDEO}`);
    console.log(`  🌐 Standalone HTML Deck:        ${PRESENTATION_HTML}`);
    console.log("==========================================================\n");

  } catch (error) {
    tracker.finish();
    console.error("\n❌ Execution failed:", error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();