(() => {
  const $ = (id) => document.getElementById(id);

  const MAX_INPUT_BYTES = 50 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

  const state = {
    tab: "file",
    convertedBlob: null,
    convertedName: "",
    previewUrl: null,
    operationPath: null,
    converting: false,
    uploading: false
  };

  function formatSize(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function setTab(tab) {
    state.tab = tab;

    $("fileTab").classList.toggle("active", tab === "file");
    $("linkTab").classList.toggle("active", tab === "link");

    $("fileSection").classList.toggle("hidden", tab !== "file");
    $("linkSection").classList.toggle("hidden", tab !== "link");
  }

  function updateSpeed() {
    const speed = Number($("speed").value);
    const inverse = (1 / speed).toFixed(2);

    $("speedText").textContent = `${speed.toFixed(2)}x`;

    $("recommendation").textContent =
      speed === 1
        ? "Untuk file hasil konversi, gunakan Sound.PlaybackSpeed = 1.0."
        : `Setelah file dikonversi ${speed.toFixed(2)}x, gunakan ` +
          `Sound.PlaybackSpeed = 1.0 untuk mendengar hasilnya. ` +
          `Gunakan sekitar ${inverse} untuk mendekati tempo dan nada asli.`;
  }

  function clearResult() {
    state.convertedBlob = null;
    state.convertedName = "";

    $("preview").pause();
    $("preview").removeAttribute("src");
    $("preview").load();

    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }

    $("downloadLink").removeAttribute("href");
    $("result").classList.add("hidden");
  }

  async function readError(response) {
    const data = await response.json().catch(() => ({}));

    return data.error || `Permintaan gagal: HTTP ${response.status}`;
  }

  async function fetchYouTubeAudio(url) {
    const response = await fetch("/api/fetch-audio", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }

    return response.arrayBuffer();
  }

  async function convertAudio() {
    if (state.converting) return;

    const speed = Number($("speed").value);
    let file = null;
    let url = "";
    let baseName = "ohim-audio";

    if (state.tab === "file") {
      file = $("audioFile").files[0];

      if (!file) {
        $("convertStatus").textContent =
          "Pilih file audio terlebih dahulu.";
        return;
      }

      if (file.size > MAX_INPUT_BYTES) {
        $("convertStatus").textContent =
          "Ukuran file maksimal 50 MB.";
        return;
      }

      baseName = file.name.replace(/\.[^/.]+$/, "") || baseName;
    } else {
      url = $("youtubeUrl").value.trim();

      if (!url) {
        $("convertStatus").textContent =
          "Masukkan link video YouTube.";
        return;
      }

      baseName = "youtube-audio";
    }

    state.converting = true;
    $("convertBtn").disabled = true;

    clearResult();

    $("convertStatus").textContent =
      state.tab === "link"
        ? "Mengambil audio dari YouTube..."
        : "Membaca file...";

    try {
      const data = file
        ? await file.arrayBuffer()
        : await fetchYouTubeAudio(url);

      const blob = await window.OhimAudio.convert(
        data,
        speed,
        (message) => {
          $("convertStatus").textContent = message;
        }
      );

      state.convertedBlob = blob;
      state.convertedName =
        `${baseName}_${speed.toFixed(2)}x.wav`;

      state.previewUrl = URL.createObjectURL(blob);

      $("resultInfo").textContent =
        `${state.convertedName} (${formatSize(blob.size)})`;

      $("preview").src = state.previewUrl;

      $("downloadLink").href = state.previewUrl;
      $("downloadLink").download = state.convertedName;

      $("result").classList.remove("hidden");

      $("convertStatus").textContent =
        "Konversi selesai. Anda dapat mendengarkan atau mengunduh hasilnya.";
    } catch (error) {
      clearResult();

      $("convertStatus").textContent =
        error.message || "Gagal mengonversi audio.";
    } finally {
      state.converting = false;
      $("convertBtn").disabled = false;
    }
  }

  function showUploadResult(data) {
    if (data.status === "pending") {
      state.operationPath = data.operationPath;

      $("uploadStatus").textContent =
        "Roblox masih memproses upload. Tekan tombol di bawah untuk memeriksa status.";

      $("checkOperationBtn").classList.remove("hidden");
      return;
    }

    state.operationPath = null;
    $("checkOperationBtn").classList.add("hidden");

    if (data.status === "completed" && data.assetId) {
      $("assetIdText").textContent =
        `rbxassetid://${data.assetId}`;

      $("assetResult").classList.remove("hidden");

      $("uploadStatus").textContent =
        "Operasi upload selesai. Aset tetap dapat terkena proses moderasi Roblox.";

      return;
    }

    $("uploadStatus").textContent =
      data.message ||
      "Operasi selesai, tetapi Asset ID tidak ditemukan. Periksa Creator Dashboard.";
  }

  async function uploadRoblox() {
    if (state.uploading) return;

    const blob = state.convertedBlob;
    const apiKey = $("apiKey").value.trim();
    const creatorId = $("creatorId").value.trim();
    const creatorType = $("creatorType").value;
    const displayName =
      $("assetName").value.trim() || "Ohim Audio";

    if (!blob) {
      $("uploadStatus").textContent =
        "Convert audio terlebih dahulu.";
      return;
    }

    if (blob.size > MAX_UPLOAD_BYTES) {
      $("uploadStatus").textContent =
        `File hasil ${formatSize(blob.size)} melebihi batas aplikasi 20 MB. ` +
        "Gunakan audio yang lebih pendek.";
      return;
    }

    if (!apiKey) {
      $("uploadStatus").textContent =
        "Masukkan Roblox API key.";
      return;
    }

    if (!/^\d{1,20}$/.test(creatorId)) {
      $("uploadStatus").textContent =
        "User ID atau Group ID harus berupa angka.";
      return;
    }

    state.uploading = true;
    state.operationPath = null;

    $("uploadBtn").disabled = true;
    $("checkOperationBtn").classList.add("hidden");
    $("assetResult").classList.add("hidden");

    $("uploadStatus").textContent =
      "Mengirim audio ke Roblox...";

    try {
      const form = new FormData();

      form.append("file", blob, state.convertedName);
      form.append("apiKey", apiKey);
      form.append("creatorType", creatorType);
      form.append("creatorId", creatorId);
      form.append("displayName", displayName);

      const response = await fetch("/api/roblox-upload", {
        method: "POST",
        body: form
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = await response.json();
      showUploadResult(data);
    } catch (error) {
      $("uploadStatus").textContent =
        error.message || "Upload gagal.";
    } finally {
      state.uploading = false;
      $("uploadBtn").disabled = false;
    }
  }

  async function checkOperation() {
    if (!state.operationPath) return;

    const apiKey = $("apiKey").value.trim();

    if (!apiKey) {
      $("uploadStatus").textContent =
        "Masukkan kembali API key untuk memeriksa status.";
      return;
    }

    $("checkOperationBtn").disabled = true;
    $("uploadStatus").textContent =
      "Memeriksa status operasi Roblox...";

    try {
      const response = await fetch("/api/roblox-operation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          apiKey,
          operationPath: state.operationPath
        })
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = await response.json();
      showUploadResult(data);
    } catch (error) {
      $("uploadStatus").textContent =
        error.message || "Gagal memeriksa status.";
    } finally {
      $("checkOperationBtn").disabled = false;
    }
  }

  $("fileTab").addEventListener("click", () => setTab("file"));
  $("linkTab").addEventListener("click", () => setTab("link"));

  $("speed").addEventListener("input", updateSpeed);

  document.querySelectorAll("[data-speed]").forEach((button) => {
    button.addEventListener("click", () => {
      $("speed").value = button.dataset.speed;
      updateSpeed();
    });
  });

  $("convertBtn").addEventListener("click", convertAudio);
  $("uploadBtn").addEventListener("click", uploadRoblox);
  $("checkOperationBtn").addEventListener("click", checkOperation);

  window.addEventListener("beforeunload", () => {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
    }
  });

  updateSpeed();
})();