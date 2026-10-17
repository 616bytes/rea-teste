import { Cli } from "incur";
import { parseConfig } from "../../dist/config/parseConfig.js";
import { silentLogger } from "../../dist/logger.js";
import { registerCoreAnalysisCommands } from "../../dist/cli/coreAnalysisCommands.js";
import { runDirectAnalysis } from "../../dist/application/DirectAnalysis.js";
import { BinarySession } from "../../dist/application/binary/BinarySession.js";
import { SessionProviderRouter } from "../../dist/application/binary/SessionProviderRouter.js";
import { AnalysisProviderRegistry } from "../../dist/application/binary/AnalysisProviderRegistry.js";
import { HopperProvider } from "../../dist/hopper/HopperProvider.js";

const configuration = parseConfig(process.env);
if (!configuration.ok) throw configuration.error;

// Exercise the real CLI commands, session, provider and socket protocol using
// the provider's injected native-launch platform. A Node bridge fixture cannot
// satisfy the Linux demo launcher's publisher and private-display contracts.
// macOS also exercises the public executable in the acceptance test.
const provider = new HopperProvider(
  configuration.value,
  silentLogger,
  process.env,
  "darwin",
);
const createSession = () =>
  new BinarySession(
    SessionProviderRouter.selectable(
      new AnalysisProviderRegistry([provider]),
      [],
    ),
  );
const dependencies = {
  readConfiguration: () => configuration,
  createBinarySession: createSession,
  createManagedBinarySession: createSession,
};
const cli = Cli.create("rea", { sync: false });
registerCoreAnalysisCommands(cli, silentLogger, (...arguments_) =>
  runDirectAnalysis(dependencies, ...arguments_),
);
await cli.serve(process.argv.slice(2));
