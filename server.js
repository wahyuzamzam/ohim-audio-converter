const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const { spawn } = require("node:child_process");
const path = require("node:path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Maksimal dua proses yt-dlp berjalan bersamaan pada satu instance.
let activeDownloads = 0;
const MAX_ACTIVE_DOWNLOADS = 2;

// Render menggunakan reverse proxy.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi."
    }
  })
);

const heavyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Batas penggunaan sementara tercapai. Coba lagi nanti."
  }
});

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 8,
    fieldSize: 4096
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * Hanya menerima URL YouTube dan mengambil video ID.
 * URL yang diteruskan ke yt-dlp dibuat ulang dari ID tersebut.
 */
function getYouTubeVideoId(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) {
    return null;
  }

  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return null;
  }

  if (url.username || url.password || url.port) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  let videoId = null;

  if (host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) {
      videoId = parts[0];
    }
  } else if (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com"
  ) {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      const match = url.pathname.match(
        /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/
      );

      if (match) {
        videoId = match[1];
      }
    }
  }

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return null;
  }

  return videoId;
}

/**
 * Mengambil audio dari video ID yang sudah divalidasi.
 *
 * Audio ditampung di memori dan dibatasi maksimal 50 MB.
 * Proses dihentikan jika terlalu lama.
 */
function downloadYouTubeAudio(videoId) {
  return new Promise((resolve, reject) => {
    const canonicalUrl =
      `https://www.youtube.com/watch?v=${videoId}`;

    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-cache-dir",
      "--no-progress",
      "--socket-timeout",
      "15",
      "--max-filesize",
      "50M",
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "-o",
      "-",
      "--",
      canonicalUrl
    ];

    const proc = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const chunks = [];
    let totalBytes = 0;
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(new Error("Pengambilan audio terlalu lama. Coba lagi."));
    }, 90 * 1000);

    function finish(error, result) {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }

    proc.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_INPUT_BYTES) {
        proc.kill("SIGKILL");
        finish(new Error("Audio melebihi batas 50 MB."));
        return;
      }

      chunks.push(chunk);
    });

    proc.stderr.on("data", (chunk) => {
      // Batasi pesan kesalahan yang ditampung.
      if (stderr.length < 4000) {
        stderr += chunk.toString();
      }
    });

    proc.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(new Error("yt-dlp belum terpasang di server."));
      } else {
        finish(new Error("Gagal menjalankan pengambil audio."));
      }
    });

    proc.on("close", (code) => {
      if (finished) return;

      if (code === 0 && totalBytes > 0) {
        finish(null, Buffer.concat(chunks));
        return;
      }

      // Hindari mengirim seluruh log internal server ke pengguna.
      const message = stderr.toLowerCase().includes("private")
        ? "Video bersifat pribadi atau tidak dapat diakses."
        : "Audio tidak dapat diambil. Video mungkin tidak tersedia atau YouTube menolak permintaan.";

      finish(new Error(message));
    });
  });
}

app.post("/api/fetch-audio", heavyLimiter, async (req, res) => {
  const videoId = getYouTubeVideoId(req.body?.url);

  if (!videoId) {
    return res.status(400).json({
      error:
        "Masukkan link video YouTube yang valid. Link playlist saja tidak didukung."
    });
  }

  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
    return res.status(503).json({
      error: "Server sedang sibuk. Silakan coba lagi sebentar."
    });
  }

  activeDownloads += 1;

  try {
    const audioBuffer = await downloadYouTubeAudio(videoId);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");

    return res.send(audioBuffer);
  } catch (error) {
    return res.status(502).json({
      error: error.message || "Gagal mengambil audio."
    });
  } finally {
    activeDownloads -= 1;
  }
});

function validCreatorId(value) {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

function validApiKey(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2048
  );
}

function validOperationPath(value) {
  return (
    typeof value === "string" &&
    /^operations\/[A-Za-z0-9_-]{1,200}$/.test(value)
  );
}

async function readRobloxResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function robloxErrorMessage(data, fallback) {
  const message =
    data?.message ||
    data?.error?.message ||
    data?.error;

  if (typeof message === "string") {
    return message.slice(0, 500);
  }

  return fallback;
}

/**
 * Mengirim file ke Roblox Open Cloud Assets API.
 *
 * Respons dapat berupa operasi yang masih diproses.
 * Status selesai tidak sama dengan jaminan lolos moderasi.
 */
