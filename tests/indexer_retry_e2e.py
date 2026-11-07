"""资料 AI 整理遇到服务商临时出错（DeepSeek 500）时的处理：
1) 偶发 500：等一会儿自动重试，整理成功
2) 某一段一直 500：拆开逐段重试，其余段落照常整理，资料标为"已整理"并注明有几段没整理好；点重试补上
3) Key 无效（401）：不反复重试，直接提示

    python tests/indexer_retry_e2e.py [站点目录，默认 mobile]
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import desktop_e2e as D  # noqa: E402

SITE = D.SITE
LOG = {"calls": 0, "fail_next": 0, "bad_alive": True, "status401": False}


def on_deepseek(route):
    req = route.request
    if req.method == "OPTIONS":
        return route.fulfill(status=204, headers=D.CORS)
    LOG["calls"] += 1
    body = json.loads(req.post_data or "{}")
    user = body["messages"][-1]["content"]
    err = lambda code, msg: route.fulfill(status=code, headers={**D.CORS, "content-type": "application/json"},
                                          body=json.dumps({"error": {"message": msg}}))
    if LOG["status401"]:
        return err(401, "Authentication Fails")
    if LOG["fail_next"] > 0:
        LOG["fail_next"] -= 1
        return err(500, "Internal Server Error (request_id: abc)")
    if LOG["bad_alive"] and "BADCHUNK" in user:
        return err(500, "Internal Server Error (request_id: def)")
    ids = [int(x) for x in re.findall(r"【片段 (\d+)】", user)]
    out = [{"id": i, "summary": f"第{i}段", "keywords": ["k"], "qa": [{"q": f"问题{i}？", "q_en": f"Q{i}?", "a": f"答案{i}"}]} for i in ids]
    route.fulfill(status=200, headers={**D.CORS, "content-type": "application/json"},
                  body=json.dumps({"choices": [{"message": {"content": json.dumps(out, ensure_ascii=False)}}]}))


SETUP = """async (text) => {
  const { Indexer } = await import('./js/indexer.js');
  const { KnowledgeBase } = await import('./js/kb.js');
  const { Router, RETRY_DELAYS } = await import('./js/llm.js');
  RETRY_DELAYS.splice(0, RETRY_DELAYS.length, 20, 20, 20);   // 测试里不用真的等
  const S = { deepseekKey: 'sk-ds', deepseekModel: 'deepseek-flash', answerProvider: 'deepseek', autoIndex: true };
  const kb = new KnowledgeBase();
  const ix = new Indexer(kb, () => new Router(S), () => S, () => {});
  window.__t = { kb, ix };
}"""


def run(page, name, text):
    return page.evaluate("""async ([name, text]) => {
      const { kb, ix } = window.__t;
      await kb.addText(name, text);
      await ix.run();
      const d = kb.docs.find(x => x.name === name);
      return { status: d.idx.status, failed: d.idx.failed || 0, total: d.idx.total, done: d.idx.chunks.filter(Boolean).length, error: d.idx.error || '' };
    }""", [name, text])


def main():
    srv, base = D.serve(SITE)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.route("https://api.deepseek.com/**", on_deepseek)
        page.goto(base + "remote.html")  # 任意同源页面，只用来加载模块
        page.evaluate(SETUP)
        para = "这是一段用来测试的资料内容，讲的是产品的价格、实施周期和数据存储。" * 14  # 约 500 字一段

        # 1) 偶发 500：前两次失败，自动重试后成功
        LOG.update(calls=0, fail_next=2)
        r = run(page, "a.md", "\n\n".join(f"## 第{i}节\n{para}" for i in range(8)))
        assert r["status"] == "done" and r["failed"] == 0 and r["done"] == r["total"], r

        # 2) 有一段一直 500：其余段落照常整理
        LOG.update(calls=0, fail_next=0, bad_alive=True)
        secs = [f"## 第{i}节\n{para}" for i in range(10)]
        secs[4] = "## 第4节\nBADCHUNK " + para
        r = run(page, "b.md", "\n\n".join(secs))
        assert r["status"] == "done" and r["failed"] >= 1 and r["done"] == r["total"] - r["failed"], r
        assert "500" in r["error"], r
        # 重试：补上没整理的段落
        LOG["bad_alive"] = False
        r2 = page.evaluate("""async () => {
          const { kb, ix } = window.__t;
          const d = kb.docs.find(x => x.name === 'b.md');
          d.idx.status = 'running'; d.idx.retry = true;
          await ix.run();
          return { status: d.idx.status, failed: d.idx.failed || 0, done: d.idx.chunks.filter(Boolean).length, total: d.idx.total };
        }""")
        assert r2["status"] == "done" and r2["failed"] == 0 and r2["done"] == r2["total"], r2

        # 3) Key 无效：直接报错，不反复重试
        LOG.update(calls=0, status401=True)
        r3 = run(page, "c.md", "\n\n".join(f"## 第{i}节\n{para}" for i in range(6)))
        assert r3["status"] == "error" and "Key 无效" in r3["error"], r3
        assert LOG["calls"] <= 2, LOG["calls"]
        b.close()
    srv.shutdown()
    print(f"indexer retry e2e ok | 偶发500 自动恢复 | 单段失败 {r['failed']}/{r['total']} 段跳过后补齐 | 401 调用 {LOG['calls']} 次")


if __name__ == "__main__":
    main()
