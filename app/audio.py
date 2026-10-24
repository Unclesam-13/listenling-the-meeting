"""音频采集：把麦克风 / 系统声音（BlackHole）转成 16kHz 16bit 单声道 PCM，实时送给识别 API。

- 线上会议：麦克风 -> channel "me"，BlackHole -> channel "others"
- 线下会议（system_device 为 null）：麦克风 -> channel "room"
断句、说话人区分都由识别 API 完成，这里只负责录音。
"""
from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("audio")

SR = 16000


def find_device(name: str | None):
    """按名字的一部分查找输入设备，返回设备序号；name 为 None 返回默认设备。"""
    import sounddevice as sd
    if name is None:
        return None
    for i, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d["max_input_channels"] > 0:
            return i
    raise RuntimeError(f"找不到输入设备「{name}」。运行 python scripts/list_devices.py 查看可用设备。")


def to_pcm16(block: np.ndarray, in_sr: int) -> bytes:
    """多声道 float32 -> 16k 单声道 int16 字节。"""
    mono = block.mean(axis=1) if block.ndim == 2 else block
    if in_sr != SR:
        if in_sr % SR == 0:  # 48k/32k：按整数倍平均降采样（自带简单低通）
            k = in_sr // SR
            n = len(mono) // k * k
            mono = mono[:n].reshape(-1, k).mean(axis=1)
        else:  # 44.1k 等：线性插值
            n_out = int(len(mono) * SR / in_sr)
            mono = np.interp(np.linspace(0, len(mono) - 1, n_out), np.arange(len(mono)), mono)
    return (np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes()


class AudioCapture:
    """为每个声道开一个输入流。on_audio(channel, pcm_bytes) 会在音频线程中被调用。"""

    def __init__(self, cfg: dict, on_audio):
        self.cfg = cfg
        self.on_audio = on_audio
        self.streams = []

    def channels(self) -> list[str]:
        return ["me", "others"] if self.cfg.get("system_device") else ["room"]

    def _open(self, channel: str, device_name) -> str:
        import sounddevice as sd
        dev = find_device(device_name)
        info = sd.query_devices(dev, "input")
        in_sr = int(info["default_samplerate"])

        def cb(indata, frames, t, status):
            try:
                self.on_audio(channel, to_pcm16(indata, in_sr))
            except Exception:  # 回调里不能抛异常，否则音频流会停止
                log.exception("音频回调出错")

        stream = sd.InputStream(device=dev, channels=min(2, info["max_input_channels"]), samplerate=in_sr,
                                dtype="float32", blocksize=int(in_sr * 0.1), callback=cb)
        self.streams.append(stream)
        log.info("音频声道 %s -> %s (%d Hz)", channel, info["name"], in_sr)
        return info["name"]

    def start(self) -> dict:
        if self.cfg.get("system_device"):
            names = {"me": self._open("me", self.cfg.get("mic_device")),
                     "others": self._open("others", self.cfg["system_device"])}
        else:
            names = {"room": self._open("room", self.cfg.get("mic_device"))}
        for s in self.streams:
            s.start()
        return names

    def stop(self):
        for s in self.streams:
            try:
                s.stop(); s.close()
            except Exception:
                pass
