"""语音识别：Apple 芯片用 mlx-whisper，其他情况用 faster-whisper。
Whisper large-v3 / turbo 对中英混说（code-switching）支持较好，language 留空自动识别。
"""
from __future__ import annotations

import logging
import re

import numpy as np

log = logging.getLogger("asr")

# Whisper 在静音/噪声上常见的"幻觉"输出
HALLUCINATIONS = [
    "谢谢观看", "感谢观看", "请不吝点赞", "订阅", "字幕由", "字幕志愿者", "明镜与点点",
    "thank you for watching", "thanks for watching", "subscribe", "amara.org",
]


def _clean(text: str) -> str:
    text = text.strip()
    low = text.lower()
    if any(h in low for h in HALLUCINATIONS):
        return ""
    # 同一短语重复多次（另一种常见幻觉）
    if re.fullmatch(r"(.{1,8}?)\1{3,}", text):
        return ""
    return text


class ASR:
    def __init__(self, cfg: dict):
        self.backend = cfg.get("backend", "mlx")
        self.model_name = cfg.get("model")
        self.language = cfg.get("language")
        self.prompt = cfg.get("initial_prompt")
        self._model = None
        if self.backend == "mlx":
            import mlx_whisper  # noqa: F401  提前报错，方便排查
            self.model_name = self.model_name or "mlx-community/whisper-large-v3-turbo"
        else:
            from faster_whisper import WhisperModel
            name = self.model_name or "large-v3-turbo"
            self._model = WhisperModel(name, device="auto", compute_type="int8")
        log.info("ASR: %s / %s", self.backend, self.model_name)

    def warmup(self):
        self.transcribe(np.zeros(16000, dtype=np.float32))

    def transcribe(self, audio: np.ndarray, context: str = "") -> str:
        prompt = (self.prompt or "") + (" " + context[-200:] if context else "")
        if self.backend == "mlx":
            import mlx_whisper
            r = mlx_whisper.transcribe(
                audio, path_or_hf_repo=self.model_name, language=self.language,
                initial_prompt=prompt or None, condition_on_previous_text=False,
                no_speech_threshold=0.6, verbose=None,
            )
            segs = [s for s in r.get("segments", []) if s.get("no_speech_prob", 0) < 0.6]
            text = "".join(s["text"] for s in segs) if segs else r.get("text", "")
        else:
            segs, _ = self._model.transcribe(
                audio, language=self.language, initial_prompt=prompt or None,
                vad_filter=False, condition_on_previous_text=False, beam_size=1,
            )
            text = "".join(s.text for s in segs if s.no_speech_prob < 0.6)
        return _clean(text)
