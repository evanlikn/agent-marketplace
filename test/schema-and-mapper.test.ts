import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { manifestToAgentCard } from "../src/shared/a2a-mapper.js";
import { validateOrThrow } from "../src/shared/schema.js";
import { A2AAgentCard, AgentManifest } from "../src/shared/types.js";

describe("manifest and a2a mapping", () => {
  test("validates demo manifest and exports valid agent card", () => {
    const raw = fs.readFileSync(path.resolve("agents/demo-agent.manifest.json"), "utf8");
    const manifest = validateOrThrow<AgentManifest>("agentManifest", JSON.parse(raw));
    const card = manifestToAgentCard(manifest, {
      listingId: "lst_demo",
      publisherId: "publisher-demo",
      gatewayBaseUrl: "http://localhost:8080"
    });
    const validated = validateOrThrow<A2AAgentCard>("a2aAgentCard", card);
    expect(validated.name).toBe("Demo Agent");
    expect(validated.supportedInterfaces[0].url).toContain("/v1/a2a/invoke/lst_demo");
  });
});
