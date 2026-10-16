// Preserve a completed baseline analysis, before interactive edits or extension execution.
// @category REA
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.program.model.listing.Program;

public class ReaGhidraAnalysisCache extends HeadlessScript {
    private static final String MARKER = "REA analysis cache identity";

    @Override
    public void run() throws Exception {
        CacheDescriptor descriptor = readDescriptor();
        verifyTarget(descriptor);

        if (descriptor.reused()) {
            verifyReusedAnalysis(descriptor.identity());
            return;
        }

        preserveCompletedAnalysis(descriptor);
    }

    private CacheDescriptor readDescriptor() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 1) {
            abort("Analysis cache requires exactly one descriptor path");
        }

        JsonObject descriptor = JsonParser.parseString(
            Files.readString(Path.of(arguments[0]))
        ).getAsJsonObject();
        return new CacheDescriptor(
            Path.of(descriptor.get("directory").getAsString()),
            descriptor.get("identity").getAsString(),
            descriptor.get("target_sha256").getAsString(),
            descriptor.get("reused").getAsBoolean()
        );
    }

    private void verifyTarget(CacheDescriptor descriptor) throws Exception {
        if (
            currentProgram == null ||
            !descriptor.targetSha256().equalsIgnoreCase(currentProgram.getExecutableSHA256())
        ) {
            abort("Cached analysis does not match the selected executable");
        }
    }

    private void verifyReusedAnalysis(String identity) throws Exception {
        String saved = currentProgram
            .getOptions(Program.PROGRAM_INFO)
            .getString(MARKER, "");
        if (!identity.equals(saved)) {
            abort("Cached analysis profile does not match this session");
        }

        println("REA analysis cache: reused complete analysis");
    }

    private void preserveCompletedAnalysis(CacheDescriptor descriptor) {
        if (analysisTimeoutOccurred() || monitor.isCancelled()) {
            println("REA analysis cache: incomplete analysis was not saved");
            return;
        }

        commitCacheIdentity(descriptor.identity());
        publishWithoutFailingSession(descriptor);
    }

    private void commitCacheIdentity(String identity) {
        currentProgram
            .getOptions(Program.PROGRAM_INFO)
            .setString(MARKER, identity);
        end(true);
    }

    private void publishWithoutFailingSession(CacheDescriptor descriptor) {
        try {
            publish(descriptor.directory(), descriptor.identity());
            println("REA analysis cache: saved complete analysis");
        }
        catch (Exception failure) {
            // A cache write failure must not discard successful analysis in this session.
            printerr("REA analysis cache could not be saved: " + failure);
            for (Throwable suppressed : failure.getSuppressed()) {
                printerr("Cache cleanup: " + suppressed);
            }
        }
    }

    private void abort(String message) throws Exception {
        setHeadlessContinuationOption(HeadlessContinuationOption.ABORT);
        throw new IllegalStateException(message);
    }

    private void publish(Path directory, String identity) throws Exception {
        String name = UUID.randomUUID().toString() + ".gzf";
        PublicationPaths paths = new PublicationPaths(
            directory.resolve(name + ".pending"),
            directory.resolve(name),
            directory.resolve(name + ".json.pending"),
            directory.resolve("ready.json")
        );

        try {
            savePendingArchive(paths.pendingArchive());
            JsonObject manifest = buildManifest(identity, name, paths.pendingArchive());
            Files.move(
                paths.pendingArchive(),
                paths.archive(),
                StandardCopyOption.ATOMIC_MOVE
            );

            writePendingManifest(paths.pendingManifest(), manifest);
            Files.move(
                paths.pendingManifest(),
                paths.readyManifest(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING
            );
        }
        catch (Exception failure) {
            cleanup(paths.pendingArchive(), failure);
            cleanup(paths.pendingManifest(), failure);
            // An unreferenced archive is safe to retain if publication's outcome is uncertain.
            throw failure;
        }
    }

    private void savePendingArchive(Path pendingArchive) throws Exception {
        currentProgram.saveToPackedFile(pendingArchive.toFile(), monitor);
        restrictPermissions(pendingArchive);
        sync(pendingArchive);
    }

    private static JsonObject buildManifest(
            String identity,
            String archiveName,
            Path pendingArchive) throws Exception {
        JsonObject manifest = new JsonObject();
        manifest.addProperty("identity", identity);
        manifest.addProperty("archive", archiveName);
        manifest.addProperty("sha256", digest(pendingArchive));
        manifest.addProperty("size", Files.size(pendingArchive));
        return manifest;
    }

    private static void writePendingManifest(
            Path pendingManifest,
            JsonObject manifest) throws Exception {
        Files.writeString(
            pendingManifest,
            manifest.toString(),
            StandardOpenOption.CREATE_NEW
        );
        restrictPermissions(pendingManifest);
        sync(pendingManifest);
    }

    private static void restrictPermissions(Path path) throws Exception {
        Files.setPosixFilePermissions(
            path,
            PosixFilePermissions.fromString("rw-------")
        );
    }

    private static void sync(Path path) throws Exception {
        try (FileChannel file = FileChannel.open(path, StandardOpenOption.WRITE)) {
            file.force(true);
        }
    }

    private static String digest(Path path) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1024 * 1024];
        try (InputStream input = Files.newInputStream(path)) {
            int count;
            while ((count = input.read(buffer)) != -1) {
                hash.update(buffer, 0, count);
            }
        }
        return HexFormat.of().formatHex(hash.digest());
    }

    private static void cleanup(Path path, Exception failure) {
        try {
            Files.deleteIfExists(path);
        }
        catch (Exception cleanupFailure) {
            failure.addSuppressed(cleanupFailure);
        }
    }

    private record CacheDescriptor(
        Path directory,
        String identity,
        String targetSha256,
        boolean reused
    ) {}

    private record PublicationPaths(
        Path pendingArchive,
        Path archive,
        Path pendingManifest,
        Path readyManifest
    ) {}
}
