"""列出本机的音频输入设备，用于填写 config.yaml 里的 mic_device / system_device。"""
import sounddevice as sd

print("可用的输入设备：\n")
for i, d in enumerate(sd.query_devices()):
    if d["max_input_channels"] > 0:
        mark = "  <- 默认" if i == sd.default.device[0] else ""
        print(f"  [{i}] {d['name']}  ({d['max_input_channels']} 声道, {int(d['default_samplerate'])} Hz){mark}")
print("\n把设备名（或其中一部分）填进 config.yaml。")
