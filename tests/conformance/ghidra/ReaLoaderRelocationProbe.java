//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptProvider;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.reloc.Relocation;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.SourceType;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

/**
 * Exercises the production loader-relocation boundary on a real imported
 * Ghidra Program. The relocation is added to the ephemeral database so the
 * probe remains deterministic across Mach-O loader versions; the source file
 * and its FileBytes are never changed.
 */
public final class ReaLoaderRelocationProbe extends GhidraScript {
    private final JsonArray checks = new JsonArray();

    private void require(String name, boolean condition) {
        if (!condition) throw new IllegalStateException("Loader relocation assertion failed: " + name);
        checks.add(name);
    }

    private Function function(String name) {
        FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
        Function found = null;
        while (functions.hasNext()) {
            Function candidate = functions.next();
            if (!candidate.getName().equals(name) && !candidate.getName().equals("_" + name)) continue;
            require("unique_function_" + name, found == null);
            found = candidate;
        }
        require("function_present_" + name, found != null);
        return found;
    }

    private static byte[] bytes(FileBytes fileBytes, boolean original) throws Exception {
        byte[] result = new byte[Math.toIntExact(fileBytes.getSize())];
        int read = original
            ? fileBytes.getOriginalBytes(0, result)
            : fileBytes.getModifiedBytes(0, result, 0, result.length);
        if (read != result.length) throw new IllegalStateException("Incomplete FileBytes capture");
        return result;
    }

    private static String digest(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static Method privateMethod(Class<?> owner, String name, Class<?>... types)
            throws Exception {
        Method method = owner.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method;
    }

    private static Object invoke(Method method, Object target, Object... arguments) throws Exception {
        try {
            return method.invoke(target, arguments);
        }
        catch (InvocationTargetException failure) {
            throw new IllegalStateException("Production bridge method failed: " + method.getName(), failure.getCause());
        }
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        for (Class<?> owner = target.getClass(); owner != null; owner = owner.getSuperclass()) {
            try {
                Field field = owner.getDeclaredField(name);
                field.setAccessible(true);
                field.set(target, value);
                return;
            }
            catch (NoSuchFieldException ignored) {
                // Continue through HeadlessScript's inherited state.
            }
        }
        throw new IllegalStateException("Missing bridge field: " + name);
    }

    private static JsonObject procedureQuery(String document, String procedure) {
        JsonObject query = new JsonObject();
        query.addProperty("document", document);
        query.addProperty("procedure", procedure);
        return query;
    }

    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 1) throw new IllegalArgumentException("Expected exact bridge source path");
        File expectedBridge = new File(arguments[0]).getCanonicalFile();
        ResourceFile resource = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        if (resource == null) throw new IllegalStateException("ReaGhidraBridge.java is absent from scriptPath");
        File actualBridge = new File(resource.getAbsolutePath()).getCanonicalFile();
        require("bridge_source_bound", expectedBridge.equals(actualBridge));
        String source = Files.readString(actualBridge.toPath());
        int protectionCall = source.indexOf("protectLoaderInitializedRelocations();");
        int decompilerCall = source.indexOf("initializeDecompiler();");
        require("relocation_protection_precedes_decompiler", protectionCall >= 0 && protectionCall < decompilerCall);

        GhidraScript bridge = GhidraScriptUtil.getProvider(resource).getScriptInstance(resource, errorWriter);
        bridge.set(getState(), getControls());
        setField(bridge, "sessionDefaultAddressSpace", currentProgram.getAddressFactory().getDefaultAddressSpace());
        setField(bridge, "admittedTargetSha256", currentProgram.getExecutableSHA256().toLowerCase());

        Memory memory = currentProgram.getMemory();
        List<FileBytes> sources = memory.getAllFileBytes();
        if (sources.isEmpty()) throw new IllegalStateException("Imported Program has no FileBytes");
        FileBytes targetSource = sources.get(0);
        byte[] sourceBefore = bytes(targetSource, true);
        String sourceDigest = digest(sourceBefore);

        Function reader = function("rea_loader_reader");
        Instruction instruction = null;
        InstructionIterator instructions = currentProgram.getListing().getInstructions(reader.getBody(), true);
        if (instructions.hasNext()) instruction = instructions.next();
        require("reader_instruction_present", instruction != null);

        byte[] fileValue = new byte[] { 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11 };
        FileBytes relocationSource = memory.createFileBytes(
            "REA_RELRO.bin", 0, fileValue.length, new ByteArrayInputStream(fileValue), monitor
        );
        byte[] relocationSourceBefore = bytes(relocationSource, true);
        Address pointer = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(0x7000000000L);
        MemoryBlock block = memory.createInitializedBlock("REA_RELRO", pointer, relocationSource, 0, fileValue.length, false);
        block.setPermissions(true, false, false);
        byte[] loaderValue = ByteBuffer.allocate(8)
            .order(currentProgram.getLanguage().isBigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN)
            .putLong(0x2222222222222222L)
            .array();
        memory.setBytes(pointer, loaderValue);
        Relocation relocation = currentProgram.getRelocationTable().add(
            pointer,
            Relocation.Status.APPLIED,
            0,
            new long[] { 0x2222222222222222L },
            fileValue,
            "rea_loader_value"
        );
        require("program_relocations_are_loader_relocations",
            !currentProgram.getRelocationTable().isRelocatable());
        require("relocation_record_added", relocation != null && currentProgram.getRelocationTable().hasRelocation(pointer));
        Reference reference = currentProgram.getReferenceManager().addMemoryReference(
            instruction.getAddress(), pointer, RefType.READ, SourceType.USER_DEFINED, -1
        );
        require("reader_references_relocation", reference != null);

