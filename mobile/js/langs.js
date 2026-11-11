// Soniox 支持识别和翻译的语言（中文以外）：[代码, 中文名, 英文名]
// https://docs.soniox.com/stt/concepts/supported-languages —— 任意两种语言之间都可以互译
export const LANGS = [
  // 常用的放前面
  ["en", "英语", "English"], ["ms", "马来语", "Malay"], ["id", "印尼语", "Indonesian"], ["ja", "日语", "Japanese"],
  ["ko", "韩语", "Korean"], ["th", "泰语", "Thai"], ["vi", "越南语", "Vietnamese"], ["tl", "菲律宾语（他加禄语）", "Tagalog"],
  ["fr", "法语", "French"], ["de", "德语", "German"], ["es", "西班牙语", "Spanish"], ["pt", "葡萄牙语", "Portuguese"],
  ["it", "意大利语", "Italian"], ["ru", "俄语", "Russian"], ["ar", "阿拉伯语", "Arabic"], ["hi", "印地语", "Hindi"],
  ["ta", "泰米尔语", "Tamil"], ["tr", "土耳其语", "Turkish"], ["nl", "荷兰语", "Dutch"], ["pl", "波兰语", "Polish"],
  // 其他
  ["af", "南非荷兰语", "Afrikaans"], ["sq", "阿尔巴尼亚语", "Albanian"], ["az", "阿塞拜疆语", "Azerbaijani"], ["eu", "巴斯克语", "Basque"],
  ["be", "白俄罗斯语", "Belarusian"], ["bn", "孟加拉语", "Bengali"], ["bs", "波斯尼亚语", "Bosnian"], ["bg", "保加利亚语", "Bulgarian"],
  ["ca", "加泰罗尼亚语", "Catalan"], ["hr", "克罗地亚语", "Croatian"], ["cs", "捷克语", "Czech"], ["da", "丹麦语", "Danish"],
  ["et", "爱沙尼亚语", "Estonian"], ["fi", "芬兰语", "Finnish"], ["gl", "加利西亚语", "Galician"], ["el", "希腊语", "Greek"],
  ["gu", "古吉拉特语", "Gujarati"], ["he", "希伯来语", "Hebrew"], ["hu", "匈牙利语", "Hungarian"], ["kn", "卡纳达语", "Kannada"],
  ["kk", "哈萨克语", "Kazakh"], ["lv", "拉脱维亚语", "Latvian"], ["lt", "立陶宛语", "Lithuanian"], ["mk", "马其顿语", "Macedonian"],
  ["ml", "马拉雅拉姆语", "Malayalam"], ["mr", "马拉地语", "Marathi"], ["no", "挪威语", "Norwegian"], ["fa", "波斯语", "Persian"],
  ["pa", "旁遮普语", "Punjabi"], ["ro", "罗马尼亚语", "Romanian"], ["sr", "塞尔维亚语", "Serbian"], ["sk", "斯洛伐克语", "Slovak"],
  ["sl", "斯洛文尼亚语", "Slovenian"], ["sw", "斯瓦希里语", "Swahili"], ["sv", "瑞典语", "Swedish"], ["te", "泰卢固语", "Telugu"],
  ["uk", "乌克兰语", "Ukrainian"], ["ur", "乌尔都语", "Urdu"], ["cy", "威尔士语", "Welsh"],
];
const BY = Object.fromEntries(LANGS.map(([c, zh, en]) => [c, { zh, en }]));
export const langZh = (c) => (c === "zh" ? "中文" : BY[c]?.zh || c);
export const langEn = (c) => (c === "zh" ? "Chinese" : BY[c]?.en || c);
export const validLang = (c) => !!BY[c];
