import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

// Runtime discovery is generated from the same canonical registrations, after
// default identity has been recorded and before bundling. Test catalogs stay separate.
const compiled = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const read = (name) => import(pathToFileURL(join(compiled, name)).href);
const [
  { createServer },
  { createBinarySession },
  { parseConfig },
  { silentLogger },
  { PROMPT_CONTRACTS },
] = await Promise.all([
  read("server/createServer.js"),
  read("composition/binary.js"),
  read("config/parseConfig.js"),
  read("logger.js"),
  read("contracts/promptContracts.js"),
]);
const config = parseConfig({});
if (!config.ok) throw config.error;
const session = createBinarySession(config.value, silentLogger, {});
const server = createServer({ kind: "session", session }, { environment: {} });
const client = new Client({ name: "rea-catalog-recorder", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const prompts = (await client.listPrompts()).prompts.map((prompt) => {
    const contract = PROMPT_CONTRACTS.find(
      (candidate) => candidate.name === prompt.name,
    );
    if (contract === undefined)
      throw new Error(`Missing prompt ${prompt.name}`);
    return { ...prompt, parameters: contract.arguments };
  });
  const catalog = {
    version: 1,
    info: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
    identity: server.catalogIdentity,
    tools,
    prompts,
  };
  const encoded = JSON.stringify(catalog);
  const digest = createHash("sha256").update(encoded).digest("hex");
  await writeFile(join(compiled, "mcp-catalog.json"), encoded);
  await writeFile(
    join(compiled, "recordedMcpCatalog.js"),
    `/** Recorded from the compiled runtime; do not edit. */\nexport const RECORDED_MCP_CATALOG_SHA256 = ${JSON.stringify(digest)};\n`,
  );
} finally {
  await client.close();
  await server.close();
  const closed = await session.close({ retainProviderDocuments: true });
  if (!closed.ok) throw closed.error;
}