        boolean readable = block.isRead();
        boolean writable = block.isWrite();
        boolean executable = block.isExecute();
        require("destination_is_loaded_initialized", block.isLoaded() && block.isInitialized());
        require("destination_is_file_backed", !block.getSourceInfos().isEmpty());
        require("destination_is_non_writable", !writable);

        Method protect = privateMethod(bridge.getClass(), "protectLoaderInitializedRelocations");
        invoke(protect, bridge);
        require("destination_block_is_volatile", block.isVolatile());
        require("destination_permissions_preserved",
            block.isRead() == readable && block.isWrite() == writable && block.isExecute() == executable);
        require("target_filebytes_original_unchanged",
            digest(bytes(targetSource, true)).equals(sourceDigest) &&
            java.util.Arrays.equals(bytes(relocationSource, true), relocationSourceBefore));
        require("loader_bytes_differ_from_file_bytes", !java.util.Arrays.equals(memoryBytes(memory, pointer), fileValue));

        Method limitationsMethod = privateMethod(
            bridge.getClass(), "functionBoundaryLimitations", Function.class, Iterable.class
        );
        @SuppressWarnings("unchecked")
        List<String> limitations = (List<String>)invoke(
            limitationsMethod,
            bridge,
            reader,
            currentProgram.getListing().getInstructions(reader.getBody(), true)
        );
        require("evidence_limitation_represents_loader_uncertainty",
            limitations.stream().anyMatch(value ->
                value.contains("non-writable block REA_RELRO") &&
                value.contains("file-backed value may differ") &&
                value.contains("not authoritative")));

        boolean decompilerAvailable = false;
        String pseudocode = null;
        Method initialize = privateMethod(bridge.getClass(), "initializeDecompiler");
        try {
            invoke(initialize, bridge);
            decompilerAvailable = true;
            Method pseudocodeMethod = privateMethod(bridge.getClass(), "procedurePseudocode", JsonObject.class);
            JsonObject output = (JsonObject)invoke(
                pseudocodeMethod,
                bridge,
                procedureQuery(currentProgram.getName(), reader.getName())
            );
            pseudocode = output.get("value").getAsString();
            require("pseudocode_does_not_use_file_constant", !pseudocode.contains("11111111"));
        }
        catch (IllegalStateException unavailable) {
            Throwable cause = unavailable.getCause();
            require("native_decompiler_unavailable_is_explicit",
                cause instanceof IllegalStateException &&
                cause.getMessage() != null && cause.getMessage().contains("could not open"));
        }
        finally {
            Object decompiler = getField(bridge, "decompiler");
            if (decompiler instanceof DecompInterface interface_) interface_.dispose();
        }
        JsonObject report = new JsonObject();
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", ghidra.framework.Application.getApplicationVersion());
        report.addProperty("bridge_source_sha256", digest(Files.readAllBytes(actualBridge.toPath())));
        report.addProperty("target_source_sha256", sourceDigest);
        report.addProperty("relocation_address", canonical(pointer));
        report.addProperty("block", block.getName());
        report.addProperty("source_bytes_unchanged",
            digest(bytes(targetSource, true)).equals(sourceDigest) &&
            java.util.Arrays.equals(bytes(relocationSource, true), relocationSourceBefore));
        report.addProperty("permissions", "read=true,write=false,execute=false");
        report.addProperty("decompiler_verified", decompilerAvailable);
        if (pseudocode != null) report.addProperty("pseudocode", pseudocode);
        report.add("limitations", GSON_ARRAY(limitations));
        report.add("checks", checks);
        report.addProperty("scope", "real Ghidra Program and production bridge private methods; synthetic relocation database record; no target execution and no source FileBytes mutation");
        println("REA_LOADER_RELOCATION_PROBE_JSON " + report);
    }

    private static JsonArray GSON_ARRAY(List<String> values) {
        JsonArray result = new JsonArray();
        for (String value : values) result.add(value);
        return result;
    }

    private static byte[] memoryBytes(Memory memory, Address address) throws Exception {
        byte[] result = new byte[8];
        if (memory.getBytes(address, result) != result.length) throw new IllegalStateException("Incomplete relocation memory read");
        return result;
    }

    private static Object getField(Object target, String name) throws Exception {
        for (Class<?> owner = target.getClass(); owner != null; owner = owner.getSuperclass()) {
            try {
                Field field = owner.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            }
            catch (NoSuchFieldException ignored) { }
        }
        throw new IllegalStateException("Missing bridge field: " + name);
    }

    private static String canonical(Address address) {
        return address.getAddressSpace().getName() + ":0x" + Long.toUnsignedString(address.getOffset(), 16);
    }
}
