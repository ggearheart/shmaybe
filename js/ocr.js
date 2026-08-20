// Screenshot → text, entirely in the browser. Tesseract is ~a few MB of wasm
// and language data, so it is loaded only when someone actually picks an
// image; the rest of the app never pays for it.
//
// The useful trick with a messages screenshot is that layout carries the
// speaker: your own bubbles sit right, everyone else's sit left. That gets us
// "me vs them"; sender-name labels above a run of bubbles get us who "them"
// is. Both are guesses, which is why the result goes to a review table rather
// than straight into the plan.

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let loading = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract)
                                      : reject(new Error('Tesseract loaded but did not register'));
    s.onerror = () => reject(new Error('Could not load the OCR library — are you offline?'));
    document.head.appendChild(s);
  });
  return loading;
}

/** Downscale huge phone screenshots; OCR gets no better above ~1600px wide. */
function toCanvas(img, maxW = 1600) {
  const scale = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image I can read.')); };
    img.src = url;
  });
}

/**
 * @param {File} file
 * @param {(pct:number, label:string)=>void} onProgress
 * @returns {Promise<{lines: Array, width: number}>}
 *   lines: [{ text, x0, x1, y0, side: 'left'|'right', confidence }]
 */
export async function imageToLines(file, onProgress = () => {}) {
  const T = await loadTesseract();
  onProgress(5, 'Reading the image');
  const img = await readImage(file);
  const canvas = toCanvas(img);

  onProgress(10, 'Starting OCR');
  const worker = await T.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') onProgress(10 + Math.round(m.progress * 85), 'Reading text');
    },
  });

  try {
    const { data } = await worker.recognize(canvas);
    const width = canvas.width;
    const raw = data.lines || [];

    const lines = raw.map(l => {
      const b = l.bbox || { x0: 0, x1: width, y0: 0 };
      // Classify by where the line *starts*: a right-hand bubble begins past
      // the middle of the screen, a left-hand one never does.
      const side = b.x0 > width * 0.42 ? 'right' : 'left';
      return {
        text: (l.text || '').replace(/\s+/g, ' ').trim(),
        x0: b.x0, x1: b.x1, y0: b.y0,
        side,
        confidence: l.confidence ?? 0,
      };
    }).filter(l => l.text && l.confidence > 30);

    onProgress(100, 'Done');
    return { lines, width };
  } finally {
    await worker.terminate();
  }
}

/**
 * Turn positioned OCR lines into a plain thread transcript that thread.js can
 * split. Sender labels (short left-aligned lines matching a roster name) become
 * "Name:" prefixes; everything right-aligned is attributed to `meName`.
 */
export function linesToTranscript(lines, roster = [], meName = 'Me') {
  const names = roster.map(p => p.name);

  // Status receipts and date separators sit in the same visual column as real
  // messages, so they have to go before attribution — otherwise "Delivered"
  // becomes something you said.
  const CHROME = /^(?:delivered|read|sent|sending|today|yesterday|now|imessage|text message|sms|mms|\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?)$/i;
  const isChrome = t => {
    const s = t.replace(/[^\w:\s]/g, '').trim();
    return !s || CHROME.test(s) || /^(?:today|yesterday)\s+\d{1,2}:\d{2}/i.test(s);
  };
  const isNameLabel = t => {
    const s = t.replace(/[^A-Za-z\s'’-]/g, '').trim();
    if (!s || s.length > 24) return false;
    return names.some(n => n.toLowerCase() === s.toLowerCase()
                        || n.toLowerCase().split(' ')[0] === s.toLowerCase());
  };

  const out = [];
  let currentLeftSpeaker = null;
  let lastSide = null;

  for (const l of lines) {
    if (isChrome(l.text)) { lastSide = null; continue; }
    if (l.side === 'left' && isNameLabel(l.text)) {
      currentLeftSpeaker = l.text.replace(/[^A-Za-z\s'’-]/g, '').trim();
      lastSide = null;                       // force a new block under this name
      continue;
    }
    const speaker = l.side === 'right' ? meName : (currentLeftSpeaker || null);

    // Consecutive lines on the same side from the same speaker are one message.
    if (lastSide === l.side && out.length && out[out.length - 1].speaker === speaker) {
      out[out.length - 1].text += ' ' + l.text;
    } else {
      out.push({ speaker, text: l.text });
    }
    lastSide = l.side;
  }

  return out
    .filter(m => m.text.trim())
    .map(m => (m.speaker ? `${m.speaker}: ${m.text}` : m.text))
    .join('\n');
}
