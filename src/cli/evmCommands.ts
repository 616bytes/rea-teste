import { z } from "incur";
import { resolve } from "node:path";
import { evmInterfaceModule } from "../composition/evm.js";
import { logCliCommand } from "../cliLogging.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve operator paths and preserve explicit encoding through the shared workflow. */
export const registerEvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = evmInterfaceModule.create(environment);
  cli.command(evmInterfaceModule.cliCommand, {
    description: "Infer interface candidates from explicit local EVM bytecode",
    args: z.object({
      path: z.string().describe("Local bytecode or compiler-output carrier"),
      encoding: z
        .enum(["raw", "hex", "solc-json"])
        .describe("Selected carrier representation"),
    }),
    options: z.object({
      "source-unit": z
        .string()
        .optional()
        .describe("Exact compiler source-unit key for solc-json"),
      "contract-name": z
        .string()
        .optional()
        .describe("Exact compiler contract key for solc-json"),
      "bytecode-kind": z
        .enum(["creation", "deployed"])
        .optional()
        .describe("Selected compiler bytecode object"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            evmInterfaceModule.cliCommand,
            async () => {
              if (
                args.encoding !== "solc-json" &&
                (options["source-unit"] !== undefined ||
                  options["contract-name"] !== undefined ||
                  options["bytecode-kind"] !== undefined)
              )
                return projectAnalysisError(
                  new AnalysisInputError("inspect_evm_interface", undefined, [
                    {
                      path: ["encoding"],
                      reason: "invalid_value",
                      message:
                        "Compiler selection options require solc-json encoding.",
                    },
                  ]),
                );
              const result = await service.inspect(
                {
                  path: resolve(args.path),
                  encoding:
                    args.encoding === "solc-json"
                      ? {
                          kind: "solc-json",
                          source_unit: options["source-unit"],
                          contract_name: options["contract-name"],
                          bytecode_kind: options["bytecode-kind"],
                        }
                      : args.encoding,
                },
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
