import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import agentManifestSchema from "../../schemas/agent-manifest.schema.json" with { type: "json" };
import a2aAgentCardSchema from "../../schemas/a2a-agent-card.schema.json" with { type: "json" };
import providerEndpointSchema from "../../schemas/provider-endpoint.schema.json" with { type: "json" };
import invocationRecordSchema from "../../schemas/invocation-record.schema.json" with { type: "json" };

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const addFormats = require("ajv-formats").default as (ajv: unknown) => void;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

type SchemaName = "agentManifest" | "a2aAgentCard" | "providerEndpoint" | "invocationRecord";

const validators: Record<SchemaName, ValidateFunction> = {
  agentManifest: ajv.compile(agentManifestSchema),
  a2aAgentCard: ajv.compile(a2aAgentCardSchema),
  providerEndpoint: ajv.compile(providerEndpointSchema),
  invocationRecord: ajv.compile(invocationRecordSchema)
};

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: ErrorObject[] | null | undefined
  ) {
    super(message);
  }
}

export function validateOrThrow<T>(schemaName: SchemaName, payload: unknown): T {
  const validator = validators[schemaName];
  const valid = validator(payload);
  if (!valid) {
    throw new SchemaValidationError(
      `${schemaName} schema validation failed`,
      "MANIFEST_SCHEMA_INVALID",
      validator.errors
    );
  }
  return payload as T;
}
