"""两路音频采集 + 语音活动检测（VAD）分句。

- 麦克风声道  -> channel="me"
- 系统声音声道（BlackHole）-> channel="others"
每当检测到一句话结束，就把这段 16kHz 单声道音频交给回调。
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass

import numpy as np

log = logging.getLogger("audio")

SR = 16000
FRAME = 512  # 32ms @16k，silero-vad 要求的帧长


@dataclass
class Utterance:
    channel: str          # "me" | "others"
    audio: np.ndarray     # float32, 16k mono
    t_start: float
    t_end: float


def find_device(name: str | None, kind: str = "input"):
    """按名字的一部分查找输入设备，返回设备序号；name 为 None 返回默认设备。"""
    import sounddevice as sd
    if name is None:
        return None
    for i, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d["max_input_channels"] > 0:
            return i
    raise RuntimeError(f"找不到输入设备「{name}」。运行 python scripts/list_devices.py 查看可用设备。")


class VAD:
    """优先用 silero-vad，没装的话用能量阈值兜底。"""

    def __init__(self):
        self.model = None
        try:
            import torch  # noqa: F401
            from silero_vad import load_silero_vad
            self.model = load_silero_vad()
            log.info("VAD: silero")
        except Exception as e:  # pragma: no cover
            log.warning("silero-vad 不可用（%s），改用能量 VAD", e)
        self.noise = 1e-3

    def is_speech(self, frame: np.ndarray) -> bool:
        if self.model is not None:
            import torch
            prob = self.model(torch.from_numpy(frame), SR).item()
            return prob > 0.5
        rms = float(np.sqrt(np.mean(frame ** 2)) + 1e-9)
        speech = rms > max(self.noise * 3.0, 0.004)
        if not speech:
            self.noise = 0.95 * self.noise + 0.05 * rms
        return speech


class ChannelSegmenter:
    def __init__(self, channel: str, cfg: dict, on_utterance):
        self.channel = channel
        self.on_utterance = on_utterance
        self.end_frames = int(cfg.get("end_silence_ms", 700) / 1000 * SR / FRAME)
        self.max_frames = int(cfg.get("max_utterance_s", 15) * SR / FRAME)
        self.min_speech_frames = int(cfg.get("min_utterance_s", 0.4) * SR / FRAME)
        self.speech_frames = 0
        self.preroll = 10  # 约 320ms 前置缓冲，避免吞掉开头的字
        self.vad = VAD()
        self.buf = np.zeros(0, dtype=np.float32)
        self.history: list[np.ndarray] = []
        self.active: list[np.ndarray] = []
        self.silence = 0
        self.t_start = 0.0

    def feed(self, samples: np.ndarray):
        self.buf = np.concatenate([self.buf, samples])
        while len(self.buf) >= FRAME:
            frame, self.buf = self.buf[:FRAME], self.buf[FRAME:]
            self._frame(frame)

    def _frame(self, frame: np.ndarray):
        speech = self.vad.is_speech(frame)
        if not self.active:
            self.history.append(frame)
            self.history = self.history[-self.preroll:]
            if speech:
                self.active = list(self.history)
                self.history = []
                self.silence = 0
                self.speech_frames = 1
                self.t_start = time.time() - len(self.active) * FRAME / SR
            return
        self.active.append(frame)
        self.silence = 0 if speech else self.silence + 1
        self.speech_frames += 1 if speech else 0
        if self.silence >= self.end_frames or len(self.active) >= self.max_frames:
            self._flush()

    def _flush(self):
        audio = np.concatenate(self.active)
        # 去掉结尾的静音
        trim = max(0, self.silence - 3) * FRAME
        if trim:
            audio = audio[:-trim]
        enough = self.speech_frames >= self.min_speech_frames
        self.active, self.silence, self.speech_frames = [], 0, 0
        if enough:
            self.on_utterance(Utterance(self.channel, audio.astype(np.float32), self.t_start, time.time()))


class AudioCapture:
    """为每个声道开一个 sounddevice 输入流，回调里只入队，分句在独立线程里做。"""

    def __init__(self, cfg: dict, on_utterance):
        self.cfg = cfg
        self.on_utterance = on_utterance
        self.streams = []
        self.threads = []
        self.running = False

    def _open(self, channel: str, device_name):
        import sounddevice as sd
        from scipy.signal import resample_poly

        dev = find_device(device_name)
        info = sd.query_devices(dev, "input")
        in_sr = int(info["default_samplerate"])
        q: queue.Queue = queue.Queue()
        seg = ChannelSegmenter(channel, self.cfg, self.on_utterance)

        def cb(indata, frames, t, status):
            if status:
                log.debug("%s: %s", channel, status)
            q.put(indata.copy())

        stream = sd.InputStream(device=dev, channels=min(2, info["max_input_channels"]),
                                samplerate=in_sr, dtype="float32", blocksize=int(in_sr * 0.05), callback=cb)

        g = np.gcd(SR, in_sr)
        up, down = SR // g, in_sr // g

        def worker():
            while self.running:
                try:
                    block = q.get(timeout=0.5)
                except queue.Empty:
                    continue
                mono = block.mean(axis=1) if block.ndim == 2 else block
                if in_sr != SR:
                    mono = resample_poly(mono, up, down).astype(np.float32)
                seg.feed(mono)

        th = threading.Thread(target=worker, daemon=True, name=f"seg-{channel}")
        self.streams.append(stream)
        self.threads.append(th)
        log.info("音频声道 %s -> %s (%d Hz)", channel, info["name"], in_sr)
        return info["name"]

    def start(self) -> dict:
        self.running = True
        if self.cfg.get("system_device"):
            # 线上会议：麦克风=我，系统声音=对方
            names = {"me": self._open("me", self.cfg.get("mic_device")),
                     "others": self._open("others", self.cfg["system_device"])}
        else:
            # 线下会议：只有一个麦克风，所有人都在同一声道，靠声纹区分
            names = {"room": self._open("room", self.cfg.get("mic_device"))}
        for s in self.streams:
            s.start()
        for t in self.threads:
            t.start()
        return names

    def stop(self):
        self.running = False
        for s in self.streams:
            try:
                s.stop(); s.close()
            except Exception:
                pass
