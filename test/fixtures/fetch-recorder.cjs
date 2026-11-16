// Preload for spawned hook runners (NODE_OPTIONS=--require=<this file>).
// Records every fetch and every socket connect to the JSON-lines file named
// by MINDGRAPH_TEST_REQUESTS, and answers fetch locally: nothing leaves the
// machine. Answers are just enough for a SessionStart to run to the end.
const fs = require("node:fs");
const net = require("node:net");

const log = process.env.MINDGRAPH_TEST_REQUESTS;

function record(entry) {
  if (!log) return;
  fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

function headersOf(init) {
  const out = {};
  const headers = new Headers(init && init.headers);
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

global.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input.url || input);
  let body;
  try {
    body = init.body ? JSON.parse(String(init.body)) : undefined;
  } catch {
    body = String(init.body);
  }
  record({
    kind: "fetch",
    url,
    method: init.method || "GET",
    headers: headersOf(init),
    body,
  });
  let result = {};
  const action = body && body.action;
  if (action === "open") result = { uid: "recorded-session" };
  else if (action === "resolve_identity") {
    const key = body.identity && body.identity.key;
    result = { uid: `recorded-repo:${key && key.repo_id}`, status: "existing" };
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordedConnect(...args) {
  const first = args[0];
  const target =
    first && typeof first === "object"
      ? { host: first.host, port: first.port, path: first.path }
      : { args: args.filter((a) => typeof a !== "function").map(String) };
  record({ kind: "connect", ...target });
  return connect.apply(this, args);
};
