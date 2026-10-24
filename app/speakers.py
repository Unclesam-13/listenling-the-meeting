"""说话人区分：在每个声道内，用声纹向量做在线聚类。

- "me" 声道直接标为「我」
- "others"/"room" 声道：提取声纹，和已知说话人比余弦相似度，够像就归为同一人，否则新建
没装 resemblyzer 时退化为按声道区分（我 / 对方）。
"""
from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("speakers")


class SpeakerTracker:
    def __init__(self, cfg: dict):
        self.enabled = cfg.get("enabled", True)
        self.threshold = cfg.get("threshold", 0.72)
        self.max_speakers = cfg.get("max_speakers", 6)
        self.encoder = None
        self.centroids: dict[str, list] = {}  # channel -> [(id, vec, count)]
        self.names: dict[str, str] = {"me": "我"}
        self._last: dict[str, str] = {}
        if self.enabled:
            try:
                from resemblyzer import VoiceEncoder
                self.encoder = VoiceEncoder(verbose=False)
                log.info("声纹区分已启用")
            except Exception as e:
                log.warning("resemblyzer 不可用（%s），只按声道区分我/对方", e)

    def _new_id(self, channel: str) -> str:
        n = sum(len(v) for k, v in self.centroids.items() if k != "me") + 1
        sid = f"spk{n}"
        self.names[sid] = f"对方{n}" if channel == "others" else f"说话人{n}"
        return sid

    def assign(self, channel: str, audio: np.ndarray) -> str:
        if channel == "me":
            return "me"
        if self.encoder is None or len(audio) < 16000 * 0.8:
            # 太短的话声纹不可靠：沿用该声道上一个说话人
            if channel in self._last:
                return self._last[channel]
            sid = self._new_id(channel)
            self.centroids.setdefault(channel, []).append([sid, None, 0])
            self._last[channel] = sid
            return sid
        from resemblyzer import preprocess_wav
        emb = self.encoder.embed_utterance(preprocess_wav(audio, source_sr=16000))
        lst = self.centroids.setdefault(channel, [])
        best, best_sim = None, -1.0
        for item in lst:
            if item[1] is None:
                item[1], item[2] = emb, 1
                best, best_sim = item, 1.0
                break
            sim = float(np.dot(emb, item[1]) / (np.linalg.norm(emb) * np.linalg.norm(item[1]) + 1e-9))
            if sim > best_sim:
                best, best_sim = item, sim
        if best is None or (best_sim < self.threshold and len(lst) < self.max_speakers):
            best = [self._new_id(channel), emb, 1]
            lst.append(best)
        elif best_sim < 1.0:
            # 更新中心向量（滑动平均）
            best[1] = (best[1] * best[2] + emb) / (best[2] + 1)
            best[2] += 1
        self._last[channel] = best[0]
        return best[0]

    def rename(self, sid: str, name: str):
        self.names[sid] = name

    def name(self, sid: str) -> str:
        return self.names.get(sid, sid)
