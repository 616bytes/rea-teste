import ghidra.app.util.headless.HeadlessScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.SourceType;

/**
 * Prepare a saved project for the persistent-project lane: name the entry
 * function as a person would in the project, so REA can only report that name
 * by serving the saved project rather than re-analyzing the target.
 */
public final class ReaPersistentProjectFixture extends HeadlessScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 2) {
            throw new IllegalArgumentException("Expected an entry address and a function name");
        }
        Function function = getFunctionAt(toAddr(arguments[0]));
        if (function == null) {
            throw new IllegalStateException("No function at " + arguments[0]);
        }
        function.setName(arguments[1], SourceType.USER_DEFINED);
        println("REA_PERSISTENT_PROJECT_FIXTURE_OK " + function.getEntryPoint() + " " +
            function.getName() + " " + currentProgram.getExecutableSHA256());
    }
}
