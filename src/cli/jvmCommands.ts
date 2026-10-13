import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";

import { jvmDebugMetadataModule } from "../composition/jvm.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve the caller-selected class-file path through the shared workflow. */
export const registerJvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = jvmDebugMetadataModule.create(environment);
  cli.command(jvmDebugMetadataModule.cliCommand, {
    description:
      "Inspect compiler-emitted debug metadata in a selected local JVM .class file",
    args: z.object({
      path: z.string().describe("Local .class artifact"),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            jvmDebugMetadataModule.cliCommand,
            async () => {
              const result = await service.inspect(
                { path: resolve(args.path) },
                { signal },
              );
              return result.ok
                ? result.value
                : projectAnalysisError(result.error);
            },
          );
        } finally {
          await service.close();
        }
      }),
  });
};
