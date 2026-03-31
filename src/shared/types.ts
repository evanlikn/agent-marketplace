export interface ManifestSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  input_modes?: string[];
  output_modes?: string[];
}

export interface AgentManifest {
  schema_version: string;
  agent_id: string;
  display_name: string;
  description: string;
  version: string;
  publisher?: {
    publisher_id: string;
    organization?: string;
    website?: string;
  };
  skills: ManifestSkill[];
  capabilities: {
    supports_streaming: boolean;
    supports_network: boolean;
    supports_push_notifications?: boolean;
    model_families?: string[];
    tool_types?: string[];
    extensions?: Array<{
      uri: string;
      description?: string;
      required?: boolean;
      params?: Record<string, unknown>;
    }>;
  };
  prompt?: {
    system_prompt_hash?: string;
    template_variables?: string[];
  };
  knowledge_decl?: {
    sources: Array<{
      type: "local_files" | "db" | "vector_store" | "api" | "other";
      summary: string;
      refresh_policy?: string;
    }>;
    last_updated_at?: string;
    contains_personal_data?: boolean;
  };
  runtime_requirements: {
    cpu_cores?: number;
    gpu?: boolean;
    min_memory_mb: number;
    max_context_tokens?: number;
    max_concurrency: number;
  };
  io_contract?: {
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
  };
  routing_hints?: {
    region_hint?: string;
    latency_sla_ms?: number;
    timeout_ms?: number;
  };
  visibility?: "private" | "unlisted" | "public";
  pricing?: {
    billing_mode?: "per_request" | "per_token" | "per_second";
    currency?: string;
    unit_price?: number;
  };
  remote_agent_id?: string;
  remote_auth?: {
    mode?: "login_token" | "api_key";
    api_key_env?: string;
  };
  a2a?: {
    protocol_version: string;
    documentation_url?: string;
    icon_url?: string;
    default_input_modes: string[];
    default_output_modes: string[];
    supported_interfaces?: Array<{
      url: string;
      protocol_binding: "JSONRPC" | "GRPC" | "HTTP+JSON";
      tenant?: string;
      protocol_version: string;
    }>;
    security_schemes?: Record<string, Record<string, unknown>>;
    security_requirements?: Array<Record<string, string[]>>;
  };
}

export interface ProviderSession {
  publisher_id: string;
  listing_id: string;
  session_id: string;
  status: "online" | "offline" | "draining" | "unhealthy";
  max_concurrency: number;
  current_concurrency: number;
  region_hint?: string;
  latency_ms?: number;
  success_rate_1m?: number;
  updated_at: string;
}

export interface InvocationRecord {
  request_id: string;
  caller_id: string;
  listing_id: string;
  provider_session_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timeout";
  latency_ms?: number;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  cost?: number;
  error_code?: string;
  started_at: string;
  finished_at?: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
    tenant?: string;
    protocolVersion: string;
  }>;
  provider?: {
    url: string;
    organization: string;
  };
  version: string;
  documentationUrl?: string;
  iconUrl?: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
    extensions?: Array<{
      uri?: string;
      description?: string;
      required?: boolean;
      params?: Record<string, unknown>;
    }>;
  };
  securitySchemes?: Record<string, Record<string, unknown>>;
  securityRequirements?: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
    securityRequirements?: Array<Record<string, string[]>>;
  }>;
  signatures?: Array<{
    protected: string;
    signature: string;
    header?: Record<string, unknown>;
  }>;
  ["x-openclaw-agentId"]?: string;
  ["x-openclaw-listingId"]?: string;
}

export interface Listing {
  listing_id: string;
  manifest: AgentManifest;
  publisher_id: string;
  created_at: string;
  updated_at: string;
}
