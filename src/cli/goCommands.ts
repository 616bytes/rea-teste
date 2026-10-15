import { z } from "incur";
import { resolve } from "node:path";
import { createGoBinaryService } from "../composition/go.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve caller paths and inspect static build metadata through the shared workflow. */
export const registerGoCommands = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.inspectGoBinary, {
    description:
      "Inspect Go build metadata and supported function entries without target execution",
    args: z.object({
      path: z.string().describe("Local ELF, PE or thin Mach-O image"),
    }),
    options: z.object({
      functions: z
        .boolean()
        .optional()
        .describe("Read supported Go function names and entry coordinates"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createGoBinaryService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectGoBinary,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  {
                    path: resolve(args.path),
                    ...(options.functions === undefined
                      ? {}
                      : { functions: options.functions }),
                  },
                  { signal },
                ),
              service,
              "go-build-info",
              "inspect_go_binary",
            ),
        );
      }),
  });
};
