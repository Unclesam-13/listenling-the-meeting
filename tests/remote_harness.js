// 测试用：在 Node 里运行 Mac 软件的手机同步服务（desktop/remote-server.js），代替 Electron 主进程。
// 另开一个控制端口，模拟外壳和电脑页面之间的通道：
//   GET /info  启动同步服务并返回手机链接；POST /sync {type,data} 电脑页面的变化；GET /cmds 手机发来的操作（SSE）
// 第一行输出控制端口。
const http = require("http");
const path = require("path");
const { RemoteServer } = require("../desktop/remote-server");

const web = path.resolve(process.argv[2] || path.join(__dirname, "..", "mobile"));
const cmdClients = new Set();
const push = (event, data) => { for (const r of cmdClients) r.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`); };
const rs = new RemoteServer({
  web, ports: [0], addresses: () => ["127.0.0.1"],
  onCommand: (c) => { console.log("CMD " + JSON.stringify(c)); push(null, c); },
  onClients: (n) => push("clients", n),
});
let started = false;
const CORS = { "access-control-allow-origin": "*" };

http.createServer(async (req, res) => {
  if (req.url === "/info") {
    const info = await rs.start();
    if (!started) { started = true; push(null, { type: "hello" }); }
    return res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(info));
  }
  if (req.url === "/sync") {
    let b = ""; for await (const c of req) b += c;
    const { type, data } = JSON.parse(b);
    rs.update(type, data);
    return res.writeHead(204, CORS).end();
  }
  if (req.url === "/cmds") {
    res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": ok\n\n");
    cmdClients.add(res);
    req.on("close", () => cmdClients.delete(res));
    return;
  }
  res.writeHead(404, CORS).end();
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
