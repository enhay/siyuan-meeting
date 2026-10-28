"use strict";

function parseHotwords(value) {
  const text = Array.isArray(value) ? value.filter((word) => typeof word === "string").join("\n") : String(value || "");
  return [...new Set(text.split(/[\s\p{P}\p{S}\p{C}]+/u).filter(Boolean))];
}

function effectiveHotwords(globalWords, meeting = {}) {
  const excluded = new Set(parseHotwords(meeting.excludedHotwords));
  return parseHotwords([
    ...parseHotwords(meeting.hotwords),
    ...(meeting.useGlobalHotwords === false ? [] : parseHotwords(globalWords)),
  ]).filter((word) => !excluded.has(word));
}

function validateHotwords(value, service) {
  const words = parseHotwords(value);
  const limit = service === "tencent" ? 128 : 5000;
  if (words.length > limit) throw new Error(`${service === "tencent" ? "腾讯云" : "豆包"}最多支持 ${limit} 个热词，请减少后再试`);
  const tooLong = words.find((word) => service === "tencent"
    ? Buffer.byteLength(word, "utf8") > 30
    : [...word].length > 30 || (word.match(/\p{Script=Han}/gu) || []).length > 10);
  if (tooLong) throw new Error(`热词“${tooLong}”过长，请使用简短的人名或术语（中文最多 10 字，英文最多 30 字母）`);
  return words;
}

function tencentHotwords(words) {
  // Ordinary emphasis; never opt users into forced homophone replacement.
  return validateHotwords(words, "tencent").map((word) => `${word}|5`).join(",");
}

function doubaoCorpus(words) {
  const hotwords = validateHotwords(words, "doubao").map((word) => ({ word }));
  return hotwords.length ? { corpus: { context: JSON.stringify({ hotwords }) } } : {};
}

module.exports = { parseHotwords, effectiveHotwords, validateHotwords, tencentHotwords, doubaoCorpus };
