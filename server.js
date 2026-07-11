import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';

const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
  console.error('缺少 GEMINI_API_KEY，請先設定環境變數（可放在 .env 檔案）。');
  process.exit(1);
}

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(express.json({ limit: '25mb' })); // 放寬 body 限制以容納參考圖片 base64
app.use(express.static('public'));

// Lyria 3 API 沒有明確的 duration / vocal / language / gender 參數，
// 這些都是靠 prompt 文字提示模型，所以這裡把 UI 欄位轉成提示句。
// 語言依官方文件說明：「Lyria 3 會以提示的語言生成歌詞」，並無正式 language 參數，
// 所以 language 為 'auto'（或未指定）時完全不加語言提示句，交由模型從 prompt 本身判斷。
// gender 同理沒有正式參數；UI 只有 female/male 兩個選項（無 auto），未指定（例如 vocal
// 關閉時）就不加性別提示。
// genre / mood / theme 是 Lyria 3 官方範例本來就常用的描述詞（例如 "ambient track"、
// "acoustic guitar piece"），所以直接寫成 "Genre: X, Y." 這種提示句，比 language/gender
// 這種模型沒有正式支援的欄位更貼近官方建議用法。
function buildPrompt({ prompt, vocal, language, gender, tags, durationSeconds }) {
  const parts = [prompt.trim()];

  if (tags) {
    for (const [label, values] of [['Genre', tags.genre], ['Mood', tags.mood], ['Theme', tags.theme]]) {
      if (values?.length) parts.push(`${label}: ${values.join(', ')}.`);
    }
  }

  if (vocal) {
    let vocalSentence = 'The song should include vocals';
    if (gender) vocalSentence += `, sung by a ${gender} voice`;
    if (language && language !== 'auto') vocalSentence += `, in ${language}`;
    vocalSentence += '.';
    parts.push(vocalSentence);
  } else {
    parts.push('Instrumental only, no vocals.');
  }

  if (durationSeconds) {
    const mins = Math.floor(durationSeconds / 60);
    const secs = durationSeconds % 60;
    parts.push(`Target song length: about ${mins}:${String(secs).padStart(2, '0')}.`);
  }

  return parts.join(' ');
}

// 圖片 base64 太長，log／debug 裡一律只顯示筆數與長度，不印內容本體。
function redactImages(images) {
  return images.map((img) => ({ mimeType: img.mimeType, dataLength: img.data.length }));
}

async function generateOne({ finalPrompt, modelId, images }) {
  const input = images?.length
    ? [
        { type: 'text', text: finalPrompt },
        ...images.map((img) => ({ type: 'image', mime_type: img.mimeType, data: img.data })),
      ]
    : finalPrompt;

  const interaction = await client.interactions.create({
    model: modelId,
    input,
  });

  const audio = interaction.output_audio;
  if (!audio?.data) {
    throw new Error('模型未回傳音訊資料');
  }

  return {
    mimeType: audio.mime_type || 'audio/mpeg',
    audioBase64: audio.data,
    lyrics: interaction.output_text || null,
  };
}

app.post('/api/generate', async (req, res) => {
  const {
    prompt,
    vocal = false,
    language = 'auto',
    gender = null,
    tags = null, // { genre: string[], mood: string[], theme: string[] }
    durationSeconds = 90,
    numSongs = 1,
    images = [], // [{ mimeType, data(base64) }], 最多 10 張
  } = req.body;

  const uiInput = { prompt, vocal, language, gender, tags, durationSeconds, numSongs, images: redactImages(images) };
  console.log('[UI input]', JSON.stringify(uiInput));

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    const debug = { uiInput, status: 'error', errorMessage: 'prompt 為必填字串' };
    return res.status(400).json({ error: 'prompt 為必填字串', debug });
  }
  if (images.length > 10) {
    const debug = { uiInput, status: 'error', errorMessage: '參考圖片最多 10 張' };
    return res.status(400).json({ error: '參考圖片最多 10 張', debug });
  }

  const count = Math.min(Math.max(Number(numSongs) || 1, 1), 5);
  // API 未公告官方時長上限（文件僅稱「幾分鐘，可透過提示控制」），
  // 這裡的 240 秒（4 分鐘）是我們自訂的產品上限，貼近一般流行歌完整長度，非 API 硬性限制。
  const clampedDuration = Math.min(Math.max(Number(durationSeconds) || 90, 10), 240);

  // 時長 > 30 秒需要 Pro 模型（Clip 模型上限 30 秒、僅輸出 MP3）
  const modelId = clampedDuration > 30 ? 'lyria-3-pro-preview' : 'lyria-3-clip-preview';
  const finalPrompt = buildPrompt({ prompt, vocal, language, gender, tags, durationSeconds: clampedDuration });

  const apiRequest = {
    model: modelId,
    input: images.length
      ? [{ type: 'text', text: finalPrompt }, ...images.map((img) => ({ type: 'image', mime_type: img.mimeType, data: `<base64 ${img.data.length} chars>` }))]
      : finalPrompt,
  };
  console.log('[Lyria 3 request]', JSON.stringify(apiRequest, null, 2));

  const requestSentAt = new Date().toISOString();

  let settled;
  try {
    settled = await Promise.allSettled(
      Array.from({ length: count }, () => generateOne({ finalPrompt, modelId, images }))
    );
  } catch (err) {
    // 理論上 allSettled 不會 reject，這裡只防呆非預期例外（例如參數組裝錯誤）
    console.error(err);
    const debug = { uiInput, finalPrompt, apiRequest, requestSentAt, status: 'error', errorMessage: err.message };
    return res.status(500).json({ error: err.message || '生成失敗', debug });
  }

  const responseReceivedAt = new Date().toISOString();

  const songs = [];
  const songErrors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      songs.push(r.value);
    } else {
      songErrors.push({ index: i, message: r.reason?.message || String(r.reason) });
    }
  });

  const songSummaries = songs.map((s) => ({
    mimeType: s.mimeType,
    audioBytes: Buffer.byteLength(s.audioBase64, 'base64'),
    lyrics: s.lyrics,
  }));
  console.log('[Lyria 3 response]', JSON.stringify(songSummaries, null, 2));
  if (songErrors.length) console.error('[Lyria 3 song errors]', songErrors);

  const status = songs.length === 0 ? 'error' : (songErrors.length ? 'partial' : 'success');
  const debug = {
    uiInput,
    finalPrompt,
    apiRequest,
    requestSentAt,
    responseReceivedAt,
    status,
    requestedCount: count,
    successCount: songs.length,
    errorCount: songErrors.length,
    songErrors,
    songs: songSummaries,
  };

  if (songs.length === 0) {
    return res.status(502).json({ error: songErrors[0]?.message || '生成失敗', debug });
  }

  res.json({ model: modelId, prompt: finalPrompt, songs, debug });
});

app.listen(PORT, () => {
  console.log(`Lyria 3 POC 伺服器啟動：http://localhost:${PORT}`);
});
