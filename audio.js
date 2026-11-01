window.OhimAudio = (() => {
  const MAX_DECODED_SECONDS = 5 * 60;

  function encodeWav(buffer) {
    const channels = Math.min(buffer.numberOfChannels, 2);
    const sampleRate = buffer.sampleRate;
    const samples = buffer.length;
    const dataSize = samples * channels * 2;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    function writeString(offset, value) {
      for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");

    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);

    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const channelData = [];

    for (let channel = 0; channel < channels; channel++) {
      channelData.push(buffer.getChannelData(channel));
    }

    let offset = 44;

    for (let i = 0; i < samples; i++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(
          -1,
          Math.min(1, channelData[channel][i])
        );

        view.setInt16(
          offset,
          sample < 0 ? sample * 0x8000 : sample * 0x7fff,
          true
        );

        offset += 2;
      }
    }

    return new Blob([arrayBuffer], {
      type: "audio/wav"
    });
  }

  async function convert(arrayBuffer, speed, onStatus) {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    const OfflineContextClass =
      window.OfflineAudioContext ||
      window.webkitOfflineAudioContext;

    if (!AudioContextClass || !OfflineContextClass) {
      throw new Error(
        "Browser ini tidak mendukung pemrosesan audio."
      );
    }

    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
      throw new Error("Kecepatan audio tidak valid.");
    }

    onStatus("Membaca dan mendekode audio...");

    const context = new AudioContextClass();
    let decoded;

    try {
      decoded = await context.decodeAudioData(arrayBuffer);
    } finally {
      await context.close().catch(() => {});
    }

    if (decoded.duration > MAX_DECODED_SECONDS) {
      throw new Error(
        "Durasi input maksimal 5 menit untuk mengurangi penggunaan memori HP."
      );
    }

    onStatus("Mengubah kecepatan audio...");

    const outputLength = Math.max(
      1,
      Math.ceil(decoded.length / speed)
    );

    const offline = new OfflineContextClass(
      Math.min(decoded.numberOfChannels, 2),
      outputLength,
      decoded.sampleRate
    );

    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.playbackRate.value = speed;
    source.connect(offline.destination);
    source.start(0);

    const rendered = await offline.startRendering();

    onStatus("Membuat file WAV...");

    // Memberi browser kesempatan memperbarui teks status.
    await new Promise((resolve) => setTimeout(resolve, 0));

    return encodeWav(rendered);
  }

  return { convert };
})();