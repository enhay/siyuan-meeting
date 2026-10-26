const { ipcRenderer } = require("electron");
const channel = new URLSearchParams(location.search).get("channel");
let phase;
ipcRenderer.on(channel, (_, state) => {
  phase = state.phase;
  document.getElementById("label").textContent = state.label;
  const pause = document.getElementById("pause");
  pause.textContent = phase === "paused" ? "▶" : "Ⅱ";
  pause.setAttribute("aria-label", phase === "paused" ? "继续录音" : "暂停录音");
  pause.title = pause.getAttribute("aria-label");
  pause.disabled = !["recording", "paused"].includes(phase);
  document.getElementById("stop").disabled = phase === "saving";
  document.body.dataset.state = phase;
});
for (const type of ["pause", "stop", "open"]) document.getElementById(type).onclick = () =>
  ipcRenderer.send(channel, { type: type === "pause" && phase === "paused" ? "resume" : type });
