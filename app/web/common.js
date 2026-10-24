// 电脑端和手机端共用：WebSocket 连接、状态管理、Markdown 渲染
const TOKEN = document.body.dataset.token;

function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 只处理回答里会出现的几种格式：加粗、列表、来源行
function md(text) {
  const lines = esc(text || "").split("\n");
  let html = "", inList = false;
  for (let raw of lines) {
    let l = raw.trim();
    l = l.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const li = l.match(/^[-*•]\s+(.*)/);
    if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${li[1]}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (!l) continue;
    if (/^(来源|Source|Sources)[:：]/i.test(l)) html += `<p class="src">${l}</p>`;
    else html += `<p>${l}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function hhmm(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const store = { transcript: [], answers: [], names: {}, status: {}, clients: 0, phone_url: "", kb: {} };

function connect(render) {
  let ws, retry = 0;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?t=${TOKEN}`);
    ws.onopen = () => { retry = 0; render("conn", true); };
    ws.onclose = () => {
      render("conn", false);
      setTimeout(open, Math.min(5000, 500 * 2 ** retry++));
    };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case "snapshot":
          Object.assign(store, { transcript: m.transcript, answers: m.answers, names: m.names,
            status: m.status, phone_url: m.phone_url, kb: m.kb, clients: m.clients });
          break;
        case "transcript": store.transcript.push(m); if (store.transcript.length > 300) store.transcript.shift(); break;
        case "answer_start": store.answers.push({ ...m, text: "", done: false }); break;
        case "answer_delta": { const a = store.answers.find(x => x.id === m.id); if (a) a.text += m.text; break; }
        case "answer_end": { const a = store.answers.find(x => x.id === m.id); if (a) { a.text = m.text; a.done = true; } break; }
        case "status": store.status = m.status; break;
        case "names": store.names = m.names; break;
        case "clients": store.clients = m.count; break;
      }
      render(m.type, m);
    };
  };
  open();
  return { send: obj => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)) };
}

function nameOf(t) { return store.names[t.sid] || t.name || t.sid; }

// 给不同说话人分配稳定的颜色
const PALETTE = ["#2f7d6d", "#b5562b", "#6a4fb3", "#a33a62", "#3d6fa8", "#7a6a1f"];
function colorOf(sid) {
  if (sid === "me") return "var(--me)";
  const n = parseInt(String(sid).replace(/\D/g, "")) || 1;
  return PALETTE[(n - 1) % PALETTE.length];
}
