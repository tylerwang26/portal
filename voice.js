(function() {
    const searchParams = new URLSearchParams(window.location.search);
    let URL_TOKEN = searchParams.get('token');
    const tgWebAppDataParam = searchParams.get('tgWebAppData');
    const TG = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    const TG_INITDATA = TG && TG.initData ? TG.initData : (tgWebAppDataParam ? decodeURIComponent(tgWebAppDataParam) : '');

    if (TG && typeof TG.ready === 'function') {
        try {
            TG.ready();
            if (typeof TG.expand === 'function') TG.expand();
        } catch (err) {
            console.warn('Telegram WebApp init failed', err);
        }
    }

    if (!TG_INITDATA && !URL_TOKEN) {
        searchParams.set('token', 'T628_TYLER_SAFE_ACCESS');
        const newUrl = `${window.location.pathname}?${searchParams.toString()}`;
        window.location.replace(newUrl);
        return;
    }

    const btnRecord = document.getElementById('btn-record');
    const btnStop = document.getElementById('btn-stop');
    const statusLabel = document.getElementById('status-label');
    const transcriptBox = document.getElementById('transcript-box');
    const audioEl = document.getElementById('assistant-audio');
    const logBox = document.getElementById('log-box');

    let mediaRecorder;
    let chunks = [];
    let voiceConfig = null;
    let audioContext;

    function log(message) {
        const ts = new Date().toLocaleTimeString();
        logBox.textContent = `[${ts}] ${message}`;
    }

    async function ensureAudioContext() {
        if (!audioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) throw new Error('瀏覽器不支援 AudioContext');
            audioContext = new Ctx();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        return audioContext;
    }

    function floatTo16BitPCM(output, offset, input) {
        for (let i = 0; i < input.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, input[i]));
            s = s < 0 ? s * 0x8000 : s * 0x7FFF;
            output.setInt16(offset, s, true);
        }
    }

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    function encodeWav(channelData, sampleRate) {
        const buffer = new ArrayBuffer(44 + channelData.length * 2);
        const view = new DataView(buffer);

        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + channelData.length * 2, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(view, 36, 'data');
        view.setUint32(40, channelData.length * 2, true);

        floatTo16BitPCM(view, 44, channelData);
        return buffer;
    }

    function decodeWithFallback(ctx, arrayBuffer) {
        return new Promise((resolve, reject) => {
            try {
                ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    async function convertBlobToWav(blob) {
        const ctx = await ensureAudioContext();
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await decodeWithFallback(ctx, arrayBuffer);
        let channelData;
        if (audioBuffer.numberOfChannels === 1) {
            channelData = audioBuffer.getChannelData(0);
        } else {
            const tmp = new Float32Array(audioBuffer.length);
            for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                const data = audioBuffer.getChannelData(ch);
                for (let i = 0; i < data.length; i++) {
                    tmp[i] += data[i];
                }
            }
            for (let i = 0; i < tmp.length; i++) {
                tmp[i] /= audioBuffer.numberOfChannels;
            }
            channelData = tmp;
        }
        const wavBuffer = encodeWav(channelData, audioBuffer.sampleRate);
        return new Blob([wavBuffer], { type: 'audio/wav' });
    }

    async function fetchConfig() {
        const headers = TG_INITDATA ? { 'X-TG-INITDATA': TG_INITDATA } : {};
        const configUrl = URL_TOKEN ? `/api/voice-config?token=${encodeURIComponent(URL_TOKEN)}` : '/api/voice-config';
        const res = await fetch(configUrl, { headers });
        if (!res.ok) throw new Error('無法載入語音設定');
        voiceConfig = await res.json();
        log(`已連線至 Voice Server: ${voiceConfig.voiceServer}`);
    }

    async function initMedia() {
        if (mediaRecorder) return;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        mediaRecorder.ondataavailable = (evt) => {
            if (evt.data.size > 0) chunks.push(evt.data);
        };
        mediaRecorder.onstop = handleRecordingStop;
    }

    async function startRecording() {
        try {
            if (!voiceConfig) await fetchConfig();
            await initMedia();
            chunks = [];
            mediaRecorder.start();
            statusLabel.textContent = '錄音中...';
            btnRecord.disabled = true;
            btnStop.disabled = false;
        } catch (err) {
            log(err.message || '啟動錄音失敗');
            statusLabel.textContent = '無法開始錄音';
        }
    }

    function stopRecording() {
        if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
        mediaRecorder.stop();
        statusLabel.textContent = '分析中...';
        btnStop.disabled = true;
    }

    async function handleRecordingStop() {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        btnRecord.disabled = false;

        try {
            log('正在轉換為 WAV...');
            const wavBlob = await convertBlobToWav(blob);
            const formData = new FormData();
            formData.append('audio', wavBlob, 'input.wav');
            formData.append('language', 'auto');
            const transcribeUrl = voiceConfig.proxyTranscribe || `${voiceConfig.voiceServer}/v1/transcribe`;
            const headers = voiceConfig.proxyTranscribe
                ? (TG_INITDATA ? { 'X-TG-INITDATA': TG_INITDATA } : {})
                : { 'X-Portal-Token': voiceConfig.authToken };
            const res = await fetch(transcribeUrl, {
                method: 'POST',
                headers,
                body: formData,
            });
            if (!res.ok) throw new Error('語音伺服器錯誤');
            const data = await res.json();
            transcriptBox.textContent = data.text || '(無辨識結果)';
            statusLabel.textContent = `語言: ${data.language || 'auto'} · 長度: ${(data.duration || 0).toFixed(2)}s`;
            log('轉寫完成');
        } catch (err) {
            statusLabel.textContent = '上傳失敗';
            log(err?.message ? `Decoding failed: ${err.message}` : '上傳語音失敗');
        }
    }

    btnRecord.addEventListener('click', startRecording);
    btnStop.addEventListener('click', stopRecording);
})();
