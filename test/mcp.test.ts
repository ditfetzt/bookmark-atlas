import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.ts";
import { dispatchMcpRequest } from "../src/mcp.ts";

test("MCP initializes and lists read-only Bookmark Atlas tools", () => {
  const db = openDatabase(":memory:");
  const initialized = dispatchMcpRequest(db, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initialized?.result && typeof initialized.result === "object" && "protocolVersion" in initialized.result, true);
  const listed = dispatchMcpRequest(db, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const result = listed?.result as { tools: Array<{ name: string }> };
  assert.deepEqual(result.tools.map((tool) => tool.name), [
    "search_bookmarks",
    "get_bookmark",
    "suggest_for_task",
    "related_bookmarks",
  ]);
  db.close();
});

test("MCP notifications do not produce a response", () => {
  const db = openDatabase(":memory:");
  assert.equal(dispatchMcpRequest(db, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  db.close();
});
