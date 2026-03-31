import { A2AAgentCard, AgentManifest } from "./types.js";
import { validateOrThrow } from "./schema.js";

export interface A2AMapperOptions {
  listingId: string;
  publisherId: string;
  gatewayBaseUrl: string;
}

export function manifestToAgentCard(manifest: AgentManifest, options: A2AMapperOptions): A2AAgentCard {
  const base = options.gatewayBaseUrl.replace(/\/$/, "");
  const canonicalUrl = `${base}/v1/a2a/invoke/${options.listingId}`;
  const defaultProtocolVersion = manifest.a2a?.protocol_version ?? "1.0";

  const supportedInterfaces =
    manifest.a2a?.supported_interfaces?.map((it) => ({
      url: canonicalUrl,
      protocolBinding: it.protocol_binding,
      tenant: it.tenant,
      protocolVersion: it.protocol_version
    })) ?? [
      {
        url: canonicalUrl,
        protocolBinding: "HTTP+JSON" as const,
        protocolVersion: defaultProtocolVersion
      }
    ];

  const card: A2AAgentCard = {
    name: manifest.display_name,
    description: manifest.description,
    version: manifest.version,
    supportedInterfaces,
    provider: manifest.publisher?.organization
      ? {
          organization: manifest.publisher.organization,
          url: manifest.publisher.website ?? base
        }
      : undefined,
    documentationUrl: manifest.a2a?.documentation_url,
    iconUrl: manifest.a2a?.icon_url,
    capabilities: {
      streaming: manifest.capabilities.supports_streaming,
      pushNotifications: manifest.capabilities.supports_push_notifications ?? false,
      extensions: manifest.capabilities.extensions
    },
    securitySchemes: manifest.a2a?.security_schemes ?? {},
    securityRequirements: manifest.a2a?.security_requirements ?? [],
    defaultInputModes: manifest.a2a?.default_input_modes ?? ["text/plain"],
    defaultOutputModes: manifest.a2a?.default_output_modes ?? ["text/plain"],
    skills: manifest.skills.map((it) => ({
      id: it.id,
      name: it.name,
      description: it.description,
      tags: it.tags,
      examples: it.examples,
      inputModes: it.input_modes,
      outputModes: it.output_modes
    })),
    "x-openclaw-agentId": `${options.publisherId}/${manifest.agent_id}`,
    "x-openclaw-listingId": options.listingId
  };

  return validateOrThrow<A2AAgentCard>("a2aAgentCard", card);
}