app.post(
  "/api/roblox-upload",
  heavyLimiter,
  upload.single("file"),
  async (req, res) => {
    const {
      apiKey,
      creatorType,
      creatorId,
      displayName
    } = req.body;

    if (!req.file || req.file.size === 0) {
      return res.status(400).json({
        error: "File audio tidak ditemukan."
      });
    }

    if (!validApiKey(apiKey)) {
      return res.status(400).json({
        error: "Masukkan API key Roblox."
      });
    }

    if (
      !validCreatorId(creatorId) ||
      !["user", "group"].includes(creatorType)
    ) {
      return res.status(400).json({
        error: "User ID atau Group ID harus berupa angka."
      });
    }

    const safeName =
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim().slice(0, 50)
        : "Ohim Audio";

    const creator =
      creatorType === "group"
        ? { groupId: creatorId }
        : { userId: creatorId };

    const assetRequest = {
      assetType: "Audio",
      displayName: safeName,
      description: "Uploaded using Ohim Audio Converter",
      creationContext: {
        creator
      }
    };

    try {
      const form = new FormData();

      form.append("request", JSON.stringify(assetRequest));

      form.append(
        "fileContent",
        new Blob([req.file.buffer], {
          type: "audio/wav"
        }),
        "audio.wav"
      );

      const response = await fetch(
        "https://apis.roblox.com/assets/v1/assets",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey.trim()
          },
          body: form,
          signal: AbortSignal.timeout(45000)
        }
      );

      const data = await readRobloxResponse(response);

      if (!response.ok) {
        return res.status(502).json({
          error: robloxErrorMessage(
            data,
            `Roblox menolak permintaan (HTTP ${response.status}).`
          )
        });
      }

      if (data.done && data.error) {
        return res.status(502).json({
          error: robloxErrorMessage(
            data,
            "Roblox gagal memproses aset."
          )
        });
      }

      const assetId = data.response?.assetId;

      if (data.done && assetId) {
        return res.json({
          status: "completed",
          assetId: String(assetId)
        });
      }

      const operationPath = data.path;

      if (validOperationPath(operationPath)) {
        return res.json({
          status: "pending",
          operationPath
        });
      }

      return res.status(502).json({
        error:
          "Roblox menerima permintaan, tetapi respons tidak berisi Asset ID atau operation path yang dikenali. Periksa Creator Dashboard sebelum mencoba ulang."
      });
    } catch (error) {
      return res.status(502).json({
        error:
          "Tidak dapat menghubungi Roblox. Periksa koneksi atau coba lagi nanti."
      });
    }
  }
);

/**
 * Periksa operasi upload Roblox.
 * API key dikirim di body, bukan di URL.
 */
app.post(
  "/api/roblox-operation",
  heavyLimiter,
  async (req, res) => {
    const { apiKey, operationPath } = req.body || {};

    if (
      !validApiKey(apiKey) ||
      !validOperationPath(operationPath)
    ) {
      return res.status(400).json({
        error: "API key atau operation path tidak valid."
      });
    }

    try {
      const response = await fetch(
        `https://apis.roblox.com/assets/v1/${operationPath}`,
        {
          headers: {
            "x-api-key": apiKey.trim()
          },
          signal: AbortSignal.timeout(20000)
        }
      );

      const data = await readRobloxResponse(response);

      if (!response.ok) {
        return res.status(502).json({
          error: robloxErrorMessage(
            data,
            `Gagal memeriksa operasi Roblox (HTTP ${response.status}).`
          )
        });
      }

      if (!data.done) {
        return res.json({
          status: "pending",
          operationPath
        });
      }

      if (data.error) {
        return res.status(502).json({
          error: robloxErrorMessage(
            data,
            "Roblox gagal memproses aset."
          )
        });
      }

      const assetId = data.response?.assetId;

      if (!assetId) {
        return res.json({
          status: "completed_without_id",
          message:
            "Operasi selesai, tetapi Asset ID tidak tersedia dalam respons. Periksa Creator Dashboard."
        });
      }

      return res.json({
        status: "completed",
        assetId: String(assetId)
      });
    } catch {
      return res.status(502).json({
        error: "Gagal menghubungi Roblox untuk memeriksa status."
      });
    }
  }
);

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File melebihi batas aplikasi sebesar 20 MB."
      });
    }

    return res.status(400).json({
      error: "Data unggahan tidak valid."
    });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      error: "Data JSON tidak valid."
    });
  }

  console.error("Server error:", error.message);

  return res.status(500).json({
    error: "Terjadi kesalahan pada server."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ohim Audio berjalan pada port ${PORT}`);
});