"""说话人名单：把识别 API 返回的说话人编号（"1"、"2"…）映射成显示名，可在电脑页面改名。

- "me" 声道（麦克风）固定为「我」
- "others" 声道（会议软件里的声音）：对方1、对方2…
- "room" 声道（线下会议，只有一个麦克风）：说话人1、说话人2…
"""
from __future__ import annotations


class SpeakerRegistry:
    def __init__(self):
        self.names: dict[str, str] = {"me": "我"}

    def sid(self, channel: str, label: str | None) -> str:
        if channel == "me":
            return "me"
        sid = f"spk{label or 1}"
        if sid not in self.names:
            self.names[sid] = ("对方" if channel == "others" else "说话人") + str(label or 1)
        return sid

    def rename(self, sid: str, name: str):
        self.names[sid] = name

    def name(self, sid: str) -> str:
        return self.names.get(sid, sid)
