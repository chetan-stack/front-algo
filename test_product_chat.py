# Landing-page product chat: validation, per-IP limit, refund on failure, answer cap.
# Claude is stubbed and usage goes to a temp file, so this costs nothing and leaves ai_usage.json alone.
import os
import tempfile

from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai_chat

ai_chat.USAGE_FILE = os.path.join(tempfile.mkdtemp(), "usage.json")
reply = {"kind": "text", "value": "x" * 2000}
ai_chat.claude_code = lambda *a, **k: iter([(reply["kind"], reply["value"])])
app = FastAPI()
app.include_router(ai_chat.router)
c = TestClient(app)
ask = lambda ip="1.1.1.1", msgs=None: c.post("/api/public/product-chat", headers={"cf-connecting-ip": ip},
                                              json={"messages": msgs or [{"role": "user", "content": "price?"}]})

assert c.post("/api/public/product-chat", json={"messages": []}).status_code == 400
assert ask(msgs=[{"role": "assistant", "content": "hi"}]).status_code == 400

r = ask()
assert r.status_code == 200 and len(r.json()["answer"]) == ai_chat.PUBLIC_MAX_ANSWER

reply.update(kind="error", value="boom")  # a failed answer doesn't use up the visitor's quota
assert ask().status_code == 502
reply.update(kind="text", value="ok")
for _ in range(ai_chat.PUBLIC_IP_LIMIT - 1):
    assert ask().status_code == 200
assert ask().status_code == 429  # 11th from the same IP
assert ask(ip="2.2.2.2").status_code == 200  # another visitor is unaffected
print("test_product_chat: all passed")
