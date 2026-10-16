// Run with the AdelisOne loader so the TypeScript module and its effect imports resolve:
//   node --import ./adelisone/node/register.mjs --test adelisone/tests/a1Account.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { A1Client } from "../server/a1/A1Account.ts";

const memorySecrets = () => {
  const store = new Map();
  return {
    store,
    read: async (name) => store.get(name),
    write: async (name, value) => void store.set(name, value),
    clear: async (name) => void store.delete(name),
  };
};

const jsonResponse = (status, body) => ({
  ok: status < 300,
  status,
  json: async () => body,
});

const registeredClient = async (fetchImpl) => {
  const dir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "a1-account-"));
  const secrets = memorySecrets();
  await NodeFS.writeFile(
    NodePath.join(dir, "adelisone-account.json"),
    JSON.stringify({
      platformUrl: "http://platform.test",
      installId: "inst-1",
      clientId: "client-1",
    }),
  );
  secrets.store.set("adelisone-install", { installId: "inst-1", installSecret: "secret-1" });
  secrets.store.set("adelisone-oauth", {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 3_600_000,
  });
  const client = new A1Client(dir, secrets, { fetchImpl, machineName: "test-mac" });
  return { client, dir, secrets };
};

test("a computer the server removed is forgotten on load and reported as removed", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/a1/installs/verify")) {
      assert.deepEqual(JSON.parse(init.body), { install_id: "inst-1", install_secret: "secret-1" });
      return jsonResponse(200, { active: false });
    }
    throw new Error(`unexpected call ${url}`);
  };
  const { client, dir, secrets } = await registeredClient(fetchImpl);
  await client.load();
  const status = client.status();
  assert.equal(status.registered, false);
  assert.equal(status.signedIn, false);
  assert.equal(status.removed, true);
  assert.equal(secrets.store.size, 0, "install and sign-in secrets are cleared");
  await assert.rejects(
    NodeFS.access(NodePath.join(dir, "adelisone-account.json")),
    "account file is gone",
  );
  assert.ok(calls.some((c) => c.endsWith("/api/a1/installs/verify")));
});

test("an unreachable server keeps the registration", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/a1/installs/verify")) throw new Error("offline");
    if (String(url).endsWith("/api/mcp")) return jsonResponse(200, { result: {} });
    throw new Error(`unexpected call ${url}`);
  };
  const { client } = await registeredClient(fetchImpl);
  await client.load();
  assert.equal(client.status().registered, true);
  assert.equal(client.status().signedIn, true);
  assert.equal(client.status().removed, false);
});

test("a computer still on the list stays connected", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/a1/installs/verify")) return jsonResponse(200, { active: true });
    if (String(url).endsWith("/api/mcp")) return jsonResponse(200, { result: {} });
    throw new Error(`unexpected call ${url}`);
  };
  const { client } = await registeredClient(fetchImpl);
  await client.load();
  assert.equal(await client.verifyRegistration(), true);
  assert.equal(client.status().signedIn, true);
});
